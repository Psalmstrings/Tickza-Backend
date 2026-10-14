import express from 'express';
import {
  getMyNotifications,
  markRead,
  markAllRead,
  getUnreadCount,
} from '../controllers/notificationController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// All notification routes require authentication
router.use(protect);

// @route  GET   /api/notifications              — list user's notifications (paginated)
router.get('/', getMyNotifications);

// @route  GET   /api/notifications/unread-count — unread count
router.get('/unread-count', getUnreadCount);

// @route  PATCH /api/notifications/read-all     — mark all as read
router.patch('/read-all', markAllRead);

// @route  PATCH /api/notifications/:id/read     — mark single as read
router.patch('/:id/read', markRead);

export default router;
