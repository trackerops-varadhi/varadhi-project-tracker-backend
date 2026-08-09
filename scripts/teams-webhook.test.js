/*
 * Microsoft Teams webhook tests (Module 5).
 *
 * Card builders are pure and tested directly. Delivery runs the REAL
 * teams-delivery.js against the real database with an injected `http`, so
 * retry classification, auto-disable and the URL-secrecy guarantees are
 * exercised without a Teams tenant.
 *
 *   node scripts/teams-webhook.test.js
 */
require('dotenv').config()

const pool = require('../src/config/db')
const cards = require('../src/utils/teams-cards')
const delivery = require('../src/utils/teams-delivery')
const fanout = require('../src/utils/teams-fanout')
const { encrypt, maskSecret } = require('../src/utils/crypto')
const { __internals } = require('../src/controllers/teams.controller')

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${e}`))
}
const httpErr = (status, msg = 'boom') =>
  Object.assign(new Error(msg), { statusCode: status })

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-teams-suite'

const MARKER = 'ZZTEAMS'
const SECRET_URL =
  'https://acme.webhook.office.com/webhookb2/aaaa-bbbb/IncomingWebhook/secretpart/cafeb3f9'

let userId = null
let projectId = null
let webhookId = null

const cleanup = async () => {
  await pool.query(`DELETE FROM teams_webhooks WHERE name LIKE '${MARKER}%'`).catch(() => {})
  await pool.query(`DELETE FROM projects WHERE name LIKE '${MARKER}%'`).catch(() => {})
  await pool.query(`DELETE FROM notifications WHERE title LIKE '${MARKER}%'`).catch(() => {})
}

async function main() {
  // ── Pure: card builders ─────────────────────────────────────────────────
  console.log('\n1. Adaptive Card envelope')
  {
    const card = cards.taskAssignedCard({
      taskTitle: 'UI Design for Dashboard',
      projectName: 'Website Redesign',
      dueDate: '30 May 2025',
      priority: 'high',
      linkTo: '/tasks/abc',
    })

    check('is a Teams message envelope', card.type === 'message', card.type)
    check('carries exactly one attachment', card.attachments.length === 1)
    check('with the adaptive-card content type',
      card.attachments[0].contentType === 'application/vnd.microsoft.card.adaptive',
      card.attachments[0].contentType)

    const content = card.attachments[0].content
    check('declares AdaptiveCard', content.type === 'AdaptiveCard')
    check('pins schema version 1.4 (highest Teams renders reliably)',
      content.version === '1.4', content.version)
    check('has a non-empty body', Array.isArray(content.body) && content.body.length > 0)
    check('no null entries leak into the body', content.body.every(Boolean))

    const json = JSON.stringify(card)
    check('includes the task title', json.includes('UI Design for Dashboard'))
    check('includes the project', json.includes('Website Redesign'))
    check('includes the due date', json.includes('30 May 2025'))
  }

  console.log('\n2. Every card links back to the tracker')
  {
    const built = {
      taskAssigned: cards.taskAssignedCard({ taskTitle: 'T', linkTo: '/tasks/1' }),
      approval: cards.approvalRequestCard({ taskTitle: 'T', linkTo: '/tasks/1' }),
      deadline: cards.deadlineAlertCard({ taskTitle: 'T', linkTo: '/tasks/1' }),
      status: cards.statusUpdateCard({ taskTitle: 'T', linkTo: '/tasks/1' }),
      summary: cards.dailySummaryCard({ completed: 5, inProgress: 8, overdue: 2 }),
      health: cards.projectHealthCard({ projectName: 'P', health: 'Good' }),
      comment: cards.commentCard({ taskTitle: 'T', linkTo: '/tasks/1', excerpt: 'hi' }),
      test: cards.testCard({ projectName: 'P' }),
      generic: cards.genericCard({ title: 'X', message: 'Y', linkTo: '/tasks/1' }),
    }

    for (const [name, card] of Object.entries(built)) {
      const content = card.attachments[0].content
      const actions = content.actions || []
      check(`${name}: has at least one action`, actions.length >= 1, JSON.stringify(actions))
      // Mirrors Notification.maxActions = 2, so a user is never offered three
      // choices in Teams and two on their phone for the same event.
      check(`${name}: never more than two actions`, actions.length <= 2, String(actions.length))
      check(`${name}: every action opens an absolute URL`,
        actions.every((a) => /^https?:\/\//.test(a.url || '')), JSON.stringify(actions))
      check(`${name}: reports its card kind`, Boolean(card.__meta?.cardKind))
    }
  }

  console.log('\n3. cardForNotification is total — no type can crash the fan-out')
  {
    const types = [
      'task_assigned', 'task_reassigned', 'review_requested', 'task_reminder',
      'task_due_today', 'task_overdue', 'task_escalation', 'task_status_changed',
      'task_comment', 'project_milestone', 'document_uploaded', 'user_invited',
      'a_type_that_does_not_exist_yet', '',
    ]
    let allOk = true
    for (const type of types) {
      try {
        const card = cards.cardForNotification(
          { type, title: 'T', message: 'M', link_to: '/tasks/1', priority: 'normal' },
          { projectName: 'P' }
        )
        if (!card?.attachments?.[0]?.content) allOk = false
      } catch {
        allOk = false
      }
    }
    check('every type (including unknown ones) yields a valid card', allOk)
    check('null notification still yields a card',
      Boolean(cards.cardForNotification(null)?.attachments?.[0]?.content))
  }

  console.log('\n4. Webhook URL validation')
  {
    const v = __internals.validateWebhookUrl
    check('accepts a Teams connector URL', v(SECRET_URL).ok === true)
    check('accepts a Power Automate URL (the connector replacement)',
      v('https://prod-1.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke').ok === true)
    check('rejects plain HTTP — the URL is a credential',
      v('http://acme.webhook.office.com/x').ok === false)
    check('rejects a non-URL', v('not a url').ok === false)
    check('rejects empty', v('').ok === false)
    check('rejects null', v(null).ok === false)
  }

  // ── Database-backed ─────────────────────────────────────────────────────
  const u = (await pool.query(`SELECT id FROM users WHERE status='active' LIMIT 1`)).rows[0]
  if (!u) {
    console.log('\nSKIP — no active user; database-backed sections not run.')
    return
  }
  userId = u.id
  await cleanup()

  projectId = (await pool.query(
    `INSERT INTO projects (name, status) VALUES ($1,'active') RETURNING id`,
    [`${MARKER} Project`]
  )).rows[0].id

  // UNIQUE (project_id, url_hint) is deliberate — one channel per project
  // cannot be configured twice. Each fixture therefore needs its own URL,
  // varying in the last four characters, which is the part maskSecret keeps.
  let hookSeq = 0
  const makeWebhook = async (overrides = {}) => {
    const url = overrides.url || SECRET_URL.replace(/.{4}$/, String(1000 + hookSeq++))
    const { rows } = await pool.query(
      `INSERT INTO teams_webhooks
         (project_id, name, webhook_url, url_hint, event_types, created_by, enabled)
       VALUES ($1,$2,$3,$4,$5::text[],$6,COALESCE($7,TRUE))
       RETURNING *`,
      [
        projectId,
        `${MARKER} hook ${hookSeq}`,
        encrypt(url),
        maskSecret(url),
        overrides.eventTypes || ['task_assigned', 'task_status_changed'],
        userId,
        overrides.enabled,
      ]
    )
    return rows[0]
  }

  console.log('\n5. Successful delivery')
  {
    // Pin the exact URL for this one so the decryption assertion is precise.
    const webhook = await makeWebhook({ url: SECRET_URL })
    webhookId = webhook.id
    const sent = []
    const http = async (url, body) => { sent.push({ url, body }); return { status: 200 } }

    const card = cards.taskAssignedCard({ taskTitle: 'T', linkTo: '/tasks/1' })
    const result = await delivery.postToWebhook(webhook, card, { http }, { eventType: 'task_assigned' })

    check('reports success', result.ok === true, JSON.stringify(result))
    check('posted exactly once', sent.length === 1, String(sent.length))
    check('posted to the DECRYPTED url', sent[0].url === SECRET_URL, sent[0].url)
    check('the __meta marker is stripped before the wire',
      sent[0].body.__meta === undefined, JSON.stringify(Object.keys(sent[0].body)))
    check('the wire payload is a valid message envelope', sent[0].body.type === 'message')

    const log = (await pool.query(
      `SELECT * FROM teams_delivery_log WHERE webhook_id = $1`, [webhook.id]
    )).rows[0]
    check('a delivery log row was written', Boolean(log))
    check('marked sent', log.status === 'sent', log.status)
    check('records the card kind for the health screen',
      log.card_kind === 'task_assigned', log.card_kind)
    // The single most important assertion in this file.
    check('the logged payload does NOT contain the webhook URL',
      !JSON.stringify(log.payload).includes('secretpart'), 'URL LEAKED INTO LOG')
  }

  console.log('\n6. Transient vs permanent classification')
  {
    check('no status (network) is transient', delivery.isTransient(httpErr(undefined)) === true)
    check('429 throttled is transient', delivery.isTransient(httpErr(429)) === true)
    check('500 is transient', delivery.isTransient(httpErr(500)) === true)
    check('503 is transient', delivery.isTransient(httpErr(503)) === true)
    check('400 bad card is PERMANENT', delivery.isTransient(httpErr(400)) === false)
    check('401 is PERMANENT', delivery.isTransient(httpErr(401)) === false)
    check('403 is PERMANENT', delivery.isTransient(httpErr(403)) === false)
    check('404 connector gone is PERMANENT', delivery.isTransient(httpErr(404)) === false)
    check('410 gone is PERMANENT', delivery.isTransient(httpErr(410)) === false)

    check('backoff doubles', delivery.backoffMs(1) === delivery.backoffMs(0) * 2)
    check('backoff is capped', delivery.backoffMs(99) <= 8 * 60_000, String(delivery.backoffMs(99)))
  }

  console.log('\n7. A transient failure is queued for retry, not dropped')
  {
    const webhook = await makeWebhook()
    const http = async () => { throw httpErr(503) }
    const result = await delivery.postToWebhook(webhook, cards.genericCard({ title: 'T' }), { http })

    check('reports failure', result.ok === false)
    check('classified transient', result.reason === 'transient', result.reason)

    const log = (await pool.query(
      `SELECT * FROM teams_delivery_log WHERE webhook_id = $1`, [webhook.id]
    )).rows[0]
    check('parked as pending for the retry sweep', log.status === 'pending', log.status)
    check('with a future next_attempt_at', new Date(log.next_attempt_at) > new Date())

    const wh = (await pool.query(`SELECT * FROM teams_webhooks WHERE id=$1`, [webhook.id])).rows[0]
    check('the failure streak advanced', wh.failure_count === 1, String(wh.failure_count))
    check('but the webhook stays enabled — one blip is not a fault',
      wh.enabled === true)
  }

  console.log('\n8. A permanent 404 disables immediately and notifies (AC-23)')
  {
    const webhook = await makeWebhook()
    const http = async () => { throw httpErr(404) }

    const errs = []
    const origErr = console.error
    console.error = (...a) => errs.push(a.join(' '))
    await delivery.postToWebhook(webhook, cards.genericCard({ title: 'T' }), { http })
    console.error = origErr

    const wh = (await pool.query(`SELECT * FROM teams_webhooks WHERE id=$1`, [webhook.id])).rows[0]
    check('the webhook was auto-disabled', wh.enabled === false)
    check('with a human-readable reason', /no longer exists/i.test(wh.disabled_reason || ''),
      wh.disabled_reason)

    const notes = (await pool.query(
      `SELECT * FROM notifications WHERE user_id=$1 AND type='teams_webhook_disabled'`, [userId]
    )).rows
    check('the configuring user was notified', notes.length >= 1, String(notes.length))

    check('failure logs identify the webhook by id',
      errs.some((l) => l.includes(webhook.id)), JSON.stringify(errs).slice(0, 200))
    check('failure logs NEVER contain the URL',
      !errs.some((l) => l.includes('secretpart')), 'URL LEAKED INTO LOGS')
  }

  console.log('\n9. A disabled webhook sends nothing (AC-25)')
  {
    const webhook = await makeWebhook({ enabled: false })
    let calls = 0
    const http = async () => { calls++; return { status: 200 } }

    const result = await delivery.postToWebhook(webhook, cards.genericCard({ title: 'T' }), { http })
    check('refuses to post', result.ok === false)
    check('gives the reason', result.reason === 'webhook_disabled', result.reason)
    check('and made ZERO http calls', calls === 0, String(calls))
  }

  console.log('\n10. Event-type filtering (AC-22)')
  {
    const webhook = await makeWebhook({ eventTypes: ['task_assigned'] })

    const subscribed = await delivery.findWebhooksFor(projectId, 'task_assigned')
    check('a subscribed type matches the webhook',
      subscribed.some((w) => w.id === webhook.id), String(subscribed.length))

    const unsubscribed = await delivery.findWebhooksFor(projectId, 'task_comment')
    check('an UNSUBSCRIBED type does not match',
      !unsubscribed.some((w) => w.id === webhook.id))

    let calls = 0
    const http = async () => { calls++; return { status: 200 } }
    const result = await delivery.fanOutNotification(
      { type: 'task_comment', title: 'C', message: 'm', link_to: '/tasks/1' },
      { projectId },
      { http }
    )
    check('fan-out posts nothing for a disabled event type',
      !result.matched || calls === 0, JSON.stringify(result))
  }

  console.log('\n11. Fan-out delivers a subscribed event')
  {
    const webhook = await makeWebhook({ eventTypes: ['task_assigned'] })
    fanout.__resetLedger()

    let calls = 0
    const http = async () => { calls++; return { status: 200 } }
    const result = await delivery.fanOutNotification(
      { type: 'task_assigned', title: 'New Task', message: 'm', link_to: '/tasks/1' },
      { projectId, projectName: 'P' },
      { http }
    )
    check('matched at least this webhook', result.matched >= 1, JSON.stringify(result))
    check('and posted', calls >= 1, String(calls))
  }

  console.log('\n12. Fan-out never throws, whatever it is handed')
  {
    const inputs = [null, {}, { notification: null }, { notification: { type: null } }]
    let threw = false
    for (const input of inputs) {
      try {
        await fanout.handleNotification(input, { http: async () => ({ status: 200 }) })
      } catch {
        threw = true
      }
    }
    check('malformed payloads are absorbed, not thrown', threw === false)

    // Isolation matters: this runs off an EventEmitter with no upstream error
    // handling, so a throw here would break in-app notifications.
    let threwOnHttpFailure = false
    try {
      await fanout.handleNotification(
        { notification: { type: 'task_assigned', title: 'T', link_to: '/tasks/1' } },
        { http: async () => { throw httpErr(500) }, context: { projectId } }
      )
    } catch {
      threwOnHttpFailure = true
    }
    check('a failing channel never throws into the dispatch path',
      threwOnHttpFailure === false)
  }

  console.log('\n13. Channel-level dedupe — one post per event, not one per recipient')
  {
    fanout.__resetLedger()
    const notification = { type: 'task_assigned', title: 'T', link_to: '/tasks/dedupe-me' }

    const first = await fanout.handleNotification({ notification }, { context: {}, http: async () => ({ status: 200 }) })
    const second = await fanout.handleNotification({ notification }, { context: {}, http: async () => ({ status: 200 }) })

    check('the first dispatch is processed', first?.skipped !== 'already_posted', JSON.stringify(first))
    // dispatchToMany fires once per recipient; a six-person project must not
    // produce six identical cards in the channel.
    check('an immediate repeat is suppressed', second?.skipped === 'already_posted',
      JSON.stringify(second))
  }

  console.log('\n14. Integration-health notifications never loop back into Teams')
  {
    fanout.__resetLedger()
    for (const type of ['teams_webhook_disabled', 'calendar_sync_failed', 'calendar_conflict_detected']) {
      const r = await fanout.handleNotification({ notification: { type, title: 'T' } })
      check(`${type} is not forwarded to Teams`, r?.skipped === 'integration_health',
        JSON.stringify(r))
    }
  }

  console.log('\n15. The API never returns the webhook URL')
  {
    const webhook = (await pool.query(
      `SELECT * FROM teams_webhooks WHERE id = $1`, [webhookId]
    )).rows[0]
    const publicShape = __internals.toPublicWebhook(webhook)
    const json = JSON.stringify(publicShape)

    check('no plaintext URL', !json.includes('secretpart'), json)
    check('no ciphertext either', !json.includes('v1:'), json)
    check('no webhookUrl field at all', publicShape.webhookUrl === undefined)
    check('only the masked hint is exposed', Boolean(publicShape.urlHint))
    check('the hint keeps the origin so channels stay distinguishable',
      publicShape.urlHint.includes('acme.webhook.office.com'), publicShape.urlHint)
    check('the hint drops the credential path',
      !publicShape.urlHint.includes('secretpart'), publicShape.urlHint)

    const stored = (await pool.query(
      `SELECT webhook_url FROM teams_webhooks WHERE id=$1`, [webhookId]
    )).rows[0]
    check('the column holds ciphertext, not the URL',
      String(stored.webhook_url).startsWith('v1:') &&
      !String(stored.webhook_url).includes('secretpart'))
  }

  console.log('\n16. Retry sweep')
  {
    const webhook = await makeWebhook()
    await delivery.postToWebhook(webhook, cards.genericCard({ title: 'T' }), {
      http: async () => { throw httpErr(503) },
    })
    await pool.query(
      `UPDATE teams_delivery_log SET next_attempt_at = NOW() - interval '1 minute'
        WHERE webhook_id = $1`, [webhook.id]
    )

    let calls = 0
    const res = await delivery.runTeamsRetriesNow({
      http: async () => { calls++; return { status: 200 } },
    })
    check('claimed the due row', res.claimed >= 1, JSON.stringify(res))
    check('re-sent it', calls >= 1, String(calls))

    const log = (await pool.query(
      `SELECT * FROM teams_delivery_log WHERE webhook_id=$1`, [webhook.id]
    )).rows[0]
    check('marked sent', log.status === 'sent', log.status)

    const before = calls
    await delivery.runTeamsRetriesNow({ http: async () => { calls++; return { status: 200 } } })
    check('a later sweep does not re-send it', calls === before, String(calls))

    const wh = (await pool.query(`SELECT * FROM teams_webhooks WHERE id=$1`, [webhook.id])).rows[0]
    check('a success resets the failure streak', wh.failure_count === 0, String(wh.failure_count))
  }

  console.log('\n17. Revoking a webhook stops everything (AC-25)')
  {
    const webhook = await makeWebhook()
    await delivery.postToWebhook(webhook, cards.genericCard({ title: 'T' }), {
      http: async () => ({ status: 200 }),
    })

    await pool.query(`DELETE FROM teams_webhooks WHERE id = $1`, [webhook.id])

    const matches = await delivery.findWebhooksFor(projectId, 'task_assigned')
    check('it is no longer selected for any event',
      !matches.some((w) => w.id === webhook.id))

    const logs = (await pool.query(
      `SELECT * FROM teams_delivery_log WHERE webhook_id = $1`, [webhook.id]
    )).rows
    check('its delivery history cascaded away with it', logs.length === 0, String(logs.length))
  }
}

main()
  .catch((e) => { console.error('HARNESS ERROR:', e.message, e.stack); fail++ })
  .finally(async () => {
    await cleanup()
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
  })
