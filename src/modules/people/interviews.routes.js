// /api/people/interviews — interview rounds. HR schedules and sees every
// round; any role sees and records the rounds assigned to them.

const router = require('express').Router()
const { protect, restrictTo } = require('../../middleware/auth.middleware')
const { handler } = require('./http')
const service = require('./recruitment.service')

router.use(protect)

router.get('/mine', handler((req) => service.listMyInterviews(req.user),
  { where: 'myInterviews', fallback: 'Failed to load your interviews.' }))
router.get('/expectations', restrictTo('admin', 'hr'),
  handler(() => service.expectationsReport(), { where: 'expectations', fallback: 'Failed to load the expectations report.' }))
router.get('/', restrictTo('admin', 'hr'),
  handler((req) => service.listInterviews(req.query), { where: 'listInterviews', fallback: 'Failed to load interviews.' }))
router.post('/', restrictTo('admin', 'hr'),
  handler((req) => service.createInterview(req.user, req.body),
    { where: 'createInterview', fallback: 'Failed to save interview.', status: 201, message: 'Interview saved.' }))
// admin/hr or the assigned interviewer — enforced in the service.
router.patch('/:id/outcome',
  handler((req) => service.recordOutcome(req.user, req.params.id, req.body),
    { where: 'recordOutcome', fallback: 'Failed to record the interview outcome.', message: 'Interview updated.' }))

module.exports = router
