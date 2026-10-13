# Backend architecture

The map of this backend, written against the structure you asked it to be compared to. It answers one
question first — *where does my change go?* — and a second underneath it: *why is it not called what I
expected?*

Nothing here is aspirational. Every path in this document exists, and `npm run lint:boundaries` fails the
build if the boundary rules below are broken.

---

## 1. The reference layout, and where each part actually lives

The layout used as the reference was:

```
prisma/schema.prisma
scripts/
src/db/index.js
src/modules/admin/
src/modules/audit/
src/modules/auth/
src/modules/core-gateway/
src/modules/email/
src/modules/identity-gateway/
src/modules/notifications/
src/modules/payouts/
```

Every structural idea in it is already here. The names differ, and two of them cannot be adopted.

| Reference | Here | Note |
| --- | --- | --- |
| `prisma/schema.prisma` | `migrations/<module>/*.js` + **`docs/SCHEMA.md`** | There is no ORM, so the authority is the migrations. `docs/SCHEMA.md` is the readable one-file view, **generated** by `npm run schema:doc`. See §4. |
| `scripts/` | `scripts/` | Same. 22 harnesses and generators, plain `node scripts/*.js`, no framework. |
| `src/db/index.js` | `src/platform/db.js` | Same job — the single database entry point for the **request path**. One pool per module, each with its own `search_path`. (Three kinds of code legitimately open their own connection instead: `platform/leader.js`, because an advisory lock is session-scoped and must not be handed back to a pool; `src/config/migrate-runner.js`, which must connect before the schemas exist; and the `scripts/` harnesses. Nothing serving a request does.) |
| `src/modules/auth/` | `src/modules/identity/` | Auth is not a peer of users; it is the same bounded context. `auth.routes.js`, `token.service.js`, `session.service.js`, `cookies.js` all live in `identity/`, next to the `users` table they authenticate against. |
| `src/modules/notifications/` | `src/modules/notify/` | Same module, shorter name. **The name is load-bearing — see §3.** |
| `src/modules/email/` | `src/utils/sendEmail.js` | A transport, not a bounded context: it owns no tables and no routes. It is called only by `notify/engine.js`, which is the single fan-out point for in-app + push + email. Promoting it to a module would create a module with one function in it. |
| `src/modules/audit/` | `src/modules/notify/audit.js`, `defects/workflow.js#logBugActivity` | Auditing here is **per-context**, not central: notification delivery/action events in `notify`, bug state transitions in `bug_activity_logs`. There is no app-wide audit trail. If you want one, that is a new module and a new table — say so and it gets built properly. |
| `src/modules/admin/` | *no module* | Admin is a **role**, not a context. `restrictTo('admin')` sits on the endpoints that need it, inside the module that owns the data: user management in `identity/users.routes.js`, SLA rules in `defects/routes.js`, leave policy in `workforce/leave.routes.js`. An `admin` module would have to reach into five other modules' tables, which `lint:boundaries` would reject. |
| `src/modules/core-gateway/`, `identity-gateway/` | *not applicable* | Gateways are a microservice deployment concern. This is one codebase deployed as **two processes** (§8), neither of which takes traffic from the other, so there is nothing to route between. The module boundary **is** the future service boundary: each module already talks to the others only through `index.js`. Adding gateways before there is a service to route to would be scaffolding with nothing on it. |
| `src/modules/payouts/` | *not applicable* | There is no money in this product. No payroll, no payouts, no payment provider. |

---

## 2. What a module looks like

Nine modules, each owning its own Postgres schema and its own migration ledger:

| Module | Owns | Shape |
| --- | --- | --- |
| `identity` | users · user_sessions · user_tokens | auth + users: two route files, two services, one repo |
| `work` | projects · project_members · tasks · comments | the tracker core |
| `defects` | bugs · bug_comments · bug_attachments · bug_activity_logs · bug_sla_rules | Module 8; the one module with a **service layer** |
| `notify` | notifications · preferences · snoozes · action_log · logs · push_subscriptions | the single fan-out point for in-app + push + email |
| `integrations` | calendar_connections · sync_settings · event_links · conflicts · teams_webhooks · delivery_log | Google/Microsoft calendar, Teams webhooks |
| `files` | documents · folders | Supabase storage behind it |
| `workforce` | leave_requests · time_logs | leave, attendance, EOD work status |
| `people` | employee_profiles · employee_exits · candidates · interviews · candidate_resumes | Module 9 (HR); holds the only encrypted PII (`pii.js`) |
| `insights` | *nothing* | dashboard + reports. Reads other modules through their `index.js`, which is why it owns no schema and has no migrations. |

A module directory holds its own `routes.js → controller.js → service.js → repo.js → pg`, plus whatever
else is its business (`sla.js`, `workflow.js`, `pii.js`, a cron, a `work-subscriber.js`).

### The one rule

`src/modules/<A>/index.js` is the **only** file anything outside `src/modules/<A>/` may require. Inside its
own directory a module may require whatever it likes.

```bash
npm run lint:boundaries     # exits 1 on any violation
```

This is hand-rolled rather than an eslint rule because core eslint's `no-restricted-imports` only sees ESM
`import`, not `require()`.

---

## 3. Why the module names cannot simply be renamed

**A module's name is its Postgres schema name.** `notify` the directory and `notify` the schema are the same
word, and each pool's `search_path` is `<module>,extensions` — deliberately with **no `public`**
(`src/platform/db.js`).

So renaming `notify` to `notifications` is not a rename. It is:

- `ALTER SCHEMA notify RENAME TO notifications` against dev **and production**,
- every `search_path` changed,
- the ledger `notify.pgmigrations` moved, and every migration's assumptions about its own schema revisited,
- `MODULES` in `src/config/migrate-runner.js` changed, which is what every production SQL script is generated
  from,
- and all of it during a window in which the running application cannot find its own tables.

For a longer word. The names stay.

### Why `public` is off the search_path

On 2026-10-05 a pre-split deployment ran the legacy provisioner and left 29 empty copies of the module tables
in `public`. A stray cross-module query then resolved against an empty shadow instead of raising — the `work`
pool read 1 notification where `notify` held 1442. Removing `public` from the path turns that class of bug
into a loud `42P01`.

`npm run test:isolation` is the regression test: every pool reads its own tables, an unqualified cross-module
name raises, a qualified one still works, and anything left in `public` is reported as a warning.

---

## 4. The schema document — the `schema.prisma` equivalent

```bash
npm run schema:doc           # DATABASE_URL -> docs/SCHEMA.md
npm run schema:doc:check     # fails if the committed doc is out of date
```

`docs/SCHEMA.md` is one file holding every table this backend owns, with columns, types, nullability,
defaults, CHECK/UNIQUE/FK constraints and indexes — plus, at the top, the exact ledger position it was read
at, so a stale document can be recognised as stale.

The dependency arrow points the opposite way to an ORM's, and that is the whole point:

- **generated from** a database, by introspection;
- **never read** by the application;
- **nothing migrates from it.**

A generated document cannot decay into a second source of truth, because the moment it disagrees with the
database it is merely out of date. A hand-maintained `schema.sql` can and did:
`src/config/schema.sql` is an **empty tombstone** and must stay one — it was the old provisioner's input, and
anything written back into it becomes a definition that competes with the migrations.

What it deliberately leaves out, and why, is documented at the top of `scripts/gen-schema-doc.js`: the
platform's own schemas (`auth`, `storage`, `realtime`, `vault`, …) are named and counted but not expanded,
and `public` is listed by table name only — expanding 29 shadow tables would print a second,
plausible-looking definition of nearly every table in the system.

The generator **refuses production by project ref**, using `PROD_REF` imported from `migrate-runner.js` so
there is exactly one definition of which database that is.

---

## 5. Migrations

```bash
npm run migrate           # apply every pending migration, all modules
npm run migrate:status    # what is applied, what is pending — per module
npm run migrate:down      # roll back one per module  (refused on anything not throwaway)
```

node-pg-migrate, one directory per module, and **one ledger per module inside that module's own schema** —
`identity.pgmigrations`, `work.pgmigrations`, … — not a shared `public.pgmigrations`. A module owns its
version history exactly as it owns its tables, so it can be migrated alone and, when extracted, leaves with
its history intact.

The cost is that *"what version is the database at?"* has eight answers. `migrate:status` prints all eight,
and that is the honest shape of a system with eight independently-deployable owners.

**Nothing migrates at boot and nothing in `render.yaml` migrates.** The schemas must exist before the app
starts, so the order is always **migrate → verify → deploy**. See `docs/PRODUCTION-DEPLOYMENT.md`.

### Production DDL is never applied by a tool

`migrate-runner.js` refuses production by project ref, first, with no flag that overrides it. Production DDL
is applied by a person pasting a reviewed script generated by:

```bash
node scripts/gen-production-sql.js <out.sql> <module>/<migration> ...
```

Each generated script is one transaction behind a ledger guard, so re-running it is refused rather than
re-applied.

The old era scripts in `src/config/` are guarded history: `split-guard.js` makes each one refuse to run
against a split database, because `CREATE TABLE IF NOT EXISTS users` on the default pool would silently
create a second, empty `public.users`.

---

## 6. Cross-cutting: `src/platform/`

Not a module — no routes, no tables, no business rules. The things every module needs and none of them owns.

| File | Job |
| --- | --- |
| `db.js` | one pool per module, `search_path` per pool. The only place a request-serving `Pool` is constructed. |
| `crypto.js` | PII encryption (`people`), keyed by `PII_ENCRYPTION_KEY` |
| `leader.js` | advisory-lock leader election, so N Render instances run a cron **once** |
| `logger.js`, `metrics.js`, `error-tracking.js` | observability |
| `readiness.js` | `/health/ready` |
| `request-context.js` | per-request async context |
| `supabase.js` | storage client (`files`, `people` resumes) |

`src/shared/response.js` is the response envelope — `successResponse` / `errorResponse` /
`paginatedResponse`, always `{ success, message, data }`.

---

## 7. Checks

| Command | What it proves |
| --- | --- |
| `npm run lint` | eslint over the repo |
| `npm run lint:boundaries` | no module reaches past another's `index.js`, and no **new** dependency cycle (§9) |
| `npm run modules:graph` | prints the cross-module dependency graph and what is extractable |
| `npm run lint:contracts` | every module's `consumes` manifest matches what its code calls |
| `npm run modules:contracts` | prints the measured cross-module surface — the future HTTP API |
| `npm run test:ports` | the org-chart port is wired, and `workforce` does not require `people` (§9) |
| `npm run test:isolation` | pools read their own tables; cross-module unqualified names raise |
| `npm run schema:doc:check` | `docs/SCHEMA.md` matches the database |
| `npm run test:bugs` | 130 integration tests against a running API (self-cleaning `ZZ `-prefixed fixtures) |
| `npm run test:people`, `test:workforce`, `test:sessions`, `test:crypto`, `test:security`, … | per-module harnesses |

All of them need a running API and/or `DATABASE_URL`, and all of them are non-destructive except where a
harness creates and cleans its own fixtures. `npm run test:ops` triggers reminder sweeps — do not run it
against a database whose users would receive the notifications.

---

## 8. One codebase, three ways to run it

`SERVICE_ROLE` decides what a process does. Same repo, same build, same image.

| `SERVICE_ROLE` | Serves HTTP | Runs sweeps | Subscribes to events |
| --- | --- | --- | --- |
| `all` *(default)* | yes | yes | yes |
| `web` | yes | **no** | yes |
| `cron` | **no** (binds no port) | yes | yes |

`all` is the default deliberately: a deployment that sets nothing behaves exactly as it did before the split,
and `npm run dev` is still one process. If `cron` were ever implied, the failure mode would be an environment
where `ENABLE_CRON` is true, no worker exists, and no sweep runs anywhere — silently.

Event subscriptions are **not** gated by role or by `ENABLE_CRON`: they fire on the request path, not on a
clock. Turning the sweeps off must not stop a deleted task's calendar event being reaped.

### Three gates on a sweep, in order

1. **`SERVICE_ROLE`** — the web tier must not sweep even with `ENABLE_CRON=true`, or the web dyno could win
   the advisory lock and leave the cron worker idle, defeating the point of having one.
2. **`ENABLE_CRON`** — the operator's kill switch. `cron` + `false` is a worker deliberately paused.
3. **The advisory lock** (`platform/leader.js`) — only the process holding it sweeps, so N instances do not
   send N copies. It fails closed: any uncertainty means no cron here.

### Why a cron worker must not exit

A web process is held open by its listener. A worker is held open only by its own timers — and there are two
ways to have none: `ENABLE_CRON=false`, or losing the advisory lock, after which `leader.acquire()` closes
the connection it opened. Either way the process would run out of work, exit 0, and Render would restart it
forever, looking like a crash loop while being nothing of the kind.

So `keepWorkerAlive()` holds a standby open and keeps asking for the lock. That is also what makes a second
worker worth running: when the leader is redeployed, Postgres drops its session lock and a standby takes over
within one `CRON_LEADER_RETRY_MS` instead of sweeps stopping until someone notices.

### On Render

The live service is **`varadhi-project-tracker`** (web). `render.yaml` describes it as
`SERVICE_ROLE=web` alongside a `varadhi-cron` worker, but **neither is in force**: there is no Blueprint
instance on the account, so that file has never been applied and the worker does not exist. Today one
service runs with `SERVICE_ROLE` unset — role `all` — and `ENABLE_CRON=false`, so no sweep runs anywhere.
Giving the sweeps their own process means creating a Background Worker by hand, and paying for an instance.

In the configuration that file describes, every shared
secret on the worker is inherited with `fromService` rather than set twice — a sweep is not read-only: the
calendar sync refreshes OAuth tokens and the Teams jobs read webhook URLs, both encrypted at rest with
`ENCRYPTION_KEY`. A worker holding a different key would not fail loudly; it would fail to decrypt every
stored token and report them as broken connections.

**The worker ships with `ENABLE_CRON=false`.** Turning the sweeps on is a deliberate step after a deploy is
verified, and it is now a change to one service that cannot affect the API.

A Render `worker` is not on the free plan.

---

## 9. Extracting a module — what the graph says

The target shape — five services, the database in three stages, and the order to get there — is in
**`docs/MICROSERVICES-TARGET.md`**. This section is the measurement it is built on.

```bash
npm run modules:graph      # the full dependency graph and extraction ranking
npm run lint:boundaries    # also fails on a NEW cycle
```

This is a **modular monolith**, not microservices: one codebase, two processes (§8), modules talking by direct
function call through `index.js`. The boundaries are service-shaped so a module *can* leave later. Measured,
here is how close that actually is.

### 25 cross-module edges, and one knot

| Module | Depended on by | Depends on |
| --- | --- | --- |
| `identity` | **8** | notify, work |
| `work` | 7 | identity, notify |
| `notify` | 7 | identity, work |
| `files` | 2 | identity, notify, work |
| `workforce` | 1 | identity, notify, work |
| **`defects`** | **0** | files, identity, notify, work |
| **`insights`** | **0** | identity, work |
| **`integrations`** | **0** | identity, notify, work |
| **`people`** | **0** | files, identity, notify, workforce |

One strongly-connected component — modules that are mutually reachable, and therefore come out together or
not at all:

```
{ identity <-> notify <-> work }
```

6 of the 25 edges take part in it, and they are the three modules every other one reads from. Node's circular `require` is already worked around with the lazy
`const notify = () => require('../notify')` form, which hides the cycle from Node but does not remove it:
over HTTP a lazy require is just a lazy client, and the cycle is still two services that each need the other
to start.

Those 6 are recorded in `scripts/module-graph.baseline.json`. **New ones fail the check.** The point is not
that the current ones are fine — it is that they are a known, bounded piece of work, and a seventh appearing
by accident is not.

### Broken cycle 2: `work` ↔ `defects` — two call sites, two knots dissolved

`defects` depends on `work` for good reasons: its task-sync creates the task a developer works a bug
through, and its work-subscriber mirrors that task's status back onto the bug. `work` depended on `defects`
in exactly two places, and they needed opposite fixes.

**`GET /api/projects/:id/bugs`** — the project page's Bugs tab — was declared in
`work/projects.routes.js`, which reached for `defects.projectBugsHandler` to serve it. That was never a
data dependency: the URL belongs to projects, the handler belongs to bugs. A module can mount a path prefix
it does not own, so the route moved to `defects/project-bugs.routes.js`, mounted on `/api/projects`. Express
tries routers in mount order and that router declares only `/:id/bugs`, so every other `/api/projects`
request passes through to work's router, and `/:id/bugs` cannot be shadowed by work's `/:id` — different
numbers of path segments. The URL and its roles are unchanged.

That also deleted a fifteen-line comment explaining that the lazy require existed because whichever of the
two modules loaded first saw the other half-built, and that the server only booted because `server.js`
happened to require `defects` before `work`.

**The bug behind a linked task** — severity, steps, attachments, shown so a developer never opens the Bugs
module — is a real read dependency, and it got a port: `work/linked-bugs.js`, registered by
`defects.subscribe()`. It fails soft on purpose: with no provider, tasks render without the bug badge. A
task list that refuses to load because a sibling module is unavailable would be the worse outcome, and
"unavailable" stops being hypothetical the day defects is its own service.

**The result was out of proportion to the change.** Two call sites took the knot from five modules to three:

```
before   { defects <-> files <-> identity <-> notify <-> work }    14 cyclic edges
after    { identity <-> notify <-> work }                           6 cyclic edges
```

`files` fell out too, without being touched — it was only ever in a cycle by way of
`work -> defects -> files`. Extractable modules went from two to four.

Verified by `npm run test:bugs`: 150 passed, 0 failed. Its section 13 already covered the moved route
(admin 200, project-scoped, manager 403) and its section 9 the bug card (severity, steps, QC reporter, the
task list), so the existing suite was the right proof for both halves.

### Broken cycle 1: `people` ↔ `workforce`

`people` requires `workforce` for attendance and leave, so the HR views can show who is in and who is away.
That direction is right. `workforce` used to require `people` back for exactly one function in two places —
`getReportingManagerId(userId)`, to find who to notify about a short-notice leave request or a missing work
status.

The data did not move: a reporting line is an HR fact and `people.employee_profiles.reporting_manager_id` is
its right home. What was wrong is that workforce was asking a *module* when all it needed was an *answer* —
nothing in `workforce/org.js` cares where the org chart lives. So workforce declares the question as a port,
and `people`, which already depends on workforce, registers itself as the answer in its `subscribe()`.
Extracted later, the same seam takes an HTTP client instead of a function.

Two things fell out of it. The resolver is **batched**, where `sweepEscalate` had been awaiting one query per
missing person inside a loop, beside an identity lookup that already did one call for everyone. And the
"no manager, or their own manager" rule, previously written out at both call sites, now lives once in the
port.

The trade is real and worth stating: a compile-time dependency became a runtime one, so deleting the
registration would stop manager escalations silently while every leave request still succeeded.
`npm run test:ports` is what notices, and the port logs a warning the first time it is asked with nobody
registered.

### Extractable today

`defects`, `insights`, `integrations` and `people` — four of nine. Nothing depends on any of them, so nothing
has to learn to call them over a network, and none sits in a knot.

**`integrations` is the better first candidate**: it is already event-driven (`work-subscriber.js`), and its
work is slow outbound I/O to Google, Microsoft and Teams — exactly what you want off the request path. If it
is down, the tracker still works and a calendar sync is late. It would need HTTP clients for `identity`,
`notify` and `work`.

`insights` has zero inbound too, but it is read-heavy aggregation over other modules' data; over HTTP it
would need `work` to expose aggregates it does not expose today, and every dashboard would pay a network hop.

### What a real extraction needs, beyond the boundary

1. **A network client per consumed module**, with the same signature as that module's `index.js` — which is
   why every function there is already `async` — plus timeouts, retries and a circuit breaker.
2. **Asymmetric JWTs.** `protect` does a database lookup in `identity`'s schema on every request. If
   `identity` becomes a service, every other service either calls it on every request or verifies the token
   itself. Today the token is signed with a shared `JWT_SECRET` (HS256); verifying locally without sharing a
   signing secret means RS256 — identity signs with a private key, everyone else verifies with the public
   one.
3. **A broker instead of an EventEmitter.** `events.js` is in-process; `emit()` awaits its subscribers and
   contains their failures. A broker delivers at-least-once, so every subscriber has to become idempotent,
   and ordered flows like `TASK_DELETED` need that stated explicitly.
4. **Sagas where a transaction used to be.** There is no distributed transaction. Two flows span modules
   inside one today: `defects/task-sync.js` creating a `work` task when a bug is assigned, and converting a
   candidate, which writes an `identity` user and a `people` profile. Each needs a compensating action.
5. **`platform/` becomes a package.** db, logger, crypto and the response envelope are shared by every
   module. Published once, or duplicated and left to drift.
6. **Per-service deploy, routing and tracing.** N services, N env sets, a gateway so the frontend keeps one
   base URL, and correlation IDs across processes — `platform/request-context.js` is the foundation for the
   last one.

### The honest recommendation

Don't do all of it. For this product — one internal tracker, ~20 users, one Postgres — the operational cost
of nine services (brokers, sagas, a gateway, nine deploys) exceeds what it buys.

Extract **one** module when there is a reason: a part that is genuinely heavy, or a team that needs to deploy
independently. `integrations` is that module. Everything else stays where it is, and the cycle gate keeps the
option open.

---

## 10. Where does my change go?

1. **Which table does it touch?** §2 names the owner. That module is where the code goes.
2. **Does it need a column?** A new migration in `migrations/<module>/`, then `npm run migrate` against dev,
   then `npm run schema:doc`. Production is a separate, manual, reviewed step — §5.
3. **Does it need another module's data?** Call that module's `index.js`. If the function you want is not
   exported, add it there — do not reach inside, and do not query another schema directly.
4. **Does it notify anyone?** `notify`'s dispatcher, with a `NOTIFICATION_TYPES` constant, wrapped in the
   local `notifySafely` pattern so a failed notification cannot turn a successful mutation into a 500.
5. **Is it admin-only?** `restrictTo('admin')` on that endpoint. Not a new module.
