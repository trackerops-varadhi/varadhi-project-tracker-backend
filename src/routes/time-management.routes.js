const router = require('express').Router()
const ctrl = require('../controllers/timeManagement.controller')
const { protect } = require('../middleware/auth.middleware')

router.use(protect)
router.get('/', ctrl.getTimeLogs)
router.post('/', ctrl.createTimeLog)
router.post('/check-in', ctrl.checkIn)
router.post('/check-out', ctrl.checkOut)

module.exports = router
