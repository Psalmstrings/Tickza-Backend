import express from 'express';
import {
  getMyTickets,
  getTicketById,
  createTicket,
  searchTicketmaster,
} from '../controllers/ticketController.js';
import { scanQR } from '../controllers/checkInController.js';
import { protect, requireApproved } from '../middleware/authMiddleware.js';

const router = express.Router();

// @route   GET  /api/tickets/my-tickets          — Private: user's own tickets
router.get('/my-tickets', protect, getMyTickets);

// @route   GET  /api/tickets/ticketmaster/search  — Private (Approved): search external events
router.get('/ticketmaster/search', protect, requireApproved, searchTicketmaster);

// @route   POST /api/tickets/checkin/scan         — Private: scan a QR token to check in
router.post('/checkin/scan', protect, scanQR);

// @route   GET  /api/tickets/:id                  — Private: single ticket by ID
router.get('/:id', protect, getTicketById);

// @route   POST /api/tickets                      — Private (Approved): manually create ticket(s)
router.post('/', protect, requireApproved, createTicket);

export default router;
