import crypto from 'crypto';
import { Ticket } from '../models/Ticket.js';
import { Event } from '../models/Event.js';
import { TicketType } from '../models/TicketType.js';
import { generateSecureQRToken, generateQRCodeDataURL } from '../services/qrService.js';
import { logAudit } from '../services/auditService.js';

// @desc    Get user's personal tickets
// @route   GET /api/tickets/my-tickets
// @access  Private
export const getMyTickets = async (req, res) => {
  try {
    const { status, filter } = req.query;
    const query = { ownerId: req.user._id };

    if (filter === 'transferred') {
      query.status = 'TRANSFERRED';
    } else if (filter === 'past') {
      // past events or used tickets
      query.status = { $in: ['USED', 'CANCELLED'] };
    } else if (filter === 'upcoming') {
      query.status = { $in: ['SOLD', 'AVAILABLE', 'RESERVED', 'LISTED'] };
    }

    const tickets = await Ticket.find(query)
      .populate('eventId')
      .populate('ticketTypeId')
      .sort({ createdAt: -1 });

    return res.json({ success: true, count: tickets.length, data: tickets });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get single ticket details with rendered QR Code
// @route   GET /api/tickets/:id
// @access  Private
export const getTicketById = async (req, res) => {
  try {
    const ticket = await Ticket.findById(req.params.id)
      .populate('eventId')
      .populate('ticketTypeId')
      .populate('ownerId', 'firstName lastName email phone');

    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    // Owner, staff, or admin can view
    const isOwner = ticket.ownerId._id.toString() === req.user._id.toString();
    const isAdmin = req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN';

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Not authorized to view this ticket' });
    }

    // Generate fresh QR Code Data URL from signed token
    const qrCodeImage = await generateQRCodeDataURL(ticket.qrToken);

    return res.json({
      success: true,
      data: {
        ...ticket.toObject(),
        qrCodeImage,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create tickets manually for an event
// @route   POST /api/tickets
// @access  Private (Approved user or Admin only)
export const createTicket = async (req, res) => {
  try {
    // CRITICAL BACKEND CHECK
    if (req.user.status !== 'APPROVED' && req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_APPROVAL_REQUIRED',
        message: 'Your account must be approved by an administrator before you can create tickets.',
      });
    }

    const { eventId, ticketTypeId, quantity = 1, price = 0, section = 'General', row = 'GA' } = req.body;

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    const createdTickets = [];
    for (let i = 0; i < quantity; i++) {
      const ticketNumber = `TICK-${Date.now().toString().slice(-6)}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const tempId = crypto.randomBytes(12).toString('hex');
      const qrToken = generateSecureQRToken(tempId, event._id, req.user._id);

      const ticket = await Ticket.create({
        eventId: event._id,
        ticketTypeId: ticketTypeId || null,
        ownerId: req.user._id,
        ticketNumber,
        section,
        row,
        seat: `Seat-${i + 1}`,
        price,
        qrToken,
        status: 'SOLD',
        transferable: true,
        resellable: true,
        history: [
          {
            action: 'ISSUED',
            toUser: req.user._id,
            notes: 'Created manually by organizer',
          },
        ],
      });
      createdTickets.push(ticket);
    }

    await logAudit({
      actorId: req.user._id,
      actorName: `${req.user.firstName} ${req.user.lastName}`,
      actorRole: req.user.role,
      action: 'TICKET_CREATED_MANUALLY',
      targetType: 'TICKET',
      details: { eventId, count: quantity },
      req,
    });

    return res.status(201).json({
      success: true,
      message: `${quantity} ticket(s) created successfully`,
      data: createdTickets,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Auto-search Ticketmaster / external events for 1-click import
// @route   GET /api/tickets/ticketmaster/search
// @access  Private (Approved user only)
export const searchTicketmaster = async (req, res) => {
  try {
    if (req.user.status !== 'APPROVED' && req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_APPROVAL_REQUIRED',
        message: 'Your account must be approved by an administrator before you can create tickets.',
      });
    }

    const { query = '' } = req.query;

    // High quality curated mock dataset mirroring Ticketmaster events
    const sampleEvents = [
      {
        id: 'tm-1',
        title: 'Coldplay - Music of the Spheres World Tour',
        venue: 'Wembley Stadium, London',
        date: '2026-10-15',
        time: '19:30',
        category: 'Music',
        description: 'Experience Coldplay live in concert featuring their greatest hits and stunning visual performances.',
        coverImage: 'https://images.unsplash.com/photo-1540039155733-5bb30b53aa14?w=1000&auto=format&fit=crop&q=80',
        latitude: 51.556,
        longitude: -0.2795,
        ticketTypes: [
          { name: 'General Pitch Standing', price: 0, quantity: 500, section: 'Pitch Standing' },
          { name: 'Level 1 Reserved Seating', price: 0, quantity: 300, section: 'Sec 104' },
          { name: 'VIP Infinity Lounge', price: 0, quantity: 50, section: 'VIP Lounge' },
        ],
      },
      {
        id: 'tm-2',
        title: 'Burna Boy Live: No Sign of Weakness Tour',
        venue: 'Tafawa Balewa Square (TBS), Lagos',
        date: '2026-11-20',
        time: '20:00',
        category: 'Music',
        description: 'African Giant Burna Boy returns to Lagos with an electric full live band experience.',
        coverImage: 'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=1000&auto=format&fit=crop&q=80',
        latitude: 6.4474,
        longitude: 3.4024,
        ticketTypes: [
          { name: 'Regular Entry', price: 0, quantity: 1000, section: 'General' },
          { name: 'VIP Front Row', price: 0, quantity: 200, section: 'VIP' },
          { name: 'VVIP Table of 10', price: 0, quantity: 20, section: 'VVIP Table' },
        ],
      },
      {
        id: 'tm-3',
        title: 'FIFA World Cup 2026 Celebration Match',
        venue: 'MetLife Stadium, East Rutherford',
        date: '2026-06-18',
        time: '18:00',
        category: 'Sports',
        description: 'Special exhibition and international tournament game celebrating the World Cup 2026.',
        coverImage: 'https://images.unsplash.com/photo-1508098682722-e99c43a406b2?w=1000&auto=format&fit=crop&q=80',
        latitude: 40.8128,
        longitude: -74.0742,
        ticketTypes: [
          { name: 'Category 1 Seating', price: 0, quantity: 400, section: 'Lower Tier' },
          { name: 'Category 2 Seating', price: 0, quantity: 600, section: 'Upper Tier' },
        ],
      },
      {
        id: 'tm-4',
        title: 'Afro Nation Music Festival 2026',
        venue: 'Eko Atlantic City, Victoria Island',
        date: '2026-12-28',
        time: '16:00',
        category: 'Festival',
        description: 'The worlds biggest celebration of Afrobeats, Amapiano, dancehall, and global black culture.',
        coverImage: 'https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=1000&auto=format&fit=crop&q=80',
        latitude: 6.4167,
        longitude: 3.4095,
        ticketTypes: [
          { name: 'General 3-Day Pass', price: 0, quantity: 1500, section: 'Beach Arena' },
          { name: 'VIP Golden Circle', price: 0, quantity: 300, section: 'Golden Circle' },
        ],
      },
    ];

    const filtered = query
      ? sampleEvents.filter(
          (e) =>
            e.title.toLowerCase().includes(query.toLowerCase()) ||
            e.venue.toLowerCase().includes(query.toLowerCase())
        )
      : sampleEvents;

    return res.json({ success: true, count: filtered.length, data: filtered });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
