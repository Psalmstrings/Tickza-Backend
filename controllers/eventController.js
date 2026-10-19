import { Event } from '../models/Event.js';
import { TicketType } from '../models/TicketType.js';
import { processUpload } from '../middleware/uploadMiddleware.js';
import { logAudit } from '../services/auditService.js';

// @desc    Get all published events
// @route   GET /api/events
// @access  Public
export const getEvents = async (req, res) => {
  try {
    const { search, category, city, date, featured, sort, admissionType } = req.query;
    const query = { status: 'PUBLISHED' };

    if (admissionType && (admissionType.toUpperCase() === 'FREE' || admissionType.toUpperCase() === 'PAID')) {
      query.admissionType = admissionType.toUpperCase();
    }

    if (category && category !== 'All' && category !== 'all') {
      // Map category labels if needed
      let catPattern = category;
      if (category.toLowerCase() === 'concerts') catPattern = 'Music|Concerts|Festival';
      else if (category.toLowerCase() === 'arts & theater') catPattern = 'Arts|Theater|Comedy|Show';
      query.category = { $regex: catPattern, $options: 'i' };
    }

    if (featured === 'true') {
      query.featured = true;
    }

    if (city && city !== 'All Cities' && city !== 'All') {
      const cityRegex = { $regex: city, $options: 'i' };
      query.$or = [{ venue: cityRegex }, { address: cityRegex }];
    }

    if (date) {
      const now = new Date();
      if (date === 'today') {
        const startOfDay = new Date(now.setHours(0, 0, 0, 0));
        const endOfDay = new Date(now.setHours(23, 59, 59, 999));
        query.startDate = { $gte: startOfDay, $lte: endOfDay };
      } else if (date === 'this_weekend') {
        // upcoming weekend
        const startOfWknd = new Date();
        const day = startOfWknd.getDay();
        const diffToFri = (5 - day + 7) % 7;
        startOfWknd.setDate(startOfWknd.getDate() + diffToFri);
        startOfWknd.setHours(0, 0, 0, 0);
        const endOfWknd = new Date(startOfWknd);
        endOfWknd.setDate(endOfWknd.getDate() + 2);
        endOfWknd.setHours(23, 59, 59, 999);
        query.startDate = { $gte: startOfWknd, $lte: endOfWknd };
      } else if (date === 'this_month') {
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        query.startDate = { $gte: startOfMonth, $lte: endOfMonth };
      }
    }

    if (search) {
      const searchRegex = { $regex: search, $options: 'i' };
      const searchClauses = [
        { title: searchRegex },
        { venue: searchRegex },
        { address: searchRegex },
        { description: searchRegex },
        { category: searchRegex },
      ];
      if (query.$or) {
        query.$and = [{ $or: query.$or }, { $or: searchClauses }];
        delete query.$or;
      } else {
        query.$or = searchClauses;
      }
    }

    let sortObj = { startDate: 1 };
    if (sort === 'date_desc') sortObj = { startDate: -1 };
    else if (sort === 'created_desc') sortObj = { createdAt: -1 };

    const events = await Event.find(query)
      .populate('organizerId', 'firstName lastName')
      .sort(sortObj);

    // Attach ticketTypes and starting prices
    const eventIds = events.map(e => e._id);
    const allTicketTypes = await TicketType.find({ eventId: { $in: eventIds } });

    const eventsWithDetails = events.map(ev => {
      const types = allTicketTypes.filter(t => t.eventId.toString() === ev._id.toString());
      const prices = types.map(t => t.price).filter(p => typeof p === 'number');
      const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
      const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;
      const isFree = ev.admissionType === 'FREE' || (prices.length > 0 && maxPrice === 0);
      return {
        ...ev.toObject(),
        admissionType: ev.admissionType || (isFree ? 'FREE' : 'PAID'),
        isFree,
        ticketTypes: types,
        minPrice,
        maxPrice,
      };
    });

    return res.json({ success: true, count: eventsWithDetails.length, data: eventsWithDetails });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get single event by ID or slug
// @route   GET /api/events/:id
// @access  Public
export const getEventById = async (req, res) => {
  try {
    const { id } = req.params;
    let event = null;

    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      event = await Event.findById(id).populate('organizerId', 'firstName lastName email');
    } else {
      event = await Event.findOne({ slug: id }).populate('organizerId', 'firstName lastName email');
    }

    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    const ticketTypes = await TicketType.find({ eventId: event._id });
    const isFree = event.admissionType === 'FREE' || (ticketTypes.length > 0 && ticketTypes.every(t => (t.price || 0) === 0));

    return res.json({
      success: true,
      data: {
        ...event.toObject(),
        admissionType: event.admissionType || (isFree ? 'FREE' : 'PAID'),
        isFree,
        ticketTypes,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create a new event manually
// @route   POST /api/events
// @access  Private (Approved user or Admin only)
export const createEvent = async (req, res) => {
  try {
    // CRITICAL BACKEND CHECK
    if (req.user.status !== 'APPROVED' && req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_APPROVAL_REQUIRED',
        message: 'Your account must be approved by an administrator before you can create events.',
      });
    }

    const {
      title,
      description,
      category,
      venue,
      entranceInfo,
      address,
      latitude,
      longitude,
      startDate,
      startTime,
      endDate,
      endTime,
      doorsOpen,
      timeAnnounced,
      multiDay,
      countdownEnabled,
      coverImageUrl,
      seatMapUrl,
      ticketTypes,
      status,
      admissionType = 'PAID',
      registrationCapacity,
      registrationStartDate,
      registrationEndDate,
      freePassName,
      registrationFields,
    } = req.body;

    if (!title || !startDate || !venue) {
      return res.status(400).json({ success: false, message: 'Title, start date, and venue are required.' });
    }

    const isFreeEvent = String(admissionType).toUpperCase() === 'FREE';

    let finalCoverImageUrl = coverImageUrl || req.body.coverImage?.url || (typeof req.body.coverImage === 'string' ? req.body.coverImage : '');
    const coverImage = finalCoverImageUrl
      ? { url: finalCoverImageUrl, publicId: req.body.coverImage?.publicId || 'manual_upload' }
      : {
          url: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=800&auto=format&fit=crop&q=80',
          publicId: 'default_cover',
        };

    const seatMap = (seatMapUrl || req.body.seatMap?.url) ? { url: seatMapUrl || req.body.seatMap?.url, publicId: 'seatmap' } : null;

    const parsedCapacity = registrationCapacity ? Math.max(1, parseInt(registrationCapacity, 10)) : (isFreeEvent ? 200 : null);

    const event = await Event.create({
      organizerId: req.user._id,
      title,
      description: description || '',
      category: category || 'Music',
      coverImage,
      seatMap,
      venue,
      entranceInfo: entranceInfo || '',
      address: address || '',
      latitude: latitude ? parseFloat(latitude) : null,
      longitude: longitude ? parseFloat(longitude) : null,
      startDate: new Date(startDate),
      startTime: startTime || '20:00',
      endDate: endDate ? new Date(endDate) : null,
      endTime: endTime || '',
      doorsOpen: doorsOpen || '',
      timeAnnounced: timeAnnounced !== undefined ? Boolean(timeAnnounced) : true,
      multiDay: Boolean(multiDay),
      countdownEnabled: countdownEnabled !== undefined ? Boolean(countdownEnabled) : true,
      status: status || 'PUBLISHED',
      admissionType: isFreeEvent ? 'FREE' : 'PAID',
      registrationCapacity: parsedCapacity,
      registeredCount: 0,
      registrationStartDate: registrationStartDate ? new Date(registrationStartDate) : null,
      registrationEndDate: registrationEndDate ? new Date(registrationEndDate) : null,
      freePassName: (freePassName && freePassName.trim()) ? freePassName.trim() : 'Free Event Pass',
      registrationFields: Array.isArray(registrationFields) ? registrationFields : [],
    });

    // Create ticket types
    let createdTicketTypes = [];
    if (isFreeEvent) {
      // Vendor created a free event: generate the complimentary pass tier automatically
      const passName = (freePassName && freePassName.trim()) ? freePassName.trim() : 'Free Event Pass';
      const cap = parsedCapacity || 200;
      const freeTier = await TicketType.create({
        eventId: event._id,
        name: passName,
        description: 'Complimentary general admission pass',
        format: 'INDIVIDUAL',
        admittedPerTicket: 1,
        price: 0,
        currency: 'NGN',
        quantity: cap,
        availableQuantity: cap,
        section: 'General',
        row: 'GA',
        benefits: ['Instant QR Entry Pass', '100% Free Registration'],
        transferable: true,
        resellable: false,
      });
      createdTicketTypes.push(freeTier);
    } else if (ticketTypes && Array.isArray(ticketTypes) && ticketTypes.length > 0) {
      const typesToInsert = ticketTypes.map((tt) => {
        const qty = tt.quantity ? parseInt(tt.quantity, 10) : 100;
        const validFormats = ['INDIVIDUAL', 'GROUP_BUNDLE', 'RESERVED_TABLE', 'CUSTOM'];
        const format = tt.format && validFormats.includes(tt.format) ? tt.format : 'INDIVIDUAL';
        let capacity = parseInt(tt.admittedPerTicket, 10);
        if (isNaN(capacity) || capacity < 1) {
          capacity = (format === 'GROUP_BUNDLE' || format === 'RESERVED_TABLE') ? 2 : 1;
        }

        let parsedBenefits = [];
        if (Array.isArray(tt.benefits)) {
          parsedBenefits = tt.benefits.map(b => String(b).trim()).filter(Boolean);
        } else if (typeof tt.benefits === 'string' && tt.benefits.trim()) {
          parsedBenefits = tt.benefits.split('\n').map(b => b.trim()).filter(Boolean);
        }

        return {
          eventId: event._id,
          name: tt.name || 'General Admission',
          description: tt.description || '',
          format,
          admittedPerTicket: capacity,
          price: tt.price !== undefined ? Math.max(0, parseFloat(tt.price)) : 0,
          currency: tt.currency || 'NGN',
          quantity: qty,
          availableQuantity: qty,
          section: tt.section || 'General',
          row: tt.row || '',
          benefits: parsedBenefits,
          minPerOrder: tt.minPerOrder ? Math.max(1, parseInt(tt.minPerOrder, 10)) : 1,
          maxPerCustomer: tt.maxPerCustomer ? Math.max(1, parseInt(tt.maxPerCustomer, 10)) : null,
          transferable: tt.transferable !== undefined ? Boolean(tt.transferable) : true,
          resellable: tt.resellable !== undefined ? Boolean(tt.resellable) : true,
          terms: tt.terms || '',
        };
      });
      createdTicketTypes = await TicketType.insertMany(typesToInsert);
    } else {
      // Default ticket type for paid event
      const defaultType = await TicketType.create({
        eventId: event._id,
        name: 'General Admission',
        description: 'Standard admission ticket',
        format: 'INDIVIDUAL',
        admittedPerTicket: 1,
        price: 0,
        currency: 'NGN',
        quantity: 200,
        availableQuantity: 200,
        section: 'GA',
        transferable: true,
        resellable: true,
      });
      createdTicketTypes.push(defaultType);
    }

    await logAudit({
      actorId: req.user._id,
      actorName: `${req.user.firstName} ${req.user.lastName}`,
      actorRole: req.user.role,
      action: 'EVENT_CREATED',
      targetType: 'EVENT',
      targetId: event._id,
      details: { title: event.title, venue: event.venue },
      req,
    });

    return res.status(201).json({
      success: true,
      message: 'Event created successfully',
      data: {
        ...event.toObject(),
        ticketTypes: createdTicketTypes,
      },
    });
  } catch (error) {
    console.error('[Create Event Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get current organizer's events
// @route   GET /api/events/organizer/my-events
// @access  Private (Approved)
export const getOrganizerEvents = async (req, res) => {
  try {
    const events = await Event.find({ organizerId: req.user._id }).sort({ createdAt: -1 });
    return res.json({ success: true, count: events.length, data: events });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Upload media for event (banner / seat map)
// @route   POST /api/events/upload
// @access  Private (Approved user or Admin)
export const uploadEventMedia = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file uploaded' });
    }
    const uploadedData = await processUpload(req.file, 'tickapp/events');
    return res.json({
      success: true,
      data: uploadedData,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
