// workforce's background jobs (Module 9, Phase 3) — the first this module has.
// Same shape as defects/sla-cron.js: idempotent start(), cron.validate()
// before scheduling, a "[name] scheduled" log line, an isRunning guard and a
// runNow() test seam. server.js decides whether jobs run at all (ENABLE_CRON
// and the leader lock).

const cron = require('node-cron')
const workStatus = require('./workstatus.service')
const notify = require('../notify')
const { BUSINESS_TZ } = require('./dates')

const makeJob = (name, schedule, sweep) => {
  let task = null
  let isRunning = false

  const runNow = async () => {
    if (isRunning) return null
    isRunning = true
    try {
      const result = await sweep()
      console.log(`[${name}] ${JSON.stringify(result)}`)
      return result
    } catch (err) {
      console.error(`[${name}] failed:`, err.message)
      try {
        await notify.dispatchToRoles({
          roles: ['admin'],
          type: notify.TYPES.SYSTEM_CRON_FAILURE,
          title: `${name} job failed`,
          message: `The ${name} job errored: ${err.message}`,
          linkTo: '/time-management',
          priority: 'high',
          dedupeWindowMinutes: 60,
        })
      } catch {
        /* the alert about the failure must not itself throw */
      }
      return null
    } finally {
      isRunning = false
    }
  }

  const start = () => {
    if (task) return task
    if (!cron.validate(schedule)) {
      console.error(`[${name}] invalid schedule "${schedule}" — not started.`)
      return null
    }
    task = cron.schedule(schedule, runNow, { scheduled: true, timezone: BUSINESS_TZ })
    console.log(`[${name}] scheduled "${schedule}" (${BUSINESS_TZ})`)
    return task
  }

  const stop = () => {
    if (task) {
      task.stop()
      task = null
    }
  }

  return { name, start, stop, runNow }
}

exports.workStatusNudge = makeJob('work-status-nudge',
  process.env.WORK_STATUS_NUDGE_CRON || '30 18 * * 1-5', workStatus.sweepNudge)
exports.workStatusEscalate = makeJob('work-status-escalate',
  process.env.WORK_STATUS_ESCALATE_CRON || '0 10 * * 1-5', workStatus.sweepEscalate)
exports.leaveNoticeReminder = makeJob('leave-notice-reminder',
  process.env.LEAVE_NOTICE_REMINDER_CRON || '0 10 1 * *', workStatus.sweepLeaveNoticeReminder)
