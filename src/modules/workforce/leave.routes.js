const router = require('express').Router()
const ctrl = require('./leave.controller')
const { protect } = require('../../middleware/auth.middleware')

// No restrictTo here: all three roles may reach these endpoints, and the
// employee-vs-manager distinction is a row-level scope rather than an
// endpoint-level one. leave.service.js enforces both — employees see only
// their own requests, and only admin/manager may change a status.
router.use(protect)

// Static paths before /:id.
// Absence calendar: all roles, no reason text (Module 9, absentee visibility).
router.get('/calendar', ctrl.getCalendar)
// Own balance for everyone; ?userId= / ?scope=team and PUT are role-checked
// in the service (admin/manager/hr read, admin/hr write).
router.get('/balances', ctrl.getBalances)
router.put('/balances', ctrl.setEntitlement)

router.get('/', ctrl.getLeaveRequests)
router.post('/', ctrl.createLeaveRequest)
router.patch('/:id/status', ctrl.updateLeaveRequestStatus)
router.patch('/:id/cancel', ctrl.cancelLeaveRequest)

module.exports = router
