// people's background jobs. Same shape as defects/sla-cron.js: an idempotent
// start(), cron.validate() before scheduling, a "[name] scheduled" log line,
// an isRunning guard, and a runNow() test seam. server.js decides whether jobs
// run at all (ENABLE_CRON and the leader lock).

const cron = require('node-cron')
const recruitment = require('./recruitment.service')
const { BUSINESS_TZ } = require('./shared')

const SCHEDULE = process.env.INTERVIEW_FEEDBACK_CRON || '0 10 * * 1-5'

let task = null
let isRunning = false

async function runInterviewFeedbackReminderNow() {
  if (isRunning) return null
  isRunning = true
  try {
    const result = await recruitment.sweepFeedbackPending()
    if (result.pending) console.log(`[interview-feedback] reminded ${result.pending} pending round(s)`)
    return result
  } catch (err) {
    console.error('[interview-feedback] sweep failed:', err.message)
    return null
  } finally {
    isRunning = false
  }
}

function start() {
  if (task) return task
  if (!cron.validate(SCHEDULE)) {
    console.error(`[interview-feedback] invalid schedule "${SCHEDULE}" — not started.`)
    return null
  }
  task = cron.schedule(SCHEDULE, runInterviewFeedbackReminderNow, { scheduled: true, timezone: BUSINESS_TZ })
  console.log(`[interview-feedback] scheduled "${SCHEDULE}" (${BUSINESS_TZ})`)
  return task
}

function stop() {
  if (task) {
    task.stop()
    task = null
  }
}

module.exports = { start, stop, runInterviewFeedbackReminderNow }
