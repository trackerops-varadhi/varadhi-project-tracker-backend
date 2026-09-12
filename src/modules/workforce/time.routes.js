const router = require('express').Router()
const ctrl = require('./time.controller')
const { protect } = require('../../middleware/auth.middleware')

// All roles may log their own time; employees are scoped to their own rows in
// time.service.js rather than by an endpoint-level role gate.
router.use(protect)

router.get('/', ctrl.getTimeLogs)
router.post('/', ctrl.createTimeLog)
router.post('/check-in', ctrl.checkIn)
router.post('/check-out', ctrl.checkOut)

module.exports = router
