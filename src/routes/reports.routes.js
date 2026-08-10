const router = require('express').Router()
const ctrl = require('../controllers/reports.controller')
const { protect } = require('../middleware/auth.middleware')

router.use(protect)

router.get('/task-status', ctrl.getTaskStatus)
router.get('/member-workload', ctrl.getMemberWorkload)
router.get('/project-completion', ctrl.getProjectCompletion)
router.get('/role-utilization', ctrl.getRoleUtilization)
router.get('/business-intelligence', ctrl.getBusinessIntelligence)
router.get('/risk-analysis', ctrl.getRiskAnalysis)

module.exports = router