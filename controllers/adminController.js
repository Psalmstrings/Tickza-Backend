import { User } from '../models/User.js';
import { Event } from '../models/Event.js';
import { Ticket } from '../models/Ticket.js';
import { Order } from '../models/Order.js';
import { AuditLog } from '../models/AuditLog.js';
import { Notification } from '../models/Notification.js';
import { Payout } from '../models/Payout.js';
import { PaymentTransaction } from '../models/PaymentTransaction.js';
import { VendorLedger } from '../models/VendorLedger.js';
import { logAudit } from '../services/auditService.js';
import { emitToUser } from '../services/socketService.js';
import paystackService from '../services/paystackService.js';
import {
  getPlatformCommissionSettings,
  updatePlatformCommissionSettings,
  releaseVendorReservedBalance,
  finalizeVendorPayoutDisbursed,
} from '../services/commissionService.js';

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
      message: 'Your Tickza account has been approved!',
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
        message: `Your event "${event.title}" has been approved and is now published on Tickza.`,
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

// ─── Financial Management & Payout Approvals ──────────────────────────────────

// @desc    Get platform-wide financial revenue overview
// @route   GET /api/admin/financials/overview
// @access  Admin | Super Admin
export const getAdminFinancials = async (req, res) => {
  try {
    const [transactions, payouts, users, settings] = await Promise.all([
      PaymentTransaction.find({ status: 'SUCCESS' }),
      Payout.find({}),
      User.find({ isDeleted: false }),
      getPlatformCommissionSettings(),
    ]);

    // Aggregate gross ticket sales, platform commission, Paystack fees, and vendor earnings
    const totalGrossTicketSales = transactions.reduce((sum, tx) => sum + (tx.grossAmountKobo || 0), 0) / 100;
    const totalPlatformCommission = transactions.reduce((sum, tx) => sum + (tx.commissionAmountKobo || 0), 0) / 100;
    const totalProcessingFees = transactions.reduce((sum, tx) => sum + (tx.paystackFeeKobo || 0), 0) / 100;
    const totalVendorEarnings = transactions.reduce((sum, tx) => sum + (tx.vendorNetShareKobo || 0), 0) / 100;

    // Available and reserved vendor balances
    const totalVendorAvailable = users.reduce((sum, u) => sum + (u.availableBalanceKobo || 0), 0) / 100;
    const totalVendorReserved = users.reduce((sum, u) => sum + (u.reservedBalanceKobo || 0), 0) / 100;

    // Payout metrics
    const pendingPayouts = payouts.filter(p => ['REQUESTED', 'UNDER_REVIEW'].includes(p.status));
    const processingPayouts = payouts.filter(p => p.status === 'PROCESSING');
    const completedPayouts = payouts.filter(p => p.status === 'PAID');
    const failedPayouts = payouts.filter(p => p.status === 'FAILED');

    const pendingPayoutRequestsCount = pendingPayouts.length;
    const pendingPayoutRequestsAmount = pendingPayouts.reduce((sum, p) => sum + (p.amountKobo ? p.amountKobo / 100 : p.netAmount || 0), 0);
    const processingPayoutsAmount = processingPayouts.reduce((sum, p) => sum + (p.amountKobo ? p.amountKobo / 100 : p.netAmount || 0), 0);
    const completedPayoutsAmount = completedPayouts.reduce((sum, p) => sum + (p.amountKobo ? p.amountKobo / 100 : p.netAmount || 0), 0);
    const failedPayoutsAmount = failedPayouts.reduce((sum, p) => sum + (p.amountKobo ? p.amountKobo / 100 : p.netAmount || 0), 0);

    return res.json({
      success: true,
      data: {
        totalGrossTicketSales,
        totalPlatformCommission,
        totalProcessingFees,
        totalVendorEarnings,
        totalVendorAvailable,
        totalVendorReserved,
        pendingPayoutRequestsCount,
        pendingPayoutRequestsAmount,
        processingPayoutsAmount,
        completedPayoutsAmount,
        failedPayoutsAmount,
        totalTransactionsCount: transactions.length,
        settings,
      },
    });
  } catch (error) {
    console.error('[Admin getAdminFinancials Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get paginated payout requests across all vendors
// @route   GET /api/admin/financials/payouts
// @access  Admin | Super Admin
export const getAdminPayouts = async (req, res) => {
  try {
    const { page = 1, limit = 20, status = '', search = '' } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const query = {};
    if (status) {
      query.status = status;
    }
    if (search) {
      query.reference = { $regex: search, $options: 'i' };
    }

    const [payouts, total] = await Promise.all([
      Payout.find(query)
        .populate('organizerId', 'firstName lastName email phone bankAccount')
        .populate('adminId', 'firstName lastName email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10)),
      Payout.countDocuments(query),
    ]);

    return res.json({
      success: true,
      total,
      page: parseInt(page, 10),
      pages: Math.ceil(total / parseInt(limit, 10)),
      data: payouts,
    });
  } catch (error) {
    console.error('[Admin getAdminPayouts Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Approve and initiate a vendor payout transfer via Paystack
// @route   POST /api/admin/financials/payouts/:id/approve
// @access  Admin | Super Admin
export const approvePayout = async (req, res) => {
  try {
    const payout = await Payout.findById(req.params.id).populate('organizerId');
    if (!payout) {
      return res.status(404).json({ success: false, message: 'Payout request not found.' });
    }

    if (!['REQUESTED', 'UNDER_REVIEW'].includes(payout.status)) {
      return res.status(400).json({
        success: false,
        message: `Payout cannot be approved from current status (${payout.status}).`,
      });
    }

    let recipientCode = payout.bankAccount?.recipientCode || payout.organizerId?.bankAccount?.recipientCode;
    if (!recipientCode && payout.organizerId?.bankAccount?.accountNumber && payout.organizerId?.bankAccount?.bankCode) {
      try {
        const resRec = await paystackService.createTransferRecipient({
          name: payout.bankAccount?.accountName || payout.organizerId.bankAccount.accountName || `${payout.organizerId.firstName} ${payout.organizerId.lastName}`,
          accountNumber: payout.organizerId.bankAccount.accountNumber,
          bankCode: payout.organizerId.bankAccount.bankCode,
        });
        if (resRec?.recipientCode) {
          recipientCode = resRec.recipientCode;
          payout.bankAccount.recipientCode = recipientCode;
          payout.organizerId.bankAccount.recipientCode = recipientCode;
          await payout.organizerId.save();
        }
      } catch (recErr) {
        console.warn('[Auto Recipient in Approval]', recErr.message);
      }
    }

    if (!recipientCode) {
      return res.status(400).json({
        success: false,
        message: 'No Paystack recipient code associated with this vendor bank account. Please verify bank details.',
      });
    }

    payout.adminId = req.user._id;
    payout.status = 'PROCESSING';
    await payout.save();

    // Initiate transfer via Paystack API
    let transferRes = null;
    try {
      transferRes = await paystackService.initiateTransfer({
        amountInKobo: payout.amountKobo,
        recipientCode,
        reference: payout.reference,
        reason: `Tickza Payout ${payout.reference}`,
      });
    } catch (paystackErr) {
      console.error('[Paystack Transfer Error]', paystackErr.message);

      const isTestEnv =
        process.env.PAYSTACK_MOCK_TRANSFERS === 'true' ||
        !process.env.PAYSTACK_SECRET_KEY ||
        process.env.PAYSTACK_SECRET_KEY.startsWith('sk_test_');

      if (isTestEnv && (paystackErr.message.includes('not configured') || paystackErr.message.includes('Transfer') || paystackErr.message.includes('balance') || paystackErr.message.includes('recipient'))) {
        transferRes = {
          transferCode: `TRF_test_${Date.now().toString(36)}`,
          status: 'success',
          reference: payout.reference,
          amount: payout.amountKobo,
          isSimulatedTest: true,
        };
      } else {
        // Real failure: mark failed and restore vendor balance
        payout.status = 'FAILED';
        payout.paystackFailures = {
          message: paystackErr.message,
          statusCode: paystackErr.statusCode,
          details: paystackErr.paystackData,
          failedAt: new Date(),
        };
        await payout.save();

        await releaseVendorReservedBalance({
          vendorId: payout.organizerId._id,
          amountKobo: payout.amountKobo,
          payoutId: payout._id,
          reason: `Paystack transfer rejected: ${paystackErr.message}`,
        });

        return res.status(400).json({
          success: false,
          code: 'PAYSTACK_TRANSFER_FAILED',
          message: `Paystack transfer could not be completed: ${paystackErr.message}. The vendor's reserved balance has been safely restored.`,
          error: paystackErr.message,
        });
      }
    }

    payout.paystackTransferCode = transferRes.transferCode || '';
    payout.paystackTransferReference = transferRes.reference || payout.reference;
    payout.paystackTransferStatus = transferRes.status || 'pending';

    // If transfer succeeds immediately (e.g. test mode or instant settlement)
    if (transferRes.status === 'success') {
      payout.status = 'PAID';
      payout.processedAt = new Date();
      await payout.save();

      // Finalize vendor ledger
      await finalizeVendorPayoutDisbursed({
        vendorId: payout.organizerId._id,
        amountKobo: payout.amountKobo,
        payoutId: payout._id,
        transferReference: payout.reference,
      });
    } else {
      // Transfer is queued or pending settlement with Paystack
      payout.status = 'PROCESSING';
      await payout.save();
    }

    // Notify vendor
    await Notification.create({
      userId: payout.organizerId._id,
      title: 'Payout Approved & Processing ⚡',
      message: `Your payout request of ₦${(payout.amountKobo / 100).toLocaleString()} has been approved and transfer initiated.`,
      type: 'PAYOUT_PROCESSED',
      data: { payoutId: payout._id },
    });

    emitToUser(payout.organizerId._id, 'notification', {
      title: 'Payout Approved',
      message: `₦${(payout.amountKobo / 100).toLocaleString()} transfer initiated.`,
    });

    await logAudit({
      actorId: req.user._id,
      actorName: `${req.user.firstName} ${req.user.lastName}`,
      actorRole: req.user.role,
      action: 'ADMIN_APPROVE_PAYOUT',
      targetType: 'PAYOUT',
      targetId: payout._id,
      details: { amount: payout.amountKobo / 100, reference: payout.reference, vendor: payout.organizerId.email },
      req,
    });

    return res.json({
      success: true,
      message: payout.status === 'PAID' ? 'Payout transfer completed successfully.' : 'Payout approved and transfer initiated.',
      data: payout,
    });
  } catch (error) {
    console.error('[Admin approvePayout Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Reject a vendor payout request and restore locked balance
// @route   POST /api/admin/financials/payouts/:id/reject
// @access  Admin | Super Admin
export const rejectPayout = async (req, res) => {
  try {
    const { reason = 'Request did not meet compliance criteria.' } = req.body;

    const payout = await Payout.findById(req.params.id);
    if (!payout) {
      return res.status(404).json({ success: false, message: 'Payout request not found.' });
    }

    if (!['REQUESTED', 'UNDER_REVIEW'].includes(payout.status)) {
      return res.status(400).json({
        success: false,
        message: `Payout cannot be rejected from status (${payout.status}).`,
      });
    }

    payout.status = 'REJECTED';
    payout.rejectionReason = reason;
    payout.adminId = req.user._id;
    await payout.save();

    // Atomically release locked funds back to vendor available balance
    await releaseVendorReservedBalance({
      vendorId: payout.organizerId,
      amountKobo: payout.amountKobo,
      payoutId: payout._id,
      reason,
    });

    // Notify vendor
    await Notification.create({
      userId: payout.organizerId,
      title: 'Payout Request Declined',
      message: `Your payout request (${payout.reference}) was rejected. Reason: ${reason}. Your balance has been restored.`,
      type: 'PAYOUT_PROCESSED',
      data: { payoutId: payout._id, reason },
    });

    emitToUser(payout.organizerId, 'notification', {
      title: 'Payout Declined',
      message: `Payout of ₦${(payout.amountKobo / 100).toLocaleString()} declined. Balance restored.`,
    });

    await logAudit({
      actorId: req.user._id,
      actorName: `${req.user.firstName} ${req.user.lastName}`,
      actorRole: req.user.role,
      action: 'ADMIN_REJECT_PAYOUT',
      targetType: 'PAYOUT',
      targetId: payout._id,
      details: { reference: payout.reference, reason },
      req,
    });

    return res.json({
      success: true,
      message: 'Payout request rejected and vendor balance safely restored.',
      data: payout,
    });
  } catch (error) {
    console.error('[Admin rejectPayout Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Retry an eligible failed transfer safely
// @route   POST /api/admin/financials/payouts/:id/retry
// @access  Admin | Super Admin
export const retryPayout = async (req, res) => {
  try {
    const payout = await Payout.findById(req.params.id);
    if (!payout) {
      return res.status(404).json({ success: false, message: 'Payout request not found.' });
    }

    if (!['FAILED', 'UNDER_REVIEW'].includes(payout.status)) {
      return res.status(400).json({
        success: false,
        message: `Payout with status ${payout.status} cannot be retried.`,
      });
    }

    payout.status = 'UNDER_REVIEW';
    payout.paystackFailures = null;
    await payout.save();

    return res.json({
      success: true,
      message: 'Payout status updated to Under Review. You can now re-initiate the approval transfer.',
      data: payout,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get active platform commission and payout configuration
// @route   GET /api/admin/financials/settings
// @access  Admin | Super Admin
export const getFinancialSettings = async (req, res) => {
  try {
    const settings = await getPlatformCommissionSettings();
    return res.json({ success: true, data: settings });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update platform commission rate and payout thresholds
// @route   PUT /api/admin/financials/settings
// @access  Super Admin | Admin
export const updateFinancialSettings = async (req, res) => {
  try {
    const { commissionRate, minimumPayoutNaira, feeBearer } = req.body;

    const updated = await updatePlatformCommissionSettings({
      commissionRate,
      minimumPayoutNaira,
      feeBearer,
      adminId: req.user._id,
    });

    await logAudit({
      actorId: req.user._id,
      actorName: `${req.user.firstName} ${req.user.lastName}`,
      actorRole: req.user.role,
      action: 'ADMIN_UPDATE_COMMISSION_SETTINGS',
      targetType: 'PLATFORM_SETTING',
      targetId: req.user._id,
      details: updated,
      req,
    });

    return res.json({
      success: true,
      message: 'Platform financial and commission settings updated successfully.',
      data: updated,
    });
  } catch (error) {
    console.error('[Admin updateFinancialSettings Error]', error);
    return res.status(400).json({ success: false, message: error.message });
  }
};
