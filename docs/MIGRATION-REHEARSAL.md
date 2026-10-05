# Migration rehearsal — production dump → disposable scratch database

Purpose: prove, on a copy, that the schema split and the modular backend work against
**production-shaped data** before production is touched. This is release Blocker 2, and
it is the only evidence that makes "production data is safe" a statement rather than a
hope.

**Nothing in this procedure touches production except one read-only `pg_dump`,** taken by
whoever holds production credentials. Every other step runs against a local throwaway
database.

Roles: **[DBA]** needs production read access · **[DEV]** runs locally · **[APPROVAL]**
needs the account owner.

---

## 0. What the code expects (verified against the migration files)

The split moves exactly **29 business tables + 1 sequence** out of `public`, and drops
**31 cross-module foreign keys**. Verified 2026-10-05 by diffing the generated rollback
script against the seven `0001_baseline.js` files — **29/29 identical**, no drift between
the two halves of the migration code.

| Schema | Tables (must already exist in `public` before the split) |
|---|---|
| `identity` | `users`, `user_sessions`, `user_tokens` |
| `work` | `projects`, `project_members`, `tasks`, `comments` |
| `defects` | `bugs`, `bug_comments`, `bug_attachments`, `bug_activity_logs`, `bug_sla_rules` |
| `notify` | `notifications`, `notification_preferences`, `notification_snoozes`, `notification_action_log`, `notification_logs`, `push_subscriptions`, `push_delivery_retries` |
| `integrations` | `calendar_connections`, `calendar_sync_settings`, `calendar_event_links`, `calendar_sync_conflicts`, `teams_webhooks`, `teams_delivery_log` |
| `files` | `documents`, `folders` |
| `workforce` | `leave_requests`, `time_logs` |

Sequence: `public.bug_number_seq` → `defects.bug_number_seq` (standalone, moved
explicitly — it is not column-owned, so it would not follow its table).

**Never moved, never touched:** `ActivityLog`, `Document`, `Project`, `ProjectMember`,
`Task`, `User`, `_prisma_migrations`. They are on an explicit leave-list in the script,
and foreign keys purely between them are classified "legacy, untouched".

The 31 dropped foreign keys, by target:

| Target | Count | Notes |
|---|---|---|
| `users` | 25 | 13 `CASCADE`, 12 `SET NULL` |
| `projects` | 4 | `teams_webhooks.project_id` and `time_logs.project_id` were `CASCADE`; `documents.project_id` and `bugs.project_id` were `SET NULL` |
| `tasks` | 1 | `bugs.linked_task_id` `SET NULL` |
| `documents` | 1 | `bug_attachments.document_id` `SET NULL` |

The four `projects` keys and the `tasks` key are the cleanups now performed in
application code by the `project.deleted` event (`scripts/project-deletion.test.js`,
55 assertions). The 25 `users` keys were dead code in practice — the application
soft-deletes users — which **step 3 confirms on real data**.

---

## 1. Read-only drift check **[DBA]**

Run this against production **before** taking a dump. It is the cheapest possible
stop/go, and it answers the question baselining cannot: does production actually contain
everything the baselines assume?

**`docs/drift-check.sql` is the packaged version of everything in this section** — 29
tables, 334 columns, eight numbered queries, generated from the baselines. It contains
**zero write statements** (asserted) and every table reference is `public.`-qualified.

It was validated on 2026-10-05 by running it read-only against the development database,
which is where it earned its keep: it exited 0 with no SQL errors, and query 5 correctly
*fired* (dev is already split, so the 7 module schemas exist). Two defects were found and
fixed in that run — catalog relations had been wrongly `public.`-qualified, and the
earlier drafts assumed client tools that are not installed here.

```bash
read -rs PROD_URL && export PROD_URL      # paste; nothing is echoed or stored

MSYS_NO_PATHCONV=1 docker run --rm -e PGURL="$PROD_URL" \
  -v "$(cygpath -w "$PWD")":/w -w /w postgres:17-alpine \
  sh -c 'psql "$PGURL" -v ON_ERROR_STOP=1 -f docs/drift-check.sql' \
  > drift-report-$(date +%F).txt 2>&1

grep -c ERROR drift-report-$(date +%F).txt     # expect 0
```

Keep `drift-report-*.txt` with the release ticket; queries 7 and 8 are the before-picture
the post-migration counts are compared against.

```sql
-- A. Which expected tables are MISSING from production? Expect zero rows.
SELECT unnest(ARRAY[
 'users','user_sessions','user_tokens','projects','project_members','tasks','comments',
 'bugs','bug_comments','bug_attachments','bug_activity_logs','bug_sla_rules',
 'notifications','notification_preferences','notification_snoozes','notification_action_log',
 'notification_logs','push_subscriptions','push_delivery_retries','calendar_connections',
 'calendar_sync_settings','calendar_event_links','calendar_sync_conflicts','teams_webhooks',
 'teams_delivery_log','documents','folders','leave_requests','time_logs']) AS missing_table
EXCEPT
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

-- B. The sequence. Expect a non-null regclass.
SELECT to_regclass('public.bug_number_seq') AS sequence_present;

-- C. Anything UNEXPECTED in public (neither an owned table nor a legacy Prisma one).
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
   AND table_name NOT IN (
 'users','user_sessions','user_tokens','projects','project_members','tasks','comments',
 'bugs','bug_comments','bug_attachments','bug_activity_logs','bug_sla_rules',
 'notifications','notification_preferences','notification_snoozes','notification_action_log',
 'notification_logs','push_subscriptions','push_delivery_retries','calendar_connections',
 'calendar_sync_settings','calendar_event_links','calendar_sync_conflicts','teams_webhooks',
 'teams_delivery_log','documents','folders','leave_requests','time_logs',
 'ActivityLog','Document','Project','ProjectMember','Task','User','_prisma_migrations');

-- D. Do the module schemas already exist? Expect zero rows (production is pre-split).
SELECT nspname FROM pg_namespace
 WHERE nspname IN ('identity','work','defects','notify','integrations','files','workforce');

-- E. Who owns the tables? SET SCHEMA requires ownership. Expect one owner, the role
--    the migration will run as.
SELECT tableowner, count(*) FROM pg_tables WHERE schemaname = 'public' GROUP BY 1;

-- F. Baseline row counts, to compare after the split. Keep this output.
SELECT 'users' t, count(*) FROM users UNION ALL SELECT 'projects', count(*) FROM projects
UNION ALL SELECT 'tasks', count(*) FROM tasks UNION ALL SELECT 'comments', count(*) FROM comments
UNION ALL SELECT 'project_members', count(*) FROM project_members
UNION ALL SELECT 'notifications', count(*) FROM notifications
UNION ALL SELECT 'documents', count(*) FROM documents UNION ALL SELECT 'bugs', count(*) FROM bugs
UNION ALL SELECT 'time_logs', count(*) FROM time_logs
UNION ALL SELECT 'leave_requests', count(*) FROM leave_requests
UNION ALL SELECT 'user_sessions', count(*) FROM user_sessions
UNION ALL SELECT 'user_tokens', count(*) FROM user_tokens ORDER BY 1;
```

### Stop conditions — any one of these halts the release

| Query | Stop if | Why it matters |
|---|---|---|
| A | **any row returned** | A table the baselines assume is missing. `migrate:baseline` would record `0001` as applied and nothing would ever create it → `42P01` at runtime. Resolve by creating the object *before* baselining, or by writing a real `0002`-style migration for it |
| B | `NULL` | `bugs.bug_number` has no sequence to default from; inserts fail |
| C | **any row returned** | An unknown table in `public`. If it is a *shadow* of a module table, a pre-split process has written to production and the data may be forked — investigate before migrating |
| D | **any row returned** | Something has already created module schemas in production. Stop and establish what and when |
| E | more than one owner, or not the migrating role | `ALTER TABLE … SET SCHEMA` needs ownership; the split would abort mid-way (it is transactional, so it rolls back, but find out first) |
| F | — | Not a stop; this is the before-picture for step 5 |

The split script performs A, C, D and E itself as a pre-flight and refuses to run if any
fail (`PRE-FLIGHT FAILED — nothing was changed`). Running the SQL first means you learn it
without invoking the migration tool at all.

### Safe production pre-flight, no changes **[DBA]**

The split script's **dry run is genuinely read-only** — it returns before writing the
rollback file and before `BEGIN`, having issued only `SELECT`s:

```bash
# No --apply. Prints the plan, the pre-flight result, and the exact FKs it would drop.
DATABASE_URL="<production>" node src/config/migrate-schema-split.js
```

Expected output: `pre-flight: OK (all 29 owned tables present, owned by this role,
CREATE allowed)`, a foreign-key split of `N total / M stay (within a module) / K stay
(legacy) / 31 to DROP`, and `DRY RUN — nothing was changed.`

---

## 2. Take the dump **[DBA]**

### Client tools — read this before running anything

`psql`, `pg_dump` and `pg_restore` are **not on PATH** on the development machine
(verified 2026-10-05). Two options, in order of preference:

**a) Containerised, version-matched (recommended).** Supabase runs **PostgreSQL 17.6**;
`postgres:17-alpine` provides psql/pg_dump **17.11** — same major version, so dumps and
restores are unambiguous.

```bash
# Git Bash on Windows needs MSYS_NO_PATHCONV=1, or it rewrites container paths
# (/w becomes W:/ and docker refuses the command).
PG="MSYS_NO_PATHCONV=1 docker run --rm -i -v $(cygpath -w "$PWD"):/w -w /w postgres:17-alpine"
```

**b) The local installs.** `C:\Program Files\PostgreSQL\18\bin` and `...\16\bin` exist.
**Prefer 17 over 18**: `pg_dump` 18 can read a 17 server, but a custom-format dump it
writes needs `pg_restore` 18+, which silently couples the backup to one toolchain. If you
use 18 for both dump and restore, that is fine — just be consistent and record which.

### Never put the production URL on a command line

It would land in shell history and in `ps` output. Put it in a file the shell reads:

```bash
read -rs PROD_URL        # paste, press enter; nothing is echoed
export PROD_URL
```

### The dump

```bash
MSYS_NO_PATHCONV=1 docker run --rm -e PGURL="$PROD_URL" \
  -v "$(cygpath -w "$PWD")":/w -w /w postgres:17-alpine \
  sh -c 'pg_dump "$PGURL" --no-owner --no-privileges -Fc -f /w/prod-backup.dump'

# Prove it is restorable BEFORE relying on it
MSYS_NO_PATHCONV=1 docker run --rm -v "$(cygpath -w "$PWD")":/w -w /w \
  postgres:17-alpine sh -c 'pg_restore --list /w/prod-backup.dump | head -20'
```

A dump that has never been listed is not a backup. Record its size, SHA256 and the time
it was taken.

The dump contains production personal data. Keep it on an encrypted volume, do not
commit it, and delete it when the rehearsal is signed off.

---

## 3. Restore into a disposable database **[DEV]**

The scratch database runs in the compose stack's Postgres, which binds to **127.0.0.1
only** — it is not reachable from the network.

```bash
cd backend
docker compose up -d db          # postgres:17-alpine on 127.0.0.1:55432

# Create the database. `docker compose exec` avoids needing a client on the host.
docker compose exec -T db psql -U postgres -c "CREATE DATABASE varadhi_rehearsal"

# Restore into it. The container reaches the db service by name on the compose network.
MSYS_NO_PATHCONV=1 docker run --rm --network varadhi-local_default \
  -v "$(cygpath -w "$PWD")":/w -w /w postgres:17-alpine \
  sh -c 'pg_restore -h db -U postgres -d varadhi_rehearsal \
           --no-owner --no-privileges /w/prod-backup.dump'
# PGPASSWORD=postgres if it prompts; the compose credentials are throwaway.

# From the host, the application and the npm scripts use:
export SCRATCH="postgresql://postgres:postgres@127.0.0.1:55432/varadhi_rehearsal"
```

Confirm the compose network name first with `docker network ls | grep varadhi` — it is
derived from the project name (`varadhi-local`), so it is `varadhi-local_default` unless
compose was invoked differently.

Confirm the restore matches production, then **record the before-picture**:

Shorthand used from here on — `sql '<statement>'` and `sqlf <file>` against the scratch
database, with no client needed on the host:

```bash
sql()  { docker compose exec -T db psql -U postgres -d varadhi_rehearsal -c "$1"; }
sqlf() { docker compose exec -T db psql -U postgres -d varadhi_rehearsal -f "/w/$1"; }
# sqlf needs the repo mounted into the db service; if it is not, use:
#   docker compose exec -T db psql -U postgres -d varadhi_rehearsal < path/to/file.sql
```

```bash
sql "SELECT table_name FROM information_schema.tables
  WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1" > before-tables.txt
sql "SELECT conname, conrelid::regclass, confrelid::regclass
  FROM pg_constraint WHERE contype='f' ORDER BY 1" > before-fks.txt
# the row counts from step 1 query F, run again here — they must match production
```

**Confirm the soft-delete claim on real data** (the premise for dropping 25 user FKs):

```sql
SELECT status, count(*) FROM users GROUP BY 1;     -- expect 'inactive' rows to exist
```

If production contains *no* inactive users and the app has no hard-delete path, the user
cascades were dead code, as assumed. Record the result either way.

---

## 4. Run the migration on the scratch copy **[DEV]**

```bash
node src/config/migrate-schema-split.js                      # dry run first; read the plan
node src/config/migrate-schema-split.js --apply              # loopback is permitted
# ^ writes schema-split-rollback.sql — KEEP IT, it is this database's rollback

npm run migrate:baseline                                     # records 0001, executes nothing
npm run migrate                                              # applies 0002 only
npm run migrate:status                                        # expect 0 pending x 7 modules
```

All commands read `DATABASE_URL`, so run them with `DATABASE_URL="$SCRATCH"` exported or
prefixed. The apply is a single transaction: it either completes or leaves nothing changed.

---

## 5. After-checks — schema and data **[DEV]**

```bash
npm run test:isolation      # expect 24 passed, 0 failed, and NO shadow warnings
```

```sql
-- 1. 7 schemas exist
SELECT nspname FROM pg_namespace WHERE nspname IN
 ('identity','work','defects','notify','integrations','files','workforce');          -- 7 rows

-- 2. 30 app tables (29 moved + rate_limit_buckets) plus 7 ledgers
SELECT table_schema, count(*) FROM information_schema.tables
 WHERE table_schema IN ('identity','work','defects','notify','integrations','files','workforce')
   AND table_type='BASE TABLE' GROUP BY 1 ORDER BY 1;

-- 3. public now holds ONLY the 7 legacy Prisma tables
SELECT table_name FROM information_schema.tables
 WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1;                 -- 7 rows

-- 4. zero cross-schema foreign keys
SELECT count(*) FROM pg_constraint con
  JOIN pg_class c ON c.oid=con.conrelid  JOIN pg_namespace n  ON n.oid=c.relnamespace
  JOIN pg_class f ON f.oid=con.confrelid JOIN pg_namespace fn ON fn.oid=f.relnamespace
 WHERE con.contype='f' AND n.nspname <> fn.nspname
   AND n.nspname IN ('identity','work','defects','notify','integrations','files','workforce');

-- 5. within-module keys and cascades survived
SELECT count(*) FILTER (WHERE true) AS within_fks,
       count(*) FILTER (WHERE confdeltype='c') AS cascades
  FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE con.contype='f' AND n.nspname IN
  ('identity','work','defects','notify','integrations','files','workforce');          -- 21 / 15

-- 6. the sequence moved and still drives bug numbers
SELECT to_regclass('defects.bug_number_seq'), to_regclass('public.bug_number_seq');   -- set, NULL

-- 7. ROW COUNTS — identical to step 1 query F and step 3. ALTER TABLE SET SCHEMA moves
--    tables without copying rows, so any difference is a defect. This is the data-safety
--    check; a mismatch stops the release.
SELECT 'users' t, count(*) FROM identity.users UNION ALL
SELECT 'projects', count(*) FROM work.projects UNION ALL
SELECT 'tasks', count(*) FROM work.tasks UNION ALL
SELECT 'comments', count(*) FROM work.comments UNION ALL
SELECT 'project_members', count(*) FROM work.project_members UNION ALL
SELECT 'notifications', count(*) FROM notify.notifications UNION ALL
SELECT 'documents', count(*) FROM files.documents UNION ALL
SELECT 'bugs', count(*) FROM defects.bugs UNION ALL
SELECT 'time_logs', count(*) FROM workforce.time_logs UNION ALL
SELECT 'leave_requests', count(*) FROM workforce.leave_requests UNION ALL
SELECT 'user_sessions', count(*) FROM identity.user_sessions UNION ALL
SELECT 'user_tokens', count(*) FROM identity.user_tokens ORDER BY 1;
```

| Check | Expected |
|---|---|
| Schemas | 7 |
| App tables | 30 total across the 7 schemas (+1 `pgmigrations` each) |
| `public` | exactly the 7 legacy Prisma tables |
| Cross-schema FKs | 0 |
| Within-module FKs / cascades | 21 / 15 |
| Sequence | `defects.bug_number_seq` set, `public.bug_number_seq` NULL |
| **Row counts** | **identical before and after, every table** |
| `test:isolation` | 24 / 0, no shadow warnings |

---

## 6. Run the application against the rehearsal database **[DEV]**

```bash
DATABASE_URL="$SCRATCH" ENABLE_CRON=false RATE_LIMIT_STORE=postgres npm start
curl -s localhost:5000/health/ready     # database ok, schemas 7, pools 7
```

Then the suites, against production-shaped data — this is the part a synthetic dev
database cannot tell you:

```bash
npm run test:isolation && npm run test:bugs && npm run test:project-deletion
npm run test:concurrency && npm run test:sibling-sync && npm run test:calendar
npm run test:teams && npm run test:push-retry
```

Do **not** run `npm run test:ops` (it calls `runRemindersNow()`). Do not enable cron.

Manual checks that exercise data the suites cannot create:

| Check | Proves |
|---|---|
| Log in as a real (copied) account | `identity`, cookies, CSRF, session lookup |
| Dashboard + the four reports render with sensible numbers | `insights` reading through `work` |
| An **existing** calendar connection still shows as connected, or a Teams webhook still renders its masked URL | **the encryption key still decrypts production ciphertext** — the single highest-value check in the rehearsal |
| Open a project with real tasks, comments, documents, bugs | `work`, `files`, `defects` |
| A pending push-notification action link still validates | `NOTIFICATION_ACTION_SECRET` derivation unchanged |

---

## 7. Rehearse the rollback too **[DEV]**

A rollback plan that has never been run is a guess.

```bash
docker compose exec -T db psql -U postgres -d varadhi_rehearsal < schema-split-rollback.sql
```

Then confirm you are back to the before-picture: `public` holds all 29 tables again, the
module schemas are gone, `before-fks.txt` matches the current FK list, and the row counts
still match. Finally, confirm the **pre-split** build runs against it:

Use a **separate worktree**, not `git stash` + `checkout` — stashing uncommitted release
work and switching branches mid-rehearsal is how you lose it:

```bash
git worktree add ../varadhi-presplit e3e9026    # the commit main currently points at
cd ../varadhi-presplit && npm install
DATABASE_URL="$SCRATCH" ENABLE_CRON=false npm start   # must boot and serve
# when done:
cd ../backend && git worktree remove ../varadhi-presplit
```

This is what proves the rollback story end to end: restore → reverse → old build works.

---

## 8. Sign-off

Record and attach to the release ticket:

- [ ] Drift check (step 1 A–E): all clear
- [ ] Dump taken and proven restorable; date and SHA noted
- [ ] Split applied on scratch; pre-flight `OK`; rollback file kept
- [ ] `migrate:status`: 0 pending × 7
- [ ] After-checks table: every row as expected
- [ ] **Row counts identical before and after**
- [ ] Soft-delete finding recorded
- [ ] Suites: actual numbers, not "passed"
- [ ] Existing encrypted data decrypts
- [ ] Rollback rehearsed, old build boots on the reversed database
- [ ] Scratch database and dump destroyed

Teardown: `docker compose down -v` and delete the dump.

---

## 9. What this rehearsal cannot prove

- **Production timing.** A free-tier Supabase instance under load may take longer to
  acquire the locks `ALTER TABLE … SET SCHEMA` needs. Note the scratch duration as a floor,
  not an estimate, and keep the maintenance window generous.
- **Production connection limits.** The service opens 18 connections (7 × 2 + 4); the
  scratch Postgres is not Supabase's pooler.
- **Concurrent writes.** The scratch copy is idle; production is not. The split takes brief
  exclusive locks, so the API must be down or read-only during the real run.
