/**
 * Teams summaries and delivery retries (Module 5).
 * ---------------------------------------------------------------------------
 * Two jobs on two schedules, in one file because they share a subject:
 *
 *   retry   — every 2 minutes, drains transient delivery failures.
 *   digest  — hourly tick that posts daily/weekly summaries when the local
 *             hour matches DIGEST_HOUR.
 *
 * Why an hourly tick rather than a `0 9 * * *` cron: node-cron schedules
 * against one fixed timezone (CRON_TIMEZONE), so a single daily expression
 * would fire at 09:00 in that zone only. Checking the hour on each tick leaves
 * room to make the digest hour per-webhook later without rewriting the
 * scheduler. Idempotence comes from teams_delivery_log — a digest already sent
 * today for a webhook is not sent twice.
 *
 * Both start under the SAME ENABLE_CRON switch as every other sweep.
 */

const cron = require('node-cron')
const pool = require('../config/db')
const { runTeamsRetriesNow, postToWebhook } = require('./teams-delivery')
const { dailySummaryCard } = require('./teams-cards')
const { notifyByRoles, NOTIFICATION_TYPES } = require('./notification-engine')

const RETRY_SCHEDULE = process.env.TEAMS_RETRY_SCHEDULE || '*/2 * * * *'
const DIGEST_SCHEDULE = process.env.TEAMS_DIGEST_SCHEDULE || '0 * * * *'
const TIMEZONE = process.env.CRON_TIMEZONE || 'Asia/Kolkata'
const DIGEST_HOUR = Number(process.env.TEAMS_DIGEST_HOUR ?? 9)

let retryTask = null
let digestTask = null
let retryRunning = false
let digestRunning = false

/**
 * Post the daily/weekly summary for every webhook that asked for one.
 *
 * @param {object} deps { http, now } injectable for tests.
 */
async function runTeamsDigestNow(deps = {}) {
  const now = deps.now ? deps.now() : new Date()
  const result = { candidates: 0, sent: 0, skipped: 0, failed: 0 }

  const isWeeklyDay = now.getDay() === 1 // Monday

  const { rows: webhooks } = await pool.query(
    `SELECT * FROM teams_webhooks
      WHERE enabled = TRUE AND summary_digest <> 'off'`
  )

  for (const webhook of webhooks) {
    if (webhook.summary_digest === 'weekly' && !isWeeklyDay) {
      result.skipped += 1
      continue
    }
    result.candidates += 1

    // Idempotence guard: one digest per webhook per day, so a restart or a
    // second tick within the hour cannot double-post.
    const { rows: already } = await pool.query(
      `SELECT 1 FROM teams_delivery_log
        WHERE webhook_id = $1 AND card_kind = 'daily_summary'
          AND status = 'sent' AND created_at > NOW() - interval '20 hours'
        LIMIT 1`,
      [webhook.id]
    )
    if (already.length) {
      result.skipped += 1
      continue
    }

    const stats = await collectProjectStats(webhook.project_id)
    const card = dailySummaryCard({
      projectName: stats.projectName,
      period: webhook.summary_digest === 'weekly' ? 'Weekly' : 'Daily',
      completed: stats.completed,
      inProgress: stats.inProgress,
      overdue: stats.overdue,
      dueToday: stats.dueToday,
      linkTo: webhook.project_id ? `/projects/${webhook.project_id}` : '/dashboard',
    })

    const posted = await postToWebhook(webhook, card, deps, { eventType: 'summary' })
    if (posted.ok) result.sent += 1
    else result.failed += 1
  }

  return result
}

/**
 * Counts for the summary card. A NULL project_id (global webhook) aggregates
 * across every active project.
 */
async function collectProjectStats(projectId) {
  const params = []
  let where = `WHERE 1=1`
  if (projectId) {
    params.push(projectId)
    where += ` AND t.project_id = $1`
  }

  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE t.status = 'completed'
                        AND t.updated_at > NOW() - interval '24 hours')::int AS completed,
       COUNT(*) FILTER (WHERE t.status = 'in_progress')::int                 AS in_progress,
       COUNT(*) FILTER (WHERE t.due_date < CURRENT_DATE
                        AND t.status <> 'completed')::int                    AS overdue,
       COUNT(*) FILTER (WHERE t.due_date = CURRENT_DATE
                        AND t.status <> 'completed')::int                    AS due_today
     FROM tasks t ${where}`,
    params
  )

  let projectName = null
  if (projectId) {
    const { rows: p } = await pool.query(`SELECT name FROM projects WHERE id = $1`, [projectId])
    projectName = p[0]?.name || null
  }

  const r = rows[0] || {}
  return {
    projectName,
    completed: r.completed || 0,
    inProgress: r.in_progress || 0,
    overdue: r.overdue || 0,
    dueToday: r.due_today || 0,
  }
}

async function alertAdmins(what, err) {
  try {
    await notifyByRoles(
      ['admin'],
      NOTIFICATION_TYPES.SYSTEM_CRON_FAILURE,
      `Teams ${what} cron failed`,
      `The Teams ${what} sweep failed: ${err.message}`,
      null,
      'urgent',
      { skipDedupe: true, ignoreQuietHours: true }
    )
  } catch (alertErr) {
    console.error(`[teams-cron] failed to notify admins of ${what} failure:`, alertErr.message)
  }
}

function startTeamsCron() {
  if (retryTask && digestTask) return { retryTask, digestTask }

  if (!retryTask && cron.validate(RETRY_SCHEDULE)) {
    retryTask = cron.schedule(
      RETRY_SCHEDULE,
      async () => {
        if (retryRunning) return
        retryRunning = true
        try {
          await runTeamsRetriesNow()
        } catch (err) {
          console.error('[teams-cron] retry sweep failed:', err.message)
          await alertAdmins('retry', err)
        } finally {
          retryRunning = false
        }
      },
      { scheduled: true, timezone: TIMEZONE }
    )
    console.log(`[teams-cron] retry scheduled "${RETRY_SCHEDULE}" (${TIMEZONE})`)
  }

  if (!digestTask && cron.validate(DIGEST_SCHEDULE)) {
    digestTask = cron.schedule(
      DIGEST_SCHEDULE,
      async () => {
        if (digestRunning) return
        // The hour gate, not the cron expression — see the header note.
        if (new Date().getHours() !== DIGEST_HOUR) return
        digestRunning = true
        try {
          const r = await runTeamsDigestNow()
          if (r.sent) console.log(`[teams-cron] digest posted to ${r.sent} channel(s)`)
        } catch (err) {
          console.error('[teams-cron] digest sweep failed:', err.message)
          await alertAdmins('digest', err)
        } finally {
          digestRunning = false
        }
      },
      { scheduled: true, timezone: TIMEZONE }
    )
    console.log(`[teams-cron] digest scheduled "${DIGEST_SCHEDULE}" at hour ${DIGEST_HOUR} (${TIMEZONE})`)
  }

  return { retryTask, digestTask }
}

function stopTeamsCron() {
  if (retryTask) { retryTask.stop(); retryTask = null }
  if (digestTask) { digestTask.stop(); digestTask = null }
}

module.exports = {
  startTeamsCron,
  stopTeamsCron,
  runTeamsDigestNow,
  collectProjectStats,
  DIGEST_HOUR,
}
