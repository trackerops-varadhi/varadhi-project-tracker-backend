-- ============================================================================
-- PRODUCTION VERIFY (read-only, ONE statement, ONE result table)
-- ----------------------------------------------------------------------------
-- The final check after the module scripts: is every object the application
-- reads actually there, and is anything in `public` that should not be.
-- It only SELECTs, and it reports table names and row counts, never data.
--
-- Row counts come through query_to_xml so a table that does not exist is
-- simply absent from the result instead of failing the whole statement.
--
-- HOW TO READ IT
--   module9 ... MISSING      something still has to be applied -- stop and say so
--   identity ... rows        the live tables the app reads
--   public leftover ...      a table in `public` that the cutover should have
--                            emptied out. After the cutover `public` must hold
--                            only the 7 legacy Prisma tables (ActivityLog,
--                            Document, Project, ProjectMember, Task, User,
--                            _prisma_migrations). Anything else means a
--                            pre-split process has run against this database
--                            and created a shadow table. A shadow with 0 rows
--                            is harmless but must be explained; a shadow with
--                            rows means writes went somewhere the app no
--                            longer reads.
--   users_role_check         must list admin, manager, employee, hr, qc
-- ============================================================================

-- Every object Module 9 and the QC role depend on, present or missing.
  SELECT 'module9 ' || x.label AS what,
         CASE WHEN x.ok THEN 'present' ELSE 'MISSING' END AS value
    FROM (VALUES
      ('people.employee_profiles.employee_code',
       to_regclass('people.employee_profiles') IS NOT NULL AND EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'people' AND table_name = 'employee_profiles'
            AND column_name = 'employee_code')),
      ('people.employee_profiles.aadhaar_encrypted',
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'people' AND table_name = 'employee_profiles'
                  AND column_name = 'aadhaar_encrypted')),
      ('people.candidate_resumes', to_regclass('people.candidate_resumes') IS NOT NULL),
      ('people.interviews.interviewer_id',
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'people' AND table_name = 'interviews'
                  AND column_name = 'interviewer_id')),
      ('workforce.leave_balances', to_regclass('workforce.leave_balances') IS NOT NULL),
      ('workforce.leave_requests.planning_type',
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'workforce' AND table_name = 'leave_requests'
                  AND column_name = 'planning_type')),
      ('workforce.daily_work_status', to_regclass('workforce.daily_work_status') IS NOT NULL),
      ('workforce.time_logs.attendance_status',
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'workforce' AND table_name = 'time_logs'
                  AND column_name = 'attendance_status')),
      ('identity.rate_limit_buckets', to_regclass('identity.rate_limit_buckets') IS NOT NULL)
    ) AS x(label, ok)

-- The identity tables the app authenticates against, with their row counts.
UNION ALL
  SELECT 'identity ' || table_name,
         (xpath('/row/c/text()',
                query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name),
                             false, true, '')))[1]::text || ' rows'
    FROM information_schema.tables
   WHERE table_schema = 'identity' AND table_type = 'BASE TABLE'

-- Anything in public that is not one of the 7 legacy Prisma tables.
UNION ALL
  SELECT 'public leftover ' || table_name,
         (xpath('/row/c/text()',
                query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name),
                             false, true, '')))[1]::text || ' rows'
    FROM information_schema.tables
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     AND table_name NOT IN ('ActivityLog', 'Document', 'Project', 'ProjectMember',
                            'Task', 'User', '_prisma_migrations')

UNION ALL
  SELECT 'users_role_check', pg_get_constraintdef(con.oid)
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE con.conname = 'users_role_check' AND n.nspname = 'identity'

ORDER BY 1;
