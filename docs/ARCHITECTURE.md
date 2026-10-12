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
| `src/modules/core-gateway/`, `identity-gateway/` | *not applicable* | Gateways are a microservice deployment concern. This is one Express process on Render. The module boundary **is** the future service boundary: each module already talks to the others only through `index.js`, so one can be lifted out behind HTTP without untangling anything. Adding gateways before there is a second process would be scaffolding with nothing on it. |
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
| `npm run lint:boundaries` | no module reaches past another's `index.js` |
| `npm run test:isolation` | pools read their own tables; cross-module unqualified names raise |
| `npm run schema:doc:check` | `docs/SCHEMA.md` matches the database |
| `npm run test:bugs` | 130 integration tests against a running API (self-cleaning `ZZ `-prefixed fixtures) |
| `npm run test:people`, `test:workforce`, `test:sessions`, `test:crypto`, `test:security`, … | per-module harnesses |

All of them need a running API and/or `DATABASE_URL`, and all of them are non-destructive except where a
harness creates and cleans its own fixtures. `npm run test:ops` triggers reminder sweeps — do not run it
against a database whose users would receive the notifications.

---

## 8. Where does my change go?

1. **Which table does it touch?** §2 names the owner. That module is where the code goes.
2. **Does it need a column?** A new migration in `migrations/<module>/`, then `npm run migrate` against dev,
   then `npm run schema:doc`. Production is a separate, manual, reviewed step — §5.
3. **Does it need another module's data?** Call that module's `index.js`. If the function you want is not
   exported, add it there — do not reach inside, and do not query another schema directly.
4. **Does it notify anyone?** `notify`'s dispatcher, with a `NOTIFICATION_TYPES` constant, wrapped in the
   local `notifySafely` pattern so a failed notification cannot turn a successful mutation into a 500.
5. **Is it admin-only?** `restrictTo('admin')` on that endpoint. Not a new module.
