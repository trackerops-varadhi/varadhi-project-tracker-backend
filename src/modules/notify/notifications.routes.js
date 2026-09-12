/**
 * Notifications routes — the inbox, preferences and push subscriptions.
 *
 * /preferences, /push/* and /unread-count are declared before any ':id' route
 * so they are never swallowed by the param match.
 */

const router = require('express').Router()
const ctrl = require('./notifications.controller')
const { protect } = require('../../middleware/auth.middleware')

// The previous version resolved the middleware through a defensive
// `protect || authenticate || verifyToken || authMiddleware` chain. Only
// `protect` has ever existed, so the chain always resolved to it — dropped
// rather than carried forward, since a fallback to the module itself would
// have silently mounted a non-middleware object.
router.use(protect)

/* Preferences */
router.get('/preferences', ctrl.getPreferences)
router.put('/preferences', ctrl.updatePreferences)

/* Push subscriptions */
router.get('/push/public-key', ctrl.getPushPublicKey)
router.post('/push/subscribe', ctrl.subscribeToPush)
router.delete('/push/subscribe', ctrl.unsubscribeFromPush)

/* Inbox */
router.get('/unread-count', ctrl.getUnreadCount)
router.patch('/read-all', ctrl.markAllAsRead)
router.get('/', ctrl.getNotifications)
router.patch('/:id/read', ctrl.markAsRead)
router.delete('/:id', ctrl.deleteNotification)

module.exports = router
