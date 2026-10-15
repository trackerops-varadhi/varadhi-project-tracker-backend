# Production deployment runbook — Varadhi backend

Branch: `refactor/phase1-module-boundaries`. Target: the existing Render web service
**`varadhi-project-tracker`** plus the production Supabase database.

> ## STATUS: THE SPLIT IS DONE. §§1–2 ARE HISTORY.
>
> This runbook was written before the cutover and read as though it were still pending.
> It is not. Checked 2026-10-13:
>
> ```
> GET https://varadhi-project-tracker.onrender.com/health/ready
> {"status":"ready","environment":"production",
>  "checks":{"database":{"ok":true},"schemas":{"ok":true,"count":8},
>            "pools":{"ok":true,"count":8}}}
> ```
>
> Production ran the split on **2026-10-05** and Module 9 (people) plus the QC role on
> **2026-10-09**. Eight module schemas exist, every pool connects, and every DDL script
> in `docs/` has been applied — `docs/SCHEMA.md` is the readable picture of what they
> produced.
>
> So **do not run §1 or §2 against production.** They describe a migration that has
> already happened, and re-running a cutover script is at best refused by its own
> ledger guard and at worst destructive. They are kept because the rehearsal method and
> the verification queries are still the right ones for the NEXT schema change.
>
> For an ordinary deploy today, start at **§3** and use **§6** and **§8**.

**Still true, and the reason the order below exists.** Nothing in `render.yaml` runs
migrations, and the API does not migrate at boot, so the schemas must exist before the
app starts (`src/platform/db.js` sets `search_path=<module>,extensions`, with no
`public`). For any FUTURE schema change: **a deploy before the database migration is an
outage, not a degraded mode.**

Order, always: **migrate → verify → deploy → verify → smoke test.**

**`render.yaml` is documentation, not configuration.** There is no Blueprint instance on
the account; the live service was created and is configured in the dashboard by hand.
Applying that file would create new services rather than adopt the live one.

Steps marked **[APPROVAL]** must not be executed without the account owner's explicit
go-ahead. Steps marked **[DBA]** need production database access.

---

## 0. Pre-flight gate

Do not start unless every line is true.

| Gate | How to confirm |
|---|---|
| Branch CI is green on the exact commit being deployed | GitHub Actions `backend-ci`, job `verify`, all steps pass |
| A production-shaped dump has been restored to a scratch database, migrated, and the full suite passed against it | Step 1 below — this is the plan's own gate, do not skip it |
| Production users are confirmed soft-deleted only | `SELECT count(*) FROM users WHERE status='inactive'` returns rows and no hard-delete path exists in code |
| The dev database's shadow tables are quarantined, or the cause is understood | `npm run test:isolation` shows no shadow warnings, or the warning is accepted knowingly |
| No stale pre-split clone can reach the production database | production credentials are not present in any developer `.env`; see §7 |
| A rollback decision-maker is online for the window | named person, reachable |
| Maintenance window agreed | the migration locks tables briefly; the API must be down or read-only |

---

## 1. Rehearse on a scratch copy  **[APPROVAL] [DBA]**

**Full procedure: `docs/MIGRATION-REHEARSAL.md`** — drift check with stop conditions,
before/after schema and row-count checks, the rollback drill, and a sign-off list. The
summary below is the shape; that document is what you actually follow.

Never rehearse on production itself.

**The exact, validated commands are in `docs/MIGRATION-REHEARSAL.md`** — including the
containerised client tools, because `psql`/`pg_dump`/`pg_restore` are **not on PATH** on
the development machine. The outline below is the shape only; do not copy it verbatim.

```bash
# 1. Read-only dump of production, taken by the DBA. Never from a developer laptop.
#    See rehearsal §2 for the containerised, version-matched (PG 17) invocation.

# 2. Restore into a throwaway database — rehearsal §3
docker compose up -d db                      # backend/docker-compose.yml, loopback only

# 3. Apply the split, baseline the ledgers, then migrate
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/varadhi_rehearsal \
  node src/config/migrate-schema-split.js --apply
DATABASE_URL=... npm run migrate:baseline
DATABASE_URL=... npm run migrate
DATABASE_URL=... npm run migrate:status      # expect 0 pending across 7 modules
DATABASE_URL=... npm run test:isolation      # expect 24 passed, 0 failed

# 4. Point a local API at the rehearsal database and run the suites
DATABASE_URL=... ENABLE_CRON=false npm start
npm run test:bugs && npm run test:project-deletion && npm run test:concurrency
npm run test:sibling-sync && npm run test:calendar && npm run test:teams
npm run test:push-retry
```

**Record the row counts before and after the split** (`users`, `projects`, `tasks`,
`notifications`, `documents`, `bugs`, `time_logs`, `leave_requests`). The split uses
`ALTER TABLE … SET SCHEMA`, which moves tables without copying rows, so every count must
be identical afterwards. Any difference stops the deployment.

Proceed only if all of the above passes. Delete the dump afterwards — it contains
production personal data.

---

## 2. Production database preparation  **[APPROVAL] [DBA]**

### 2.1 Backup

```bash
read -rs PROD_URL && export PROD_URL          # paste; never echoed, never in history

MSYS_NO_PATHCONV=1 docker run --rm -e PGURL="$PROD_URL" \
  -v "$(cygpath -w "$PWD")":/w -w /w postgres:17-alpine \
  sh -c 'pg_dump "$PGURL" --no-owner --no-privileges -Fc -f /w/prod-pre-split.dump'
```

`postgres:17-alpine` ships psql/pg_dump **17.11**, matching the Supabase server (**17.6**).
The local `C:\Program Files\PostgreSQL\18\bin` also works, but a custom-format dump written
by pg_dump 18 needs pg_restore 18+ — pick one toolchain and record which.

Also take a Supabase dashboard snapshot (Database → Backups) so there are two
independent restore paths. Verify the dump is restorable (`pg_restore --list` on it)
before touching anything.

### 2.2 Required extensions and settings

The baselines assume `gen_random_uuid()` is resolvable. On this database the extensions
live in the `extensions` schema, which is on every pool's `search_path`. Confirm:

```sql
SELECT n.nspname, p.proname FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.proname IN ('gen_random_uuid','uuid_generate_v4');
```

No other extension is required. Connection limits: the service opens **one pool per
module plus a default pool** (8 pools), each capped by `PER_MODULE_MAX` in
`src/platform/db.js`. On Supabase, connect through the **pooler** host, not the direct
host, and confirm the plan's connection ceiling covers 8 pools × max.

### 2.3 Apply the migration

```bash
# Against production, with the DBA present. The runner refuses the production ref
# outright, so this is deliberately a manual, explicit action.
node src/config/migrate-schema-split.js --apply     # creates 7 schemas, moves 29 tables,
                                                    # drops 31 cross-module FKs
npm run migrate:baseline                            # records 0001 per module, executes nothing
npm run migrate                                     # applies 0002 onward (rate_limit_buckets)
```

`schema-split-rollback.sql` is generated by the split script and records the original
foreign keys. Keep it with the backup.

### 2.4 Confirm the database is ready before deploying

```bash
npm run migrate:status      # 7 modules, 0 pending
npm run test:isolation      # 24 passed, 0 failed, no shadow warnings
```

```sql
-- 7 schemas, 30 app tables, 0 cross-schema FKs, and the legacy Prisma tables intact
SELECT nspname FROM pg_namespace
 WHERE nspname IN ('identity','work','defects','notify','integrations','files','workforce');
SELECT table_schema, count(*) FROM information_schema.tables
 WHERE table_schema IN ('identity','work','defects','notify','integrations','files','workforce')
   AND table_type='BASE TABLE' GROUP BY 1 ORDER BY 1;
SELECT count(*) FROM pg_constraint con
  JOIN pg_class c ON c.oid=con.conrelid  JOIN pg_namespace n  ON n.oid=c.relnamespace
  JOIN pg_class f ON f.oid=con.confrelid JOIN pg_namespace fn ON fn.oid=f.relnamespace
 WHERE con.contype='f' AND n.nspname <> fn.nspname
   AND n.nspname IN ('identity','work','defects','notify','integrations','files','workforce');
SELECT table_name FROM information_schema.tables
 WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1;  -- expect only the
 -- 7 legacy Prisma tables: ActivityLog, Document, Project, ProjectMember, Task, User,
 -- _prisma_migrations. Anything else means a pre-split process has run.
```

---

## 3. Render service configuration

From `render.yaml` (the live service may override values in the dashboard — the dashboard
wins):

| Setting | Value | Source |
|---|---|---|
| Runtime | `node` | `render.yaml` |
| Build command | `npm install` | `render.yaml` |
| Start command | `npm start` → `node src/server.js` | `package.json` |
| Health check path | `/health` | `render.yaml` — liveness, no database |
| Instances | **one** | see `RATE_LIMIT_STORE` below |

### Environment variables

Required, by name only — never paste values into tickets, commits or chat:

| Variable | Where the value comes from | Notes |
|---|---|---|
| `NODE_ENV` | `production` | turns on SSL for the pools |
| `DATABASE_URL` | Supabase → pooler connection string | **verify it points at Supabase, not the Render `varadhi-db` declared in `render.yaml`** |
| `JWT_SECRET` | Render-generated | rotating it logs everyone out once; see §4 ordering |
| `ENCRYPTION_KEY` | dashboard, `sync:false` | **set it explicitly before rotating `JWT_SECRET`** |
| `FRONTEND_URL` | the deployed Vercel origin | CORS allow-list and deep-link base |
| `API_PUBLIC_URL` | this service's public URL | OAuth redirect URIs must match exactly |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | `npx web-push generate-vapid-keys` | both keys or push silently no-ops |
| `GOOGLE_CLIENT_ID`/`_SECRET`, `MS_CLIENT_ID`/`_SECRET` | provider consoles | absent ⇒ calendar runs against a mock |
| `ENABLE_CRON` | `true` or `false` | **decide before deploying — see §5** |
| `NOTIFICATION_ACTION_TTL_HOURS` | `72` | optional |
| `RATE_LIMIT_STORE` | unset, or `postgres` | set to `postgres` only after `identity.rate_limit_buckets` exists; **mandatory before a second instance** |
| `MULTI_INSTANCE` | unset | with the memory store this refuses to boot, by design |

---

## 4. Secrets and rotation order

Rotation is a separate operation from this deployment. If both are happening, deploy
first, confirm healthy, then rotate.

1. **`ENCRYPTION_KEY` first.** `utils/crypto.js` falls back to deriving a key from
   `JWT_SECRET`. Rotating `JWT_SECRET` while that fallback is in use makes every stored
   calendar OAuth token and Teams webhook URL **permanently undecryptable**. Set
   `ENCRYPTION_KEY` (and `NOTIFICATION_ACTION_SECRET` if used) to the value currently
   derived, then rotate.
2. Supabase service-role key.
3. SMTP app password.
4. `JWT_SECRET` — logs every user out once; acceptable, announce it.
5. VAPID pair — invalidates push subscriptions; browsers re-subscribe on next visit.
6. `DATABASE_URL` — the genuinely disruptive one. Schedule separately, never during a
   migration.

`.env.dev.backup` remains in two commits of git history. Rotation, not history rewriting,
is what closes that exposure. **Never reuse a dev credential in production.**

---

## 5. Decide `ENABLE_CRON` before deploying

`render.yaml` currently sets `ENABLE_CRON=true`. On the first tick after deploy the
reminder sweeps scan all live work and dispatch due-tomorrow, overdue and escalation
notifications. If production carries a backlog of overdue tasks, that is a burst of
in-app rows and **real web-push** to real users in one go. Email is currently inert (the
notification engine looks for an export `sendEmail.js` does not provide).

Pick one, in writing:

- **Deploy with `ENABLE_CRON=false`**, clear or accept the backlog, then enable
  deliberately and watch the first tick. Recommended.
- Deploy with cron on, having first measured the backlog and accepted the burst.

Leader election means only one instance sweeps, so this is about volume, not duplication.

---

## 6. Deployment sequence

1. **[APPROVAL]** Confirm §0 gate and the §1 rehearsal result.
2. Announce the maintenance window.
3. **[DBA]** Take the backup (§2.1) and verify it is restorable.
4. Put the API into maintenance (scale to zero, or accept downtime for the window).
5. **[DBA]** Apply the migration (§2.3).
6. **[DBA]** Run the readiness confirmations (§2.4). **Stop and roll back if any fail.**
7. Set/confirm the Render environment variables (§3), including the `ENABLE_CRON`
   decision.
8. Deploy the branch commit. Watch the deploy log for `✓ Ready in`, the pool count and
   `store ready:`.
9. Verify health (§8).
10. Run the smoke tests (§8).
11. Verify the frontend end to end (§8).
12. Watch logs and error tracking for 30 minutes before declaring success.

### Frontend compatibility

No frontend change is required: the route surface is byte-identical to pre-refactor
(117 routes, same methods, paths and role gates). Two frontend facts matter:

- The Vercel **same-origin API proxy rewrite** must be present in `next.config.mjs`. It
  was silently dropped by an auto-merge once and restored on 2026-10-03. Without it every
  API call 404s, and cross-origin cookies break login.
- The frontend must send `X-Requested-With` on mutations. Its axios client does this by
  default; an API tool that omits it gets a deliberate `403 CSRF_HEADER_MISSING`.

---

## 7. Preventing a second split-brain

The dev database was polluted on 2026-10-03 by a **pre-split backend** pointed at it: its
pool sets no `search_path`, so it worked in `public`, and `main` still has the legacy
`db:migrate*` scripts, no `split-guard.js`, and boot migrations. The same mistake against
production would fork production data.

Before and after this deployment:

- Production credentials live **only** in Render. Not in any developer `.env`, not in a
  shared password note used for dev.
- Back-port `split-guard.js` to `main`, or retire the legacy scripts there too.
- After deploying, confirm only the Render service connects:
  `SELECT application_name, client_addr, backend_start FROM pg_stat_activity WHERE datname = current_database();`

---

## 8. Post-deployment validation

```bash
curl -s https://<service>/health            # 200, {"status":"ok"}
curl -s https://<service>/health/ready      # 200, database ok, schemas 7, pools 7
```

Then, as a real user in the deployed frontend:

1. **Log in** — confirms cookies, CSRF, the session lookup and `identity`.
2. **Load the dashboard and reports** — confirms `insights` reading through `work`.
3. **Open a project, then its Tasks and Bugs tabs** — confirms `work` and `defects`.
4. **Create a task, comment, change its status** — confirms writes plus notifications.
5. **Open Documents** — confirms `files` and Supabase storage.
6. **Log a time entry / leave request** — confirms `workforce`.
7. **Open the notification bell** — confirms `notify`.
8. **Delete a throwaway project** — confirms the `project.deleted` fan-out across four
   modules. Do this on a project created for the purpose.

Log checks — `grep` the Render log for:

| Pattern | Means |
|---|---|
| `42P01` / `does not exist` | a query resolved against the wrong schema |
| `0-of-7` or `schemas":{"ok":false` | the migration did not complete |
| `RATE LIMIT STORE UNUSABLE` | `RATE_LIMIT_STORE=postgres` without migration 0002 |
| `supabaseUrl is required` | `SUPABASE_URL` missing — the process exits |
| `MIGRATION FAILED` | a migration ran at deploy time, which should be impossible |

---

## 9. Rollback

| Situation | Action |
|---|---|
| Migration fails midway | The split script runs per-statement; restore from the §2.1 dump. Do **not** hand-patch half a split. |
| Migration succeeded, app unhealthy | Re-deploy the previous commit **only if** it is a pre-split build — it expects tables in `public`, which no longer holds them. Safer: fix forward, or restore the dump and redeploy the old build together. |
| Cross-schema errors in logs | Capture the statement, roll back the deploy, fix the query. Data is intact: the FKs were dropped, not the rows. |
| Notification burst from cron | Set `ENABLE_CRON=false` and redeploy; already-sent push cannot be recalled. |
| Need the old foreign keys back | `schema-split-rollback.sql`, generated by the split script. |

**The migration and the code are a matched pair.** Pre-split code needs tables in
`public`; this code needs the module schemas. Rolling back one without the other does not
work — plan rollback as "restore dump **and** redeploy previous build".

---

## 10. Known risks

| Risk | Severity | Mitigation |
|---|---|---|
| Deploying before migrating | **outage** | this runbook's ordering; `/health/ready` reports it immediately |
| A pre-split clone reaching production | **data fork** | §7 |
| Reminder burst on first cron tick | user-visible | §5 |
| `JWT_SECRET` rotated before `ENCRYPTION_KEY` is set | **permanent data loss** (tokens, webhook URLs) | §4 ordering |
| Supabase connection ceiling vs 8 pools | degraded | §2.2, use the pooler host |
| `RATE_LIMIT_STORE=postgres` before migration 0002 | boot failure | set it after migrating |
| Second instance with the memory store | refuses to boot (by design) | set `RATE_LIMIT_STORE=postgres` first |
