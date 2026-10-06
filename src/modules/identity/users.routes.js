const router = require('express').Router()
const ctrl = require('./users.controller')
const { protect, restrictTo } = require('../../middleware/auth.middleware')

router.use(protect)

// hr reads the roster (Module 9) but never invites, re-roles or deactivates.
router.get('/', restrictTo('admin', 'manager', 'hr'), ctrl.getAllUsers)
router.put('/profile', ctrl.updateProfile)
router.post('/invite', restrictTo('admin'), ctrl.inviteUser)
// Must precede '/:id' so 'stats' is not parsed as a user id.
router.get('/stats', restrictTo('admin', 'manager', 'hr'), ctrl.getUserStats)
router.get('/:id', ctrl.getUserById)
router.patch('/:id/role', restrictTo('admin'), ctrl.updateRole)
router.patch('/:id/deactivate', restrictTo('admin'), ctrl.deactivateUser)

module.exports = router
