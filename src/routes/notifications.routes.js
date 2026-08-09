// const router = require('express').Router()
// const pool = require('../config/db')
// const { protect } = require('../middleware/auth.middleware')
// const { successResponse, errorResponse } = require('../utils/response')
// router.use(protect)
// router.get('/', async (req, res) => {
//   try {
//     const result = await pool.query('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20', [req.user.id])
//     return successResponse(res, result.rows)
//   } catch (err) { return errorResponse(res, err.message, 500) }
// })
// router.patch('/:id/read', async (req, res) => {
//   try {
//     await pool.query('UPDATE notifications SET is_read=true WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])
//     return successResponse(res, null, 'Marked as read.')
//   } catch (err) { return errorResponse(res, err.message, 500) }
// })
// router.patch('/read-all', async (req, res) => {
//   try {
//     await pool.query('UPDATE notifications SET is_read=true WHERE user_id=$1', [req.user.id])
//     return successResponse(res, null, 'All marked as read.')
//   } catch (err) { return errorResponse(res, err.message, 500) }
// })
// module.exports = router

/**
 * Notifications routes — mounted at /api/notifications in server.js
 *
 * NOTE: /preferences and /unread-count are declared before any ':id' route so
 * they are never swallowed by the param match.
 */

const express = require('express');

const authMiddleware = require('../middleware/auth.middleware');
const controller = require('../controllers/notifications.controller');

// Your auth middleware may be exported as `protect`, `authenticate`,
// `verifyToken`, or as the module itself. Pick whichever exists.
const requireAuth =
  authMiddleware.protect ||
  authMiddleware.authenticate ||
  authMiddleware.verifyToken ||
  authMiddleware.authMiddleware ||
  authMiddleware;

const router = express.Router();

// Everything below requires a valid JWT.
router.use(requireAuth);

/* Preferences */
router.get('/preferences', controller.getPreferences);
router.put('/preferences', controller.updatePreferences);

/* Push subscriptions */
router.get('/push/public-key', controller.getPushPublicKey);
router.post('/push/subscribe', controller.subscribeToPush);
router.delete('/push/subscribe', controller.unsubscribeFromPush);

/* Inbox */
router.get('/unread-count', controller.getUnreadCount);
router.patch('/read-all', controller.markAllAsRead);
router.get('/', controller.getNotifications);
router.patch('/:id/read', controller.markAsRead);
router.delete('/:id', controller.deleteNotification);

module.exports = router;