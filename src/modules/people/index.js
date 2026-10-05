// PUBLIC INTERFACE — people (employee_profiles · employee_exits · candidates · interviews)
//
// The only file outside this directory that anything else may require.
//
// Module 9, first slice: the HR Management screen's Employee Directory,
// Attrition Management and Interview Management, plus the dashboard figures.
// See docs/Module-9-People-Plan.md for the later phases.
//
// Cross-module API: none. people reads identity (names, active roster) and
// workforce (attendance, leave) through their interfaces; nothing reads people.

exports.mount = [
  { path: '/api/people', router: require('./routes') },
]
