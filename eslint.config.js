/**
 * ESLint flat config — the CI lint gate.
 *
 * SCOPED TO REAL DEFECTS, NOT STYLE.
 * This codebase has no formatter and no prior lint history, so a default
 * recommended config would produce hundreds of findings on day one and the gate
 * would be switched off within a week. The rules below are the ones that catch
 * mistakes rather than preferences: an undefined variable, an unreachable
 * branch, a promise executor that swallows a rejection, a duplicated object key.
 * Style is deliberately absent — quotes, semicolons and spacing are not what CI
 * is for.
 *
 * Where a rule fires on an intentional pattern (an empty catch used to swallow
 * a best-effort cleanup), the code carries a comment saying so and the rule is
 * configured to allow it, rather than the rule being disabled globally.
 */

const node = {
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: 'commonjs',
    globals: {
      require: 'readonly', module: 'writable', exports: 'writable',
      process: 'readonly', console: 'readonly', Buffer: 'readonly',
      __dirname: 'readonly', __filename: 'readonly',
      setTimeout: 'readonly', clearTimeout: 'readonly',
      setInterval: 'readonly', clearInterval: 'readonly',
      setImmediate: 'readonly', queueMicrotask: 'readonly',
      URL: 'readonly', URLSearchParams: 'readonly', TextEncoder: 'readonly',
      TextDecoder: 'readonly', AbortController: 'readonly', fetch: 'readonly',
      structuredClone: 'readonly', crypto: 'readonly',
    },
  },
  rules: {
    // Correctness.
    'no-undef': 'error',
    'no-dupe-keys': 'error',
    'no-dupe-args': 'error',
    'no-duplicate-case': 'error',
    'no-unreachable': 'error',
    'no-cond-assign': 'error',
    'no-const-assign': 'error',
    'no-self-assign': 'error',
    'no-self-compare': 'error',
    'no-unsafe-negation': 'error',
    'no-unsafe-finally': 'error',
    'use-isnan': 'error',
    'valid-typeof': 'error',
    'no-compare-neg-zero': 'error',
    'no-sparse-arrays': 'error',
    'no-func-assign': 'error',
    'no-import-assign': 'error',
    'no-obj-calls': 'error',
    'no-class-assign': 'error',

    // Async mistakes, which in this codebase are the expensive kind.
    //
    // require-atomic-updates is deliberately OFF. It fires 22 times, every one
    // of them on the same correct pattern:
    //
    //     if (isRunning) return { skipped: true }
    //     isRunning = true
    //     try { ...await... } finally { isRunning = false }
    //
    // the overlap guard on each cron sweep. The rule warns that a value read
    // before an await may be stale by the time it is written — true in a
    // language with preemptive threads, and impossible here: Node runs one
    // callback at a time, so nothing can interleave between the check and the
    // assignment. The guard is also directly tested (ops.test.js §9 proves two
    // concurrent runRemindersNow calls produce exactly one skip).
    //
    // Turning it on would mean rewriting five correct sweeps to satisfy a rule
    // that is wrong about this runtime. Left off, with this note, rather than
    // scattered inline disables that say nothing about why.
    'require-atomic-updates': 'off',
    'no-async-promise-executor': 'error',
    'no-promise-executor-return': 'error',
    'no-await-in-loop': 'off',   // sequential DB work is often deliberate here

    // Unused code is a defect signal, but an unused error binding in a
    // best-effort catch is idiomatic in this codebase and intentional.
    'no-unused-vars': ['error', {
      args: 'none',
      caughtErrors: 'none',
      varsIgnorePattern: '^_',
    }],

    // Empty blocks are used deliberately for best-effort cleanup
    // (`catch { /* nothing to do */ }`), so allow them when commented.
    'no-empty': ['error', { allowEmptyCatch: true }],
  },
}

module.exports = [
  { ignores: ['node_modules/**', 'coverage/**', '*.log'] },
  { files: ['src/**/*.js', 'scripts/**/*.js', 'migrations/**/*.js'], ...node },
]
