const router = require('express').Router()
const ctrl = require('./documents.controller')
const { protect } = require('../../middleware/auth.middleware')
const upload = require('../../middleware/upload')

router.use(protect)

// No restrictTo: all roles may list and upload. The employee restriction on
// move/download/delete is enforced in documents.service.js, matching the legacy
// controller — it is a row-level policy expressed per-action, not per-route.
router.get('/', ctrl.getAllDocuments)
router.post('/upload', upload.single('file'), ctrl.uploadDocument)
router.patch('/:id/move', ctrl.moveDocument)
router.get('/:id/download', ctrl.downloadDocument)
router.delete('/:id', ctrl.deleteDocument)

module.exports = router
