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

console.log('')
process.exit(violations.length ? 1 : 0)
