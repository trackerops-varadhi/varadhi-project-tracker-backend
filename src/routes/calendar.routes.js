const router = require('express').Router()
const ctrl = require('../controllers/calendar.controller')
const { protect } = require('../middleware/auth.middleware')

// ---------------------------------------------------------------------------
// PUBLIC — must be declared BEFORE router.use(protect).
//
// The OAuth callback is a browser redirect from Google/Microsoft. It carries
// no Authorization header, so `protect` would reject it and the connect flow
// could never complete. Authentication comes instead from the signed `state`
// parameter, verified in utils/oauth-state.js — which is a stronger guarantee
// here than a bearer token would be, because it also binds the callback to the
// exact user who initiated the flow (OAuth CSRF).
// ---------------------------------------------------------------------------
router.get('/:provider/callback', ctrl.oauthCallback)

router.use(protect)

router.get('/providers', ctrl.getProviders)
router.get('/connections', ctrl.getConnections)
router.get('/events', ctrl.getUpcomingEvents)
router.get('/conflicts', ctrl.getConflicts)
router.post('/conflicts/:id/resolve', ctrl.resolveConflictById)
router.get('/:provider/auth-url', ctrl.getAuthUrl)
router.get('/connections/:id/settings', ctrl.getSettings)
router.put('/connections/:id/settings', ctrl.updateSettings)
router.post('/connections/:id/sync', ctrl.syncNow)
router.delete('/connections/:id', ctrl.disconnect)

module.exports = router
