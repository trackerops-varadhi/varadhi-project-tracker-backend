// /api/people/candidates — the candidate pipeline and resume vault. HR only.

const router = require('express').Router()
const { protect, restrictTo } = require('../../middleware/auth.middleware')
const upload = require('../../middleware/upload')
const { handler } = require('./http')
const service = require('./recruitment.service')

router.use(protect)
router.use(restrictTo('admin', 'hr'))

router.get('/', handler((req) => service.listCandidates(req.query),
  { where: 'listCandidates', fallback: 'Failed to load candidates.' }))
router.post('/', handler((req) => service.createCandidate(req.user, req.body),
  { where: 'createCandidate', fallback: 'Failed to add candidate.', status: 201, message: 'Candidate added.' }))
// Resume Folder: every resume across candidates. Declared before /:id.
router.get('/resumes', handler(() => service.listAllResumes(),
  { where: 'listResumes', fallback: 'Failed to load resumes.' }))

router.get('/:id', handler((req) => service.getCandidate(req.params.id),
  { where: 'getCandidate', fallback: 'Failed to load candidate.' }))
router.put('/:id', handler((req) => service.updateCandidate(req.user, req.params.id, req.body),
  { where: 'updateCandidate', fallback: 'Failed to update candidate.', message: 'Candidate updated.' }))
router.patch('/:id/status', handler((req) => service.setCandidateStatus(req.user, req.params.id, req.body?.status),
  { where: 'candidateStatus', fallback: 'Failed to update candidate status.', message: 'Status updated.' }))
router.delete('/:id', handler((req) => service.deleteCandidate(req.params.id),
  { where: 'deleteCandidate', fallback: 'Failed to delete candidate.', status: 204 }))
router.post('/:id/convert', handler((req) => service.convertCandidate(req.user, req.params.id, req.body),
  { where: 'convertCandidate', fallback: 'Failed to convert candidate.', status: 201, message: 'Candidate converted and invited.' }))

router.post('/:id/resumes', upload.single('file'),
  handler((req) => service.uploadResume(req.user, req.params.id, req.file),
    { where: 'uploadResume', fallback: 'Failed to upload resume.', status: 201, message: 'Resume uploaded.' }))
// A short-lived signed URL — never a redirect to a public object (plan §7.3).
router.get('/:id/resumes/:resumeId', handler((req) => service.getResumeLink(req.params.id, req.params.resumeId),
  { where: 'resumeLink', fallback: 'Failed to open resume.' }))
router.delete('/:id/resumes/:resumeId', handler((req) => service.deleteResume(req.params.id, req.params.resumeId),
  { where: 'deleteResume', fallback: 'Failed to delete resume.', status: 204 }))

module.exports = router
