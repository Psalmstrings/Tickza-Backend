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

export default router;
