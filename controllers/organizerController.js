import crypto from 'crypto';
import { Event } from '../models/Event.js';
import { TicketType } from '../models/TicketType.js';
import { Ticket } from '../models/Ticket.js';
import { Order } from '../models/Order.js';
import { CheckIn } from '../models/CheckIn.js';
import { User } from '../models/User.js';
import { PromoCode } from '../models/PromoCode.js';
import { TeamMember } from '../models/TeamMember.js';
import { Payout } from '../models/Payout.js';
import { Notification } from '../models/Notification.js';
import { logAudit } from '../services/auditService.js';

// ────────────────────────────────────────────────────
// Helper: ensure the requester is owner of the event
// ────────────────────────────────────────────────────
async function authorizeEventAccess(req, eventId) {
  const event = await Event.findById(eventId);
  if (!event) return { error: 'Event not found', status: 404 };
  const isAdmin = req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN';
  const isOrganizer = event.organizerId.toString() === req.user._id.toString();
  if (!isAdmin && !isOrganizer) {
    return { error: 'Not authorised for this event', status: 403 };
  }
  return { event };
}

// ── DASHBOARD OVERVIEW ────────────────────────────────

/**
 * @route   GET /api/organizer/overview
 * @desc    Get organizer dashboard overview stats
 * @access  Private (Approved)
 */
export const getOrganizerOverview = async (req, res) => {
  try {
    const organizerId = req.user._id;
    const { range = '30' } = req.query; // days

    const rangeNum = parseInt(range, 10) || 30;
    const since = new Date();
    since.setDate(since.getDate() - rangeNum);

    // Get organizer's events
    const events = await Event.find({ organizerId });
    const eventIds = events.map(e => e._id);

    if (eventIds.length === 0) {
      return res.json({
        success: true,
        data: {
          totalRevenue: 0,
          ticketsSold: 0,
          totalAttendees: 0,
          activeEvents: 0,
          pendingPayouts: 0,
          conversionRate: 0,
          avgTicketValue: 0,
          upcomingEvents: 0,
          recentActivity: [],
          topEvents: [],
        },
      });
    }

    // Orders for these events (paid)
    const orders = await Order.find({
      'items.eventId': { $in: eventIds },
      status: 'PAID',
      createdAt: { $gte: since },
    }).populate('items.eventId', 'title');

    const allOrders = await Order.find({
      'items.eventId': { $in: eventIds },
      status: 'PAID',
    });

    // Tickets sold
    const tickets = await Ticket.find({
      eventId: { $in: eventIds },
      status: { $in: ['SOLD', 'USED'] },
      createdAt: { $gte: since },
    });

    const allTickets = await Ticket.find({
      eventId: { $in: eventIds },
      status: { $in: ['SOLD', 'USED'] },
    });

    // Revenue from order items (sum totalPrice for event items)
    let revenue = 0;
    for (const order of orders) {
      for (const item of order.items) {
        if (eventIds.some(id => id.toString() === item.eventId?.toString())) {
          revenue += item.totalPrice || 0;
        }
      }
    }

    // Attendees (checked-in)
    const checkIns = await CheckIn.countDocuments({
      eventId: { $in: eventIds },
      status: 'VALID',
    });

    // Active events
    const now = new Date();
    const activeEvents = events.filter(e =>
      e.status === 'PUBLISHED' && new Date(e.startDate) >= now
    ).length;

    const upcomingEvents = events.filter(e =>
      e.status === 'PUBLISHED' && new Date(e.startDate) >= now
    ).length;

    // Avg ticket value
    const totalRevAllTime = allTickets.reduce((s, t) => s + (t.price || 0), 0);
    const avgTicketValue = allTickets.length > 0 ? totalRevAllTime / allTickets.length : 0;

    // Conversion rate (orders / total unique visitors - we use orders / tickets as proxy)
    const conversionRate = allTickets.length > 0
      ? Math.min(100, ((allOrders.length / Math.max(allTickets.length, 1)) * 100))
      : 0;

    // Top events by ticket count
    const ticketsByEvent = {};
    for (const t of allTickets) {
      const eId = t.eventId.toString();
      ticketsByEvent[eId] = (ticketsByEvent[eId] || 0) + 1;
    }
    const topEvents = events
      .map(e => ({ event: e, count: ticketsByEvent[e._id.toString()] || 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return res.json({
      success: true,
      data: {
        totalRevenue: revenue,
        ticketsSold: tickets.length,
        totalAttendees: checkIns,
        activeEvents,
        pendingPayouts: 0, // Will be populated from Payout model
        conversionRate: parseFloat(conversionRate.toFixed(1)),
        avgTicketValue: parseFloat(avgTicketValue.toFixed(2)),
        upcomingEvents,
        totalEvents: events.length,
        topEvents: topEvents.map(({ event, count }) => ({
          id: event._id,
          title: event.title,
          date: event.startDate,
          status: event.status,
          ticketsSold: count,
        })),
      },
    });
  } catch (error) {
    console.error('[Organizer Overview Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── ANALYTICS ────────────────────────────────────────

/**
 * @route   GET /api/organizer/analytics
 * @desc    Revenue + sales analytics with time-series data
 * @access  Private (Approved)
 */
export const getOrganizerAnalytics = async (req, res) => {
  try {
    const organizerId = req.user._id;
    const { range = '30', eventId } = req.query;

    const rangeNum = parseInt(range, 10) || 30;
    const since = new Date();
    since.setDate(since.getDate() - rangeNum);

    let eventFilter = { organizerId };
    if (eventId) eventFilter._id = eventId;

    const events = await Event.find(eventFilter);
    const eventIds = events.map(e => e._id);

    if (eventIds.length === 0) {
      return res.json({
        success: true,
        data: {
          summary: {
            totalRevenue: 0,
            totalTickets: 0,
            totalOrders: 0,
            avgOrderValue: 0,
          },
          timeSeries: {
            tickets: [],
            orders: [],
          },
          ticketTypeBreakdown: [],
        },
      });
    }

    // Time-series: group tickets by day
    const ticketsByDay = await Ticket.aggregate([
      {
        $match: {
          eventId: { $in: eventIds },
          status: { $in: ['SOLD', 'USED'] },
          createdAt: { $gte: since },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
          },
          count: { $sum: 1 },
          revenue: { $sum: '$price' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Orders by day
    const ordersByDay = await Order.aggregate([
      {
        $match: {
          'items.eventId': { $in: eventIds },
          status: 'PAID',
          createdAt: { $gte: since },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
          },
          count: { $sum: 1 },
          revenue: { $sum: '$totalAmount' },
          avgOrderValue: { $avg: '$totalAmount' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Ticket type breakdown
    const ticketTypeBreakdown = await Ticket.aggregate([
      {
        $match: {
          eventId: { $in: eventIds },
          status: { $in: ['SOLD', 'USED'] },
        },
      },
      {
        $group: {
          _id: '$ticketTypeId',
          count: { $sum: 1 },
          revenue: { $sum: '$price' },
        },
      },
      {
        $lookup: {
          from: 'tickettypes',
          localField: '_id',
          foreignField: '_id',
          as: 'ticketType',
        },
      },
      { $unwind: { path: '$ticketType', preserveNullAndEmptyArrays: true } },
    ]);

    // Summary totals
    const totalRevenue = ticketsByDay.reduce((s, d) => s + d.revenue, 0);
    const totalTickets = ticketsByDay.reduce((s, d) => s + d.count, 0);
    const totalOrders = ordersByDay.reduce((s, d) => s + d.count, 0);
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

    return res.json({
      success: true,
      data: {
        summary: {
          totalRevenue,
          totalTickets,
          totalOrders,
          avgOrderValue: parseFloat(avgOrderValue.toFixed(2)),
        },
        timeSeries: {
          tickets: ticketsByDay,
          orders: ordersByDay,
        },
        ticketTypeBreakdown: ticketTypeBreakdown.map(t => ({
          name: t.ticketType?.name || 'Unknown',
          count: t.count,
          revenue: t.revenue,
        })),
      },
    });
  } catch (error) {
    console.error('[Organizer Analytics Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── EVENT MANAGEMENT ──────────────────────────────────

/**
 * @route   GET /api/organizer/events
 * @desc    Organizer events with ticket + revenue stats
 */
export const getOrganizerEvents = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const query = { organizerId: req.user._id };
    if (status) query.status = status;

    const [events, total] = await Promise.all([
      Event.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
      Event.countDocuments(query),
    ]);

    const eventIds = events.map(e => e._id);

    // Batch-fetch stats
    const [ticketCounts, revenueSums, checkInCounts] = await Promise.all([
      Ticket.aggregate([
        { $match: { eventId: { $in: eventIds }, status: { $in: ['SOLD', 'USED'] } } },
        { $group: { _id: '$eventId', count: { $sum: 1 }, revenue: { $sum: '$price' } } },
      ]),
      Order.aggregate([
        { $match: { 'items.eventId': { $in: eventIds }, status: 'PAID' } },
        { $unwind: '$items' },
        { $match: { 'items.eventId': { $in: eventIds } } },
        { $group: { _id: '$items.eventId', revenue: { $sum: '$items.totalPrice' } } },
      ]),
      CheckIn.aggregate([
        { $match: { eventId: { $in: eventIds }, status: 'VALID' } },
        { $group: { _id: '$eventId', count: { $sum: 1 } } },
      ]),
    ]);

    const ticketMap = {};
    ticketCounts.forEach(t => { ticketMap[t._id] = { count: t.count, revenue: t.revenue }; });
    const revenueMap = {};
    revenueSums.forEach(r => { revenueMap[r._id] = r.revenue; });
    const checkInMap = {};
    checkInCounts.forEach(c => { checkInMap[c._id] = c.count; });

    const enriched = events.map(ev => ({
      ...ev.toObject(),
      ticketsSold: ticketMap[ev._id]?.count || 0,
      revenue: revenueMap[ev._id] || ticketMap[ev._id]?.revenue || 0,
      checkedIn: checkInMap[ev._id] || 0,
    }));

    return res.json({
      success: true,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
      data: enriched,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/organizer/events/:id/stats
 * @desc    Single event detailed stats
 */
export const getEventStats = async (req, res) => {
  try {
    const { event, error, status } = await authorizeEventAccess(req, req.params.id);
    if (error) return res.status(status).json({ success: false, message: error });

    const eventId = event._id;
    const ticketTypes = await TicketType.find({ eventId });

    // Per-ticket-type stats
    const ticketStats = await Ticket.aggregate([
      { $match: { eventId, status: { $in: ['SOLD', 'USED'] } } },
      {
        $group: {
          _id: '$ticketTypeId',
          sold: { $sum: 1 },
          revenue: { $sum: '$price' },
          checkedIn: {
            $sum: { $cond: [{ $eq: ['$status', 'USED'] }, 1, 0] },
          },
        },
      },
    ]);

    const statsMap = {};
    ticketStats.forEach(s => { statsMap[s._id] = s; });

    const ticketTypesWithStats = ticketTypes.map(tt => ({
      ...tt.toObject(),
      sold: statsMap[tt._id]?.sold || 0,
      revenue: statsMap[tt._id]?.revenue || 0,
      checkedIn: statsMap[tt._id]?.checkedIn || 0,
      available: tt.availableQuantity,
    }));

    // Overall check-in stats
    const [validCI, totalSold] = await Promise.all([
      CheckIn.countDocuments({ eventId, status: 'VALID' }),
      Ticket.countDocuments({ eventId, status: { $in: ['SOLD', 'USED'] } }),
    ]);

    // Daily sales
    const dailySales = await Ticket.aggregate([
      { $match: { eventId, status: { $in: ['SOLD', 'USED'] } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
          revenue: { $sum: '$price' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const totalRevenue = ticketTypesWithStats.reduce((s, t) => s + t.revenue, 0);

    return res.json({
      success: true,
      data: {
        event,
        ticketTypes: ticketTypesWithStats,
        summary: {
          totalRevenue,
          totalSold,
          checkedIn: validCI,
          attendanceRate: totalSold > 0 ? parseFloat(((validCI / totalSold) * 100).toFixed(1)) : 0,
        },
        dailySales,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   PUT /api/organizer/events/:id
 * @desc    Update an event (organizer)
 */
export const updateOrganizerEvent = async (req, res) => {
  try {
    const { event, error, status } = await authorizeEventAccess(req, req.params.id);
    if (error) return res.status(status).json({ success: false, message: error });

    const allowedUpdates = [
      'description', 'category', 'venue', 'address',
      'startTime', 'endTime', 'doorsOpen',
      'status', 'featured', 'entranceInfo',
      'timeAnnounced', 'multiDay', 'countdownEnabled',
    ];
    allowedUpdates.forEach(key => {
      if (req.body[key] !== undefined) event[key] = req.body[key];
    });

    // Handle Title and Slug
    if (req.body.title && req.body.title.trim() && req.body.title !== event.title) {
      event.title = req.body.title.trim();
      event.slug = req.body.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') + '-' + Date.now().toString().slice(-4);
    }

    // Handle Dates
    if (req.body.startDate) {
      const d = new Date(req.body.startDate);
      if (!isNaN(d.getTime())) event.startDate = d;
    }
    if (req.body.endDate) {
      const d = new Date(req.body.endDate);
      if (!isNaN(d.getTime())) event.endDate = d;
    }

    // Handle Image Replacement
    if (req.body.coverImageUrl) {
      event.coverImage = {
        url: req.body.coverImageUrl,
        publicId: req.body.coverImagePublicId || event.coverImage?.publicId || 'manual_upload',
      };
    } else if (typeof req.body.coverImage === 'string' && req.body.coverImage.trim()) {
      event.coverImage = {
        url: req.body.coverImage.trim(),
        publicId: 'manual_upload',
      };
    } else if (req.body.coverImage && typeof req.body.coverImage === 'object' && req.body.coverImage.url) {
      event.coverImage = {
        url: req.body.coverImage.url,
        publicId: req.body.coverImage.publicId || event.coverImage?.publicId || 'manual_upload',
      };
    }

    if (req.body.seatMapUrl) {
      event.seatMap = { url: req.body.seatMapUrl, publicId: 'seatmap' };
    }

    await event.save();

    await logAudit({
      actorId: req.user._id,
      actorName: `${req.user.firstName} ${req.user.lastName}`,
      actorRole: req.user.role,
      action: 'EVENT_UPDATED',
      targetType: 'EVENT',
      targetId: event._id,
      details: { title: event.title },
      req,
    });

    return res.json({ success: true, message: 'Event updated successfully.', data: event });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   DELETE /api/organizer/events/:id
 * @desc    Safely delete or archive an event (organizer or admin)
 */
export const deleteOrganizerEvent = async (req, res) => {
  try {
    const { event, error, status } = await authorizeEventAccess(req, req.params.id);
    if (error) return res.status(status).json({ success: false, message: error });

    // Check for existing paid orders or issued tickets
    const [paidTicketsCount, paidOrdersCount] = await Promise.all([
      Ticket.countDocuments({ eventId: event._id, status: { $in: ['SOLD', 'USED'] } }),
      Order.countDocuments({ 'items.eventId': event._id, status: 'PAID' }),
    ]);

    if (paidTicketsCount > 0 || paidOrdersCount > 0) {
      // Safe archival: do not destroy attendee booking records or financial history
      event.status = 'SUSPENDED';
      await event.save();

      await logAudit({
        actorId: req.user._id,
        actorName: `${req.user.firstName} ${req.user.lastName}`,
        actorRole: req.user.role,
        action: 'EVENT_SUSPENDED_WITH_ORDERS',
        targetType: 'EVENT',
        targetId: event._id,
        details: { title: event.title, paidTicketsCount, paidOrdersCount },
        req,
      });

      return res.json({
        success: true,
        archived: true,
        message: `Event has ${paidTicketsCount} issued ticket(s) and cannot be permanently deleted. It has been cancelled and unlisted from public discovery to protect attendee records.`,
        data: event,
      });
    }

    // No paid orders or issued tickets: safe to permanently remove
    await Promise.all([
      Event.findByIdAndDelete(event._id),
      TicketType.deleteMany({ eventId: event._id }),
      PromoCode.deleteMany({ eventId: event._id }),
      Ticket.deleteMany({ eventId: event._id }),
    ]);

    await logAudit({
      actorId: req.user._id,
      actorName: `${req.user.firstName} ${req.user.lastName}`,
      actorRole: req.user.role,
      action: 'EVENT_PERMANENTLY_DELETED',
      targetType: 'EVENT',
      targetId: event._id,
      details: { title: event.title },
      req,
    });

    return res.json({
      success: true,
      deleted: true,
      message: 'Event and associated ticket tiers deleted successfully.',
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── TICKET TYPES ──────────────────────────────────────

/**
 * @route   GET /api/organizer/events/:id/ticket-types
 */
export const getEventTicketTypes = async (req, res) => {
  try {
    const { error, status } = await authorizeEventAccess(req, req.params.id);
    if (error) return res.status(status).json({ success: false, message: error });

    const ticketTypes = await TicketType.find({ eventId: req.params.id });
    return res.json({ success: true, data: ticketTypes });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/organizer/events/:id/ticket-types
 */
export const createTicketType = async (req, res) => {
  try {
    const { event, error, status } = await authorizeEventAccess(req, req.params.id);
    if (error) return res.status(status).json({ success: false, message: error });

    const {
      name, description, price, quantity,
      format, admittedPerTicket, currency,
      section, row, transferable, resellable,
      saleStartDate, saleEndDate, minPerOrder, maxPerCustomer,
      isActive, visibility, benefits, terms, metadata,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Ticket type name is required' });
    }

    const validFormats = ['INDIVIDUAL', 'GROUP_BUNDLE', 'RESERVED_TABLE', 'CUSTOM'];
    const chosenFormat = format && validFormats.includes(format) ? format : 'INDIVIDUAL';

    const numPrice = parseFloat(price);
    if (isNaN(numPrice) || numPrice < 0) {
      return res.status(400).json({ success: false, message: 'Price must be a valid non-negative number' });
    }

    const qty = parseInt(quantity, 10);
    if (isNaN(qty) || qty < 1) {
      return res.status(400).json({ success: false, message: 'Quantity must be at least 1' });
    }

    let capacity = parseInt(admittedPerTicket, 10);
    if (isNaN(capacity) || capacity < 1) {
      capacity = (chosenFormat === 'GROUP_BUNDLE' || chosenFormat === 'RESERVED_TABLE') ? 2 : 1;
    }

    // Process benefits array if string or array
    let parsedBenefits = [];
    if (Array.isArray(benefits)) {
      parsedBenefits = benefits.map(b => String(b).trim()).filter(Boolean);
    } else if (typeof benefits === 'string' && benefits.trim()) {
      parsedBenefits = benefits.split('\n').map(b => b.trim()).filter(Boolean);
    }

    const tt = await TicketType.create({
      eventId: event._id,
      name: name.trim(),
      description: description ? description.trim() : '',
      format: chosenFormat,
      admittedPerTicket: capacity,
      price: numPrice,
      currency: currency || 'NGN',
      quantity: qty,
      availableQuantity: qty,
      section: section ? section.trim() : 'General',
      row: row ? row.trim() : '',
      benefits: parsedBenefits,
      minPerOrder: minPerOrder ? Math.max(1, parseInt(minPerOrder, 10)) : 1,
      maxPerCustomer: maxPerCustomer ? Math.max(1, parseInt(maxPerCustomer, 10)) : null,
      transferable: transferable !== false,
      resellable: resellable !== false,
      saleStartDate: saleStartDate ? new Date(saleStartDate) : null,
      saleEndDate: saleEndDate ? new Date(saleEndDate) : null,
      isActive: isActive !== false,
      visibility: visibility || 'PUBLIC',
      terms: terms ? terms.trim() : '',
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
    });

    await logAudit({
      actorId: req.user._id,
      actorName: `${req.user.firstName} ${req.user.lastName}`,
      actorRole: req.user.role,
      action: 'TICKET_TYPE_CREATED',
      targetType: 'TICKET_TYPE',
      targetId: tt._id,
      details: { eventId: event._id, name: tt.name, format: tt.format, price: tt.price, quantity: tt.quantity },
      req,
    });

    return res.status(201).json({ success: true, message: 'Ticket type created successfully', data: tt });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   PUT /api/organizer/events/:id/ticket-types/:ttId
 */
export const updateTicketType = async (req, res) => {
  try {
    const { event, error, status } = await authorizeEventAccess(req, req.params.id);
    if (error) return res.status(status).json({ success: false, message: error });

    const tt = await TicketType.findOne({ _id: req.params.ttId, eventId: event._id });
    if (!tt) return res.status(404).json({ success: false, message: 'Ticket type not found' });

    const allowed = [
      'name', 'description', 'price', 'quantity', 'format', 'admittedPerTicket',
      'currency', 'section', 'row', 'transferable', 'resellable', 'isActive',
      'visibility', 'saleStartDate', 'saleEndDate', 'minPerOrder', 'maxPerCustomer',
      'terms', 'metadata'
    ];

    allowed.forEach(k => {
      if (req.body[k] !== undefined) {
        if (k === 'price') {
          const p = parseFloat(req.body.price);
          if (!isNaN(p) && p >= 0) tt.price = p;
        } else if (k === 'admittedPerTicket') {
          const cap = parseInt(req.body.admittedPerTicket, 10);
          if (!isNaN(cap) && cap >= 1) tt.admittedPerTicket = cap;
        } else if (k === 'minPerOrder') {
          tt.minPerOrder = req.body.minPerOrder ? Math.max(1, parseInt(req.body.minPerOrder, 10)) : 1;
        } else if (k === 'maxPerCustomer') {
          tt.maxPerCustomer = req.body.maxPerCustomer ? Math.max(1, parseInt(req.body.maxPerCustomer, 10)) : null;
        } else if (k === 'saleStartDate') {
          tt.saleStartDate = req.body.saleStartDate ? new Date(req.body.saleStartDate) : null;
        } else if (k === 'saleEndDate') {
          tt.saleEndDate = req.body.saleEndDate ? new Date(req.body.saleEndDate) : null;
        } else {
          tt[k] = req.body[k];
        }
      }
    });

    if (req.body.benefits !== undefined) {
      if (Array.isArray(req.body.benefits)) {
        tt.benefits = req.body.benefits.map(b => String(b).trim()).filter(Boolean);
      } else if (typeof req.body.benefits === 'string') {
        tt.benefits = req.body.benefits.split('\n').map(b => b.trim()).filter(Boolean);
      }
    }

    // Concurrency-safe inventory adjustment if total quantity changed
    if (req.body.quantity !== undefined) {
      const newQty = parseInt(req.body.quantity, 10);
      if (!isNaN(newQty) && newQty >= 0) {
        const sold = Math.max(0, tt.quantity - tt.availableQuantity);
        if (newQty < sold) {
          return res.status(400).json({
            success: false,
            message: `Cannot reduce total quantity below already sold quantity (${sold} tickets sold).`,
          });
        }
        tt.availableQuantity = newQty - sold;
        tt.quantity = newQty;
      }
    }

    await tt.save();

    await logAudit({
      actorId: req.user._id,
      actorName: `${req.user.firstName} ${req.user.lastName}`,
      actorRole: req.user.role,
      action: 'TICKET_TYPE_UPDATED',
      targetType: 'TICKET_TYPE',
      targetId: tt._id,
      details: { eventId: event._id, name: tt.name, price: tt.price, quantity: tt.quantity },
      req,
    });

    return res.json({ success: true, message: 'Ticket type updated successfully', data: tt });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/organizer/events/:id/ticket-types/:ttId/duplicate
 * @desc    Duplicate an existing ticket type
 */
export const duplicateTicketType = async (req, res) => {
  try {
    const { event, error, status } = await authorizeEventAccess(req, req.params.id);
    if (error) return res.status(status).json({ success: false, message: error });

    const source = await TicketType.findOne({ _id: req.params.ttId, eventId: event._id });
    if (!source) return res.status(404).json({ success: false, message: 'Source ticket type not found' });

    const newObj = source.toObject();
    delete newObj._id;
    delete newObj.createdAt;
    delete newObj.updatedAt;

    newObj.name = `${source.name} (Copy)`;
    newObj.availableQuantity = source.quantity; // Fresh inventory for duplicate

    const duplicated = await TicketType.create(newObj);

    await logAudit({
      actorId: req.user._id,
      actorName: `${req.user.firstName} ${req.user.lastName}`,
      actorRole: req.user.role,
      action: 'TICKET_TYPE_DUPLICATED',
      targetType: 'TICKET_TYPE',
      targetId: duplicated._id,
      details: { eventId: event._id, originalName: source.name, newName: duplicated.name },
      req,
    });

    return res.status(201).json({ success: true, message: 'Ticket type duplicated', data: duplicated });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   DELETE /api/organizer/events/:id/ticket-types/:ttId
 * @desc    Safely delete a ticket type (prevent if orders or tickets exist)
 */
export const deleteTicketType = async (req, res) => {
  try {
    const { event, error, status } = await authorizeEventAccess(req, req.params.id);
    if (error) return res.status(status).json({ success: false, message: error });

    const tt = await TicketType.findOne({ _id: req.params.ttId, eventId: event._id });
    if (!tt) return res.status(404).json({ success: false, message: 'Ticket type not found' });

    // Guard against destructive action compromising existing sales records
    const ticketsCount = await Ticket.countDocuments({
      ticketTypeId: tt._id,
      status: { $in: ['SOLD', 'USED', 'PARTIALLY_USED', 'RESERVED', 'LISTED', 'TRANSFER_PENDING'] },
    });

    if (ticketsCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete "${tt.name}" because ${ticketsCount} active/sold ticket(s) exist for it. You can deactivate sales instead.`,
      });
    }

    await TicketType.findByIdAndDelete(tt._id);

    await logAudit({
      actorId: req.user._id,
      actorName: `${req.user.firstName} ${req.user.lastName}`,
      actorRole: req.user.role,
      action: 'TICKET_TYPE_DELETED',
      targetType: 'TICKET_TYPE',
      targetId: tt._id,
      details: { eventId: event._id, name: tt.name },
      req,
    });

    return res.json({ success: true, message: 'Ticket type removed successfully' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── ATTENDEES ─────────────────────────────────────────

/**
 * @route   GET /api/organizer/events/:id/attendees
 */
export const getEventAttendees = async (req, res) => {
  try {
    const { event, error, status } = await authorizeEventAccess(req, req.params.id);
    if (error) return res.status(status).json({ success: false, message: error });

    const { page = 1, limit = 50, search = '', ticketType = '', checkedIn = '' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const matchQuery = {
      eventId: event._id,
      status: { $in: ['SOLD', 'USED', 'TRANSFER_PENDING', 'TRANSFERRED'] },
    };
    if (checkedIn === 'true') matchQuery.checkedInAt = { $exists: true, $ne: null };
    if (checkedIn === 'false') matchQuery.checkedInAt = { $exists: false };
    if (ticketType) matchQuery.ticketTypeId = ticketType;

    let tickets = await Ticket.find(matchQuery)
      .populate('ownerId', 'firstName lastName email phone')
      .populate('ticketTypeId', 'name price')
      .populate('orderId', 'orderNumber totalAmount createdAt')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Apply name/email search (after populate)
    if (search) {
      const q = search.toLowerCase();
      tickets = tickets.filter(t => {
        const name = `${t.ownerId?.firstName} ${t.ownerId?.lastName}`.toLowerCase();
        const email = t.ownerId?.email?.toLowerCase() || '';
        const num = t.ticketNumber?.toLowerCase() || '';
        return name.includes(q) || email.includes(q) || num.includes(q);
      });
    }

    const total = await Ticket.countDocuments(matchQuery);

    return res.json({
      success: true,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
      data: tickets,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── ORDERS ────────────────────────────────────────────

/**
 * @route   GET /api/organizer/events/:id/orders
 */
export const getEventOrders = async (req, res) => {
  try {
    const { event, error, status } = await authorizeEventAccess(req, req.params.id);
    if (error) return res.status(status).json({ success: false, message: error });

    const { page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [orders, total] = await Promise.all([
      Order.find({ 'items.eventId': event._id })
        .populate('userId', 'firstName lastName email phone')
        .populate('items.ticketTypeId', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Order.countDocuments({ 'items.eventId': event._id }),
    ]);

    return res.json({
      success: true,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
      data: orders,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── PROMO CODES ───────────────────────────────────────

/**
 * @route   GET /api/organizer/events/:id/promo-codes
 */
export const getPromoCodes = async (req, res) => {
  try {
    const { error, status } = await authorizeEventAccess(req, req.params.id);
    if (error) return res.status(status).json({ success: false, message: error });

    const codes = await PromoCode.find({ eventId: req.params.id }).sort({ createdAt: -1 });
    return res.json({ success: true, data: codes });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/organizer/events/:id/promo-codes
 */
export const createPromoCode = async (req, res) => {
  try {
    const { event, error, status } = await authorizeEventAccess(req, req.params.id);
    if (error) return res.status(status).json({ success: false, message: error });

    const {
      code, discountType, discountValue,
      usageLimit, perCustomerLimit, maxDiscountAmount,
      minimumOrderAmount, validFrom, validUntil,
      description, applicableTicketTypes,
    } = req.body;

    if (!code) return res.status(400).json({ success: false, message: 'Promo code is required' });
    if (!discountValue || parseFloat(discountValue) <= 0) {
      return res.status(400).json({ success: false, message: 'Discount value must be greater than 0' });
    }

    const promo = await PromoCode.create({
      eventId: event._id,
      organizerId: req.user._id,
      code: code.toUpperCase().trim(),
      discountType: discountType || 'PERCENTAGE',
      discountValue: parseFloat(discountValue),
      usageLimit: usageLimit ? parseInt(usageLimit, 10) : null,
      perCustomerLimit: perCustomerLimit ? parseInt(perCustomerLimit, 10) : null,
      maxDiscountAmount: maxDiscountAmount ? parseFloat(maxDiscountAmount) : null,
      minimumOrderAmount: minimumOrderAmount ? parseFloat(minimumOrderAmount) : 0,
      validFrom: validFrom ? new Date(validFrom) : null,
      validUntil: validUntil ? new Date(validUntil) : null,
      description: description || '',
      applicableTicketTypes: Array.isArray(applicableTicketTypes) ? applicableTicketTypes : [],
    });

    return res.status(201).json({ success: true, data: promo });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'This promo code already exists for this event' });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   PUT /api/organizer/events/:id/promo-codes/:codeId
 */
export const updatePromoCode = async (req, res) => {
  try {
    const { error, status } = await authorizeEventAccess(req, req.params.id);
    if (error) return res.status(status).json({ success: false, message: error });

    const promo = await PromoCode.findById(req.params.codeId);
    if (!promo) return res.status(404).json({ success: false, message: 'Promo code not found' });

    const allowed = [
      'discountValue', 'discountType', 'usageLimit', 'perCustomerLimit', 'maxDiscountAmount',
      'minimumOrderAmount', 'validFrom', 'validUntil', 'isActive', 'description', 'applicableTicketTypes'
    ];
    allowed.forEach(k => {
      if (req.body[k] !== undefined) {
        if (k === 'usageLimit' || k === 'perCustomerLimit') {
          promo[k] = req.body[k] ? parseInt(req.body[k], 10) : null;
        } else if (k === 'maxDiscountAmount') {
          promo[k] = req.body[k] ? parseFloat(req.body[k]) : null;
        } else if (k === 'validFrom' || k === 'validUntil') {
          promo[k] = req.body[k] ? new Date(req.body[k]) : null;
        } else {
          promo[k] = req.body[k];
        }
      }
    });
    await promo.save();

    return res.json({ success: true, data: promo });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   DELETE /api/organizer/events/:id/promo-codes/:codeId
 */
export const deletePromoCode = async (req, res) => {
  try {
    const { error, status } = await authorizeEventAccess(req, req.params.id);
    if (error) return res.status(status).json({ success: false, message: error });

    await PromoCode.findByIdAndDelete(req.params.codeId);
    return res.json({ success: true, message: 'Promo code deleted' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/organizer/promo-codes/validate
 * @desc    Validate a promo code at checkout (public/buyer endpoint)
 */
export const validatePromoCode = async (req, res) => {
  try {
    const { code, eventId, orderAmount, ticketTypeId, items } = req.body;
    if (!code || !eventId) {
      return res.status(400).json({ success: false, message: 'Code and eventId are required' });
    }

    const subtotal = parseFloat(orderAmount) || 0;
    const promo = await PromoCode.findOne({ eventId, code: code.toUpperCase().trim(), isActive: true });
    if (!promo) {
      return res.status(404).json({ success: false, message: 'Invalid or inactive promo code.' });
    }

    const now = new Date();
    if (promo.validFrom && now < promo.validFrom) {
      return res.status(400).json({ success: false, message: 'This promo code is not active yet.' });
    }
    if (promo.validUntil && now > promo.validUntil) {
      return res.status(400).json({ success: false, message: 'This promo code has expired.' });
    }
    if (promo.usageLimit && promo.usageCount >= promo.usageLimit) {
      return res.status(400).json({ success: false, message: 'This promo code has reached its total usage limit.' });
    }
    if (promo.minimumOrderAmount && subtotal < promo.minimumOrderAmount) {
      return res.status(400).json({
        success: false,
        message: `Minimum order amount of ₦${promo.minimumOrderAmount.toLocaleString()} required.`,
      });
    }

    // Per-customer limit check if user is logged in
    if (promo.perCustomerLimit && req.user?._id) {
      const userOrdersWithPromo = await Order.countDocuments({
        userId: req.user._id,
        promoCode: promo.code,
        status: { $in: ['PAID', 'PENDING'] },
      });
      if (userOrdersWithPromo >= promo.perCustomerLimit) {
        return res.status(400).json({
          success: false,
          message: `You have reached the maximum redemptions (${promo.perCustomerLimit}) for this code.`,
        });
      }
    }

    // Check applicable ticket types
    let eligibleSubtotal = subtotal;
    if (promo.applicableTicketTypes && promo.applicableTicketTypes.length > 0) {
      const allowedIds = promo.applicableTicketTypes.map(id => id.toString());
      if (Array.isArray(items) && items.length > 0) {
        eligibleSubtotal = items
          .filter(it => allowedIds.includes((it.ticketTypeId || it.id || it._id || '').toString()))
          .reduce((sum, it) => sum + ((parseFloat(it.price) || 0) * (parseInt(it.quantity, 10) || 1)), 0);
      } else if (ticketTypeId) {
        if (!allowedIds.includes(ticketTypeId.toString())) {
          return res.status(400).json({
            success: false,
            message: 'This promo code does not apply to the selected ticket tier.',
          });
        }
      }

      if (eligibleSubtotal <= 0) {
        return res.status(400).json({
          success: false,
          message: 'This promo code does not apply to the selected ticket tier(s).',
        });
      }
    }

    let discount = promo.discountType === 'PERCENTAGE'
      ? (eligibleSubtotal * promo.discountValue) / 100
      : promo.discountValue;

    if (promo.maxDiscountAmount && discount > promo.maxDiscountAmount) {
      discount = promo.maxDiscountAmount;
    }

    const finalDiscount = parseFloat(Math.min(discount, subtotal).toFixed(2));
    const finalPayable = parseFloat(Math.max(0, subtotal - finalDiscount).toFixed(2));

    return res.json({
      success: true,
      data: {
        code: promo.code,
        discountType: promo.discountType,
        discountValue: promo.discountValue,
        discountAmount: finalDiscount,
        subtotal,
        finalAmount: finalPayable,
        message: 'Promo code applied successfully!',
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── TEAM ──────────────────────────────────────────────

/**
 * @route   GET /api/organizer/team
 */
export const getTeamMembers = async (req, res) => {
  try {
    const members = await TeamMember.find({ organizerId: req.user._id, status: { $ne: 'REMOVED' } })
      .sort({ createdAt: -1 });
    return res.json({ success: true, data: members });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/organizer/team
 */
export const inviteTeamMember = async (req, res) => {
  try {
    const { email, role, firstName, lastName } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });

    // Check if already on team
    const existing = await TeamMember.findOne({ organizerId: req.user._id, email: email.toLowerCase() });
    if (existing) {
      return res.status(400).json({ success: false, message: 'This person is already on your team' });
    }

    // Check if user exists in system
    const userInSystem = await User.findOne({ email: email.toLowerCase() });

    // Default permissions by role
    const rolePermissions = {
      MANAGER: { viewEvents: true, editEvents: true, viewTickets: true, manageTickets: true, viewAttendees: true, checkIn: true, viewOrders: true, viewAnalytics: true },
      CHECKIN_STAFF: { viewEvents: true, viewAttendees: true, checkIn: true },
      FINANCE: { viewEvents: true, viewOrders: true, viewAnalytics: true, viewPayouts: true },
      MARKETING: { viewEvents: true, viewAttendees: true, managePromos: true },
    };

    const permissions = rolePermissions[role] || rolePermissions['CHECKIN_STAFF'];

    const member = await TeamMember.create({
      organizerId: req.user._id,
      userId: userInSystem?._id || null,
      email: email.toLowerCase(),
      firstName: firstName || userInSystem?.firstName || '',
      lastName: lastName || userInSystem?.lastName || '',
      role: role || 'CHECKIN_STAFF',
      status: userInSystem ? 'ACTIVE' : 'PENDING',
      permissions,
    });

    // Notify user if they exist
    if (userInSystem) {
      await Notification.create({
        userId: userInSystem._id,
        title: 'Team Invitation',
        message: `${req.user.firstName} ${req.user.lastName} has added you to their event team as ${role || 'Check-in Staff'}.`,
        type: 'TEAM_INVITE',
        data: { organizerId: req.user._id },
      });
    }

    return res.status(201).json({ success: true, data: member });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'This person is already on your team' });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   PUT /api/organizer/team/:memberId
 */
export const updateTeamMember = async (req, res) => {
  try {
    const member = await TeamMember.findOne({ _id: req.params.memberId, organizerId: req.user._id });
    if (!member) return res.status(404).json({ success: false, message: 'Team member not found' });

    const { role, status, permissions } = req.body;
    if (role) member.role = role;
    if (status) member.status = status;
    if (permissions) member.permissions = { ...member.permissions, ...permissions };
    await member.save();

    return res.json({ success: true, data: member });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   DELETE /api/organizer/team/:memberId
 */
export const removeTeamMember = async (req, res) => {
  try {
    const member = await TeamMember.findOne({ _id: req.params.memberId, organizerId: req.user._id });
    if (!member) return res.status(404).json({ success: false, message: 'Team member not found' });

    member.status = 'REMOVED';
    await member.save();
    return res.json({ success: true, message: 'Team member removed' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── PAYOUTS ───────────────────────────────────────────

/**
 * @route   GET /api/organizer/payouts
 */
export const getPayouts = async (req, res) => {
  try {
    const organizerId = req.user._id;
    const payouts = await Payout.find({ organizerId })
      .populate('eventId', 'title startDate')
      .sort({ createdAt: -1 });

    // Compute total net revenue
    const events = await Event.find({ organizerId });
    const eventIds = events.map(e => e._id);
    const tickets = await Ticket.find({ eventId: { $in: eventIds }, status: { $in: ['SOLD', 'USED'] } });
    const grossRevenue = tickets.reduce((s, t) => s + (t.price || 0), 0);
    const platformFee = grossRevenue * 0.05; // 5% platform fee
    const processingFee = grossRevenue * 0.015; // 1.5% processing
    const netRevenue = grossRevenue - platformFee - processingFee;

    const paidOut = payouts.filter(p => p.status === 'PAID').reduce((s, p) => s + p.netAmount, 0);
    const pending = payouts.filter(p => p.status === 'PENDING').reduce((s, p) => s + p.netAmount, 0);

    return res.json({
      success: true,
      data: {
        summary: {
          grossRevenue,
          platformFee,
          processingFee,
          netRevenue,
          paidOut,
          pending,
          available: Math.max(0, netRevenue - paidOut),
        },
        payouts,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── CHECK-IN ──────────────────────────────────────────

/**
 * @route   GET /api/organizer/events/:id/checkins
 */
export const getEventCheckInStats = async (req, res) => {
  try {
    const { event, error, status } = await authorizeEventAccess(req, req.params.id);
    if (error) return res.status(status).json({ success: false, message: error });

    const eventId = event._id;

    const [totalSold, totalCheckedIn, recentCheckIns, byTicketType] = await Promise.all([
      Ticket.countDocuments({ eventId, status: { $in: ['SOLD', 'USED'] } }),
      CheckIn.countDocuments({ eventId, status: 'VALID' }),
      CheckIn.find({ eventId, status: 'VALID' })
        .populate({
          path: 'ticketId',
          select: 'ticketNumber ownerId ticketTypeId',
          populate: [
            { path: 'ownerId', select: 'firstName lastName' },
            { path: 'ticketTypeId', select: 'name' },
          ],
        })
        .populate('staffId', 'firstName lastName')
        .sort({ checkInTime: -1 })
        .limit(20),
      Ticket.aggregate([
        { $match: { eventId, status: { $in: ['SOLD', 'USED'] } } },
        {
          $group: {
            _id: '$ticketTypeId',
            total: { $sum: 1 },
            checkedIn: { $sum: { $cond: [{ $eq: ['$status', 'USED'] }, 1, 0] } },
          },
        },
        {
          $lookup: {
            from: 'tickettypes',
            localField: '_id',
            foreignField: '_id',
            as: 'type',
          },
        },
        { $unwind: '$type' },
      ]),
    ]);

    return res.json({
      success: true,
      data: {
        event: { _id: event._id, title: event.title, startDate: event.startDate, venue: event.venue },
        stats: {
          totalSold,
          totalCheckedIn,
          notArrived: totalSold - totalCheckedIn,
          attendanceRate: totalSold > 0 ? parseFloat(((totalCheckedIn / totalSold) * 100).toFixed(1)) : 0,
        },
        byTicketType: byTicketType.map(b => ({
          name: b.type.name,
          total: b.total,
          checkedIn: b.checkedIn,
          notArrived: b.total - b.checkedIn,
        })),
        recentCheckIns,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── ALL ORGANIZER ATTENDEES (CRM) ─────────────────────

/**
 * @route   GET /api/organizer/attendees
 * @desc    All attendees across all organizer events (CRM view)
 */
export const getAllAttendees = async (req, res) => {
  try {
    const { page = 1, limit = 50, search = '' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const events = await Event.find({ organizerId: req.user._id });
    const eventIds = events.map(e => e._id);

    const matchQuery = {
      eventId: { $in: eventIds },
      status: { $in: ['SOLD', 'USED'] },
    };

    let tickets = await Ticket.find(matchQuery)
      .populate('ownerId', 'firstName lastName email phone createdAt')
      .populate('eventId', 'title startDate')
      .populate('ticketTypeId', 'name price')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    if (search) {
      const q = search.toLowerCase();
      tickets = tickets.filter(t => {
        const name = `${t.ownerId?.firstName} ${t.ownerId?.lastName}`.toLowerCase();
        const email = t.ownerId?.email?.toLowerCase() || '';
        return name.includes(q) || email.includes(q);
      });
    }

    const total = await Ticket.countDocuments(matchQuery);

    return res.json({
      success: true,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
      data: tickets,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── GLOBAL SEARCH ─────────────────────────────────────

/**
 * @route   GET /api/organizer/search
 */
export const organizerSearch = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.json({ success: true, data: { events: [], tickets: [], orders: [] } });
    }

    const events = await Event.find({ organizerId: req.user._id });
    const eventIds = events.map(e => e._id);
    const regex = { $regex: q.trim(), $options: 'i' };

    const [matchedEvents, matchedTickets, matchedOrders] = await Promise.all([
      Event.find({ organizerId: req.user._id, $or: [{ title: regex }, { venue: regex }] }).limit(5),
      Ticket.find({ eventId: { $in: eventIds }, $or: [{ ticketNumber: regex }] })
        .populate('ownerId', 'firstName lastName email')
        .populate('eventId', 'title')
        .limit(10),
      Order.find({ 'items.eventId': { $in: eventIds }, $or: [{ orderNumber: regex }] })
        .populate('userId', 'firstName lastName email')
        .limit(5),
    ]);

    return res.json({
      success: true,
      data: { events: matchedEvents, tickets: matchedTickets, orders: matchedOrders },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── COMPLIMENTARY TICKETS ─────────────────────────────

/**
 * @route   POST /api/organizer/events/:id/complimentary
 * @desc    Issue complimentary tickets
 */
export const issueComplimentaryTickets = async (req, res) => {
  try {
    const { event, error, status } = await authorizeEventAccess(req, req.params.id);
    if (error) return res.status(status).json({ success: false, message: error });

    const { ticketTypeId, guests, note } = req.body;
    // guests is array of { firstName, lastName, email, phone, quantity }
    if (!ticketTypeId || !Array.isArray(guests) || guests.length === 0) {
      return res.status(400).json({ success: false, message: 'Ticket type and guest list are required' });
    }

    const tt = await TicketType.findById(ticketTypeId);
    if (!tt) return res.status(404).json({ success: false, message: 'Ticket type not found' });

    const { generateSecureQRToken } = await import('../services/qrService.js');

    const createdTickets = [];
    for (const g of guests) {
      const qty = parseInt(g.quantity || 1, 10);
      let user = await User.findOne({ email: g.email.toLowerCase().trim() });
      if (!user) {
        user = await User.create({
          firstName: g.firstName || 'Guest',
          lastName: g.lastName || 'Attendee',
          email: g.email.toLowerCase().trim(),
          phone: g.phone || '08000000000',
          passwordHash: 'COMP_GUEST_NO_PASS',
          role: 'USER',
          status: 'APPROVED',
        });
      }

      for (let i = 0; i < qty; i++) {
        const ticketNumber = `COMP-${Date.now().toString().slice(-5)}${i}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const tempId = crypto.randomBytes(12).toString('hex');
        const qrToken = generateSecureQRToken(tempId, event._id, user._id);

        const ticket = await Ticket.create({
          eventId: event._id,
          ticketTypeId: tt._id,
          ownerId: user._id,
          ticketNumber,
          section: tt.section || 'General',
          row: 'VIP/Comp',
          seat: `Comp-${i + 1}`,
          price: 0,
          qrToken,
          status: 'SOLD',
          transferable: false,
          resellable: false,
          history: [
            {
              action: 'ISSUED',
              toUser: user._id,
              notes: `Complimentary pass issued by organizer: ${note || 'Guest list'}`,
            },
          ],
        });
        createdTickets.push(ticket);
      }
    }

    return res.status(201).json({
      success: true,
      message: `Successfully issued ${createdTickets.length} complimentary ticket(s)`,
      data: createdTickets,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── POST-EVENT REPORTS ────────────────────────────────

/**
 * @route   GET /api/organizer/events/:id/report
 */
export const getEventReport = async (req, res) => {
  try {
    const { event, error, status } = await authorizeEventAccess(req, req.params.id);
    if (error) return res.status(status).json({ success: false, message: error });

    const eventId = event._id;

    const [tickets, checkIns, promoCodes, orders] = await Promise.all([
      Ticket.find({ eventId }).populate('ticketTypeId', 'name price'),
      CheckIn.find({ eventId, status: 'VALID' }),
      PromoCode.find({ eventId }),
      Order.find({ 'items.eventId': eventId, status: 'PAID' }),
    ]);

    const paidTickets = tickets.filter(t => t.price > 0 && (t.status === 'SOLD' || t.status === 'USED'));
    const compTickets = tickets.filter(t => t.price === 0 && (t.status === 'SOLD' || t.status === 'USED'));
    const refundedTickets = tickets.filter(t => t.status === 'REFUNDED');
    const checkedInCount = checkIns.length;
    const totalSold = paidTickets.length + compTickets.length;
    const attendanceRate = totalSold > 0 ? parseFloat(((checkedInCount / totalSold) * 100).toFixed(1)) : 0;
    const grossRevenue = paidTickets.reduce((s, t) => s + (t.price || 0), 0);
    const platformFee = grossRevenue * 0.05;
    const processingFee = grossRevenue * 0.015;
    const netRevenue = grossRevenue - platformFee - processingFee;

    // Best-selling ticket type
    const ttMap = {};
    paidTickets.forEach(t => {
      const name = t.ticketTypeId?.name || 'General';
      ttMap[name] = (ttMap[name] || 0) + 1;
    });
    let bestSelling = 'None';
    let maxSold = 0;
    Object.entries(ttMap).forEach(([name, count]) => {
      if (count > maxSold) { maxSold = count; bestSelling = name; }
    });

    return res.json({
      success: true,
      data: {
        event: {
          id: event._id,
          title: event.title,
          venue: event.venue,
          startDate: event.startDate,
          status: event.status,
        },
        summary: {
          totalSold,
          paidTicketsCount: paidTickets.length,
          compTicketsCount: compTickets.length,
          refundedCount: refundedTickets.length,
          grossRevenue,
          platformFee,
          processingFee,
          netRevenue,
          checkedInCount,
          noShowCount: Math.max(0, totalSold - checkedInCount),
          attendanceRate,
          bestSellingTicket: bestSelling,
        },
        promos: promoCodes.map(p => ({
          code: p.code,
          uses: p.usageCount,
          discountValue: p.discountValue,
          discountType: p.discountType,
        })),
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── REFUND MANAGEMENT ─────────────────────────────────

/**
 * @route   POST /api/organizer/orders/:id/refund
 */
export const processOrderRefund = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    // Validate organizer ownership
    const firstItem = order.items?.[0];
    if (firstItem?.eventId) {
      const { error, status } = await authorizeEventAccess(req, firstItem.eventId);
      if (error) return res.status(status).json({ success: false, message: error });
    }

    order.status = 'REFUNDED';
    await order.save();

    // Mark tickets as REFUNDED
    await Ticket.updateMany(
      { orderId: order._id },
      {
        $set: { status: 'REFUNDED' },
        $push: {
          history: {
            action: 'CANCELLED',
            timestamp: new Date(),
            notes: 'Order refunded by organizer',
          },
        },
      }
    );

    // Notify buyer
    await Notification.create({
      userId: order.userId,
      title: 'Order Refunded',
      message: `Your order #${order.orderNumber} has been refunded by the event organizer.`,
      type: 'ORDER_UPDATE',
      data: { orderId: order._id },
    });

    return res.json({ success: true, message: 'Order refunded successfully', data: order });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ── SETTINGS & BANK ACCOUNT ───────────────────────────

/**
 * @route   GET /api/organizer/settings
 */
export const getOrganizerSettings = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-passwordHash');
    return res.json({
      success: true,
      data: {
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        bankAccount: user.bankAccount || { bankName: '', accountNumber: '', accountName: '' },
        branding: user.branding || { brandColor: '#4F46E5', logoUrl: '' },
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @route   PUT /api/organizer/settings
 */
export const updateOrganizerSettings = async (req, res) => {
  try {
    const { firstName, lastName, phone, bankAccount, branding } = req.body;
    const user = await User.findById(req.user._id);

    if (firstName) user.firstName = firstName;
    if (lastName) user.lastName = lastName;
    if (phone) user.phone = phone;
    if (bankAccount) {
      user.bankAccount = {
        bankName: bankAccount.bankName || '',
        accountNumber: bankAccount.accountNumber || '',
        accountName: bankAccount.accountName || '',
      };
    }
    if (branding) {
      user.branding = {
        brandColor: branding.brandColor || '#4F46E5',
        logoUrl: branding.logoUrl || '',
      };
    }

    await user.save();
    return res.json({ success: true, message: 'Settings saved successfully', data: user });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

