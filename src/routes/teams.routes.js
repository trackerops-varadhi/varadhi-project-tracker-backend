const router = require('express').Router()
const ctrl = require('../controllers/teams.controller')
const { protect, restrictTo } = require('../middleware/auth.middleware')

router.use(protect)

// Readable by any authenticated user so the settings UI can render the event
// catalogue before the role check bites on the mutating routes below.
router.get('/event-types', ctrl.getEventTypes)

// PRD business rule: "Only users with Project Admin or higher role may
// configure or modify webhook integrations for a project." Employees cannot
// even list webhooks — a url_hint plus a project name still tells them which
// channel receives which project's activity.
router.use(restrictTo('admin', 'manager'))

router.get('/webhooks', ctrl.getWebhooks)
router.post('/webhooks', ctrl.createWebhook)
router.put('/webhooks/:id', ctrl.updateWebhook)
router.delete('/webhooks/:id', ctrl.deleteWebhook)
router.post('/webhooks/:id/test', ctrl.testWebhook)
router.get('/webhooks/:id/health', ctrl.getWebhookHealth)

module.exports = router
