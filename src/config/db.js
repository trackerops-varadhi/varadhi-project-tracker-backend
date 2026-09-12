// MOVED → src/platform/db.js
//
// Compatibility shim. ~42 modules still require this path; they are migrated
// domain by domain as each moves under src/modules/. Node caches the resolved
// module, so requiring through this shim yields the same Pool instance and the
// connect-check side effect still runs exactly once.
//
// Delete this file once `grep -r "config/db" src` comes back empty.
module.exports = require('../platform/db')
