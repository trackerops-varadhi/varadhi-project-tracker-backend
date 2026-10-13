/**
 * GET /api/projects/:id/bugs — the project detail page's Bugs tab.
 *
 * WHY A BUGS ROUTE LIVES UNDER /api/projects
 * The URL belongs to projects because the resource is "this project's bugs".
 * The HANDLER belongs here because bugs are this module's: the same service
 * /api/bugs uses answers it, with the same role scoping, so the tab cannot
 * widen what anyone can see.
 *
 * It used to be declared in work/projects.routes.js, which reached for
 * `defects.projectBugsHandler` to do it. That single line was half of the
 * `work -> defects` dependency, and `work <-> defects` was a cycle — two
 * modules that cannot be deployed apart. It also forced a lazy require with a
 * fifteen-line comment explaining that whichever module was loaded first saw
 * the other half-built, and that the server only booted because server.js
 * happened to require defects before work.
 *
 * Nothing about the URL required any of that. A module can mount a path
 * prefix it does not own: server.js mounts every module's `mount` array, and
 * express tries routers in order, so a router declaring only `/:id/bugs`
 * passes every other /api/projects request through to work's router
 * untouched. `/:id/bugs` cannot be shadowed by work's `/:id` either — those
 * are different numbers of path segments.
 *
 * So the route moved to the module that owns the data, and the cycle went with
 * it. defects already depends on work; work no longer depends on defects.
 */

const router = require('express').Router()

const { protect, restrictTo } = require('../../middleware/auth.middleware')
const ctrl = require('./controller')

// Role workspaces: bugs are QC's, so only admin and qc reach this tab — the
// same pair /api/bugs is restricted to.
router.get('/:id/bugs', protect, restrictTo('admin', 'qc'), ctrl.getBugsByProject)

module.exports = router
