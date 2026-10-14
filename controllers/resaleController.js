import crypto from 'crypto';
import { ResaleListing } from '../models/ResaleListing.js';
import { Ticket } from '../models/Ticket.js';
import { Event } from '../models/Event.js';
import { Notification } from '../models/Notification.js';
import { generateSecureQRToken } from '../services/qrService.js';
import { emitToUser } from '../services/socketService.js';
import { logAudit } from '../services/auditService.js';

// Platform resale fee percentage (0 = free for now)
const PLATFORM_FEE_PERCENT = 0;

// @desc    List a ticket for resale
// @route   POST /api/resale
// @access  Private (Approved users only)
export const listForResale = async (req, res) => {
  try {
    // Only approved users (or admins) may list
    if (
      req.user.status !== 'APPROVED' &&
      req.user.role !== 'ADMIN' &&
      req.user.role !== 'SUPER_ADMIN'
    ) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_APPROVAL_REQUIRED',
        message: 'Your account must be approved before you can list tickets for resale.',
      });
    }

    const { ticketId, price } = req.body;

    if (!ticketId || price === undefined || price === null) {
      return res.status(400).json({ success: false, message: 'Ticket ID and resale price are required.' });
    }

    const resalePrice = parseFloat(price);
    if (isNaN(resalePrice) || resalePrice < 0) {
      return res.status(400).json({ success: false, message: 'Resale price must be a non-negative number.' });
    }

    const ticket = await Ticket.findById(ticketId).populate('eventId');
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found.' });
    }

    // Must be the current owner
    if (ticket.ownerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You do not own this ticket.' });
    }

    // Ticket must be resellable
    if (!ticket.resellable) {
      return res.status(400).json({ success: false, message: 'This ticket type cannot be resold.' });
    }

    // Ticket must be in SOLD status to be listed
    if (ticket.status !== 'SOLD') {
      return res.status(400).json({
        success: false,
        message: `Only tickets with status SOLD can be listed for resale. Current status: ${ticket.status}`,
      });
    }

    // Check that it's not already listed
    const existingListing = await ResaleListing.findOne({ ticketId: ticket._id, status: 'ACTIVE' });
    if (existingListing) {
      return res.status(400).json({ success: false, message: 'This ticket is already listed for resale.' });
    }

    const platformFee = parseFloat((resalePrice * PLATFORM_FEE_PERCENT).toFixed(2));
    const sellerReceives = parseFloat((resalePrice - platformFee).toFixed(2));

    const listing = await ResaleListing.create({
      ticketId:       ticket._id,
      eventId:        ticket.eventId._id,
      sellerId:       req.user._id,
      originalPrice:  ticket.price,
      price:          resalePrice,
      platformFee,
      sellerReceives,
      status:         'ACTIVE',
    });

    // Update ticket status to LISTED
    ticket.status = 'LISTED';
    ticket.history.push({
      action:    'LISTED_RESALE',
      fromUser:  req.user._id,
      timestamp: new Date(),
      notes:     `Listed for resale at $${resalePrice}`,
    });
    await ticket.save();

    await logAudit({
      actorId:    req.user._id,
      actorName:  `${req.user.firstName} ${req.user.lastName}`,
      actorRole:  req.user.role,
      action:     'RESALE_LISTED',
      targetType: 'RESALE_LISTING',
      targetId:   listing._id,
      details:    { ticketId: ticket._id, price: resalePrice, event: ticket.eventId.title },
      req,
    });

    return res.status(201).json({
      success: true,
      message: 'Ticket successfully listed for resale.',
      data: listing,
    });
  } catch (error) {
    console.error('[Resale listForResale Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get all active resale listings
// @route   GET /api/resale
// @access  Public (or authenticated)
export const getResaleListings = async (req, res) => {
  try {
    const { page = 1, limit = 20, eventId = '' } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const query = { status: 'ACTIVE' };
    if (eventId) query.eventId = eventId;

    const [listings, total] = await Promise.all([
      ResaleListing.find(query)
        .populate({
          path:   'ticketId',
          select: 'section row seat ticketNumber status transferable resellable',
          populate: { path: 'ticketTypeId', select: 'name' },
        })
        .populate('eventId', 'title venue startDate startTime coverImage category')
        .populate('sellerId', 'firstName lastName avatar')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10)),
      ResaleListing.countDocuments(query),
    ]);

    return res.json({
      success: true,
      total,
      page:  parseInt(page, 10),
      pages: Math.ceil(total / parseInt(limit, 10)),
      data:  listings,
    });
  } catch (error) {
    console.error('[Resale getResaleListings Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Buy a resale ticket
// @route   POST /api/resale/:id/buy
// @access  Private (Authenticated)
export const buyResaleTicket = async (req, res) => {
  try {
    const listing = await ResaleListing.findById(req.params.id)
      .populate('ticketId')
      .populate('eventId')
      .populate('sellerId', 'firstName lastName email');

    if (!listing) {
      return res.status(404).json({ success: false, message: 'Resale listing not found.' });
    }

    if (listing.status !== 'ACTIVE') {
      return res.status(400).json({
        success: false,
        message: `This listing is no longer available (status: ${listing.status}).`,
      });
    }

    // Cannot buy your own listing
    if (listing.sellerId._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: 'You cannot buy your own resale listing.' });
    }

    const ticket = await Ticket.findById(listing.ticketId._id).populate('eventId');
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Associated ticket not found.' });
    }

    const previousOwnerId = ticket.ownerId;

    // Regenerate QR token bound to new owner so old QR is invalidated
    const tempId   = crypto.randomBytes(12).toString('hex');
    const newQrToken = generateSecureQRToken(tempId, ticket.eventId._id, req.user._id);

    // Transfer ticket ownership
    ticket.ownerId  = req.user._id;
    ticket.qrToken  = newQrToken;
    ticket.status   = 'SOLD';
    ticket.history.push({
      action:    'RESOLD',
      fromUser:  previousOwnerId,
      toUser:    req.user._id,
      timestamp: new Date(),
      notes:     `Resold via listing ${listing._id} at $${listing.price}`,
    });
    await ticket.save();

    // Finalise the listing
    listing.status  = 'SOLD';
    listing.buyerId = req.user._id;
    listing.soldAt  = new Date();
    await listing.save();

    const eventTitle = ticket.eventId?.title || listing.eventId?.title || 'your event';

    // Notify seller
    await Notification.create({
      userId:  previousOwnerId,
      title:   'Your Resale Ticket Sold! 💸',
      message: `Your ticket for "${eventTitle}" was purchased via the resale marketplace.`,
      type:    'RESALE_SOLD',
      data:    { listingId: listing._id, ticketId: ticket._id },
    });
    emitToUser(previousOwnerId, 'notification', {
      title:   'Ticket Sold',
      message: `Your resale listing for "${eventTitle}" was sold!`,
    });

    // Notify buyer
    await Notification.create({
      userId:  req.user._id,
      title:   'Resale Ticket Purchased! 🎟️',
      message: `You have successfully purchased a resale ticket for "${eventTitle}". Check My Tickets.`,
      type:    'TICKET_PURCHASED',
      data:    { listingId: listing._id, ticketId: ticket._id },
    });
    emitToUser(req.user._id, 'notification', {
      title:   'Ticket Purchased',
      message: `You purchased a resale ticket for "${eventTitle}"!`,
    });

    await logAudit({
      actorId:    req.user._id,
      actorName:  `${req.user.firstName} ${req.user.lastName}`,
      actorRole:  req.user.role,
      action:     'RESALE_PURCHASED',
      targetType: 'RESALE_LISTING',
      targetId:   listing._id,
      details:    { ticketId: ticket._id, price: listing.price, seller: listing.sellerId.email },
      req,
    });

    return res.json({
      success: true,
      message: 'Resale ticket purchased successfully!',
      data: {
        listing,
        ticket,
      },
    });
  } catch (error) {
    console.error('[Resale buyResaleTicket Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Cancel a resale listing (seller only)
// @route   DELETE /api/resale/:id
// @access  Private (Authenticated — seller only)
export const cancelResaleListing = async (req, res) => {
  try {
    const listing = await ResaleListing.findById(req.params.id);
    if (!listing) {
      return res.status(404).json({ success: false, message: 'Resale listing not found.' });
    }

    // Only the seller (or admin) can cancel
    const isAdmin  = req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN';
    const isSeller = listing.sellerId.toString() === req.user._id.toString();

    if (!isSeller && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Only the seller can cancel this listing.' });
    }

    if (listing.status !== 'ACTIVE') {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel a listing with status: ${listing.status}`,
      });
    }

    listing.status = 'CANCELLED';
    await listing.save();

    // Revert ticket status to SOLD (it's back with the owner)
    const ticket = await Ticket.findById(listing.ticketId);
    if (ticket) {
      ticket.status = 'SOLD';
      ticket.history.push({
        action:    'CANCELLED',
        fromUser:  req.user._id,
        timestamp: new Date(),
        notes:     'Resale listing cancelled by seller',
      });
      await ticket.save();
    }

    await logAudit({
      actorId:    req.user._id,
      actorName:  `${req.user.firstName} ${req.user.lastName}`,
      actorRole:  req.user.role,
      action:     'RESALE_CANCELLED',
      targetType: 'RESALE_LISTING',
      targetId:   listing._id,
      details:    { ticketId: listing.ticketId },
      req,
    });

    return res.json({
      success: true,
      message: 'Resale listing cancelled. Ticket has been returned to your inventory.',
      data: listing,
    });
  } catch (error) {
    console.error('[Resale cancelResaleListing Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
