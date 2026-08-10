const router = require('express').Router()
const ctrl = require('../controllers/users.controller')
const { protect, restrictTo } = require('../middleware/auth.middleware')
router.use(protect)
router.get('/', restrictTo('admin','manager'), ctrl.getAllUsers)
router.put('/profile', ctrl.updateProfile)
router.post('/invite', restrictTo('admin'), ctrl.inviteUser)
// Must precede '/:id' so 'stats' is not parsed as a user id.
router.get('/stats', restrictTo('admin','manager'), ctrl.getUserStats)
router.get('/:id', ctrl.getUserById)
router.patch('/:id/role', restrictTo('admin'), ctrl.updateRole)
router.patch('/:id/deactivate', restrictTo('admin'), ctrl.deactivateUser)
module.exports = router
