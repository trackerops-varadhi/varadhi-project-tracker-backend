const router = require('express').Router()
const ctrl = require('./controller')
const { protect, restrictTo } = require('../../middleware/auth.middleware')

// HR records — exit reasons, interview outcomes, the employee directory — are
// admin/manager only, enforced here for every endpoint. There is no employee
// scope: the PII-free Team Directory for all roles is a later phase with its
// own endpoint, so nothing here ever needs to answer an employee.
router.use(protect)
router.use(restrictTo('admin', 'manager'))

router.get('/dashboard', ctrl.getDashboard)

router.get('/employees', ctrl.getEmployees)
router.get('/employees/eligible-users', ctrl.getEligibleUsers)
router.post('/employees', ctrl.createEmployee)

router.get('/exits', ctrl.getExits)
router.post('/exits', ctrl.createExit)

router.get('/interviews', ctrl.getInterviews)
router.post('/interviews', ctrl.createInterview)

module.exports = router
