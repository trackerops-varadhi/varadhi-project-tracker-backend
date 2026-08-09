const router = require('express').Router()
const ctrl = require('../controllers/leaveManagement.controller')
const { protect } = require('../middleware/auth.middleware')

router.use(protect)
router.get('/', ctrl.getLeaveRequests)
router.post('/', ctrl.createLeaveRequest)
router.patch('/:id/status', ctrl.updateLeaveRequestStatus)

module.exports = router
