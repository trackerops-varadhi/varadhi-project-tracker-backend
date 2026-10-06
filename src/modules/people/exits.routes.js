// /api/people/exits — attrition. Recording and editing an exit is HR work;
// the aggregate analytics are open to managers too (plan §3.2).

const router = require('express').Router()
const { protect, restrictTo } = require('../../middleware/auth.middleware')
const { handler } = require('./http')
const service = require('./exits.service')

router.use(protect)

router.get('/analytics', restrictTo('admin', 'manager', 'hr'),
  handler((req) => service.analytics(req.query), { where: 'exitAnalytics', fallback: 'Failed to load attrition analytics.' }))
router.get('/', restrictTo('admin', 'hr'),
  handler(() => service.listExits(), { where: 'listExits', fallback: 'Failed to load attrition records.' }))
router.post('/', restrictTo('admin', 'hr'),
  handler((req) => service.createExit(req.user, req.body),
    { where: 'createExit', fallback: 'Failed to save attrition record.', status: 201, message: 'Attrition record saved.' }))
router.patch('/:id', restrictTo('admin', 'hr'),
  handler((req) => service.updateExit(req.user, req.params.id, req.body),
    { where: 'updateExit', fallback: 'Failed to update attrition record.', message: 'Attrition record updated.' }))

module.exports = router
