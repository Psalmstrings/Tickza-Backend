import express from 'express';
import {
  initiateTransfer,
  acceptTransfer,
  getMyTransfers,
} from '../controllers/transferController.js';
import { protect, requireApproved } from '../middleware/authMiddleware.js';

const router = express.Router();

// @route   GET  /api/transfers/my-transfers       — Private: user's sent/received transfers
router.get('/my-transfers', protect, getMyTransfers);

// @route   POST /api/transfers                    — Private (Approved): initiate a transfer
router.post('/', protect, requireApproved, initiateTransfer);

// @route   POST /api/transfers/:id/accept         — Private: accept a transfer (by ID or token)
router.post('/:id/accept', protect, acceptTransfer);

// @route   POST /api/transfers/:id/decline        — Private: decline a transfer
router.post('/:id/decline', protect, async (req, res) => {
  try {
    const { Transfer } = await import('../models/Transfer.js');
    const { Ticket }   = await import('../models/Ticket.js');
    const { Notification } = await import('../models/Notification.js');
    const { logAudit } = await import('../services/auditService.js');
    const { emitToUser } = await import('../services/socketService.js');

    const { id } = req.params;
    let transfer;

    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      transfer = await Transfer.findById(id).populate('ticketId senderId');
    } else {
      transfer = await Transfer.findOne({ token: id }).populate('ticketId senderId');
    }

    if (!transfer) {
      return res.status(404).json({ success: false, message: 'Transfer not found.' });
    }
    if (transfer.status !== 'PENDING') {
      return res.status(400).json({ success: false, message: `Transfer is already ${transfer.status.toLowerCase()}.` });
    }

    transfer.status = 'DECLINED';
    await transfer.save();

    // Revert the ticket to SOLD
    const ticket = await Ticket.findById(transfer.ticketId._id);
    if (ticket) {
      ticket.status = 'SOLD';
      await ticket.save();
    }

    // Notify sender
    await Notification.create({
      userId:  transfer.senderId._id,
      title:   'Transfer Declined',
      message: `Your ticket transfer was declined by the recipient.`,
      type:    'TRANSFER_SENT',
      data:    { transferId: transfer._id },
    });
    emitToUser(transfer.senderId._id, 'notification', {
      title:   'Transfer Declined',
      message: 'The recipient declined your ticket transfer.',
    });

    await logAudit({
      actorId:    req.user._id,
      actorName:  `${req.user.firstName} ${req.user.lastName}`,
      actorRole:  req.user.role,
      action:     'TRANSFER_DECLINED',
      targetType: 'TRANSFER',
      targetId:   transfer._id,
      req,
    });

    return res.json({ success: true, message: 'Transfer declined.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// @route   DELETE /api/transfers/:id              — Private (Approved): cancel a transfer
router.delete('/:id', protect, requireApproved, async (req, res) => {
  try {
    const { Transfer } = await import('../models/Transfer.js');
    const { Ticket }   = await import('../models/Ticket.js');
    const { logAudit } = await import('../services/auditService.js');

    const transfer = await Transfer.findById(req.params.id);
    if (!transfer) {
      return res.status(404).json({ success: false, message: 'Transfer not found.' });
    }

    // Only the sender (or admin) can cancel
    const isAdmin  = req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN';
    const isSender = transfer.senderId.toString() === req.user._id.toString();
    if (!isSender && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Only the sender can cancel this transfer.' });
    }
    if (transfer.status !== 'PENDING') {
      return res.status(400).json({ success: false, message: `Cannot cancel a transfer with status: ${transfer.status}` });
    }

    transfer.status = 'CANCELLED';
    await transfer.save();

    // Revert ticket to SOLD
    const ticket = await Ticket.findById(transfer.ticketId);
    if (ticket) {
      ticket.status = 'SOLD';
      await ticket.save();
    }

    await logAudit({
      actorId:    req.user._id,
      actorName:  `${req.user.firstName} ${req.user.lastName}`,
      actorRole:  req.user.role,
      action:     'TRANSFER_CANCELLED',
      targetType: 'TRANSFER',
      targetId:   transfer._id,
      req,
    });

    return res.json({ success: true, message: 'Transfer cancelled. Ticket returned to your inventory.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
