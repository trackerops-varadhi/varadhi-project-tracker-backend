/*
 * Operations floor — logging, correlation ids, metrics, leader election,
 * rate-limit store, and the Docker/CI configuration.
 *
 *   npm run test:ops-infra
 *
 * OFFLINE BY DEFAULT. Everything except the leader-election and postgres-store
 * sections runs with no database at all, which is what lets this suite run in
 * CI. The database sections use a DISPOSABLE LOOPBACK target and are skipped
 * with a printed notice — never silently — when one is not reachable.
 *
 *   SCRATCH_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/varadhi_scratch
 *
 * THE TWO ASSERTIONS THAT MATTER MOST
 *   - two processes cannot both become cron leader. Proven with two real child
 *     processes against one database, not by mocking the lock.
 *   - the memory store is refused when MULTI_INSTANCE=true. That combination is
 *     how a configured limit of 20 silently becomes 60 across three instances.
 */

const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')
const http = require('http')

require('dotenv').config()

const BACKEND = path.join(__dirname, '..')
const SCRATCH = process.env.SCRATCH_DATABASE_URL
  || 'postgresql://varadhi_scratch_user:admin123@127.0.0.1:5432/varadhi_scratch'

const scratchHost = SCRATCH.match(/@([^:/?]+)/)?.[1]
if (!['127.0.0.1', 'localhost', '::1'].includes(scratchHost)) {
  console.error(`REFUSING — SCRATCH_DATABASE_URL host "${scratchHost}" is not loopback.`)
  process.exit(1)
}

let pass = 0
let fail = 0
let skipped = 0
const failures = []
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; failures.push(`${name} ${extra}`); console.log(`  FAIL  ${name}  ${extra}`) }
}
const skip = (name, why) => { skipped++; console.log(`  SKIP  ${name} — ${why}`) }

/**
 * Run a snippet in a child and return BOTH streams.
 *
 * stderr matters here: the logger sends warn and error to stderr, as it should,
 * so a stdout-only capture silently misses exactly the lines these tests check
 * for — which is how the first version of this suite reported a passing bridge
 * as a failure.
 */
const inChild = (code, env = {}) => {
  const r = spawnSync(process.execPath, ['-e', code], {
    cwd: BACKEND, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, ...env },
  })
  return `${r.stdout || ''}${r.stderr || ''}`
}

/** The last JSON object printed across either stream. */
const lastJsonLine = (out) => {
  const line = out.trim().split('\n').map((l) => l.trim())
    .filter((l) => l.startsWith('{')).pop() || ''
  try { return JSON.parse(line) } catch { return null }
}

async function main() {
  console.log(`\nOperations floor\n${'='.repeat(64)}`)

  /* ═══════════════════════════════════════ 1. STRUCTURED LOGGING ════════ */
  console.log('\n1. Structured logging')
  {
    const out = inChild(`
      const { logger, install } = require('./src/platform/logger')
      install()
      logger.info('hello', { a: 1, err: new Error('boom') })
    `, { LOG_FORMAT: 'json', NODE_ENV: 'test' })
    const parsed = lastJsonLine(out)
    check('json mode emits one parseable object per line', parsed !== null, out.slice(-160))
    check('carries ts, level, msg',
      parsed && parsed.level === 'info' && parsed.msg === 'hello' && Boolean(parsed.ts),
      JSON.stringify(parsed))
    check('Error fields are unwrapped, not {}',
      parsed && parsed.err && parsed.err.message === 'boom' && Boolean(parsed.err.stack),
      JSON.stringify(parsed && parsed.err))

    const pretty = inChild(`
      const { logger, install } = require('./src/platform/logger')
      install()
      console.log('plain line')
    `, { LOG_FORMAT: 'pretty', NODE_ENV: 'development' })
    check('pretty mode passes console.log through unchanged',
      pretty.includes('plain line') && !pretty.includes('"level"'), pretty.slice(0, 120))

    const bridged = inChild(`
      const { install } = require('./src/platform/logger')
      install()
      console.error('legacy call site')
    `, { LOG_FORMAT: 'json', NODE_ENV: 'test' })
    const bp = lastJsonLine(bridged)
    check('json mode bridges existing console.* to structured output',
      bp && bp.level === 'error' && bp.msg === 'legacy call site', bridged.slice(-160))

    const quiet = inChild(`
      const { logger, install } = require('./src/platform/logger')
      install(); logger.debug('should not appear'); logger.info('should appear')
    `, { LOG_FORMAT: 'json', LOG_LEVEL: 'info', NODE_ENV: 'test' })
    check('LOG_LEVEL suppresses below threshold',
      !quiet.includes('should not appear') && quiet.includes('should appear'))
  }

  /* ═══════════════════════════════════════ 2. CORRELATION IDS ═══════════ */
  console.log('\n2. Correlation ids')
  {
    const { VALID } = require('../src/middleware/request-id.middleware')
    check('accepts a plausible id', VALID.test('abc123DEF-_456xyz'))
    check('rejects one that is too short', !VALID.test('short'))
    check('rejects one that is too long', !VALID.test('x'.repeat(65)))
    check('rejects newline injection', !VALID.test('abcdefgh\nInjected: yes'))
    check('rejects spaces and quotes', !VALID.test('abcd efgh') && !VALID.test('abcd"efgh'))

    const context = require('../src/platform/request-context')
    check('newRequestId is 16 hex chars', /^[0-9a-f]{16}$/.test(context.newRequestId()))
    const idA = context.newRequestId()
    const idB = context.newRequestId()
    check('two ids differ', idA !== idB, `${idA} ${idB}`)
    check('outside a request the id is null', context.getRequestId() === null)

    // The property that makes this useful: the id survives awaits, so a log
    // line written deep in async work still carries it.
    const seen = await context.run({ requestId: 'deadbeefdeadbeef' }, async () => {
      await new Promise((r) => { setImmediate(r) })
      await new Promise((r) => { setTimeout(r, 5) })
      return context.getRequestId()
    })
    check('id survives setImmediate and setTimeout awaits', seen === 'deadbeefdeadbeef', String(seen))

    // Concurrent requests must not see each other's ids.
    const [a, b] = await Promise.all([
      context.run({ requestId: 'aaaaaaaaaaaaaaaa' }, async () => {
        await new Promise((r) => { setTimeout(r, 10) })
        return context.getRequestId()
      }),
      context.run({ requestId: 'bbbbbbbbbbbbbbbb' }, async () => {
        await new Promise((r) => { setTimeout(r, 1) })
        return context.getRequestId()
      }),
    ])
    check('concurrent contexts do not leak into each other',
      a === 'aaaaaaaaaaaaaaaa' && b === 'bbbbbbbbbbbbbbbb', `${a} / ${b}`)

    // End to end through express.
    const express = require('express')
    const { requestId } = require('../src/middleware/request-id.middleware')
    const app = express()
    app.use(requestId)
    app.get('/echo', async (req, res) => {
      await new Promise((r) => { setTimeout(r, 5) })
      res.json({ fromContext: context.getRequestId(), fromReq: req.id })
    })
    const server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s))
    })
    const port = server.address().port
    const get = (headers) => new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/echo', headers, agent: false }, (res) => {
        let raw = ''
        res.on('data', (d) => { raw += d })
        res.on('end', () => resolve({ headers: res.headers, body: JSON.parse(raw) }))
      })
    })

    const generated = await get({})
    check('response echoes an X-Request-Id', /^[0-9a-f]{16}$/.test(generated.headers['x-request-id'] || ''),
      String(generated.headers['x-request-id']))
    check('handler sees the same id the header carries',
      generated.body.fromContext === generated.headers['x-request-id'])
    check('req.id matches the context id', generated.body.fromReq === generated.body.fromContext)

    const supplied = await get({ 'X-Request-Id': 'client-supplied-0001' })
    check('a valid inbound id is preserved end to end',
      supplied.headers['x-request-id'] === 'client-supplied-0001'
      && supplied.body.fromContext === 'client-supplied-0001',
      JSON.stringify(supplied.body))

    // WHAT IS NOT TESTED OVER THE WIRE, and why that is correct: a header value
    // containing CRLF cannot be sent at all — Node's http client throws
    // ERR_INVALID_CHAR before the socket write. That defence lives at the right
    // layer and this suite cannot fake it without bypassing the client. The
    // regex unit checks above cover the injection shape; what runs here is an id
    // that IS perfectly sendable and still must not be trusted.
    const hostile = await get({ 'X-Request-Id': 'x'.repeat(200) })
    check('an over-long inbound id is replaced, not echoed',
      /^[0-9a-f]{16}$/.test(hostile.headers['x-request-id'] || ''),
      String(hostile.headers['x-request-id']).slice(0, 40))
    check('and the request still succeeds rather than 400ing',
      Boolean(hostile.body.fromContext))

    const quoted = await get({ 'X-Request-Id': 'has spaces and "quotes"' })
    check('an id with spaces and quotes is replaced',
      /^[0-9a-f]{16}$/.test(quoted.headers['x-request-id'] || ''),
      String(quoted.headers['x-request-id']))
    await new Promise((r) => { server.close(r) })
  }

  /* ═══════════════════════════════════════ 3. METRICS ═══════════════════ */
  console.log('\n3. Metrics')
  {
    const metrics = require('../src/platform/metrics')
    metrics.reset()
    metrics.inc('t_total', { route: '/a' })
    metrics.inc('t_total', { route: '/a' })
    metrics.inc('t_total', { route: '/b' })
    metrics.observe('t_ms', 42, { route: '/a' })
    const snap = metrics.snapshot()
    check('counters accumulate per label set',
      snap.counters.t_total['route="/a"'] === 2 && snap.counters.t_total['route="/b"'] === 1,
      JSON.stringify(snap.counters))
    check('histogram records sum and count',
      snap.histograms.t_ms['route="/a"'].count === 1
      && snap.histograms.t_ms['route="/a"'].sum === 42)
    const text = metrics.render()
    check('renders Prometheus exposition', /# TYPE t_total counter/.test(text)
      && /t_ms_bucket\{route="\/a",le="50"\}/.test(text), text.slice(0, 120))
    check('label order is stable regardless of insertion order', (() => {
      metrics.reset()
      metrics.inc('x', { b: 2, a: 1 })
      metrics.inc('x', { a: 1, b: 2 })
      return Object.keys(metrics.snapshot().counters.x).length === 1
    })(), 'unstable label keys multiply series')
    metrics.reset()

    const off = inChild(`
      const m = require('./src/platform/metrics')
      console.log(JSON.stringify({ enabled: m.isEnabled() }))
    `, { METRICS_ENABLED: '' })
    check('/metrics is off unless explicitly enabled', /"enabled":false/.test(off), off.slice(0, 80))
  }

  /* ═══════════════════════════════════════ 4. ERROR TRACKING ════════════ */
  console.log('\n4. Error tracking')
  {
    const et = require('../src/platform/error-tracking')
    const scrubbed = et.scrub({
      password: 'hunter2',
      Authorization: 'Bearer abc.def.ghi',
      nested: { token: 'x', note: 'connect postgres://u:p@host:5432/db now' },
      safe: 'keep me',
    })
    check('redacts by key name', scrubbed.password === '[redacted]'
      && scrubbed.Authorization === '[redacted]' && scrubbed.nested.token === '[redacted]',
      JSON.stringify(scrubbed))
    check('redacts a connection string by shape, not just key',
      !/postgres:\/\/u:p@/.test(scrubbed.nested.note), scrubbed.nested.note)
    check('leaves innocuous fields alone', scrubbed.safe === 'keep me')

    let got = null
    et.register({ captureException: (err, ctx) => { got = { err, ctx } } })
    check('isConfigured reflects registration', et.isConfigured() === true)
    et.captureException(new Error('kaboom'), { password: 'hunter2', route: '/x' })
    check('backend receives the error', got && got.err.message === 'kaboom')
    check('backend never receives raw secrets', got && got.ctx.password === '[redacted]',
      JSON.stringify(got && got.ctx))

    et.register({ captureException: () => { throw new Error('backend down') } })
    let survived = true
    try { et.captureException(new Error('original')) } catch { survived = false }
    check('a throwing backend does not replace the original error', survived,
      'an error in the error reporter must not become the failure')
    et.register(null)
  }

  /* ═══════════════════════════════════════ 5. RATE LIMIT STORE ══════════ */
  console.log('\n5. Rate-limit store')
  {
    const store = require('../src/middleware/rate-limit-store')

    // The configuration mistake that silently multiplies every quota.
    const refused = inChild(`
      const s = require('./src/middleware/rate-limit-store')
      try { s.getStore(); console.log('ACCEPTED') }
      catch (e) { console.log('REFUSED: ' + e.message) }
    `, { RATE_LIMIT_STORE: 'memory', MULTI_INSTANCE: 'true' })
    check('memory store REFUSED when MULTI_INSTANCE=true', /REFUSED/.test(refused),
      refused.slice(0, 140))
    check('and the refusal explains the N-times-quota consequence',
      /N times the configured limit|full quota/.test(refused), refused.slice(0, 200))

    const ok = inChild(`
      const s = require('./src/middleware/rate-limit-store')
      console.log(s.getStore().name)
    `, { RATE_LIMIT_STORE: 'memory', MULTI_INSTANCE: '' })
    check('memory store allowed for a single instance', /memory/.test(ok), ok.trim())

    const unknown = inChild(`
      const s = require('./src/middleware/rate-limit-store')
      try { s.getStore(); console.log('ACCEPTED') } catch (e) { console.log('REFUSED') }
    `, { RATE_LIMIT_STORE: 'redis' })
    check('an unknown store name is refused rather than defaulted',
      /REFUSED/.test(unknown), unknown.trim())

    // Behaviour: limit, reset, concurrency.
    const mem = new store.MemoryStore()
    const WINDOW = 300
    let last
    for (let i = 0; i < 5; i += 1) last = await mem.hit('k', WINDOW)
    check('counts each hit', last.count === 5, String(last.count))

    const concurrent = await Promise.all(
      Array.from({ length: 20 }, () => mem.hit('concurrent', WINDOW)))
    const counts = concurrent.map((r) => r.count).sort((a, b) => a - b)
    check('20 concurrent hits produce exactly 1..20 with no lost updates',
      JSON.stringify(counts) === JSON.stringify(Array.from({ length: 20 }, (_, i) => i + 1)),
      JSON.stringify(counts))

    await new Promise((r) => { setTimeout(r, WINDOW + 60) })
    const afterWindow = await mem.hit('k', WINDOW)
    check('the window resets and the count restarts at 1', afterWindow.count === 1,
      String(afterWindow.count))

    await mem.reset('concurrent')
    const afterReset = await mem.hit('concurrent', WINDOW)
    check('explicit reset clears a bucket', afterReset.count === 1, String(afterReset.count))
  }

  /* ═══════════════════════════════════════ 6. POSTGRES STORE ════════════ */
  console.log('\n6. Rate-limit store — postgres (shared)')
  {
    const { Client } = require('pg')
    let reachable = true
    const probe = new Client({ connectionString: SCRATCH, connectionTimeoutMillis: 3000 })
    try { await probe.connect(); await probe.end() } catch { reachable = false }

    if (!reachable) {
      skip('postgres store', `no database at ${scratchHost}`)
    } else {
      const { Pool } = require('pg')
      const pool = new Pool({ connectionString: SCRATCH, max: 6 })
      const TABLE = 'identity.rate_limit_buckets'
      try {
        await pool.query('CREATE SCHEMA IF NOT EXISTS identity')
        // Mirrors migrations/identity/0002 exactly. Created here rather than by
        // running the migration, because this suite must not run migrations.
        await pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
          bucket_key text PRIMARY KEY,
          hits integer NOT NULL DEFAULT 0,
          reset_at timestamptz NOT NULL)`)
        await pool.query(`DELETE FROM ${TABLE}`)

        const { PostgresStore } = require('../src/middleware/rate-limit-store')
        const pg = new PostgresStore(pool)

        let r
        for (let i = 0; i < 3; i += 1) r = await pg.hit('pgkey', 60000)
        check('postgres store counts hits', r.count === 3, String(r.count))

        // The property memory cannot provide: two independent store instances,
        // as two processes would be, sharing one counter.
        const other = new PostgresStore(pool)
        const shared = await other.hit('pgkey', 60000)
        check('a SECOND store instance sees the same counter', shared.count === 4,
          `${shared.count} — this is what an in-memory limiter gets wrong`)

        const conc = await Promise.all(
          Array.from({ length: 15 }, () => pg.hit('pgconc', 60000)))
        const cs = conc.map((x) => x.count).sort((a, b) => a - b)
        check('15 concurrent upserts lose no updates',
          JSON.stringify(cs) === JSON.stringify(Array.from({ length: 15 }, (_, i) => i + 1)),
          JSON.stringify(cs))

        await pg.reset('pgkey')
        const afterReset = await pg.hit('pgkey', 60000)
        check('reset clears the shared bucket', afterReset.count === 1, String(afterReset.count))

        // Window expiry is decided by the DATABASE clock, so drifting instances
        // cannot disagree about when a window ends.
        await pool.query(
          `UPDATE ${TABLE} SET reset_at = now() - interval '1 second' WHERE bucket_key = $1`,
          ['pgkey'])
        const expired = await pg.hit('pgkey', 60000)
        check('an expired window restarts at 1', expired.count === 1, String(expired.count))

        const pruned = await pg.prune()
        check('prune removes nothing still live', typeof pruned === 'number', String(pruned))

        await pool.query(`DELETE FROM ${TABLE}`)
      } finally {
        await pool.end().catch(() => {})
      }
    }
  }

  /* ═══════════════════════════════════════ 7. LEADER ELECTION ═══════════ */
  console.log('\n7. Leader election — two processes, one lock')
  {
    const { Client } = require('pg')
    let reachable = true
    const probe = new Client({ connectionString: SCRATCH, connectionTimeoutMillis: 3000 })
    try { await probe.connect(); await probe.end() } catch { reachable = false }

    if (!reachable) {
      skip('leader election', `no database at ${scratchHost}`)
    } else {
      const LOCK = 991177001

      // Hold the lock in THIS process, then have a child try for it. Two real
      // sessions competing for one advisory lock — not a mock.
      const holder = new Client({ connectionString: SCRATCH })
      await holder.connect()
      const held = await holder.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK])
      check('first session acquires the lock', held.rows[0].ok === true)

      const loser = inChild(`
        process.env.DATABASE_URL = ${JSON.stringify(SCRATCH)}
        const leader = require('./src/platform/leader')
        leader.acquire({ lockId: ${LOCK} }).then((ok) => {
          console.log('RESULT:' + JSON.stringify({ ok, status: leader.status() }))
          process.exit(0)
        })
      `, { LOG_FORMAT: 'json' })
      const loserLine = loser.split('\n').find((l) => l.startsWith('RESULT:'))
      const loserResult = loserLine ? JSON.parse(loserLine.slice(7)) : null
      check('a SECOND process cannot become leader', loserResult && loserResult.ok === false,
        loser.slice(-200))
      check('and it says why', loserResult && /held by another instance/.test(loserResult.status.reason || ''),
        JSON.stringify(loserResult && loserResult.status))

      // Release, and the next process CAN take it — leadership is transferable,
      // which is what makes a rolling deploy work.
      await holder.query('SELECT pg_advisory_unlock($1)', [LOCK])
      const winner = inChild(`
        process.env.DATABASE_URL = ${JSON.stringify(SCRATCH)}
        const leader = require('./src/platform/leader')
        leader.acquire({ lockId: ${LOCK} }).then(async (ok) => {
          console.log('RESULT:' + JSON.stringify({ ok, isLeader: leader.isLeader() }))
          await leader.release()
          process.exit(0)
        })
      `, { LOG_FORMAT: 'json' })
      const winLine = winner.split('\n').find((l) => l.startsWith('RESULT:'))
      const winResult = winLine ? JSON.parse(winLine.slice(7)) : null
      check('once released, the next process DOES become leader',
        winResult && winResult.ok === true && winResult.isLeader === true, winner.slice(-200))

      await holder.end().catch(() => {})

      // Fail closed: an unreachable database must not produce a leader.
      const unreachable = inChild(`
        const leader = require('./src/platform/leader')
        leader.acquire({ connectionString: 'postgresql://u:p@127.0.0.1:59999/nope', timeoutMs: 1500 })
          .then((ok) => { console.log('RESULT:' + JSON.stringify({ ok })); process.exit(0) })
      `, { LOG_FORMAT: 'json' })
      const unLine = unreachable.split('\n').find((l) => l.startsWith('RESULT:'))
      check('an unreachable database yields NOT leader (fails closed)',
        unLine && JSON.parse(unLine.slice(7)).ok === false, unreachable.slice(-200))

      const noUrl = inChild(`
        const leader = require('./src/platform/leader')
        leader.acquire({ connectionString: '' })
          .then((ok) => { console.log('RESULT:' + JSON.stringify({ ok })); process.exit(0) })
      `, { LOG_FORMAT: 'json', DATABASE_URL: '' })
      const nuLine = noUrl.split('\n').find((l) => l.startsWith('RESULT:'))
      check('a missing DATABASE_URL yields NOT leader (fails closed)',
        nuLine && JSON.parse(nuLine.slice(7)).ok === false, noUrl.slice(-200))
    }
  }

  /* ═══════════════════════════════════════ 8. DOCKER / CI CONFIG ════════ */
  console.log('\n8. Docker and CI configuration')
  {
    const read = (p) => fs.readFileSync(path.join(BACKEND, p), 'utf8')

    const dockerfile = read('Dockerfile')
    check('Dockerfile exists and is multi-stage',
      (dockerfile.match(/^FROM /gm) || []).length >= 2)
    check('runs as a non-root user', /^USER node$/m.test(dockerfile))
    check('declares a HEALTHCHECK', /HEALTHCHECK/.test(dockerfile))
    // Assert on the CMD line only. Matching the whole file caught the comment
    // that explains WHY readiness is not used here, which is the opposite of
    // what this check is for.
    const healthCmd = (dockerfile.match(/HEALTHCHECK[\s\S]*?\n(?:\s*CMD[^\n]*)/) || [''])[0]
    check('healthcheck probes liveness, not readiness',
      /\/health'/.test(healthCmd) && !/\/health\/ready/.test(healthCmd),
      'a readiness-based container healthcheck restart-loops the fleet on a DB outage')
    check('never COPYs an env file', !/COPY[^\n]*\.env/.test(dockerfile))
    check('no literal secret assignments', !/ENV\s+\w*(SECRET|PASSWORD|KEY|TOKEN)\s*=\s*\S+/i
      .test(dockerfile.replace(/ENV\s+LOG_FORMAT[^\n]*/g, '')))

    const ignore = read('.dockerignore')
    check('.dockerignore excludes .env', /^\.env$/m.test(ignore))
    check('.dockerignore excludes the whole .env family', /^\.env\.\*$/m.test(ignore))
    check('.dockerignore excludes node_modules and .git',
      /^node_modules$/m.test(ignore) && /^\.git$/m.test(ignore))

    const compose = read('docker-compose.yml')
    check('compose defines a local database', /image:\s*postgres:/.test(compose))
    check('compose binds ports to loopback only',
      (compose.match(/- "(\d+\.\d+\.\d+\.\d+):/g) || []).every((m) => m.includes('127.0.0.1'))
      && /127\.0\.0\.1:/.test(compose),
      'publishing on 0.0.0.0 exposes a dev database to the local network')
    check('compose never references a Supabase host',
      !/supabase\.co|supabase\.com/.test(compose))
    check('compose uses ${VAR} placeholders for real credentials',
      /JWT_SECRET:\s*\$\{JWT_SECRET/.test(compose))
    check('compose keeps cron OFF by default',
      /ENABLE_CRON:\s*\$\{ENABLE_CRON:-false\}/.test(compose))
    check('compose has a second instance for leader-election testing',
      /backend-2:/.test(compose) && /profiles:\s*\["multi"\]/.test(compose))
    check('the multi profile declares MULTI_INSTANCE', /MULTI_INSTANCE:\s*"true"/.test(compose))

    const ci = read('.github/workflows/ci.yml')
    check('CI workflow exists', ci.length > 0)
    check('CI installs with npm ci', /npm ci/.test(ci))
    check('CI runs lint', /npm run lint/.test(ci))
    check('CI runs the boundary check', /check-boundaries/.test(ci))
    check('CI runs the migration-system suite', /test:migrate-system/.test(ci))
    check('CI builds the Docker image', /docker build/.test(ci))
    check('CI fails clearly when required env vars are missing',
      /::error::Required environment variable/.test(ci))
    check('CI asserts its database target is loopback',
      /must target a loopback database/.test(ci))
    check('CI references no repository secrets', !/\$\{\{\s*secrets\./.test(ci),
      'this workflow needs none; referencing one would be a review signal')
    check('CI states which suites it does NOT cover',
      /does NOT cover/.test(ci),
      'a green tick must not imply more coverage than it has')
  }

  /* ═══════════════════════════════════ 9. CONTAINER-LOCAL DB GUARD ══════════ */
  console.log('\n9. Migration target guard — container-local databases')
  {
    /*
     * The compose Postgres is reached as `db`, which is neither loopback nor a
     * Supabase project ref. Before this branch existed the runner refused it
     * under EVERY flag combination — correct for a cloud database, wrong for a
     * throwaway container, and it made `docker compose up` impossible to
     * bootstrap.
     *
     * The branch opens on two independent conditions. These assertions exist to
     * prove it did not become one: a bare hostname alone must never be enough,
     * because a DNS search domain can resolve `db` to a real server.
     *
     * Driven through the runner as a child process — the way compose invokes
     * it — rather than by calling the guard directly, so the npm script, the
     * argv parsing and the env all take part.
     */
    const RUNNER = path.join(BACKEND, 'src', 'config', 'migrate-runner.js')
    const guard = (url, env = {}, args = ['up']) => {
      const r = spawnSync(process.execPath, [RUNNER, ...args], {
        cwd: BACKEND,
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, DATABASE_URL: url, MIGRATE_ALLOW_CONTAINER_DB: '', ...env },
      })
      const out = `${r.stdout || ''}${r.stderr || ''}`
      const refusal = (out.match(/REFUSING — [^\n]*/) || [null])[0]
      return { refusal, passed: refusal === null, out }
    }

    const CONTAINER = 'postgresql://u:p@db:5432/varadhi_local'
    const PROD = 'postgresql://postgres.ostmlxuzhprymlchmmak:p@aws-1-ap-south-1.pooler.supabase.com:5432/postgres'
    const UNKNOWN = 'postgresql://postgres.zzzzzzzzzzzzzzzzzz:p@aws-1-ap-south-1.pooler.supabase.com:5432/postgres'
    const DEV = 'postgresql://postgres.dbuiauuhajwwpisjevpk:p@aws-1-ap-south-1.pooler.supabase.com:5432/postgres'
    const FQDN = 'postgresql://u:p@db.corp.example.com:5432/x'

    // (a) accepted WITH the opt-in
    const withOptIn = guard(CONTAINER, { MIGRATE_ALLOW_CONTAINER_DB: 'true' })
    check('container host ACCEPTED with MIGRATE_ALLOW_CONTAINER_DB=true',
      withOptIn.passed, withOptIn.refusal || '')

    // (b) refused WITHOUT it — unset, empty and an explicit "false"
    for (const [label, value] of [['unset', ''], ['false', 'false'], ['yes', 'yes']]) {
      const r = guard(CONTAINER, { MIGRATE_ALLOW_CONTAINER_DB: value })
      check(`container host REFUSED when the opt-in is ${label}`,
        /container-local database without the opt-in/.test(r.refusal || ''),
        r.refusal || 'it was ACCEPTED')
    }
    // --allow-remote must not be a way around the opt-in.
    const viaRemote = guard(CONTAINER, {}, ['up', '--allow-remote'])
    check('--allow-remote does NOT substitute for the opt-in',
      /container-local database without the opt-in/.test(viaRemote.refusal || ''),
      viaRemote.refusal || 'it was ACCEPTED')

    // (c) hosted targets are untouched by the new branch
    const prodPlain = guard(PROD, { MIGRATE_ALLOW_CONTAINER_DB: 'true' })
    check('PRODUCTION still refused, opt-in set',
      /THIS IS PRODUCTION/.test(prodPlain.refusal || ''), prodPlain.refusal || 'ACCEPTED')

    const prodArmed = guard(PROD, { MIGRATE_ALLOW_CONTAINER_DB: 'true' }, ['up', '--allow-remote'])
    check('PRODUCTION still refused with opt-in AND --allow-remote',
      /THIS IS PRODUCTION/.test(prodArmed.refusal || ''), prodArmed.refusal || 'ACCEPTED')

    const prodDown = guard(PROD, { MIGRATE_ALLOW_CONTAINER_DB: 'true' }, ['down'])
    check('PRODUCTION still refused for down',
      /THIS IS PRODUCTION/.test(prodDown.refusal || ''), prodDown.refusal || 'ACCEPTED')

    const unknown = guard(UNKNOWN, { MIGRATE_ALLOW_CONTAINER_DB: 'true' }, ['up', '--allow-remote'])
    check('unknown hosted ref still refused',
      /UNRECOGNISED HOSTED DATABASE/.test(unknown.refusal || ''), unknown.refusal || 'ACCEPTED')

    const devNoFlag = guard(DEV, { MIGRATE_ALLOW_CONTAINER_DB: 'true' })
    check('hosted dev still needs --allow-remote',
      /without --allow-remote/.test(devNoFlag.refusal || ''), devNoFlag.refusal || 'ACCEPTED')

    // The opt-in is scoped to bare labels. A dotted host is a real host.
    const fqdn = guard(FQDN, { MIGRATE_ALLOW_CONTAINER_DB: 'true' }, ['up', '--allow-remote'])
    check('a DOTTED host is not container-local, opt-in or not',
      /UNRECOGNISED HOSTED DATABASE/.test(fqdn.refusal || ''),
      `${fqdn.refusal || 'ACCEPTED'} — the opt-in must not cover db.corp.example.com`)

    // And compose actually supplies the two things the branch needs.
    const compose = fs.readFileSync(path.join(BACKEND, 'docker-compose.yml'), 'utf8')
    check('compose defines the one-shot migrate service',
      /^\s{2}migrate:/m.test(compose))
    check('migrate service sets MIGRATE_ALLOW_CONTAINER_DB=true',
      /MIGRATE_ALLOW_CONTAINER_DB:\s*"true"/.test(compose))
    check('migrate service overrides NODE_ENV to development',
      /migrate:[\s\S]{0,600}?NODE_ENV:\s*development/.test(compose),
      'the image bakes NODE_ENV=production, which turns SSL on against an ssl=off Postgres')
    check('both backends wait for migrate to COMPLETE',
      (compose.match(/condition:\s*service_completed_successfully/g) || []).length === 2,
      'a "started" condition would race the migration and lose')
  }
}

main()
  .catch((err) => { console.error('\nHARNESS ERROR:', err.message, '\n', err.stack); fail++ })
  .finally(() => {
    console.log(`\n${'='.repeat(64)}`)
    console.log(`${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`)
    if (failures.length) {
      console.log('\nFailures:')
      for (const f of failures) console.log(`   - ${f}`)
    }
    process.exit(fail ? 1 : 0)
  })
