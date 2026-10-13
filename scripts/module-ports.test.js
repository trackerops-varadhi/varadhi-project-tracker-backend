#!/usr/bin/env node
/**
 * Module port wiring — the questions a module asks and does not answer.
 *
 *     npm run test:ports
 *
 * Two ports so far, both created to break a dependency cycle:
 *   workforce/org.js        who does this person report to?   answered by people
 *   work/linked-bugs.js     which bug is this task from?      answered by defects
 *
 * NO DATABASE, NO RUNNING API. Every other test:* harness in this repo drives
 * the live API on :5000; this one deliberately does not touch either, because
 * what it checks is composition: that workforce can ask who someone reports to
 * without requiring `people`, that `people` is what answers, and that the
 * answer is filtered the way the two call sites assume.
 *
 * WHY IT IS WORTH A TEST
 * Breaking the people <-> workforce cycle replaced a static require with a
 * resolver registered at boot. That trade is the point — the dependency now
 * points one way and the modules can be deployed apart — but it moves a
 * compile-time guarantee to runtime: delete the registration and manager
 * escalations stop, silently, with every leave request still succeeding. These
 * assertions are what notices.
 */

// Nothing here connects to anything, but loading people/index.js builds its
// route tree, which constructs the Supabase storage client for resumes — and
// that throws at require time without SUPABASE_URL. Same reason every other
// harness in scripts/ loads .env.
require('dotenv').config()

const assert = require('assert')

let failures = 0
const check = (name, fn) => {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') {
      return r.then(
        () => console.log(`  ok    ${name}`),
        (err) => { failures += 1; console.log(`  FAIL  ${name}\n          ${err.message}`) }
      )
    }
    console.log(`  ok    ${name}`)
    return Promise.resolve()
  } catch (err) {
    failures += 1
    console.log(`  FAIL  ${name}\n          ${err.message}`)
    return Promise.resolve()
  }
}

async function main() {
  console.log('\nModule port wiring\n')

  console.log('workforce/org - the org chart, answered by people')

  // Required directly: this is a test about the port, not about the module's
  // HTTP surface, and loading workforce/index.js would pull in its routes.
  const org = require('../src/modules/workforce/org')

  await check('with no resolver registered, the map is empty rather than a throw', async () => {
    const map = await org.reportingManagersFor(['u1', 'u2'])
    assert.strictEqual(map.size, 0)
    assert.strictEqual(org.hasReportingManagerResolver(), false)
  })

  await check('an empty or all-falsy id list never calls the resolver', async () => {
    let called = false
    org.setReportingManagerResolver(async () => { called = true; return new Map() })
    assert.strictEqual((await org.reportingManagersFor([])).size, 0)
    assert.strictEqual((await org.reportingManagersFor([null, undefined, ''])).size, 0)
    assert.strictEqual(called, false, 'resolver was called for nothing to resolve')
  })

  await check('ids are de-duplicated before the resolver sees them', async () => {
    let seen = null
    org.setReportingManagerResolver(async (ids) => { seen = ids; return new Map() })
    await org.reportingManagersFor(['u1', 'u1', 'u2', 'u1'])
    assert.deepStrictEqual(seen, ['u1', 'u2'])
  })

  await check('a user with no manager is absent, not present-with-null', async () => {
    org.setReportingManagerResolver(async () => new Map([['u1', null], ['u2', 'mgr']]))
    const map = await org.reportingManagersFor(['u1', 'u2'])
    assert.strictEqual(map.has('u1'), false)
    assert.strictEqual(map.get('u2'), 'mgr')
  })

  // Both call sites used to write `if (!managerId || managerId === userId)`.
  // That rule now lives in one place, so this is what keeps it true.
  await check('a self-managed reporting line is dropped', async () => {
    org.setReportingManagerResolver(async () => new Map([['u1', 'u1'], ['u2', 'mgr']]))
    const map = await org.reportingManagersFor(['u1', 'u2'])
    assert.strictEqual(map.has('u1'), false, 'u1 reports to u1 and would be told about itself')
    assert.strictEqual(map.get('u2'), 'mgr')
  })

  await check('reportingManagerFor returns null for one unresolvable user', async () => {
    org.setReportingManagerResolver(async () => new Map([['u1', 'u1']]))
    assert.strictEqual(await org.reportingManagerFor('u1'), null)
    assert.strictEqual(await org.reportingManagerFor('nobody'), null)
  })

  await check('registering a non-function is refused', () => {
    assert.throws(() => org.setReportingManagerResolver(null), TypeError)
    assert.throws(() => org.setReportingManagerResolver('people'), TypeError)
  })

  await check('people.subscribe() is what registers the resolver', () => {
    // Loaded here rather than at the top so the "no resolver" case above runs
    // against a genuinely unwired port.
    const people = require('../src/modules/people')
    const workforce = require('../src/modules/workforce')

    assert.strictEqual(typeof people.subscribe, 'function', 'people must expose subscribe()')
    assert.strictEqual(
      typeof workforce.setReportingManagerResolver, 'function',
      'workforce must expose the port on its public surface'
    )

    people.subscribe()
    assert.strictEqual(workforce.hasReportingManagerResolver(), true)

    // server.js calls subscribe() for every module on every boot; a second call
    // must not be a second registration that breaks.
    people.subscribe()
    assert.strictEqual(workforce.hasReportingManagerResolver(), true)
  })

  await check('workforce does not require people — the cycle is gone', () => {
    const fs = require('fs')
    const path = require('path')
    const dir = path.join(__dirname, '..', 'src', 'modules', 'workforce')

    const offenders = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .filter((f) => {
        const src = fs.readFileSync(path.join(dir, f), 'utf8')
        // Strip comments the crude way: this file's own prose mentions the
        // require it is asserting the absence of, and so does org.js.
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
        return /require\(\s*['"]\.\.\/people['"]\s*\)/.test(code)
      })

    assert.deepStrictEqual(offenders, [], `workforce still requires people in: ${offenders.join(', ')}`)
  })

  console.log('')
  console.log('work/linked-bugs - the bug behind a task, answered by defects')

  const linkedBugs = require('../src/modules/work/linked-bugs')

  await check('with no provider registered, the map is empty rather than a throw', async () => {
    assert.strictEqual(linkedBugs.hasBugCardProvider(), false)
    assert.strictEqual((await linkedBugs.bugCardsFor(['t1', 't2'])).size, 0)
  })

  await check('an empty or all-falsy id list never calls the provider', async () => {
    let called = false
    linkedBugs.setBugCardProvider(async () => { called = true; return new Map() })
    assert.strictEqual((await linkedBugs.bugCardsFor([])).size, 0)
    assert.strictEqual((await linkedBugs.bugCardsFor([null, undefined, ''])).size, 0)
    assert.strictEqual(called, false, 'provider was called for nothing to resolve')
  })

  await check('task ids are de-duplicated before the provider sees them', async () => {
    let seen = null
    linkedBugs.setBugCardProvider(async (ids) => { seen = ids; return new Map() })
    await linkedBugs.bugCardsFor(['t1', 't1', 't2', 't1'])
    assert.deepStrictEqual(seen, ['t1', 't2'])
  })

  // Most tasks are not bugs, so the common case is a provider returning fewer
  // entries than it was asked about. tasks.service reads the result with
  // `?? null`, so a missing key must stay missing rather than become undefined.
  await check('tasks with no bug are simply absent from the map', async () => {
    linkedBugs.setBugCardProvider(async () => new Map([['t2', { key: 'BUG-7' }]]))
    const map = await linkedBugs.bugCardsFor(['t1', 't2'])
    assert.strictEqual(map.has('t1'), false)
    assert.strictEqual(map.get('t2').key, 'BUG-7')
  })

  await check('a provider returning nothing at all degrades to an empty map', async () => {
    linkedBugs.setBugCardProvider(async () => undefined)
    assert.strictEqual((await linkedBugs.bugCardsFor(['t1'])).size, 0)
  })

  await check('registering a non-function is refused', () => {
    assert.throws(() => linkedBugs.setBugCardProvider(null), TypeError)
    assert.throws(() => linkedBugs.setBugCardProvider('defects'), TypeError)
  })

  await check('defects.subscribe() is what registers the provider', () => {
    const defects = require('../src/modules/defects')
    const work = require('../src/modules/work')

    assert.strictEqual(typeof defects.subscribe, 'function')
    assert.strictEqual(
      typeof work.setBugCardProvider, 'function',
      'work must expose the port on its public surface'
    )

    defects.subscribe()
    assert.strictEqual(work.hasBugCardProvider(), true)

    // server.js calls subscribe() for every module on every boot.
    defects.subscribe()
    assert.strictEqual(work.hasBugCardProvider(), true)

    defects.unsubscribe()
  })

  await check('work does not require defects - the cycle is gone', () => {
    const fs = require('fs')
    const path = require('path')
    const dir = path.join(__dirname, '..', 'src', 'modules', 'work')

    // Line-based rather than a regex, and comment lines are dropped: both
    // projects.routes.js and linked-bugs.js explain in prose the require this
    // is asserting the absence of.
    const offenders = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .filter((f) => fs.readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))
        .some((l) => l.includes("require('../defects')")))

    assert.deepStrictEqual(offenders, [], `work still requires defects in: ${offenders.join(', ')}`)
  })

  console.log(failures ? `\n${failures} failure(s)\n` : '\nAll port checks passed\n')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error(`\nPORT TEST CRASHED: ${err.message}\n`)
  process.exit(1)
})
