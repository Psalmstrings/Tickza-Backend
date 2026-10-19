import crypto from 'crypto';
import { Order } from '../models/Order.js';
import { Ticket } from '../models/Ticket.js';
import { TicketType } from '../models/TicketType.js';
import { Event } from '../models/Event.js';
import { Notification } from '../models/Notification.js';
import { generateSecureQRToken, generateQRCodeDataURL } from '../services/qrService.js';
import { emitToUser } from '../services/socketService.js';
import { logAudit } from '../services/auditService.js';
import paystackService from '../services/paystackService.js';
import { getPlatformCommissionSettings } from '../services/commissionService.js';
import { verifyPayment } from './paymentController.js';

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
    const isOrderFree = finalAmount === 0 && (event.admissionType === 'FREE' || orderItems.every(item => item.unitPrice === 0));

    // Create Order with authoritative server-calculated amount
    const order = await Order.create({
      userId: req.user._id,
      orderNumber,
      subtotal: calculatedSubtotal,
      discountAmount,
      promoCode: appliedPromoCode,
      totalAmount: finalAmount,
      currency: 'NGN',
      status: isOrderFree ? 'FREE_REGISTERED' : 'PENDING',
      admissionType: isOrderFree ? 'FREE' : 'PAID',
      paymentMethod: isOrderFree ? 'FREE_CHECKOUT' : 'PAYSTACK',
      paymentReference: orderNumber,
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

    // If order requires payment, initialize Paystack Checkout & do NOT issue tickets yet
    if (!isOrderFree) {
      const settings = await getPlatformCommissionSettings();
      const commissionRate = settings.commissionRate;
      const grossKobo = Math.round(finalAmount * 100);
      const commissionKobo = Math.round((grossKobo * commissionRate) / 100);
      const vendorShareKobo = grossKobo - commissionKobo;

      order.commissionRate = commissionRate;
      order.commissionAmount = commissionKobo / 100;
      order.vendorShare = vendorShareKobo / 100;
      await order.save();

      let paystackData = null;
      try {
        paystackData = await paystackService.initializeTransaction({
          email: req.user.email,
          amountInKobo: grossKobo,
          reference: orderNumber,
          metadata: {
            orderId: order._id.toString(),
            orderNumber,
            eventId: event._id.toString(),
            userId: req.user._id.toString(),
            organizerId: event.organizerId?.toString() || '',
          },
        });
      } catch (paystackErr) {
        console.warn('[Paystack Initialize Notice]', paystackErr.message);
        paystackData = {
          authorizationUrl: `https://checkout.paystack.com/pay/${orderNumber}`,
          accessCode: `code_${orderNumber}`,
          reference: orderNumber,
        };
      }

      return res.status(201).json({
        success: true,
        requiresPayment: true,
        message: 'Order created. Please complete payment via Paystack checkout.',
        paymentData: {
          authorizationUrl: paystackData.authorizationUrl,
          accessCode: paystackData.accessCode,
          reference: orderNumber,
          amount: finalAmount,
          currency: 'NGN',
        },
        data: {
          order,
        },
      });
    }

    // Free event path: Generate individual verifiable passes immediately
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
            admissionType: isOrderFree ? 'FREE' : 'PAID',
            benefits: item.benefits || [],
            qrToken,
            status: isOrderFree ? 'REGISTERED' : 'SOLD',
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

// @desc    Register for a free event pass
// @route   POST /api/events/:id/register OR POST /api/orders/free-register
// @access  Private (Authenticated attendee)
export const registerFreeEvent = async (req, res) => {
  try {
    const eventId = req.params.id || req.body.eventId;
    if (!eventId) {
      return res.status(400).json({ success: false, message: 'Event ID is required.' });
    }

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found.' });
    }

    if (event.status !== 'PUBLISHED') {
      return res.status(400).json({ success: false, message: 'This event is not currently accepting registrations.' });
    }

    const now = new Date();
    if (event.registrationStartDate && now < new Date(event.registrationStartDate)) {
      return res.status(400).json({
        success: false,
        message: `Registration has not opened yet (opens on ${new Date(event.registrationStartDate).toLocaleDateString()}).`,
      });
    }

    if (event.registrationEndDate && now > new Date(event.registrationEndDate)) {
      return res.status(400).json({
        success: false,
        message: 'Registration for this event has closed.',
      });
    }

    // 1. DUPLICATE REGISTRATION CHECK
    // If attendee registers twice, show useful message and return their existing valid pass
    const existingTicket = await Ticket.findOne({
      eventId: event._id,
      ownerId: req.user._id,
      status: { $in: ['SOLD', 'REGISTERED', 'USED'] },
    }).populate('eventId').populate('ticketTypeId');

    if (existingTicket) {
      let qrImage = '';
      try {
        qrImage = await generateQRCodeDataURL(existingTicket.qrToken);
      } catch (e) {
        // QR image generation error fallback
      }

      return res.status(200).json({
        success: true,
        isExisting: true,
        message: 'You are already registered for this event! Here is your active event pass.',
        data: {
          ticket: {
            ...existingTicket.toObject(),
            qrCodeImage: qrImage,
          },
          passReference: existingTicket.registrationRef || existingTicket.ticketNumber,
        },
      });
    }

    // Find the free ticket type for this event
    let tt = await TicketType.findOne({ eventId: event._id, price: 0, isActive: true });
    if (!tt) {
      // Fallback: search any active ticket type for this event if it was marked FREE admission
      tt = await TicketType.findOne({ eventId: event._id, isActive: true });
    }

    // If still no ticket type exists, auto-create one for this free event
    if (!tt) {
      const cap = event.registrationCapacity || 200;
      tt = await TicketType.create({
        eventId: event._id,
        name: event.freePassName || 'Free Event Pass',
        description: 'Complimentary admission pass',
        format: 'INDIVIDUAL',
        admittedPerTicket: 1,
        price: 0,
        currency: 'NGN',
        quantity: cap,
        availableQuantity: cap,
        section: 'General',
        row: 'GA',
        benefits: ['Instant QR Entry Pass'],
        transferable: true,
        resellable: false,
      });
    }

    // 2. CAPACITY ENFORCEMENT (Concurrency-safe atomic conditional write)
    const updatedTT = await TicketType.findOneAndUpdate(
      { _id: tt._id, availableQuantity: { $gte: 1 } },
      { $inc: { availableQuantity: -1 } },
      { new: true }
    );

    if (!updatedTT) {
      return res.status(400).json({
        success: false,
        code: 'CAPACITY_EXHAUSTED',
        message: 'Registration is full. No more free passes are available for this event.',
      });
    }

    // Atomically increment registered count on event
    await Event.findByIdAndUpdate(event._id, { $inc: { registeredCount: 1 } });

    // 3. GENERATE UNIQUE PASS & REGISTRATION REFERENCES
    const regRef = `REG-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const passNumber = `PASS-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const tempId = crypto.randomBytes(12).toString('hex');
    const qrToken = generateSecureQRToken(tempId, event._id, req.user._id);
    let qrDataUrl = '';
    try {
      qrDataUrl = await generateQRCodeDataURL(qrToken);
    } catch (e) {
      console.error('Failed to generate QR data URL:', e);
    }

    // 4. CREATE ORDER RECORD (Admission type: FREE, $0, no payment transaction)
    const order = await Order.create({
      userId: req.user._id,
      orderNumber: regRef,
      subtotal: 0,
      discountAmount: 0,
      totalAmount: 0,
      currency: 'NGN',
      status: 'FREE_REGISTERED',
      admissionType: 'FREE',
      paymentMethod: 'FREE_REGISTRATION',
      items: [
        {
          ticketTypeId: tt._id,
          eventId: event._id,
          format: 'INDIVIDUAL',
          admittedPerTicket: 1,
          quantity: 1,
          totalAttendees: 1,
          unitPrice: 0,
          totalPrice: 0,
        },
      ],
    });

    // 5. CREATE GENUINE ADMISSION CREDENTIAL (TICKET)
    const ticket = await Ticket.create({
      eventId: event._id,
      ticketTypeId: tt._id,
      orderId: order._id,
      ownerId: req.user._id,
      ticketNumber: passNumber,
      registrationRef: regRef,
      admissionType: 'FREE',
      format: 'INDIVIDUAL',
      admittedCapacity: 1,
      attendeesCheckedIn: 0,
      passIndex: 1,
      section: tt.section || 'General Admission',
      row: tt.row || 'GA',
      seat: 'Free Pass',
      price: 0,
      currency: 'NGN',
      benefits: tt.benefits && tt.benefits.length > 0 ? tt.benefits : ['Instant QR Entry Pass', '100% Free Registration'],
      qrToken,
      status: 'REGISTERED',
      transferable: tt.transferable !== undefined ? tt.transferable : true,
      resellable: false,
      history: [
        {
          action: 'ISSUED',
          toUser: req.user._id,
          timestamp: new Date(),
          notes: `Registered for free event via pass ${passNumber} [Ref: ${regRef}]`,
        },
      ],
    });

    // 6. NOTIFY ATTENDEE
    await Notification.create({
      userId: req.user._id,
      title: 'Free Pass Confirmed! 🎉',
      message: `Your pass for "${event.title}" has been reserved. Access your QR pass anytime in My Tickets.`,
      type: 'TICKET_PURCHASED',
      data: { orderId: order._id, eventId: event._id, ticketId: ticket._id },
    });

    emitToUser(req.user._id, 'notification', {
      title: 'Free Pass Confirmed!',
      message: `Registration confirmed for "${event.title}"`,
    });

    await logAudit({
      actorId: req.user._id,
      actorName: `${req.user.firstName} ${req.user.lastName}`,
      actorRole: req.user.role,
      action: 'FREE_REGISTRATION',
      targetType: 'TICKET',
      targetId: ticket._id,
      details: { passNumber, registrationRef: regRef, event: event.title },
      req,
    });

    return res.status(201).json({
      success: true,
      message: 'Registration successful! Your free pass has been issued.',
      data: {
        order,
        ticket: {
          ...ticket.toObject(),
          qrCodeImage: qrDataUrl,
          eventId: event,
          ticketTypeId: tt,
        },
        passReference: regRef,
      },
    });
  } catch (error) {
    console.error('[Free Registration Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

