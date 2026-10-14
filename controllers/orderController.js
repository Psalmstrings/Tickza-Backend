import crypto from 'crypto';
import { Order } from '../models/Order.js';
import { Ticket } from '../models/Ticket.js';
import { TicketType } from '../models/TicketType.js';
import { Event } from '../models/Event.js';
import { Notification } from '../models/Notification.js';
import { generateSecureQRToken } from '../services/qrService.js';
import { emitToUser } from '../services/socketService.js';
import { logAudit } from '../services/auditService.js';

// @desc    Place a free ticket order (instant fulfillment)
// @route   POST /api/orders
// @access  Private (Any authenticated active user)
// @desc    Place a ticket order (instant fulfillment or payment processing)
// @route   POST /api/orders
// @access  Private (Any authenticated active user)
export const createOrder = async (req, res) => {
  try {
    const { eventId, ticketTypeId, quantity = 1, items: reqItems, promoCode } = req.body;

    // Normalise incoming order items: can be single { ticketTypeId, quantity } or { items: [...] }
    let itemsToProcess = [];
    if (Array.isArray(reqItems) && reqItems.length > 0) {
      itemsToProcess = reqItems;
    } else if (ticketTypeId) {
      itemsToProcess = [{ ticketTypeId, quantity: parseInt(quantity, 10) || 1 }];
    } else {
      return res.status(400).json({ success: false, message: 'Ticket selection is required.' });
    }

    if (!eventId) {
      return res.status(400).json({ success: false, message: 'Event ID is required.' });
    }

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found.' });
    }

    if (event.status !== 'PUBLISHED') {
      return res.status(400).json({ success: false, message: 'This event is not currently accepting ticket orders.' });
    }

    // Process & validate each ticket type server-side
    let calculatedSubtotal = 0;
    const orderItems = [];
    const inventoryUpdates = [];

    for (const item of itemsToProcess) {
      const ttId = item.ticketTypeId || item.id || item._id;
      const numQty = parseInt(item.quantity, 10) || 1;
      if (numQty < 1) {
        return res.status(400).json({ success: false, message: 'Ticket quantity must be at least 1.' });
      }

      const tt = await TicketType.findOne({ _id: ttId, eventId: event._id });
      if (!tt) {
        return res.status(404).json({ success: false, message: `Ticket tier not found for this event.` });
      }

      if (!tt.isActive) {
        return res.status(400).json({ success: false, message: `The ticket "${tt.name}" is currently inactive.` });
      }

      // Check sales schedule window
      const now = new Date();
      if (tt.saleStartDate && now < new Date(tt.saleStartDate)) {
        return res.status(400).json({
          success: false,
          message: `Sales for "${tt.name}" have not started yet (starts ${new Date(tt.saleStartDate).toLocaleDateString()}).`,
        });
      }
      if (tt.saleEndDate && now > new Date(tt.saleEndDate)) {
        return res.status(400).json({
          success: false,
          message: `Sales for "${tt.name}" have ended.`,
        });
      }

      // Check min and max limits
      if (tt.minPerOrder && numQty < tt.minPerOrder) {
        return res.status(400).json({
          success: false,
          message: `A minimum of ${tt.minPerOrder} ticket(s) required for "${tt.name}".`,
        });
      }
      if (tt.maxPerCustomer && numQty > tt.maxPerCustomer) {
        return res.status(400).json({
          success: false,
          message: `Maximum of ${tt.maxPerCustomer} ticket(s) allowed per order for "${tt.name}".`,
        });
      }

      // Concurrency-safe atomic check & deduction:
      // $inc availableQuantity by -numQty only if availableQuantity >= numQty
      const updatedTT = await TicketType.findOneAndUpdate(
        { _id: tt._id, availableQuantity: { $gte: numQty } },
        { $inc: { availableQuantity: -numQty } },
        { new: true }
      );

      if (!updatedTT) {
        // Rollback any earlier inventory deductions in this transaction loop
        for (const rolled of inventoryUpdates) {
          await TicketType.findByIdAndUpdate(rolled.ttId, { $inc: { availableQuantity: rolled.qty } });
        }
        return res.status(400).json({
          success: false,
          message: `Sold out or insufficient inventory remaining for "${tt.name}".`,
        });
      }

      inventoryUpdates.push({ ttId: tt._id, qty: numQty });

      const itemUnitPrice = tt.price || 0;
      const itemTotalPrice = itemUnitPrice * numQty;
      const capacity = tt.admittedPerTicket || 1;
      const totalAttendees = numQty * capacity;

      calculatedSubtotal += itemTotalPrice;

      orderItems.push({
        ticketTypeId: tt._id,
        eventId: event._id,
        ticketTypeName: tt.name,
        format: tt.format || 'INDIVIDUAL',
        admittedPerTicket: capacity,
        quantity: numQty,
        totalAttendees,
        unitPrice: itemUnitPrice,
        totalPrice: itemTotalPrice,
        section: tt.section || 'General',
        row: tt.row || '',
        benefits: tt.benefits || [],
        transferable: tt.transferable,
        resellable: tt.resellable,
      });
    }

    // Apply promo code discount if provided
    let discountAmount = 0;
    let appliedPromoCode = '';
    if (promoCode && typeof promoCode === 'string' && promoCode.trim()) {
      const cleanCode = promoCode.toUpperCase().trim();
      const { PromoCode } = await import('../models/PromoCode.js');
      const promo = await PromoCode.findOne({
        eventId: event._id,
        code: cleanCode,
        isActive: true,
      });

      if (!promo) {
        return res.status(400).json({ success: false, message: 'Invalid or inactive promo code.' });
      }

      const now = new Date();
      if (promo.validFrom && now < promo.validFrom) {
        return res.status(400).json({ success: false, message: 'This promo code is not active yet.' });
      }
      if (promo.validUntil && now > promo.validUntil) {
        return res.status(400).json({ success: false, message: 'This promo code has expired.' });
      }
      if (promo.usageLimit && promo.usageCount >= promo.usageLimit) {
        return res.status(400).json({ success: false, message: 'This promo code has reached its maximum total redemptions.' });
      }
      if (promo.minimumOrderAmount && calculatedSubtotal < promo.minimumOrderAmount) {
        return res.status(400).json({
          success: false,
          message: `Minimum order amount of ₦${promo.minimumOrderAmount.toLocaleString()} required to use this code.`,
        });
      }

      // Check per-customer limit
      if (promo.perCustomerLimit) {
        const userOrdersWithPromo = await Order.countDocuments({
          userId: req.user._id,
          promoCode: promo.code,
          status: { $in: ['PAID', 'PENDING'] },
        });
        if (userOrdersWithPromo >= promo.perCustomerLimit) {
          return res.status(400).json({
            success: false,
            message: `You have reached the maximum limit (${promo.perCustomerLimit}) for this promo code.`,
          });
        }
      }

      // Check applicable ticket types
      let eligibleSubtotal = calculatedSubtotal;
      if (promo.applicableTicketTypes && promo.applicableTicketTypes.length > 0) {
        const eligibleTypeIds = promo.applicableTicketTypes.map(t => t.toString());
        eligibleSubtotal = orderItems
          .filter(item => eligibleTypeIds.includes(item.ticketTypeId.toString()))
          .reduce((sum, item) => sum + item.totalPrice, 0);

        if (eligibleSubtotal <= 0) {
          return res.status(400).json({
            success: false,
            message: 'This promo code does not apply to any of the selected ticket tiers.',
          });
        }
      }

      // Calculate discount amount
      if (promo.discountType === 'PERCENTAGE') {
        discountAmount = (eligibleSubtotal * promo.discountValue) / 100;
        if (promo.maxDiscountAmount && discountAmount > promo.maxDiscountAmount) {
          discountAmount = promo.maxDiscountAmount;
        }
      } else {
        discountAmount = Math.min(promo.discountValue, eligibleSubtotal);
      }

      discountAmount = Math.min(discountAmount, calculatedSubtotal);
      appliedPromoCode = promo.code;

      // Increment usage and track analytics
      promo.usageCount += 1;
      promo.totalRevenue = (promo.totalRevenue || 0) + Math.max(0, calculatedSubtotal - discountAmount);
      promo.totalDiscount = (promo.totalDiscount || 0) + discountAmount;
      await promo.save();
    }

    const finalAmount = Math.max(0, calculatedSubtotal - discountAmount);
    const orderNumber = `ORD-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

    // Create Order with authoritative server-calculated amount
    const order = await Order.create({
      userId: req.user._id,
      orderNumber,
      subtotal: calculatedSubtotal,
      discountAmount,
      promoCode: appliedPromoCode,
      totalAmount: finalAmount,
      currency: 'NGN',
      status: 'PAID', // Instant fulfillment on Tickza
      paymentMethod: finalAmount === 0 ? 'FREE_CHECKOUT' : 'NGN_PAYMENT',
      items: orderItems.map(item => ({
        ticketTypeId: item.ticketTypeId,
        eventId: item.eventId,
        format: item.format,
        admittedPerTicket: item.admittedPerTicket,
        quantity: item.quantity,
        totalAttendees: item.totalAttendees,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
      })),
    });

    // Generate individual verifiable tickets
    // If ticket is GROUP_BUNDLE or RESERVED_TABLE, we generate the master packages or attendee passes
    const issuedTickets = [];

    for (const item of orderItems) {
      for (let q = 0; q < item.quantity; q++) {
        const packageIndex = q + 1;
        const capacity = item.admittedPerTicket || 1;
        const isMultiAttendee = item.format === 'GROUP_BUNDLE' || item.format === 'RESERVED_TABLE';

        // For group bundles and tables, generate linked individual admission passes so all attendees get admission credentials
        if (isMultiAttendee && capacity > 1) {
          // Generate a parent ticket representing the package/table
          const parentTicketNumber = `TBL-${Date.now().toString().slice(-5)}${q}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
          const parentTempId = crypto.randomBytes(12).toString('hex');
          const parentQrToken = generateSecureQRToken(parentTempId, event._id, req.user._id);

          const parentTicket = await Ticket.create({
            eventId: event._id,
            ticketTypeId: item.ticketTypeId,
            orderId: order._id,
            ownerId: req.user._id,
            ticketNumber: parentTicketNumber,
            format: item.format,
            admittedCapacity: capacity,
            attendeesCheckedIn: 0,
            passIndex: 1,
            tableNumber: item.format === 'RESERVED_TABLE' ? `Table ${packageIndex}` : '',
            section: item.section || 'General',
            row: item.row || 'GA',
            seat: item.format === 'RESERVED_TABLE' ? `Table ${packageIndex} (Full Table)` : `Group Pass (${capacity} Persons)`,
            price: item.unitPrice,
            currency: 'NGN',
            benefits: item.benefits || [],
            qrToken: parentQrToken,
            status: 'SOLD',
            transferable: item.transferable,
            resellable: item.resellable,
            history: [
              {
                action: 'ISSUED',
                toUser: req.user._id,
                notes: `Purchased package via order ${orderNumber} (Admits ${capacity})`,
              },
            ],
          });
          issuedTickets.push(parentTicket);

          // Generate the linked attendee passes for each person in the group/table
          for (let p = 1; p <= capacity; p++) {
            const attendeeTicketNum = `${parentTicketNumber}-G${p}`;
            const attendeeTempId = crypto.randomBytes(12).toString('hex');
            const attendeeQrToken = generateSecureQRToken(attendeeTempId, event._id, req.user._id);

            const attendeeTicket = await Ticket.create({
              eventId: event._id,
              ticketTypeId: item.ticketTypeId,
              orderId: order._id,
              ownerId: req.user._id,
              parentTicketId: parentTicket._id,
              ticketNumber: attendeeTicketNum,
              format: item.format,
              admittedCapacity: 1,
              passIndex: p,
              tableNumber: item.format === 'RESERVED_TABLE' ? `Table ${packageIndex}` : '',
              section: item.section || 'General',
              row: item.row || 'GA',
              seat: item.format === 'RESERVED_TABLE' ? `Table ${packageIndex} - Seat ${p}` : `Guest Pass #${p} of ${capacity}`,
              price: 0, // Individual seat value covered by parent package price
              currency: 'NGN',
              benefits: item.benefits || [],
              qrToken: attendeeQrToken,
              status: 'SOLD',
              transferable: item.transferable,
              resellable: false,
              history: [
                {
                  action: 'ISSUED',
                  toUser: req.user._id,
                  notes: `Linked guest pass #${p} of ${capacity} under ${parentTicketNumber}`,
                },
              ],
            });
            issuedTickets.push(attendeeTicket);
          }
        } else {
          // Individual or custom single ticket
          const ticketNumber = `TICK-${Date.now().toString().slice(-5)}${q}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
          const tempId = crypto.randomBytes(12).toString('hex');
          const qrToken = generateSecureQRToken(tempId, event._id, req.user._id);

          const singleTicket = await Ticket.create({
            eventId: event._id,
            ticketTypeId: item.ticketTypeId,
            orderId: order._id,
            ownerId: req.user._id,
            ticketNumber,
            format: item.format,
            admittedCapacity: 1,
            passIndex: 1,
            section: item.section || 'General',
            row: item.row || 'GA',
            seat: `Seat-${packageIndex}`,
            price: item.unitPrice,
            currency: 'NGN',
            benefits: item.benefits || [],
            qrToken,
            status: 'SOLD',
            transferable: item.transferable,
            resellable: item.resellable,
            history: [
              {
                action: 'ISSUED',
                toUser: req.user._id,
                notes: `Purchased via order ${orderNumber}`,
              },
            ],
          });
          issuedTickets.push(singleTicket);
        }
      }
    }

    const totalTicketsCount = issuedTickets.length;

    // Create notification
    await Notification.create({
      userId: req.user._id,
      title: 'Tickets Confirmed! 🎉',
      message: `You have successfully confirmed ${totalTicketsCount} ticket(s)/pass(es) for "${event.title}". View them in My Tickets.`,
      type: 'TICKET_PURCHASED',
      data: { orderId: order._id, eventId: event._id },
    });

    emitToUser(req.user._id, 'notification', {
      title: 'Tickets Confirmed!',
      message: `Claimed ${totalTicketsCount} pass(es) for ${event.title}`,
    });

    await logAudit({
      actorId: req.user._id,
      actorName: `${req.user.firstName} ${req.user.lastName}`,
      actorRole: req.user.role,
      action: 'ORDER_PLACED',
      targetType: 'ORDER',
      targetId: order._id,
      details: { orderNumber, totalAmount: finalAmount, passesIssued: totalTicketsCount, event: event.title },
      req,
    });

    return res.status(201).json({
      success: true,
      message: 'Tickets confirmed successfully!',
      data: {
        order,
        tickets: issuedTickets,
      },
    });
  } catch (error) {
    console.error('[Order Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get current user's orders
// @route   GET /api/orders/my-orders
// @access  Private
export const getMyOrders = async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.user._id })
      .populate('items.eventId')
      .populate('items.ticketTypeId')
      .sort({ createdAt: -1 });

    return res.json({ success: true, count: orders.length, data: orders });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
