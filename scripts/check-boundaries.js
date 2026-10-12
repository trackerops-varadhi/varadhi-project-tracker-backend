#!/usr/bin/env node
/**
 * Module boundary checker.
 *
 * The whole value of the modules/ restructure is that a module's internals stay
 * private. Nothing enforces that in JavaScript, so without a check this decays
 * back to spaghetti within a quarter — someone reaches for
 * `require('../work/repo')` because it is right there, and the boundary is gone
 * with no error and no review comment.
 *
 * THE RULE
 *   modules/<A>/index.js is the only file any code outside modules/<A>/ may
 *   require. Inside its own directory a module may require whatever it likes.
 *
 * Deliberately hand-rolled rather than an eslint rule: the backend has no
 * eslint config, no lint script and no plugin chain today, and `require()`
 * paths are not covered by core eslint's no-restricted-imports anyway (that
 * rule only sees ESM `import`). This matches the repo's existing convention of
 * plain `node scripts/*.js` harnesses with no framework.
 *
 *   npm run lint:boundaries      -> exits 1 on any violation
 */
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'src')
const MODULES_DIR = path.join(SRC, 'modules')

// Legacy paths that still exist as re-export shims. Not violations — they are
// the migration's own scaffolding — but worth counting so the shims actually
// get deleted rather than living forever.
// Two shims have already reached zero and been deleted: 'config/supabase' when
// defects migrated, 'utils/response' when integrations did. 'config/db' is the
// last one — the remaining importers are migration scripts under config/, which
// are not domain code and move with the Phase 2 schema work.
const SHIMS = {
  'config/db': 'platform/db',
}

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full, out)
    } else if (entry.name.endsWith('.js')) {
      out.push(full)
    }
  }
  return out
}

// Which module does this file belong to? null = outside modules/.
const moduleOf = (file) => {
  const rel = path.relative(MODULES_DIR, file)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep)[0]
}

// Resolve a relative require spec to a real file on disk.
const resolveSpec = (fromFile, spec) => {
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

const REQUIRE_RE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g

const violations = []
const shimUsers = []
const files = walk(SRC)

/**
 * The cross-module dependency graph, collected while the boundary walk is
 * already reading every file.
 *
 * WHY IT IS WORTH COLLECTING
 * The boundary rule says a module may only be reached through its index.js. It
 * says nothing about WHO reaches whom, and that is the question that decides
 * whether a module can ever be extracted. Two things fall out of the graph that
 * nothing else in the repo can tell you:
 *
 *   - a module nobody depends on can be lifted out without writing a single
 *     HTTP client for it;
 *   - a CYCLE cannot be extracted at all. `work` requires `defects` and
 *     `defects` requires `work`; behind a network that is two services that
 *     each need the other to start, and neither can be deployed alone.
 *
 * Node's circular `require` is already worked around in this codebase with the
 * lazy `const notify = () => require('../notify')` form. That hides the cycle
 * from Node. It does not remove it — over HTTP a lazy require is just a lazy
 * client, and the cycle is still there.
 *
 * So the existing cycles are recorded in a baseline and NEW ones fail. The
 * point is not to pretend the current ones are fine; it is that they are a
 * known, bounded piece of work, and a tenth one appearing by accident is not.
 */
const edges = new Map() // "from->to" -> { from, to, files: Set<string> }

const addEdge = (from, to, file) => {
  const key = `${from}->${to}`
  if (!edges.has(key)) edges.set(key, { from, to, files: new Set() })
  // Forward slashes: this output is read on Windows and in CI, and a path that
  // changes shape between them is a path you cannot grep for.
  edges.get(key).files.add(path.relative(SRC, file).split(path.sep).join('/'))
}

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  const owner = moduleOf(file)

  for (const m of src.matchAll(REQUIRE_RE)) {
    const spec = m[1]
    const target = resolveSpec(file, spec)
    if (!target) continue

    const targetOwner = moduleOf(target)
    // Only cross-module (or outside-in) references are constrained.
    if (!targetOwner || targetOwner === owner) continue

    // Recorded whether or not it is a violation: the dependency exists either
    // way, and reaching past index.js does not make it less of one.
    if (owner) addEdge(owner, targetOwner, file)

    const isPublicSurface =
      path.resolve(target) === path.resolve(MODULES_DIR, targetOwner, 'index.js')

    if (!isPublicSurface) {
      violations.push({
        file: path.relative(SRC, file),
        spec,
        target: path.relative(SRC, target),
        from: owner ? `modules/${owner}` : 'outside modules/',
        wanted: `modules/${targetOwner}`,
      })
    }
  }

  for (const [shim, replacement] of Object.entries(SHIMS)) {
    if (src.includes(`/${shim}'`) || src.includes(`/${shim}"`)) {
      shimUsers.push({ file: path.relative(SRC, file), shim, replacement })
    }
  }
}

// ── dependency graph analysis ─────────────────────────────────────────────
const nodes = [...new Set([...edges.values()].flatMap((e) => [e.from, e.to]))].sort()
const out = new Map(nodes.map((n) => [n, []]))
const inbound = new Map(nodes.map((n) => [n, []]))
for (const e of edges.values()) {
  out.get(e.from).push(e.to)
  inbound.get(e.to).push(e.from)
}

/**
 * Tarjan's strongly-connected components.
 *
 * SCCs rather than a list of every two-module loop, because a component is the
 * actionable unit: every module inside one is mutually reachable, so they come
 * out together or not at all. Four modules in one knot is one piece of work to
 * plan, where the six pairwise loops inside it are six symptoms of it.
 */
function stronglyConnected() {
  let index = 0
  const idx = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const components = []

  const strongConnect = (v) => {
    idx.set(v, index)
    low.set(v, index)
    index += 1
    stack.push(v)
    onStack.add(v)

    for (const w of out.get(v) || []) {
      if (!idx.has(w)) {
        strongConnect(w)
        low.set(v, Math.min(low.get(v), low.get(w)))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), idx.get(w)))
      }
    }

    if (low.get(v) === idx.get(v)) {
      const component = []
      let w
      do {
        w = stack.pop()
        onStack.delete(w)
        component.push(w)
      } while (w !== v)
      components.push(component.sort())
    }
  }

  for (const v of nodes) if (!idx.has(v)) strongConnect(v)
  return components
}

const components = stronglyConnected()
const knots = components.filter((c) => c.length > 1)
const sccOf = new Map()
components.forEach((c, i) => c.forEach((n) => sccOf.set(n, i)))

// An edge inside a knot is an edge that participates in a cycle. These are what
// the baseline records, so the failure can name the exact require to look at.
const cyclicEdges = [...edges.values()]
  .filter((e) => e.from !== e.to && sccOf.get(e.from) === sccOf.get(e.to) && knots.some((k) => k.includes(e.from)))
  .map((e) => ({ key: `${e.from}->${e.to}`, files: [...e.files].sort() }))
  .sort((a, b) => a.key.localeCompare(b.key))

const BASELINE = path.join(__dirname, 'module-graph.baseline.json')
const baseline = fs.existsSync(BASELINE)
  ? JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
  : { cyclicEdges: [] }

const baselineSet = new Set(baseline.cyclicEdges || [])
let newCycles = cyclicEdges.filter((e) => !baselineSet.has(e.key))
let fixedCycles = [...baselineSet].filter((k) => !cyclicEdges.some((e) => e.key === k))

if (process.argv.includes('--update-baseline')) {
  fs.writeFileSync(
    BASELINE,
    `${JSON.stringify({
      note: 'Cross-module requires that take part in a cycle. A cycle cannot be extracted into its own service, so new ones fail the check. Shrink this list; do not grow it. Regenerate deliberately with: npm run lint:boundaries -- --update-baseline',
      updated: new Date().toISOString().slice(0, 10),
      cyclicEdges: cyclicEdges.map((e) => e.key),
    }, null, 2)}\n`,
    'utf8'
  )
  console.log(`\nBaseline rewritten: ${cyclicEdges.length} cyclic edge(s) recorded.`)
  if (newCycles.length) console.log(`  accepted as intended: ${newCycles.map((e) => e.key).join(', ')}`)
  if (fixedCycles.length) console.log(`  dropped, no longer cyclic: ${fixedCycles.join(', ')}`)
  console.log('')

  // The file on disk now says this is the expected state, so the run that wrote
  // it must not also fail against the version it replaced.
  newCycles = []
  fixedCycles = []
}

// ── report ────────────────────────────────────────────────────────────────
const moduleNames = fs.existsSync(MODULES_DIR)
  ? fs.readdirSync(MODULES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : []

console.log(`\nBoundary check — ${files.length} files, ${moduleNames.length} modules (${moduleNames.join(', ')})\n`)

if (violations.length) {
  console.log(`✗ ${violations.length} boundary violation(s):\n`)
  for (const v of violations) {
    console.log(`  ${v.file}`)
    console.log(`      requires '${v.spec}' -> ${v.target}`)
    console.log(`      ${v.from} may only reach ${v.wanted} through its index.js\n`)
  }
} else {
  console.log('✓ no boundary violations')
}

if (shimUsers.length) {
  const counts = shimUsers.reduce((acc, s) => ({ ...acc, [s.shim]: (acc[s.shim] || 0) + 1 }), {})
  console.log(`\n  migration debt — files still importing a shim:`)
  for (const [shim, n] of Object.entries(counts)) {
    console.log(`    ${n.toString().padStart(3)} x ${shim}  ->  ${SHIMS[shim]}`)
  }
  console.log('    (not a failure; the shims are deleted when these reach 0)')
}

// ── dependency graph report ───────────────────────────────────────────────
console.log('')
console.log(`  Dependency graph — ${edges.size} cross-module edges`)

if (process.argv.includes('--graph')) {
  console.log('')
  console.log('    module          depended on by   depends on')
  console.log('    ------          --------------   ----------')
  for (const n of nodes) {
    const ins = [...new Set(inbound.get(n))].sort()
    const outs = [...new Set(out.get(n))].sort()
    console.log(
      `    ${n.padEnd(15)} ${String(ins.length).padStart(2)}`.padEnd(38) +
      (outs.length ? outs.join(', ') : '-')
    )
  }
}

// Who could leave today. Zero inbound means nothing has to learn to call it
// over a network; being outside every knot means it has no mutual dependency
// to break first.
const extractable = nodes.filter((n) => inbound.get(n).length === 0 && !knots.some((k) => k.includes(n)))
if (extractable.length) {
  console.log('')
  console.log(`  Extractable today (nothing depends on them): ${extractable.join(', ')}`)
  for (const n of extractable) {
    const outs = [...new Set(out.get(n))].sort()
    console.log(`    ${n} would need an HTTP client for: ${outs.length ? outs.join(', ') : 'nothing'}`)
  }
}

if (knots.length) {
  console.log('')
  console.log(`  ${knots.length} cycle(s) — these modules cannot be extracted separately:`)
  for (const k of knots) console.log(`    { ${k.join(' <-> ')} }`)
  console.log(`    ${cyclicEdges.length} of the ${edges.size} edges take part in one.`)
}

if (fixedCycles.length) {
  console.log('')
  console.log(`  ✓ ${fixedCycles.length} baselined cycle edge(s) are gone: ${fixedCycles.join(', ')}`)
  console.log('    Shrink the baseline: npm run lint:boundaries -- --update-baseline')
}

if (newCycles.length) {
  console.log('')
  console.log(`  ✗ ${newCycles.length} NEW cyclic dependenc${newCycles.length === 1 ? 'y' : 'ies'}:`)
  for (const e of newCycles) {
    console.log(`\n      ${e.key}`)
    for (const f of e.files) console.log(`        ${f}`)
  }
  console.log('')
  console.log('    A cycle cannot be extracted into its own service: behind a network these')
  console.log('    become two services that each need the other to start. Invert one side')
  console.log('    (emit an event instead of calling), or move the shared read behind the')
  console.log('    module that owns it.')
  console.log('')
  console.log('    If this cycle is genuinely intended, record it deliberately:')
  console.log('      npm run lint:boundaries -- --update-baseline')
}

console.log('')
process.exit(violations.length || newCycles.length ? 1 : 0)
