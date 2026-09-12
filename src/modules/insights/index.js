// PUBLIC INTERFACE — insights (dashboard · reports)
//
// The only file outside this directory that anything else may require.
//
// TABLES: none. insights is a pure read model — it owns no data and writes
// nothing. Every figure it renders is a question answered by work.analytics or
// identity, with the arithmetic, thresholds and presentation applied here.
//
// That is why this module has no repo.js and no platform/db import: if a query
// ever appears in this directory, the boundary has been broken.

exports.mount = [
  { path: '/api/dashboard', router: require('./dashboard.routes') },
  { path: '/api/reports', router: require('./reports.routes') },
]

// Cross-module API: none. Nothing consumes insights — it is a leaf, and the
// last module in the dependency order. If something ever needs a figure from
// here, it almost certainly wants the underlying accessor on work or identity
// instead.
