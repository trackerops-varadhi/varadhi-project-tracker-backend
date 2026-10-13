# Microservices: the target shape, and the order to get there

This is the *destination*, written down so the work can be done in pieces without re-deciding it each time.
Nothing here is a commitment to go all the way; §6 is honest about when to stop.

Today the backend is a **modular monolith**: one codebase, two process roles (§8 of `ARCHITECTURE.md`), nine
modules talking by direct function call through their `index.js`. The boundaries are service-shaped. This
document says what the services would be, how the database follows, and which step comes next.

Every grouping below is derived from the measured dependency graph — `npm run modules:graph` and
`npm run modules:contracts` — not from taste.

---

## 1. Five services, not nine

| Service | Modules | Why these together |
| --- | --- | --- |
| **core** | identity, notify, work, insights | identity ↔ notify ↔ work is the remaining cycle: mutually reachable, so they come out together or not at all. insights owns no tables and aggregates core's data — over HTTP every dashboard would pay several hops for nothing. |
| **hr** | people, workforce | After the cycle break, `people → workforce` only, and workforce's single inbound edge is people. Splitting them buys one network hop per HR screen and nothing else. |
| **defects** | defects | Zero inbound edges. Extractable today. |
| **files** | files | Inbound from defects and hr only. A storage service is a clean seam. |
| **integrations** | integrations | Zero inbound, already event-driven, and its work is slow outbound I/O to Google, Microsoft and Teams. |

Nine services would mean four extra deployments whose only job is to add a network hop inside a bounded
context that nobody asked to split.

```
                            ┌──────────────┐
         frontend  ────────▶│   gateway    │  one public base URL
                            └──────┬───────┘
          ┌────────────────┬───────┴────────┬────────────────┐
          ▼                ▼                ▼                ▼
    ┌──────────┐     ┌──────────┐     ┌──────────┐    ┌──────────────┐
    │  core    │◀────│ defects  │     │   hr     │    │ integrations │
    │ identity │     │          │────▶│ people   │    │  calendar    │
    │ notify   │◀────│          │     │ workforce│    │  teams       │
    │ work     │◀────┼──────────┼─────┼──────────┼────┤              │
    │ insights │     └────┬─────┘     └────┬─────┘    └──────┬───────┘
    └────┬─────┘          │                │                 │
         │                ▼                ▼                 │
         │          ┌──────────┐     ┌──────────┐            │
         └─────────▶│  files   │◀────│  files   │◀───────────┘
                    └──────────┘     └──────────┘
                      (one service, drawn twice for its two callers)
```

Everything points **into** core. Nothing points out of it, which is what makes core deployable alone and
everything else deployable behind it.

---

## 2. Repository layout

A monorepo with workspaces, not five repos. Five repos for a two-person team means five dependency bumps,
five CI configs and a version skew problem for `packages/contracts`.

```
varadhi/
├── services/
│   ├── core/              identity · notify · work · insights
│   ├── hr/                people · workforce
│   ├── defects/
│   ├── files/
│   └── integrations/
│       └── each: src/ · migrations/<module>/ · package.json · Dockerfile
│
├── packages/
│   ├── platform/          db · crypto · logger · metrics · leader · request-context
│   ├── contracts/         one file per service: the functions it serves
│   ├── clients/           generated from contracts; HTTP + timeout/retry/breaker
│   ├── events/            outbox · publisher · subscriber (idempotency keys)
│   └── auth/              sign (core only) · verify (everyone)
│
└── gateway/               path → service, derived from each service's mount array
```

`packages/platform` is today's `src/platform/`. It has to become a package the moment there are two
deployables, or it becomes five copies that drift.

---

## 3. The contracts already exist, and are enforced

Every module declares what it consumes, in its own `index.js`:

```js
exports.consumes = {
  identity: ['getUserCards'],
  notify: ['NOTIFICATION_TYPES', 'dispatchNotification', 'notificationEvents', 'notifyByRoles'],
  work: ['events', 'getProjectCards', 'getSyncableMilestonesForUser', 'getSyncableTasksForUser',
         'getTaskDigestCounts', 'getTaskSummary', 'getUpcomingTasksForUser', 'projectExists',
         'setTaskDueDate'],
}
```

```bash
npm run modules:contracts    # print the measured surface
npm run lint:contracts       # fail on undeclared or stale consumption
```

**That list is the HTTP API.** Extract `integrations` and those fourteen names become the calls its client
makes — no discovery phase, no grep, no "we found another one in production".

The check fails in both directions, and both matter. A call the manifest does not list would produce a
client missing a method, failing at runtime rather than at build time. A manifest entry nothing calls is one
more endpoint the extracted service has to keep serving for no reader.

One thing the measurement already corrected: `integrations → work` is **nine** functions, not the six a grep
suggested, and one of them — `setTaskDueDate` — is a **write**. Two-way calendar sync writes a task's due
date back. integrations is not a read-only consumer, which changes its contract and its failure modes.

---

## 4. Database: three stages, the first already done

### Stage A — one instance, one schema per module ✅ **done 2026-10-05**

```
Supabase ostmlxuzhprymlchmmak
  identity · notify · work │ people · workforce │ defects │ files │ integrations
  each with its own pgmigrations ledger · ZERO cross-schema foreign keys
  one role (postgres) reaching every schema          ← the remaining weakness
```

Cross-schema foreign keys were dropped during the cutover, which is why a module's tables can leave with it.
`search_path` is `<module>,extensions` with no `public`, so a module cannot *accidentally* read a sibling's
table — but only by convention. `npm run test:isolation` is what tests that convention.

### Stage B — one instance, one role per service ✅ **built, not yet applied**

The whole value in one line: **a service touching a schema it does not own gets `42501 permission denied`
instead of a quietly wrong answer.** `npm run test:isolation` already shows that an *unqualified*
cross-module name raises `42P01`, because `public` is off the search_path — but that is a test of a
convention, and a *qualified* name like `people.employee_profiles` still worked from the `work` pool,
because one role was allowed to read everything. Stage B is what makes it not work.

Worth having even if nothing is ever extracted: it is the isolation `test:isolation` asserts, made true
rather than tested. No new infrastructure and no new cost.

```bash
npm run db:roles        # service-map.js -> docs/db-roles.sql   (never touches a database)
npm run test:db-roles   # proves each role reaches its own schemas and is refused on the rest
```

| Piece | Where |
| --- | --- |
| module → service, one definition | `src/platform/service-map.js` |
| the grants, generated from it | `scripts/gen-db-roles.js` → `docs/db-roles.sql` |
| a pool connecting as its service's role | `platform/db.js` — `DATABASE_URL_<SERVICE>`, falling back to `DATABASE_URL` |
| proof it is confined | `scripts/db-roles.test.js` |
| whether it is on | the boot banner's `- DB:` line |

**Non-breaking by construction.** With no `DATABASE_URL_*` variable set, every pool resolves to
`DATABASE_URL` and the behaviour is exactly what it was — the banner says `shared credential (search_path
isolation only)`. The roles can be created, granted and pointed at **one service at a time**, and the
rollback for each is unsetting a variable, which changes nothing in the database.

The SQL is **purely additive** — `CREATE ROLE` and `GRANT`, no `REVOKE`, no `DROP`, no `ALTER` of an
existing role. Revoking from the migration role would break migrations, and a script that can only add is
one that needs no rollback plan. It is also idempotent, so it can be re-run as each service is brought on.

Two details that would otherwise bite:

- Every pool's `search_path` is `<module>,extensions`, so a role without `USAGE ON SCHEMA extensions`
  cannot call `gen_random_uuid()` and every insert with a uuid default fails. The grants include it.
- `ALTER DEFAULT PRIVILEGES` applies to tables created by the role that *runs* it, so it has to be executed
  as the role that runs migrations (`postgres`, which is also who the Supabase SQL editor runs as). Run by
  anyone else, the next migration quietly produces tables the services cannot read.

Passwords are deliberately **not** in the generated file: roles are created `LOGIN` with no password, which
cannot connect, and the operator sets one per role. So the file is safe to commit and nothing is reachable
in the window between.

### Stage C — separate instances, on demand only

Only when one service needs its own scaling, backup schedule or retention. `defects` (SLA sweep write
volume) and `integrations` (token churn) are the plausible first candidates. After this there are no
cross-schema joins to lose, because there are none now.

---

## 5. Between services

### Synchronous — a call that needs an answer

Generated from `packages/contracts`, so the client's signature is the contract's. Every function in a
module's `index.js` is already `async`, which is why call sites survive the change unedited. Each client
adds a timeout, bounded retries for idempotent reads, a circuit breaker, and the correlation id from
`platform/request-context`.

### Asynchronous — announcing that something happened

Today `work/events.js` is a Node `EventEmitter`: in-process, and `emit()` awaits its subscribers so a
failure is contained rather than lost. Across services that becomes an **outbox**:

```
  work transaction ─┬─ INSERT task
                    └─ INSERT outbox row          same transaction, so either both or neither
                              │
                    publisher ▼ ──▶ broker ──▶ defects · files · integrations · hr
```

The outbox is what stops "the task was created but the event never left". Delivery is at-least-once, so every
subscriber needs an idempotency key — `TASK_DELETED` in particular depends on ordering today and has to say
so explicitly.

### Auth

core holds an RS256 **private** key and signs. Every other service verifies with the **public** key and never
calls core to do it. Today `protect` does a database lookup in identity's schema on every request; without
this change, every request to every service would become two.

---

## 6. The order, and where to stop

| # | Step | Worth doing even if we never split? |
| --- | --- | --- |
| 1 | Break the dependency cycles | **Yes** — clearer ownership. 2 of 3 done: `people↔workforce`, `work↔defects` |
| 2 | Declared consumption contracts | **Yes** — the surface is documented and enforced. **Done** |
| 3 | Stage B: role per service | **Yes** — isolation enforced by Postgres, not convention. **Built; SQL waiting to be applied** |
| 4 | Outbox for domain events | **Yes** — an event can no longer be lost on a commit |
| 5 | Idempotent subscribers | **Yes** — safe retries today |
| 6 | RS256 tokens | Only at extraction |
| 7 | `packages/platform`, monorepo layout | Only at extraction |
| 8 | Extract `integrations` | Only with a trigger |
| 9 | Extract the rest | Probably never |

Steps 1–5 are ordinary engineering that happen to be prerequisites. Steps 6–9 are the microservices project,
and they should wait for one of these:

- the instance's CPU or memory is pinned by calendar/Teams sync
- a tracker deploy is blocked by integration work, or the reverse
- a provider outage takes the tracker down with it
- someone else owns integrations and needs their own deploy cadence
- more than one team deploys this backend

Until one of those is true, splitting costs money and buys nothing. For one internal tracker with ~20 users
on one Postgres, none of them is true today.
