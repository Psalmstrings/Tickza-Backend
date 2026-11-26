import crypto from 'crypto';
import mongoose from 'mongoose';
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

// @desc    Get SEO and Open Graph preview for a shared ticket
// @route   GET /api/tickets/:id/seo
// @access  Public
export const getTicketSeoPreview = async (req, res) => {
  try {
    const ticket = await Ticket.findById(req.params.id)
      .populate('eventId')
      .populate('ticketTypeId')
      .lean();

    if (!ticket || !ticket.eventId) {
      return res.status(404).send('Ticket or event not found');
    }

    const event = ticket.eventId;
    const clientUrl = process.env.CLIENT_URL || 'https://tickza.vercel.app';
    const canonicalUrl = `${clientUrl}/tickets/${ticket._id}`;
    const title = `${event.title} — Digital Admission Pass | Tickza`;

    let dateStr = '';
    if (event.startDate) {
      const d = new Date(event.startDate);
      dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      if (event.startTime) dateStr += ` at ${event.startTime}`;
    }

    const tierName = ticket.ticketTypeId?.name || 'General Admission';
    const venueStr = event.venue || event.address || '';
    const parts = [];
    parts.push(`🎟️ Tier: ${tierName}`);
    if (dateStr) parts.push(`📅 ${dateStr}`);
    if (venueStr) parts.push(`📍 ${venueStr}`);

    let description = parts.join(' • ');
    if (!description) description = 'Verified digital ticket on Tickza.';

    let imageUrl = event.coverImage?.url || event.thumbnail?.url || `${clientUrl}/tickza-official-logo.jpg`;
    if (imageUrl.startsWith('/')) imageUrl = `${clientUrl}${imageUrl}`;

    if (req.headers.accept?.includes('application/json')) {
      return res.json({
        success: true,
        seo: { title, description, imageUrl, canonicalUrl, type: 'ticket' },
      });
    }

    const escapeHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const safeTitle = escapeHtml(title);
    const safeDesc = escapeHtml(description);
    const safeImage = escapeHtml(imageUrl);
    const safeUrl = escapeHtml(canonicalUrl);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${safeTitle}</title>
  <meta name="description" content="${safeDesc}">
  <link rel="canonical" href="${safeUrl}">

  <!-- Open Graph -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="${safeUrl}">
  <meta property="og:site_name" content="Tickza">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDesc}">
  <meta property="og:image" content="${safeImage}">
  <meta property="og:image:secure_url" content="${safeImage}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:site" content="@Tickza">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="${safeDesc}">
  <meta name="twitter:image" content="${safeImage}">

  <meta http-equiv="refresh" content="0;url=${safeUrl}">
  <script>window.location.replace(${JSON.stringify(canonicalUrl)});</script>
</head>
<body>
  <h1>${safeTitle}</h1>
  <p>${safeDesc}</p>
  <img src="${safeImage}" alt="${safeTitle}" style="max-width:100%; height:auto;" />
  <p><a href="${safeUrl}">View Ticket on Tickza</a></p>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=1800, s-maxage=3600');
    return res.status(200).send(html);
  } catch (error) {
    return res.status(500).send('Error generating ticket preview');
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

// @desc    Search published events for ticket template import
// @route   GET /api/tickets/ticketmaster/search
// @access  Private (Approved user only)
export const searchTicketmaster = async (req, res) => {
  try {
    if (req.user.status !== 'APPROVED' && req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_APPROVAL_REQUIRED',
        message: 'Your account must be approved by an administrator before you can create tickets.',
      });
    }

    const { query = '' } = req.query;
    const filter = { status: 'PUBLISHED' };
    if (query && typeof query === 'string' && query.trim()) {
      filter.$or = [
        { title: { $regex: query.trim(), $options: 'i' } },
        { venue: { $regex: query.trim(), $options: 'i' } },
        { category: { $regex: query.trim(), $options: 'i' } },
      ];
    }

    const realEvents = await Event.find(filter)
      .select('title venue startDate startTime category coverImage')
      .limit(20);

    const eventIds = realEvents.map(e => e._id);
    const tiers = await TicketType.find({ eventId: { $in: eventIds } });

    const results = realEvents.map(ev => ({
      id: ev._id.toString(),
      title: ev.title,
      venue: ev.venue,
      date: ev.startDate ? new Date(ev.startDate).toISOString().slice(0, 10) : '',
      time: ev.startTime || '',
      category: ev.category,
      coverImage: ev.coverImage?.url || '',
      ticketTypes: tiers.filter(t => t.eventId.toString() === ev._id.toString()),
    }));

    return res.json({ success: true, count: results.length, data: results });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
