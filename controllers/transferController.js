import crypto from 'crypto';
import { Transfer } from '../models/Transfer.js';
import { Ticket } from '../models/Ticket.js';
import { User } from '../models/User.js';
import { Notification } from '../models/Notification.js';
import { generateSecureQRToken } from '../services/qrService.js';
import { emitToUser } from '../services/socketService.js';
import { logAudit } from '../services/auditService.js';

// @desc    Initiate a ticket transfer
// @route   POST /api/transfers
// @access  Private (Approved users or Admin only)
export const initiateTransfer = async (req, res) => {
  try {
    // CRITICAL BACKEND CHECK
    if (req.user.status !== 'APPROVED' && req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_APPROVAL_REQUIRED',
        message: 'Your account must be approved by an administrator before you can transfer tickets.',
      });
    }

    const { ticketId, recipientEmail, recipientPhone, recipientName } = req.body;

    if (!ticketId || (!recipientEmail && !recipientPhone)) {
      return res.status(400).json({
        success: false,
        message: 'Ticket ID and either recipient email or phone are required.',
      });
    }

    const ticket = await Ticket.findById(ticketId).populate('eventId');
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    // Verify ownership
    if (ticket.ownerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You do not own this ticket.' });
    }

    if (!ticket.transferable) {
      return res.status(400).json({ success: false, message: 'This ticket type cannot be transferred.' });
    }

    if (ticket.status !== 'SOLD' && ticket.status !== 'AVAILABLE') {
      return res.status(400).json({
        success: false,
        message: `Ticket cannot be transferred in its current status: ${ticket.status}`,
      });
    }

    // Check if recipient is an existing user
    let recipientUser = null;
    if (recipientEmail) {
      recipientUser = await User.findOne({ email: recipientEmail.toLowerCase() });
    } else if (recipientPhone) {
      recipientUser = await User.findOne({ phone: recipientPhone });
    }

    if (recipientUser && recipientUser._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: 'You cannot transfer a ticket to yourself.' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours

    const transfer = await Transfer.create({
      ticketId: ticket._id,
      senderId: req.user._id,
      recipientId: recipientUser ? recipientUser._id : null,
      recipientEmail: recipientEmail ? recipientEmail.toLowerCase() : '',
      recipientPhone: recipientPhone || '',
      recipientName: recipientName || (recipientUser ? `${recipientUser.firstName} ${recipientUser.lastName}` : ''),
      token,
      expiresAt,
      status: 'PENDING',
    });

    // Mark ticket as transfer pending
    ticket.status = 'TRANSFER_PENDING';
    await ticket.save();

    // Notify recipient if registered
    if (recipientUser) {
      await Notification.create({
        userId: recipientUser._id,
        title: 'Incoming Ticket Transfer 🎟️',
        message: `${req.user.firstName} ${req.user.lastName} sent you a ticket for "${ticket.eventId.title}".`,
        type: 'TRANSFER_RECEIVED',
        data: { transferId: transfer._id, token },
      });

      emitToUser(recipientUser._id, 'notification', {
        title: 'Incoming Ticket Transfer',
        message: `You received a ticket transfer for ${ticket.eventId.title}`,
      });
    }

    await logAudit({
      actorId: req.user._id,
      actorName: `${req.user.firstName} ${req.user.lastName}`,
      actorRole: req.user.role,
      action: 'TRANSFER_INITIATED',
      targetType: 'TRANSFER',
      targetId: transfer._id,
      details: { ticketId: ticket._id, recipient: recipientEmail || recipientPhone },
      req,
    });

    return res.status(201).json({
      success: true,
      message: 'Transfer initiated successfully. Recipient can claim this ticket.',
      data: transfer,
    });
  } catch (error) {
    console.error('[Transfer Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Accept ticket transfer
// @route   POST /api/transfers/:id/accept
// @access  Private
export const acceptTransfer = async (req, res) => {
  try {
    const { id } = req.params;
    let transfer = null;

    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      transfer = await Transfer.findById(id).populate('ticketId senderId');
    } else {
      transfer = await Transfer.findOne({ token: id }).populate('ticketId senderId');
    }

    if (!transfer) {
      return res.status(404).json({ success: false, message: 'Transfer request not found.' });
    }

    if (transfer.status !== 'PENDING') {
      return res.status(400).json({ success: false, message: `Transfer has already been ${transfer.status.toLowerCase()}.` });
    }

    if (new Date() > transfer.expiresAt) {
      transfer.status = 'EXPIRED';
      await transfer.save();
      return res.status(400).json({ success: false, message: 'This transfer link has expired.' });
    }

    const ticket = await Ticket.findById(transfer.ticketId._id).populate('eventId');
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Associated ticket not found.' });
    }

    const previousOwnerId = ticket.ownerId;
    const newOwnerId = req.user._id;

    // Generate new secure QR token so old physical/saved copies are invalidated
    const tempId = crypto.randomBytes(12).toString('hex');
    const newQrToken = generateSecureQRToken(tempId, ticket.eventId._id, newOwnerId);

    // Update ticket ownership
    ticket.ownerId = newOwnerId;
    ticket.qrToken = newQrToken;
    ticket.status = 'SOLD';
    ticket.history.push({
      action: 'TRANSFERRED',
      fromUser: previousOwnerId,
      toUser: newOwnerId,
      timestamp: new Date(),
      notes: `Transferred via transfer ${transfer._id}`,
    });
    await ticket.save();

    // Mark transfer as ACCEPTED
    transfer.status = 'ACCEPTED';
    transfer.recipientId = newOwnerId;
    transfer.acceptedAt = new Date();
    await transfer.save();

    // Notify sender that recipient accepted
    await Notification.create({
      userId: previousOwnerId,
      title: 'Ticket Transfer Accepted ✅',
      message: `${req.user.firstName} ${req.user.lastName} has accepted your ticket transfer.`,
      type: 'TRANSFER_ACCEPTED',
      data: { ticketId: ticket._id },
    });

    emitToUser(previousOwnerId, 'notification', {
      title: 'Transfer Accepted',
      message: `Your ticket transfer was accepted!`,
    });

    await logAudit({
      actorId: newOwnerId,
      actorName: `${req.user.firstName} ${req.user.lastName}`,
      actorRole: req.user.role,
      action: 'TRANSFER_ACCEPTED',
      targetType: 'TRANSFER',
      targetId: transfer._id,
      details: { ticketId: ticket._id, previousOwner: previousOwnerId },
      req,
    });

    return res.json({
      success: true,
      message: 'Ticket successfully claimed and transferred to your account!',
      data: ticket,
    });
  } catch (error) {
    console.error('[Accept Transfer Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get user's transfers (both sent and received)
// @route   GET /api/transfers/my-transfers
// @access  Private
export const getMyTransfers = async (req, res) => {
  try {
    const sent = await Transfer.find({ senderId: req.user._id })
      .populate('ticketId')
      .populate('recipientId', 'firstName lastName email')
      .sort({ createdAt: -1 });

    const received = await Transfer.find({
      $or: [{ recipientId: req.user._id }, { recipientEmail: req.user.email }],
    })
      .populate('ticketId')
      .populate('senderId', 'firstName lastName email')
      .sort({ createdAt: -1 });

    return res.json({ success: true, sent, received });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
