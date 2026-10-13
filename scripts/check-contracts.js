#!/usr/bin/env node
/**
 * Module consumption contracts — what each module actually asks of the others.
 * ---------------------------------------------------------------------------
 *
 *     npm run modules:contracts          print the measured surface
 *     npm run lint:contracts             fail on undeclared or stale consumption
 *     npm run lint:contracts -- --write  regenerate every `consumes` manifest
 *
 * WHY THIS EXISTS
 * `lint:boundaries` proves a module is only reached through its index.js, and
 * the graph says WHO reaches whom. Neither says WHAT is reached — and that is
 * the list you need to extract a service, because it becomes the HTTP API. Up
 * to now it existed only as a question you could answer by grepping.
 *
 * So each module declares, in its own index.js:
 *
 *     exports.consumes = {
 *       work: ['getProjectCards', 'projectExists', 'events'],
 *       identity: ['getUserCards'],
 *     }
 *
 * and this script checks the declaration against what the code does. Two
 * failures, both worth failing on:
 *
 *   UNDECLARED  the code calls something the manifest does not list. An
 *               extraction built from the manifest would ship a client missing
 *               that call, and it would fail in production, not at build time.
 *   STALE       the manifest lists something the code no longer calls. Harmless
 *               at runtime and expensive later: it is one more endpoint the
 *               extracted service has to keep serving for no reader.
 *
 * STATIC ON PURPOSE. No app module is required, no env is read, no database is
 * touched — so this runs in CI next to lint:boundaries, with nothing
 * configured. The cost is that it understands the three require idioms this
 * codebase actually uses and nothing cleverer:
 *
 *     const identity = require('../identity')          identity.foo
 *     const identity = () => require('../identity')    identity().foo
 *     const { foo, BAR } = require('../notify')        foo, BAR
 *
 * A fourth idiom would read as zero usage, so the manifest would look stale
 * rather than silently wrong — the failure points at this file, which is the
 * right direction for it to point.
 */

const fs = require('fs')
const path = require('path')

const MODULES_DIR = path.join(__dirname, '..', 'src', 'modules')

const moduleNames = () =>
  fs.readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()

const filesIn = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) return filesIn(full)
      return e.name.endsWith('.js') ? [full] : []
    })

/**
 * Strip comments so prose cannot be mistaken for code. Conservative, like
 * check-boundaries' isInComment: line comments and block comments only, and a
 * string containing a comment opener is left alone because the consequence of
 * over-stripping (a missed usage, reported as a stale manifest entry) is
 * noisier than the consequence of under-stripping.
 */
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//')
      return i === -1 ? line : line.slice(0, i)
    })
    .join('\n')

/**
 * Every member of `<other module>` that `src` reads, by binding form.
 * @returns {Map<string, Set<string>>} target module -> member names
 */
function usedMembers(src, targets) {
  const out = new Map()
  const add = (target, member) => {
    if (!out.has(target)) out.set(target, new Set())
    out.get(target).add(member)
  }

  const code = stripComments(src)

  for (const target of targets) {
    // 3. Destructured: const { a, b } = require('../x')
    const destructured = new RegExp(
      `const\\s*\\{([^}]*)\\}\\s*=\\s*require\\(\\s*['"]\\.\\./${target}['"]\\s*\\)`,
      'g'
    )
    for (const m of code.matchAll(destructured)) {
      for (const part of m[1].split(',')) {
        // `a`, `a: b`, `a = fallback` all name `a` on the far side.
        const name = part.split(':')[0].split('=')[0].trim()
        if (name) add(target, name)
      }
    }

    // 1 and 2. A binding, eager or lazy, then `binding.member` /
    // `binding().member`. Both forms are collected from the same binding name.
    const bindings = new Set()
    const bound = new RegExp(
      `const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:\\(\\s*\\)\\s*=>\\s*)?require\\(\\s*['"]\\.\\./${target}['"]\\s*\\)`,
      'g'
    )
    for (const m of code.matchAll(bound)) bindings.add(m[1])

    for (const binding of bindings) {
      const member = new RegExp(`\\b${binding}\\s*(?:\\(\\s*\\))?\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g')
      for (const m of code.matchAll(member)) add(target, m[1])
    }

    // Inline, with no binding at all: require('../x').member
    const inline = new RegExp(
      `require\\(\\s*['"]\\.\\./${target}['"]\\s*\\)\\s*\\.\\s*([A-Za-z_$][\\w$]*)`,
      'g'
    )
    for (const m of code.matchAll(inline)) add(target, m[1])
  }

  return out
}

/** `exports.foo = ...` in a module's index.js — its public surface. */
function declaredExports(moduleName) {
  const index = path.join(MODULES_DIR, moduleName, 'index.js')
  if (!fs.existsSync(index)) return new Set()
  const code = stripComments(fs.readFileSync(index, 'utf8'))
  return new Set([...code.matchAll(/^\s*exports\.([A-Za-z_$][\w$]*)\s*=/gm)].map((m) => m[1]))
}

/** The `consumes` manifest a module declares, or null if it has none yet. */
function declaredConsumes(moduleName) {
  const index = path.join(MODULES_DIR, moduleName, 'index.js')
  if (!fs.existsSync(index)) return null
  const code = stripComments(fs.readFileSync(index, 'utf8'))
  const m = /exports\.consumes\s*=\s*\{([\s\S]*?)\n\}/.exec(code)
  if (!m) return null

  const out = {}
  for (const entry of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*\[([^\]]*)\]/g)) {
    out[entry[1]] = [...entry[2].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]).sort()
  }
  return out
}

/* ── Measure ──────────────────────────────────────────────────────────────── */

const modules = moduleNames()
const surface = new Map() // module -> Map<target, Set<member>>

for (const mod of modules) {
  const targets = modules.filter((m) => m !== mod)
  const merged = new Map()

  for (const file of filesIn(path.join(MODULES_DIR, mod))) {
    const src = fs.readFileSync(file, 'utf8')
    for (const [target, members] of usedMembers(src, targets)) {
      if (!merged.has(target)) merged.set(target, new Set())
      for (const member of members) merged.get(target).add(member)
    }
  }

  surface.set(mod, merged)
}

const exportsOf = new Map(modules.map((m) => [m, declaredExports(m)]))

/* ── --write: regenerate the manifests in place ───────────────────────────── */

const renderManifest = (used) => {
  const lines = ['exports.consumes = {']
  for (const target of [...used.keys()].sort()) {
    const members = [...used.get(target)].sort()
    lines.push(`  ${target}: [${members.map((x) => `'${x}'`).join(', ')}],`)
  }
  lines.push('}')
  return lines.join('\n')
}

const MANIFEST_HEADER = `/* ── What this module consumes ───────────────────────────────────────────── */
//
// GENERATED, and checked by \`npm run lint:contracts\`. Every name here is read
// from another module's index.js, so this list IS this module's half of the
// future HTTP contract: extract it and these become the calls its client makes.
// Do not hand-edit — change the code, then run \`npm run lint:contracts -- --write\`.
`

if (process.argv.includes('--write')) {
  for (const mod of modules) {
    const used = surface.get(mod)
    const index = path.join(MODULES_DIR, mod, 'index.js')
    let src = fs.readFileSync(index, 'utf8')

    const block = used.size === 0
      ? `${MANIFEST_HEADER}//\n// This module consumes nothing from its siblings.\nexports.consumes = {}\n`
      : `${MANIFEST_HEADER}${renderManifest(used)}\n`

    const existing = /\/\* ── What this module consumes[\s\S]*?\nexports\.consumes = (?:\{[\s\S]*?\n\}|\{\})\n/
    src = existing.test(src)
      ? src.replace(existing, block)
      : `${src.replace(/\n+$/, '')}\n\n${block}`

    fs.writeFileSync(index, src, 'utf8')
  }
  console.log(`\nRewrote ${modules.length} consumes manifest(s).\n`)
}

/* ── Report ───────────────────────────────────────────────────────────────── */

const problems = []
const wide = process.argv.includes('--surface') || process.argv.includes('--graph')

console.log(`\nModule contracts — ${modules.length} modules\n`)

for (const mod of modules) {
  const used = surface.get(mod)
  const declared = declaredConsumes(mod)

  if (wide) {
    const total = [...used.values()].reduce((n, s) => n + s.size, 0)
    console.log(`  ${mod}${total ? '' : '  (consumes nothing)'}`)
    for (const target of [...used.keys()].sort()) {
      console.log(`    -> ${target.padEnd(13)} ${[...used.get(target)].sort().join(', ')}`)
    }
  }

  if (declared === null) {
    problems.push({ mod, kind: 'missing', detail: 'no exports.consumes manifest' })
    continue
  }

  for (const target of new Set([...used.keys(), ...Object.keys(declared)])) {
    const u = [...(used.get(target) || [])].sort()
    const d = declared[target] || []

    for (const member of u.filter((x) => !d.includes(x))) {
      problems.push({ mod, kind: 'undeclared', detail: `${target}.${member}` })
    }
    for (const member of d.filter((x) => !u.includes(x))) {
      problems.push({ mod, kind: 'stale', detail: `${target}.${member}` })
    }
    // A name the target does not export is a call that would already be
    // failing, or a public surface that has drifted since.
    for (const member of u.filter((x) => !exportsOf.get(target)?.has(x))) {
      problems.push({ mod, kind: 'not-exported', detail: `${target}.${member}` })
    }
  }
}

if (wide) console.log('')

const LABEL = {
  missing: 'has no consumes manifest',
  undeclared: 'calls something it does not declare',
  stale: 'declares something it no longer calls',
  'not-exported': 'calls something the target does not export',
}

if (problems.length === 0) {
  console.log('  ✓ every manifest matches the code\n')
  process.exit(0)
}

for (const kind of ['not-exported', 'undeclared', 'stale', 'missing']) {
  const group = problems.filter((p) => p.kind === kind)
  if (group.length === 0) continue
  console.log(`  ✗ ${group.length} × ${LABEL[kind]}:`)
  for (const p of group) console.log(`      ${p.mod.padEnd(13)} ${p.detail}`)
  console.log('')
}

console.log('  Regenerate the manifests deliberately: npm run lint:contracts -- --write\n')
process.exit(1)
