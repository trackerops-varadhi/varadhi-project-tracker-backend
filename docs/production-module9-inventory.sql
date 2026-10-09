-- ============================================================================
-- MODULE 9 INVENTORY (read-only, ONE statement, ONE result table)
-- ----------------------------------------------------------------------------
-- Lists what the `people` and `workforce` schemas actually contain, so the
-- remaining DDL can be derived from the database instead of from an assumed
-- history. It only SELECTs, and it names tables and columns -- never a row of
-- data.
--
-- Written 2026-10-09. Production's ledger says identity/0003_hr_role,
-- workforce/0002_leave_policy and workforce/0003_work_status were applied in
-- one transaction at 12:29:31, while people/0002 and people/0003 -- which the
-- same script writes inside that same transaction -- are absent. One run
-- cannot produce both, so the ledger is not trustworthy here and the columns
-- are the only reliable evidence.
--
-- WHAT EACH PENDING MIGRATION LEAVES BEHIND, to read the result against:
--   people/0002     employee_profiles gains employee_code, gender, dob,
--                   personal_email, aadhaar_encrypted, reporting_manager_id ...
--   people/0003     candidates and interviews gain columns, and a new table
--                   people.candidate_resumes appears
--   workforce/0002  leave_requests gains planning_type, day_type, ... and a new
--                   table workforce.leave_balances appears
--   workforce/0003  time_logs gains columns and a new table
--                   workforce.daily_work_status appears
-- ============================================================================

  SELECT 'ledger people' AS kind, name AS obj, run_on::text AS columns
    FROM people.pgmigrations

-- One row per table, with every column name in it. Compact on purpose: a
-- half-applied ALTER TABLE is visible without a row per column.
UNION ALL
  SELECT 'table', table_schema || '.' || table_name,
         string_agg(column_name, ', ' ORDER BY ordinal_position)
    FROM information_schema.columns
   WHERE table_schema IN ('people', 'workforce')
   GROUP BY 1, 2

ORDER BY 1, 2;
