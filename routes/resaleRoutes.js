import express from 'express';
import {
  listForResale,
  getResaleListings,
  buyResaleTicket,
  cancelResaleListing,
} from '../controllers/resaleController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// @route   GET    /api/resale        — Public: list all active resale listings
router.get('/', getResaleListings);

// @route   POST   /api/resale        — Private (Approved): list a ticket for resale
router.post('/', protect, listForResale);

// @route   POST   /api/resale/:id/buy — Private: purchase a resale listing
router.post('/:id/buy', protect, buyResaleTicket);

// @route   DELETE /api/resale/:id    — Private: cancel a resale listing (seller only)
router.delete('/:id', protect, cancelResaleListing);

export default router;
