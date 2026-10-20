import express from 'express';
import {
  getEvents,
  getEventById,
  createEvent,
  getOrganizerEvents,
  uploadEventMedia,
} from '../controllers/eventController.js';
import {
  updateOrganizerEvent,
  deleteOrganizerEvent,
  validatePromoCode,
} from '../controllers/organizerController.js';
import { registerFreeEvent } from '../controllers/orderController.js';
import { protect, requireApproved } from '../middleware/authMiddleware.js';
import { upload } from '../middleware/uploadMiddleware.js';

const router = express.Router();

// @route   GET  /api/events          — Public: list all published events
router.get('/', getEvents);

// @route   GET  /api/events/organizer/my-events  — Private: organizer's own events
router.get('/organizer/my-events', protect, requireApproved, getOrganizerEvents);

// @route   POST /api/events/upload   — Private (Approved): upload event media
router.post(
  '/upload',
  protect,
  requireApproved,
  upload.single('image'),
  uploadEventMedia
);

// @route   GET  /api/events/:id      — Public: single event by ID or slug
router.get('/:id', getEventById);

// @route   POST /api/events          — Private (Approved): create new event
router.post('/', protect, requireApproved, createEvent);

// @route   PUT  /api/events/:id      — Private (Approved): update event
router.put('/:id', protect, requireApproved, updateOrganizerEvent);

// @route   DELETE /api/events/:id    — Private (Approved): safely delete or archive event
router.delete('/:id', protect, requireApproved, deleteOrganizerEvent);

// @route   POST /api/events/:id/register — Private: free event attendee registration
router.post('/:id/register', protect, registerFreeEvent);

// @route   POST /api/events/:id/validate-promo — Public/buyer promo validation
router.post('/:id/validate-promo', validatePromoCode);
router.post('/validate-promo', validatePromoCode);

export default router;
