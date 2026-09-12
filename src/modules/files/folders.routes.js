const router = require('express').Router()
const ctrl = require('./folders.controller')
const { protect, restrictTo } = require('../../middleware/auth.middleware')

router.use(protect)

// Reading folders is open to all roles; creating and changing them is not.
router.get('/', ctrl.getAllFolders)
router.post('/', restrictTo('admin', 'manager'), ctrl.createFolder)
router.patch('/:id', restrictTo('admin', 'manager'), ctrl.renameFolder)
router.delete('/:id', restrictTo('admin', 'manager'), ctrl.deleteFolder)

module.exports = router
