import mongoose from 'mongoose';
import { Ticket } from '../models/Ticket.js';
import { Event } from '../models/Event.js';
import { CheckIn } from '../models/CheckIn.js';
import { Notification } from '../models/Notification.js';
import { verifySecureQRToken } from '../services/qrService.js';
import { emitToEvent } from '../services/socketService.js';
import { logAudit } from '../services/auditService.js';

// @desc    Scan a QR code or validate a Ticket ID to check in an attendee
// @route   POST /api/tickets/checkin/scan
// @access  Private (Admin or Approved event organizer / staff)
export const scanQR = async (req, res) => {
  try {
    const rawInput = (
      req.body.qrToken ||
      req.body.ticketId ||
      req.body.ticketNumber ||
      req.body.token ||
      ''
    ).toString().trim();

    const { eventId } = req.body;

    if (!rawInput) {
      return res.status(400).json({
        success: false,
        message: 'Ticket ID or QR code token is required.',
      });
    }

    // Clean input: remove leading '#' or ticket URL prefixes if user pasted a link
    let cleanInput = rawInput.replace(/^#/, '').trim();
    if (cleanInput.includes('/tickets/')) {
      cleanInput = cleanInput.split('/tickets/').pop().split('?')[0].trim();
    }

    // ── Locate Ticket in Database ──────────────────────────────────────────
    // Supports:
    // 1. Signed QR token (TICKZA-V1... or TICKAPP-V1...)
    // 2. Ticket Number (e.g. "TICK-852150-52B2CA", "#TICK-852150-52B2CA", or "852150-52B2CA")
    // 3. Database ObjectId (24-character hex)
    // 4. Exact stored qrToken match
    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const safeClean = escapeRegex(cleanInput);
    const safeRaw = escapeRegex(rawInput);
    const safeWithoutTick = escapeRegex(cleanInput.replace(/^TICK[-_]?/i, ''));

    const orConditions = [
      { qrToken: cleanInput },
      { qrToken: rawInput },
      { ticketNumber: new RegExp(`^${safeClean}$`, 'i') },
      { ticketNumber: new RegExp(`^${safeRaw}$`, 'i') },
      { ticketNumber: new RegExp(`^TICK-${safeWithoutTick}$`, 'i') },
      { ticketNumber: new RegExp(`${safeWithoutTick}$`, 'i') },
    ];

    if (mongoose.Types.ObjectId.isValid(cleanInput) && cleanInput.length === 24) {
      orConditions.push({ _id: cleanInput });
    }

    const ticket = await Ticket.findOne({ $or: orConditions })
      .populate('eventId')
      .populate('ownerId', 'firstName lastName email phone')
      .populate('ticketTypeId', 'name section');

    if (!ticket) {
      return res.status(404).json({
        success: false,
        code: 'TICKET_NOT_FOUND',
        message: `Pass / ticket "${cleanInput}" not found. Please verify the Ticket ID or QR code.`,
      });
    }

    // ── Check Organizer / Staff Authorization ──────────────────────────────
    const event = ticket.eventId;
    if (!event) {
      return res.status(404).json({
        success: false,
        code: 'EVENT_NOT_FOUND',
        message: 'The event associated with this ticket was not found.',
      });
    }

    const isAdmin = req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN';
    const isOrganizer = event.organizerId && event.organizerId.toString() === req.user._id.toString();

    if (!isAdmin && !isOrganizer) {
      return res.status(403).json({
        success: false,
        code: 'NOT_AUTHORIZED_FOR_EVENT',
        message: `You are not authorised to check in tickets for "${event.title}".`,
      });
    }

    // Optional eventId mismatch safeguard (if organizer specifically selected an event in dropdown)
    if (eventId && eventId.trim() && event._id.toString() !== eventId.toString()) {
      // If the current user owns both events, allow admission but notify
      if (!isAdmin && !isOrganizer) {
        return res.status(400).json({
          success: false,
          code: 'EVENT_MISMATCH',
          message: `This pass is for "${event.title}", not the selected event.`,
          data: {
            expectedEventId: eventId,
            actualEvent: {
              id: event._id,
              title: event.title,
            },
          },
        });
      }
    }

    // ── Step 4: Guard against duplicate check-in or full capacity reached ──
    const admittedCapacity = ticket.admittedCapacity || 1;
    const currentCheckedIn = ticket.attendeesCheckedIn || 0;

    if (ticket.status === 'USED' || (ticket.checkedInAt && currentCheckedIn >= admittedCapacity)) {
      // Record as a duplicate scan in the CheckIn collection for audit
      await CheckIn.create({
        ticketId:    ticket._id,
        eventId:     event._id,
        staffId:     req.user._id,
        checkInTime: new Date(),
        status:      'DUPLICATE',
        notes:       `Duplicate scan attempt. Original check-in: ${ticket.checkedInAt?.toISOString()}`,
      });

      return res.status(409).json({
        success: false,
        code:    'ALREADY_CHECKED_IN',
        message: `This ticket / package was already fully checked in at ${ticket.checkedInAt?.toLocaleString()}.`,
        data: {
          ticket: {
            ticketNumber: ticket.ticketNumber,
            section:      ticket.section,
            seat:         ticket.seat,
            format:       ticket.format,
            admittedCapacity,
            checkedInAt:  ticket.checkedInAt,
          },
          event: {
            id:    event._id,
            title: event.title,
            venue: event.venue,
          },
        },
      });
    }

    // ── Step 5: Validate ticket status ───────────────────────────────────────
    if (ticket.status === 'CANCELLED' || ticket.status === 'REFUNDED' || ticket.status === 'AVAILABLE') {
      await CheckIn.create({
        ticketId:    ticket._id,
        eventId:     event._id,
        staffId:     req.user._id,
        checkInTime: new Date(),
        status:      'INVALID',
        notes:       `Ticket status is ${ticket.status}`,
      });

      return res.status(400).json({
        success: false,
        code:    'TICKET_INVALID',
        message: `This pass / ticket cannot be used: status is ${ticket.status}.`,
      });
    }

    // ── Step 6: Atomic check-in operation (protects against concurrent scans) ────────
    const isMultiCapacity = admittedCapacity > 1;
    const countToAdmit = req.body.admitCount ? Math.min(parseInt(req.body.admitCount, 10), admittedCapacity - currentCheckedIn) : (isMultiCapacity ? admittedCapacity : 1);

    const checkInTimestamp = new Date();

    // Atomic update with optimistic lock: guarantees two concurrent scanners cannot admit the same ticket
    const updatedTicket = await Ticket.findOneAndUpdate(
      {
        _id: ticket._id,
        status: { $nin: ['USED', 'CANCELLED', 'REFUNDED'] },
        $or: [
          { attendeesCheckedIn: { $lt: admittedCapacity } },
          { attendeesCheckedIn: { $exists: false } },
        ],
      },
      {
        $inc: { attendeesCheckedIn: countToAdmit },
        $set: {
          checkedInBy: req.user._id,
          ...(ticket.checkedInAt ? {} : { checkedInAt: checkInTimestamp }),
        },
        $push: {
          history: {
            action: 'CHECKED_IN',
            toUser: ticket.ownerId?._id || ticket.ownerId || req.user._id,
            timestamp: checkInTimestamp,
            notes: `Checked in ${countToAdmit} guest(s) by ${req.user.firstName} ${req.user.lastName} at "${event.title}"`,
          },
        },
      },
      { new: true }
    );

    if (!updatedTicket) {
      await CheckIn.create({
        ticketId: ticket._id,
        eventId: event._id,
        staffId: req.user._id,
        checkInTime: new Date(),
        status: 'DUPLICATE',
        notes: `Simultaneous duplicate scan blocked atomically.`,
      });

      return res.status(409).json({
        success: false,
        code: 'ALREADY_CHECKED_IN',
        message: 'This ticket was just checked in by another scanner or is already at full capacity.',
      });
    }

    const newCheckedInCount = updatedTicket.attendeesCheckedIn || countToAdmit;
    const isFullyCheckedIn = newCheckedInCount >= admittedCapacity;
    const targetStatus = isFullyCheckedIn ? 'USED' : 'PARTIALLY_USED';

    if (updatedTicket.status !== targetStatus) {
      updatedTicket.status = targetStatus;
      await updatedTicket.save();
    }

    // Create CheckIn record
    const checkInRecord = await CheckIn.create({
      ticketId:          ticket._id,
      eventId:           event._id,
      staffId:           req.user._id,
      checkInTime:       new Date(),
      status:            isFullyCheckedIn ? 'VALID' : 'PARTIAL',
      attendeesAdmitted: countToAdmit,
      notes:             `Admitted ${countToAdmit} attendee(s) for ${ticket.ticketNumber} [${ticket.format || 'INDIVIDUAL'}]`,
    });

    // Notify the ticket owner if present
    const isFree = ticket.admissionType === 'FREE';
    if (ticket.ownerId?._id) {
      try {
        await Notification.create({
          userId:  ticket.ownerId._id,
          title:   isFree ? 'Pass Checked In ✅' : 'Ticket Checked In ✅',
          message: `Your ${isFree ? 'free pass' : 'ticket'} for "${event.title}" has been successfully scanned (${newCheckedInCount}/${admittedCapacity} admitted). Enjoy the event!`,
          type:    'CHECK_IN',
          data:    { ticketId: ticket._id, eventId: event._id },
        });
      } catch (e) {
        console.warn('[CheckIn Notification Warning]', e.message);
      }
    }

    // Broadcast real-time check-in update to event room
    emitToEvent(event._id, 'check_in', {
      ticketId:           ticket._id,
      ticketNumber:       ticket.ticketNumber,
      admissionType:      ticket.admissionType || 'PAID',
      registrationRef:    ticket.registrationRef || null,
      section:            ticket.section,
      owner:              ticket.ownerId ? `${ticket.ownerId.firstName || ''} ${ticket.ownerId.lastName || ''}`.trim() : 'Guest Attendee',
      admittedCapacity,
      attendeesCheckedIn: newCheckedInCount,
      checkedInAt:        updatedTicket.checkedInAt || checkInTimestamp,
    });

    await logAudit({
      actorId:    req.user._id,
      actorName:  `${req.user.firstName} ${req.user.lastName}`,
      actorRole:  req.user.role,
      action:     'TICKET_CHECKED_IN',
      targetType: 'TICKET',
      targetId:   ticket._id,
      details:    { eventId: event._id, ticketNumber: ticket.ticketNumber, admitted: countToAdmit, capacity: admittedCapacity, admissionType: ticket.admissionType || 'PAID' },
      req,
    });

    return res.json({
      success: true,
      code:    'CHECK_IN_SUCCESS',
      message: isFree
        ? `Welcome! Free pass verified for "${event.title}" (${newCheckedInCount}/${admittedCapacity} guests admitted).`
        : `Welcome! Ticket successfully verified for "${event.title}" (${newCheckedInCount}/${admittedCapacity} guests admitted).`,
      data: {
        checkIn: checkInRecord,
        ticket: {
          id:                 ticket._id,
          ticketNumber:       ticket.ticketNumber,
          format:             ticket.format,
          admissionType:      ticket.admissionType || 'PAID',
          registrationRef:    ticket.registrationRef || null,
          admittedCapacity,
          attendeesCheckedIn: newCheckedInCount,
          section:            ticket.section,
          row:                ticket.row,
          seat:               ticket.seat,
          tableNumber:        ticket.tableNumber,
          status:             ticket.status,
          checkedInAt:        updatedTicket.checkedInAt || checkInTimestamp,
          owner: ticket.ownerId ? {
            firstName: ticket.ownerId.firstName,
            lastName:  ticket.ownerId.lastName,
            email:     ticket.ownerId.email,
          } : null,
          ticketType: ticket.ticketTypeId?.name || (isFree ? 'Free Pass' : 'General'),
        },
        event: {
          id:        event._id,
          title:     event.title,
          venue:     event.venue,
          startDate: event.startDate,
          startTime: event.startTime,
        },
      },
    });
  } catch (error) {
    console.error('[CheckIn scanQR Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get all check-in records for an event
// @route   GET /api/checkin/event/:eventId
// @access  Private (Admin or the event organizer)
export const getEventCheckIns = async (req, res) => {
  try {
    const { eventId } = req.params;
    const { page = 1, limit = 50, status = '' } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found.' });
    }

    // Authorization: admin or the event organizer
    const isAdmin     = req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN';
    const isOrganizer = event.organizerId.toString() === req.user._id.toString();

    if (!isAdmin && !isOrganizer) {
      return res.status(403).json({
        success: false,
        message: 'Only admins or the event organizer can view check-in records.',
      });
    }

    const query = { eventId };
    if (status) query.status = status;

    const [checkIns, total] = await Promise.all([
      CheckIn.find(query)
        .populate({
          path:     'ticketId',
          select:   'ticketNumber section row seat ownerId',
          populate: { path: 'ownerId', select: 'firstName lastName email' },
        })
        .populate('staffId', 'firstName lastName email')
        .sort({ checkInTime: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10)),
      CheckIn.countDocuments(query),
    ]);

    // Summary stats
    const [validCount, duplicateCount, invalidCount] = await Promise.all([
      CheckIn.countDocuments({ eventId, status: 'VALID' }),
      CheckIn.countDocuments({ eventId, status: 'DUPLICATE' }),
      CheckIn.countDocuments({ eventId, status: 'INVALID' }),
    ]);

    return res.json({
      success: true,
      total,
      page:  parseInt(page, 10),
      pages: Math.ceil(total / parseInt(limit, 10)),
      summary: { validCount, duplicateCount, invalidCount },
      data:  checkIns,
    });
  } catch (error) {
    console.error('[CheckIn getEventCheckIns Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
