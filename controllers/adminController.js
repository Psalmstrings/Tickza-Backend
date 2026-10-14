import { User } from '../models/User.js';
import { Event } from '../models/Event.js';
import { Ticket } from '../models/Ticket.js';
import { Order } from '../models/Order.js';
import { AuditLog } from '../models/AuditLog.js';
import { Notification } from '../models/Notification.js';
import { logAudit } from '../services/auditService.js';
import { emitToUser } from '../services/socketService.js';

// ─── Users ────────────────────────────────────────────────────────────────────

// @desc    Get all users (paginated, searchable, filterable)
// @route   GET /api/admin/users
// @access  Admin | Super Admin
export const getUsers = async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '', status = '' } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const query = { isDeleted: false };

    if (status && ['PENDING', 'APPROVED', 'SUSPENDED', 'DELETED'].includes(status)) {
      query.status = status;
    }

    if (search) {
      query.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { lastName:  { $regex: search, $options: 'i' } },
        { email:     { $regex: search, $options: 'i' } },
        { phone:     { $regex: search, $options: 'i' } },
      ];
    }

    const [users, total] = await Promise.all([
      User.find(query)
        .select('-passwordHash')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10)),
      User.countDocuments(query),
    ]);

    return res.json({
      success: true,
      total,
      page: parseInt(page, 10),
      pages: Math.ceil(total / parseInt(limit, 10)),
      data: users,
    });
  } catch (error) {
    console.error('[Admin getUsers Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Approve a user account
// @route   PATCH /api/admin/users/:id/approve
// @access  Admin | Super Admin
export const approveUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user || user.isDeleted) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (user.status === 'APPROVED') {
      return res.status(400).json({ success: false, message: 'User is already approved.' });
    }

    user.status = 'APPROVED';
    user.role   = 'APPROVED_USER';
    await user.save();

    // Create in-app notification for the user
    await Notification.create({
      userId:  user._id,
      title:   'Account Approved ✅',
      message: 'Congratulations! Your account has been approved by an administrator. You can now create events, purchase and transfer tickets.',
      type:    'ACCOUNT_APPROVED',
    });

    emitToUser(user._id, 'notification', {
      title:   'Account Approved',
      message: 'Your TickApp account has been approved!',
    });

    await logAudit({
      actorId:    req.user._id,
      actorName:  `${req.user.firstName} ${req.user.lastName}`,
      actorRole:  req.user.role,
      action:     'ADMIN_APPROVE_USER',
      targetType: 'USER',
      targetId:   user._id,
      details:    { email: user.email },
      req,
    });

    return res.json({
      success: true,
      message: `${user.firstName} ${user.lastName}'s account has been approved.`,
      data: { id: user._id, status: user.status, role: user.role },
    });
  } catch (error) {
    console.error('[Admin approveUser Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Suspend a user account
// @route   PATCH /api/admin/users/:id/suspend
// @access  Admin | Super Admin
export const suspendUser = async (req, res) => {
  try {
    const { reason = 'Violation of platform terms of service.' } = req.body;

    const user = await User.findById(req.params.id);
    if (!user || user.isDeleted) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Protect admins from being suspended by other admins (only SUPER_ADMIN can)
    if (
      (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') &&
      req.user.role !== 'SUPER_ADMIN'
    ) {
      return res.status(403).json({ success: false, message: 'Only a Super Admin can suspend another admin.' });
    }

    user.status           = 'SUSPENDED';
    user.suspensionReason = reason;
    await user.save();

    await Notification.create({
      userId:  user._id,
      title:   'Account Suspended',
      message: `Your account has been suspended. Reason: ${reason}. Please contact support if you believe this is a mistake.`,
      type:    'ACCOUNT_SUSPENDED',
    });

    await logAudit({
      actorId:    req.user._id,
      actorName:  `${req.user.firstName} ${req.user.lastName}`,
      actorRole:  req.user.role,
      action:     'ADMIN_SUSPEND_USER',
      targetType: 'USER',
      targetId:   user._id,
      details:    { email: user.email, reason },
      req,
    });

    return res.json({
      success: true,
      message: `${user.firstName} ${user.lastName}'s account has been suspended.`,
      data: { id: user._id, status: user.status, suspensionReason: user.suspensionReason },
    });
  } catch (error) {
    console.error('[Admin suspendUser Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Soft-delete a user account
// @route   DELETE /api/admin/users/:id
// @access  Admin | Super Admin
export const deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user || user.isDeleted) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (user.role === 'SUPER_ADMIN') {
      return res.status(403).json({ success: false, message: 'A Super Admin account cannot be deleted.' });
    }

    user.isDeleted = true;
    user.status    = 'DELETED';
    await user.save();

    await logAudit({
      actorId:    req.user._id,
      actorName:  `${req.user.firstName} ${req.user.lastName}`,
      actorRole:  req.user.role,
      action:     'ADMIN_DELETE_USER',
      targetType: 'USER',
      targetId:   user._id,
      details:    { email: user.email },
      req,
    });

    return res.json({
      success: true,
      message: `${user.firstName} ${user.lastName}'s account has been deleted.`,
    });
  } catch (error) {
    console.error('[Admin deleteUser Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Events ───────────────────────────────────────────────────────────────────

// @desc    Get all events for admin (any status, paginated)
// @route   GET /api/admin/events
// @access  Admin | Super Admin
export const getAdminEvents = async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '', status = '' } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const query = {};
    if (status) query.status = status;
    if (search) {
      query.$or = [
        { title:  { $regex: search, $options: 'i' } },
        { venue:  { $regex: search, $options: 'i' } },
      ];
    }

    const [events, total] = await Promise.all([
      Event.find(query)
        .populate('organizerId', 'firstName lastName email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10)),
      Event.countDocuments(query),
    ]);

    return res.json({
      success: true,
      total,
      page:  parseInt(page, 10),
      pages: Math.ceil(total / parseInt(limit, 10)),
      data:  events,
    });
  } catch (error) {
    console.error('[Admin getAdminEvents Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Approve / publish an event
// @route   PATCH /api/admin/events/:id/approve
// @access  Admin | Super Admin
export const approveEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id).populate('organizerId', 'firstName lastName email');
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    event.status = 'PUBLISHED';
    await event.save();

    // Notify the organizer
    if (event.organizerId) {
      await Notification.create({
        userId:  event.organizerId._id,
        title:   'Event Approved 🎉',
        message: `Your event "${event.title}" has been approved and is now published on TickApp.`,
        type:    'SYSTEM',
        data:    { eventId: event._id },
      });

      emitToUser(event.organizerId._id, 'notification', {
        title:   'Event Approved',
        message: `"${event.title}" is now live!`,
      });
    }

    await logAudit({
      actorId:    req.user._id,
      actorName:  `${req.user.firstName} ${req.user.lastName}`,
      actorRole:  req.user.role,
      action:     'ADMIN_APPROVE_EVENT',
      targetType: 'EVENT',
      targetId:   event._id,
      details:    { title: event.title },
      req,
    });

    return res.json({
      success: true,
      message: `"${event.title}" has been approved and published.`,
      data: { id: event._id, status: event.status },
    });
  } catch (error) {
    console.error('[Admin approveEvent Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Reject an event
// @route   PATCH /api/admin/events/:id/reject
// @access  Admin | Super Admin
export const rejectEvent = async (req, res) => {
  try {
    const { reason = 'Event did not meet platform guidelines.' } = req.body;

    const event = await Event.findById(req.params.id).populate('organizerId', 'firstName lastName email');
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    event.status = 'REJECTED';
    await event.save();

    if (event.organizerId) {
      await Notification.create({
        userId:  event.organizerId._id,
        title:   'Event Rejected',
        message: `Your event "${event.title}" has been rejected. Reason: ${reason}. Please review and resubmit.`,
        type:    'SYSTEM',
        data:    { eventId: event._id, reason },
      });

      emitToUser(event.organizerId._id, 'notification', {
        title:   'Event Rejected',
        message: `"${event.title}" was not approved.`,
      });
    }

    await logAudit({
      actorId:    req.user._id,
      actorName:  `${req.user.firstName} ${req.user.lastName}`,
      actorRole:  req.user.role,
      action:     'ADMIN_REJECT_EVENT',
      targetType: 'EVENT',
      targetId:   event._id,
      details:    { title: event.title, reason },
      req,
    });

    return res.json({
      success: true,
      message: `"${event.title}" has been rejected.`,
      data: { id: event._id, status: event.status },
    });
  } catch (error) {
    console.error('[Admin rejectEvent Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Tickets ──────────────────────────────────────────────────────────────────

// @desc    Get all tickets (paginated)
// @route   GET /api/admin/tickets
// @access  Admin | Super Admin
export const getAdminTickets = async (req, res) => {
  try {
    const { page = 1, limit = 20, status = '', eventId = '' } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const query = {};
    if (status)  query.status  = status;
    if (eventId) query.eventId = eventId;

    const [tickets, total] = await Promise.all([
      Ticket.find(query)
        .populate('eventId', 'title venue startDate')
        .populate('ownerId', 'firstName lastName email')
        .populate('ticketTypeId', 'name price')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10)),
      Ticket.countDocuments(query),
    ]);

    return res.json({
      success: true,
      total,
      page:  parseInt(page, 10),
      pages: Math.ceil(total / parseInt(limit, 10)),
      data:  tickets,
    });
  } catch (error) {
    console.error('[Admin getAdminTickets Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Orders ───────────────────────────────────────────────────────────────────

// @desc    Get all orders (paginated)
// @route   GET /api/admin/orders
// @access  Admin | Super Admin
export const getAdminOrders = async (req, res) => {
  try {
    const { page = 1, limit = 20, status = '' } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const query = {};
    if (status) query.status = status;

    const [orders, total] = await Promise.all([
      Order.find(query)
        .populate('userId', 'firstName lastName email')
        .populate('items.eventId', 'title venue')
        .populate('items.ticketTypeId', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10)),
      Order.countDocuments(query),
    ]);

    return res.json({
      success: true,
      total,
      page:  parseInt(page, 10),
      pages: Math.ceil(total / parseInt(limit, 10)),
      data:  orders,
    });
  } catch (error) {
    console.error('[Admin getAdminOrders Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Audit Logs ───────────────────────────────────────────────────────────────

// @desc    Get paginated audit logs
// @route   GET /api/admin/audit-logs
// @access  Admin | Super Admin
export const getAuditLogs = async (req, res) => {
  try {
    const { page = 1, limit = 30, action = '', targetType = '' } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const query = {};
    if (action)     query.action     = { $regex: action,     $options: 'i' };
    if (targetType) query.targetType = { $regex: targetType, $options: 'i' };

    const [logs, total] = await Promise.all([
      AuditLog.find(query)
        .populate('actorId', 'firstName lastName email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10)),
      AuditLog.countDocuments(query),
    ]);

    return res.json({
      success: true,
      total,
      page:  parseInt(page, 10),
      pages: Math.ceil(total / parseInt(limit, 10)),
      data:  logs,
    });
  } catch (error) {
    console.error('[Admin getAuditLogs Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Dashboard Stats ──────────────────────────────────────────────────────────

// @desc    Get platform-wide statistics
// @route   GET /api/admin/stats
// @access  Admin | Super Admin
export const getStats = async (req, res) => {
  try {
    const [
      totalUsers,
      pendingUsers,
      approvedUsers,
      suspendedUsers,
      totalEvents,
      publishedEvents,
      totalTickets,
      totalOrders,
    ] = await Promise.all([
      User.countDocuments({ isDeleted: false }),
      User.countDocuments({ status: 'PENDING',   isDeleted: false }),
      User.countDocuments({ status: 'APPROVED',  isDeleted: false }),
      User.countDocuments({ status: 'SUSPENDED', isDeleted: false }),
      Event.countDocuments({}),
      Event.countDocuments({ status: 'PUBLISHED' }),
      Ticket.countDocuments({}),
      Order.countDocuments({}),
    ]);

    return res.json({
      success: true,
      data: {
        totalUsers,
        pendingUsers,
        approvedUsers,
        suspendedUsers,
        totalEvents,
        publishedEvents,
        totalTickets,
        totalOrders,
      },
    });
  } catch (error) {
    console.error('[Admin getStats Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
