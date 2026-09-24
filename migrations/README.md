# Migrations

Versioned, per-module database migrations on [node-pg-migrate](https://github.com/salsita/node-pg-migrate).

```
migrations/
  identity/0001_baseline.js
  work/0001_baseline.js
  defects/0001_baseline.js
  notify/0001_baseline.js
  integrations/0001_baseline.js
  files/0001_baseline.js
  workforce/0001_baseline.js
```

## Commands

```bash
npm run migrate              # apply everything pending, all modules
npm run migrate:status       # what is applied, what is pending, per module
npm run migrate:baseline     # mark 0001 applied WITHOUT running it
npm run migrate:down         # roll back one migration per module (LOCAL ONLY)

node src/config/migrate-runner.js up   --module notify
node src/config/migrate-runner.js down --module notify --count 1
node src/config/migrate-runner.js up   --allow-remote        # hosted dev
```

## One ledger per module

Each module keeps its own version history in its own schema — `identity.pgmigrations`,
`work.pgmigrations`, and so on — rather than a single shared `public.pgmigrations`.

A module owns its migration history exactly as it owns its tables. A module can be
migrated alone without coordinating with six others, and when one is eventually
extracted it takes its directory *and* its history with it, with nothing to untangle
from a shared table.

The cost is that "what version is this database at?" has seven answers. `migrate:status`
prints all seven. That is the honest shape of a system with seven independently
deployable owners.

**The sharp edge:** a migration must never drop the schema holding its own ledger.
`DROP SCHEMA notify CASCADE` takes `notify.pgmigrations` with it, and node-pg-migrate
then fails deleting the row for the migration it just reversed — leaving the database
migrated while reporting the rollback as *failed*. Baseline `down` therefore drops the
module's **tables**, not its schema. This is not hypothetical; the first version of the
baseline did exactly this and the test suite caught it.

## The 0001 baselines

Each `0001_baseline.js` is the exact post-split shape of that module's schema, captured
with `pg_dump` from a database provisioned by the legacy path and verified against dev.

They are **raw SQL**, not `pgm.createTable(...)`. A baseline's only job is to reproduce
an existing schema exactly; hand-translating 141 statements into the builder API would
introduce drift in the one place drift is most expensive. **Later migrations should use
the builder** — the baseline is a transcript, not a style guide.

No baseline declares a cross-module foreign key. The 31 that crossed a module boundary
were dropped by the schema split deliberately, because a foreign key cannot span two
services. Within-module foreign keys and cascades are preserved exactly.

## Existing databases: baseline, don't migrate

dev and production already hold these 29 tables. Running `0001` against them would fail
on the first `CREATE TABLE`. Run this instead:

```bash
npm run migrate:baseline
```

which writes the ledger row **without executing the body**, so the database is recorded
as being at `0001` and migration `0002` onward applies normally. It refuses to touch a
module whose ledger already has rows, so it cannot paper over real history.

## Fresh database

```bash
npm run migrate              # 7 schemas, 29 tables, 21 within-module FKs, 15 cascades
```

That is the whole sequence, and it is now the only one. The legacy `db:migrate*` npm
scripts have been removed and the API no longer runs migrations at boot, so nothing
applies DDL outside this ledger.

The era scripts themselves remain in `src/config/` as guarded history — each refuses to
run against a split database (`split-guard.js`) — and `migrate-schema-split.js` stays
because production is still pre-split and that is the tool which moves it. The one
exception to "nothing outside the ledger" is `migrate-sessions.js`, whose one-time
backfill is still covered by `scripts/migration-compat.test.js`.

## Safety

| Target | `up` | `down` | `status` |
|---|---|---|---|
| loopback (`127.0.0.1`) | yes | yes | yes |
| hosted dev | `--allow-remote` | **refused** | yes |
| any other hosted | **refused** | **refused** | yes |
| production | **refused, no override** | **refused** | **refused** |

`down` is refused on every hosted database regardless of flags — rolling back a baseline
drops every table the module owns. Roll a hosted database back from a backup, deliberately.

## Tests

```bash
npm run test:migrate-system   # 68 assertions, disposable local database only
```

Covers fresh migration and order, the 29/21/15 invariants, zero cross-module FKs, zero
shadow tables, per-module ledgers, idempotency, rollback, the ledger surviving rollback,
round-trip, a deliberately failing migration leaving its module untouched with no ledger
row, baseline marking without executing, and every target guard above.

The suite drops and recreates schemas, so it refuses any non-loopback host before running
a single statement.

## Note on `src/config/schema.sql`

It is an empty tombstone and stays that way. Maintaining it alongside `migrate.js` as a
second source of truth is what broke password reset and document upload in production.
Do not revive it.
