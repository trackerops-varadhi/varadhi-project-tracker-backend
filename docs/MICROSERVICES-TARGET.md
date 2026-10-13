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

### Stage B — one instance, one role per service ⬅ **the next database step**

```sql
-- illustrative; prepared as migrations, applied deliberately
CREATE ROLE svc_core        LOGIN PASSWORD :'pw';
GRANT USAGE ON SCHEMA identity, notify, work TO svc_core;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity, notify, work TO svc_core;

CREATE ROLE svc_hr          LOGIN PASSWORD :'pw';
GRANT USAGE ON SCHEMA people, workforce TO svc_hr;
...
```

The whole value in one line: **a service touching a schema it does not own gets `42501 permission denied`
instead of a quietly wrong answer.** Convention becomes enforcement. No new infrastructure, no new cost, and
it is a prerequisite for extraction that is worth having even if extraction never happens — it is the same
isolation `test:isolation` asserts, made true rather than tested.

The work: one role per service, scoped grants, `ALTER DEFAULT PRIVILEGES` so new tables inherit them, five
connection strings, and `platform/db.js` choosing the one for its service.

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
| 3 | Stage B: role per service | **Yes** — isolation enforced by Postgres, not convention |
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
