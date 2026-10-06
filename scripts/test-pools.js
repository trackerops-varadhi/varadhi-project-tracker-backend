/**
 * Module pools for the integration test suites.
 * ---------------------------------------------------------------------------
 * After the Phase 2 schema split, `require('../src/config/db')` — the default
 * pool — can no longer see any module's tables: its search_path is `public`,
 * and the 29 owned tables now live in seven module schemas. Every suite that
 * set up fixtures or asserted through that pool started failing with
 * `relation "..." does not exist`.
 *
 * The fix is NOT one wide pool with every schema on its search_path. That would
 * work, and it would also let a fixture build a row combination that no module
 * could actually produce — tests passing against states the application cannot
 * reach. Instead each suite reaches for the pool of the module that OWNS the
 * table it is touching, exactly as production code does:
 *
 *   const { identity, work } = require('./test-pools')
 *   await identity.query('SELECT id FROM users WHERE email = $1', [email])
 *   await work.query('DELETE FROM tasks WHERE title LIKE $1', ['ZZ %'])
 *
 * A query sent to the wrong pool fails loudly, which is the point: the suites
 * now encode table ownership rather than assuming a flat namespace.
 *
 * These are the same cached pools the application uses (platform/db keeps one
 * per schema), so a suite adds no connections beyond what the server holds.
 */

const db = require('../src/platform/db')

const MODULES = [
  'identity', 'work', 'defects', 'notify', 'integrations', 'files', 'workforce', 'people',
]

// Lazily resolved: a suite that only touches identity never opens the other six.
for (const name of MODULES) {
  Object.defineProperty(exports, name, {
    enumerable: true,
    get: () => db.forSchema(name),
  })
}

/** Close every pool a suite opened. Call in the suite's cleanup. */
exports.endAll = () => db.endAll()

/**
 * Which module owns a table — for fixture helpers that take a table name.
 * Throws rather than guessing, so a typo surfaces as a test error.
 */
const OWNER = {
  users: 'identity', user_sessions: 'identity', user_tokens: 'identity',
  projects: 'work', project_members: 'work', tasks: 'work', comments: 'work',
  bugs: 'defects', bug_comments: 'defects', bug_attachments: 'defects',
  bug_activity_logs: 'defects', bug_sla_rules: 'defects',
  notifications: 'notify', notification_preferences: 'notify',
  notification_snoozes: 'notify', notification_action_log: 'notify',
  notification_logs: 'notify', push_subscriptions: 'notify',
  push_delivery_retries: 'notify',
  calendar_connections: 'integrations', calendar_sync_settings: 'integrations',
  calendar_event_links: 'integrations', calendar_sync_conflicts: 'integrations',
  teams_webhooks: 'integrations', teams_delivery_log: 'integrations',
  documents: 'files', folders: 'files',
  leave_requests: 'workforce', time_logs: 'workforce',
  employee_profiles: 'people', employee_exits: 'people',
  candidates: 'people', interviews: 'people', candidate_resumes: 'people',
}

exports.poolFor = (table) => {
  const mod = OWNER[table]
  if (!mod) throw new Error(`test-pools: no module owns table "${table}"`)
  return db.forSchema(mod)
}

exports.OWNER = OWNER
