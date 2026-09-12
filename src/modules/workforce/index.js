// PUBLIC INTERFACE — workforce (leave_requests · time_logs)
//
// The only file outside this directory that anything else may require.
//
// `mount` is the module's HTTP surface, consumed by server.js. Declaring the
// base paths here rather than in server.js means a module owns its own routing:
// when workforce is extracted to its own service, this array becomes that
// service's route table and the gateway rewrite rules are derived from the same
// paths.
//
// Cross-module API: none yet. Nothing in the system reads leave or time data —
// workforce is a leaf, which is exactly why it went first. When Insights needs
// utilisation figures it will get an async accessor here, not a join.

exports.mount = [
  { path: '/api/leave-management', router: require('./leave.routes') },
  { path: '/api/time-management', router: require('./time.routes') },
]
