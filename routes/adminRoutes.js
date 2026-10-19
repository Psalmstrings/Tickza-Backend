import express from 'express';
import {
  getUsers,
  approveUser,
  suspendUser,
  deleteUser,
  getAdminEvents,
  approveEvent,
  rejectEvent,
  getAdminTickets,
  getAdminOrders,
  getAuditLogs,
  getStats,
  getAdminFinancials,
  getAdminPayouts,
  approvePayout,
  rejectPayout,
  retryPayout,
  getFinancialSettings,
  updateFinancialSettings,
} from '../controllers/adminController.js';
import { getEventCheckIns } from '../controllers/checkInController.js';
import { protect, requireAdmin } from '../middleware/authMiddleware.js';

const router = express.Router();

// All admin routes require authentication AND admin role
router.use(protect, requireAdmin);

// ── Stats ──────────────────────────────────────────────────────────────────
// @route  GET /api/admin/stats
router.get('/stats', getStats);

// ── Users ──────────────────────────────────────────────────────────────────
// @route  GET    /api/admin/users
router.get('/users', getUsers);

// @route  PATCH  /api/admin/users/:id/approve
router.patch('/users/:id/approve', approveUser);

// @route  PATCH  /api/admin/users/:id/suspend
router.patch('/users/:id/suspend', suspendUser);

// @route  DELETE /api/admin/users/:id
router.delete('/users/:id', deleteUser);

// ── Events ─────────────────────────────────────────────────────────────────
// @route  GET   /api/admin/events
router.get('/events', getAdminEvents);

// @route  PATCH /api/admin/events/:id/approve
router.patch('/events/:id/approve', approveEvent);

// @route  PATCH /api/admin/events/:id/reject
router.patch('/events/:id/reject', rejectEvent);

// ── Tickets ────────────────────────────────────────────────────────────────
// @route  GET /api/admin/tickets
router.get('/tickets', getAdminTickets);

// ── Orders ─────────────────────────────────────────────────────────────────
// @route  GET /api/admin/orders
router.get('/orders', getAdminOrders);

// ── Audit Logs ─────────────────────────────────────────────────────────────
// @route  GET /api/admin/audit-logs
router.get('/audit-logs', getAuditLogs);

// ── Check-Ins ──────────────────────────────────────────────────────────────
// @route  GET /api/admin/checkins/:eventId
router.get('/checkins/:eventId', getEventCheckIns);

// ── Financials & Payout Approvals ──────────────────────────────────────────
// @route  GET   /api/admin/financials/overview
router.get('/financials/overview', getAdminFinancials);

// @route  GET   /api/admin/financials/payouts
router.get('/financials/payouts', getAdminPayouts);

// @route  POST  /api/admin/financials/payouts/:id/approve
router.post('/financials/payouts/:id/approve', approvePayout);

// @route  POST  /api/admin/financials/payouts/:id/reject
router.post('/financials/payouts/:id/reject', rejectPayout);

// @route  POST  /api/admin/financials/payouts/:id/retry
router.post('/financials/payouts/:id/retry', retryPayout);

// @route  GET   /api/admin/financials/settings
router.get('/financials/settings', getFinancialSettings);

// @route  PUT   /api/admin/financials/settings
router.put('/financials/settings', updateFinancialSettings);

export default router;
