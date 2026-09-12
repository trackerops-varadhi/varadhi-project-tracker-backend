const router = require('express').Router()
const ctrl = require('./leave.controller')
const { protect } = require('../../middleware/auth.middleware')

// No restrictTo here: all three roles may reach these endpoints, and the
// employee-vs-manager distinction is a row-level scope rather than an
// endpoint-level one. leave.service.js enforces both — employees see only
// their own requests, and only admin/manager may change a status.
router.use(protect)

router.get('/', ctrl.getLeaveRequests)
router.post('/', ctrl.createLeaveRequest)
router.patch('/:id/status', ctrl.updateLeaveRequestStatus)

module.exports = router
