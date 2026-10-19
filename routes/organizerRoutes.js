import express from 'express';
import { protect, requireApproved } from '../middleware/authMiddleware.js';
import {
  getOrganizerOverview,
  getOrganizerAnalytics,
  getOrganizerEvents,
  getEventStats,
  updateOrganizerEvent,
  deleteOrganizerEvent,
  getEventTicketTypes,
  createTicketType,
  updateTicketType,
  duplicateTicketType,
  deleteTicketType,
  getEventAttendees,
  getEventOrders,
  getPromoCodes,
  createPromoCode,
  updatePromoCode,
  deletePromoCode,
  validatePromoCode,
  getTeamMembers,
  inviteTeamMember,
  updateTeamMember,
  removeTeamMember,
  getPayouts,
  requestPayout,
  getPayoutBanks,
  resolvePayoutAccount,
  savePayoutAccount,
  getFinancialTransactions,
  getEventCheckInStats,
  getAllAttendees,
  organizerSearch,
  issueComplimentaryTickets,
  getEventReport,
  processOrderRefund,
  getOrganizerSettings,
  updateOrganizerSettings,
} from '../controllers/organizerController.js';

const router = express.Router();

// All organizer routes require authentication + account approval
router.use(protect, requireApproved);

// ── Overview & Analytics ──────────────────────────────────────────────────────
router.get('/overview',   getOrganizerOverview);
router.get('/analytics',  getOrganizerAnalytics);
router.get('/search',     organizerSearch);

// ── Events ────────────────────────────────────────────────────────────────────
router.get('/events',           getOrganizerEvents);
router.put('/events/:id',       updateOrganizerEvent);
router.delete('/events/:id',    deleteOrganizerEvent);
router.get('/events/:id/stats', getEventStats);

// ── Ticket Types ──────────────────────────────────────────────────────────────
router.get('/events/:id/ticket-types',                   getEventTicketTypes);
router.post('/events/:id/ticket-types',                  createTicketType);
router.put('/events/:id/ticket-types/:ttId',             updateTicketType);
router.post('/events/:id/ticket-types/:ttId/duplicate',   duplicateTicketType);
router.delete('/events/:id/ticket-types/:ttId',          deleteTicketType);

// ── Attendees & Complimentary ──────────────────────────────────────────
router.get('/attendees',                          getAllAttendees);
router.get('/events/:id/attendees',               getEventAttendees);
router.post('/events/:id/complimentary',          issueComplimentaryTickets);

// ── Orders & Refunds ──────────────────────────────────────────────────────────
router.get('/events/:id/orders',                  getEventOrders);
router.post('/orders/:id/refund',                 processOrderRefund);

// ── Reports ───────────────────────────────────────────────────────────────────
router.get('/events/:id/report',                  getEventReport);

// ── Settings ──────────────────────────────────────────────────────────────────
router.get('/settings',                           getOrganizerSettings);
router.put('/settings',                           updateOrganizerSettings);

// ── Check-in ─────────────────────────────────────────────────────────────────
router.get('/events/:id/checkins',     getEventCheckInStats);

// ── Promo Codes ───────────────────────────────────────────────────────────────
router.get('/events/:id/promo-codes',              getPromoCodes);
router.post('/events/:id/promo-codes',             createPromoCode);
router.put('/events/:id/promo-codes/:codeId',      updatePromoCode);
router.delete('/events/:id/promo-codes/:codeId',   deletePromoCode);
router.post('/promo-codes/validate',               validatePromoCode);

// ── Team ──────────────────────────────────────────────────────────────────────
router.get('/team',                 getTeamMembers);
router.post('/team',                inviteTeamMember);
router.put('/team/:memberId',       updateTeamMember);
router.delete('/team/:memberId',    removeTeamMember);

// ── Payouts & Financials ──────────────────────────────────────────────────────
router.get('/payouts',                    getPayouts);
router.post('/payouts/request',           requestPayout);
router.get('/payouts/banks',              getPayoutBanks);
router.post('/payouts/resolve-account',   resolvePayoutAccount);
router.post('/payouts/bank-account',      savePayoutAccount);
router.get('/financials/transactions',    getFinancialTransactions);

export default router;
