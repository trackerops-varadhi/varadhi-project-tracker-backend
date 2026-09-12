const router = require('express').Router()
const ctrl = require('./reports.controller')
const { protect } = require('../../middleware/auth.middleware')

router.use(protect)

/*
 * NOTE — no `restrictTo` here, and that is a faithful copy of the previous
 * behaviour, not an endorsement of it.
 *
 * Every endpoint below is reachable by any authenticated user, including an
 * employee, and returns organisation-wide figures: every member's workload,
 * every project's completion, throughput across the whole company. The sidebar
 * hides the Reports page from employees, and /api/bugs/reports IS gated to
 * admin/manager on the stated grounds that Reports is admin/manager-only — so
 * these six are inconsistent with the module they sit beside.
 *
 * Left unchanged because this phase is behaviour-preserving. Adding
 * `restrictTo('admin','manager')` here is a one-line fix and is written up as
 * finding 2 in docs/Varadhi-Architecture.docx.
 */
router.get('/task-status', ctrl.getTaskStatus)
router.get('/member-workload', ctrl.getMemberWorkload)
router.get('/project-completion', ctrl.getProjectCompletion)
router.get('/role-utilization', ctrl.getRoleUtilization)
router.get('/business-intelligence', ctrl.getBusinessIntelligence)
router.get('/risk-analysis', ctrl.getRiskAnalysis)

module.exports = router
