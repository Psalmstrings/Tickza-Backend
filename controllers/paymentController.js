import crypto from 'crypto';
import { Order } from '../models/Order.js';
import { Ticket } from '../models/Ticket.js';
import { Event } from '../models/Event.js';
import { User } from '../models/User.js';
import { PaymentTransaction } from '../models/PaymentTransaction.js';
import { Notification } from '../models/Notification.js';
import { Payout } from '../models/Payout.js';
import { generateSecureQRToken } from '../services/qrService.js';
import { emitToUser } from '../services/socketService.js';
import { logAudit } from '../services/auditService.js';
import paystackService from '../services/paystackService.js';
import {
  getPlatformCommissionSettings,
  creditVendorForTicketSale,
  finalizeVendorPayoutDisbursed,
  releaseVendorReservedBalance,
} from '../services/commissionService.js';

/**
 * Helper: Issue cryptographically signed tickets for a verified or free order
 */
export const issueTicketsForOrder = async (order, user, event) => {
  const issuedTickets = [];
  const isOrderFree = order.totalAmount === 0 || order.admissionType === 'FREE';

  for (const item of order.items) {
    for (let q = 0; q < item.quantity; q++) {
      const packageIndex = q + 1;
      const capacity = item.admittedPerTicket || 1;
      const isMultiAttendee = item.format === 'GROUP_BUNDLE' || item.format === 'RESERVED_TABLE';

      if (isMultiAttendee && capacity > 1) {
        const parentTicketNumber = `TBL-${Date.now().toString().slice(-5)}${q}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const parentTempId = crypto.randomBytes(12).toString('hex');
        const parentQrToken = generateSecureQRToken(parentTempId, event._id, user._id);

        const parentTicket = await Ticket.create({
          eventId: event._id,
          ticketTypeId: item.ticketTypeId,
          orderId: order._id,
          ownerId: user._id,
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
          admissionType: isOrderFree ? 'FREE' : 'PAID',
          benefits: item.benefits || [],
          qrToken: parentQrToken,
          status: isOrderFree ? 'REGISTERED' : 'SOLD',
          transferable: item.transferable,
          resellable: item.resellable,
          history: [
            {
              action: 'ISSUED',
              toUser: user._id,
              notes: `Package issued via order ${order.orderNumber} (Admits ${capacity})`,
            },
          ],
        });
        issuedTickets.push(parentTicket);

        for (let p = 1; p <= capacity; p++) {
          const attendeeTicketNum = `${parentTicketNumber}-G${p}`;
          const attendeeTempId = crypto.randomBytes(12).toString('hex');
          const attendeeQrToken = generateSecureQRToken(attendeeTempId, event._id, user._id);

          const attendeeTicket = await Ticket.create({
            eventId: event._id,
            ticketTypeId: item.ticketTypeId,
            orderId: order._id,
            ownerId: user._id,
            parentTicketId: parentTicket._id,
            ticketNumber: attendeeTicketNum,
            format: item.format,
            admittedCapacity: 1,
            passIndex: p,
            tableNumber: item.format === 'RESERVED_TABLE' ? `Table ${packageIndex}` : '',
            section: item.section || 'General',
            row: item.row || 'GA',
            seat: item.format === 'RESERVED_TABLE' ? `Table ${packageIndex} - Seat ${p}` : `Guest Pass #${p} of ${capacity}`,
            price: 0,
            currency: 'NGN',
            admissionType: isOrderFree ? 'FREE' : 'PAID',
            benefits: item.benefits || [],
            qrToken: attendeeQrToken,
            status: isOrderFree ? 'REGISTERED' : 'SOLD',
            transferable: item.transferable,
            resellable: false,
            history: [
              {
                action: 'ISSUED',
                toUser: user._id,
                notes: `Linked guest pass #${p} of ${capacity} under ${parentTicketNumber}`,
              },
            ],
          });
          issuedTickets.push(attendeeTicket);
        }
      } else {
        const ticketNumber = `TICK-${Date.now().toString().slice(-5)}${q}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const tempId = crypto.randomBytes(12).toString('hex');
        const qrToken = generateSecureQRToken(tempId, event._id, user._id);

        const singleTicket = await Ticket.create({
          eventId: event._id,
          ticketTypeId: item.ticketTypeId,
          orderId: order._id,
          ownerId: user._id,
          ticketNumber,
          format: item.format || 'INDIVIDUAL',
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
          transferable: item.transferable !== undefined ? item.transferable : true,
          resellable: item.resellable !== undefined ? item.resellable : true,
          history: [
            {
              action: 'ISSUED',
              toUser: user._id,
              notes: `Purchased via order ${order.orderNumber}`,
            },
          ],
        });
        issuedTickets.push(singleTicket);
      }
    }
  }

  return issuedTickets;
};

/**
 * @desc    Initialize a Paystack checkout transaction for an order
 * @route   POST /api/payments/initialize
 * @access  Private
 */
export const initializeOrderPayment = async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ success: false, message: 'Order ID is required.' });
    }

    const order = await Order.findById(orderId).populate('items.eventId');
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    // Verify requesting user owns this order
    if (order.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Unauthorized access to this order.' });
    }

    if (order.status === 'PAID') {
      return res.status(400).json({ success: false, message: 'This order has already been paid and fulfilled.' });
    }

    const totalAmount = order.totalAmount;
    if (totalAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Free orders do not require payment processing.' });
    }

    const amountInKobo = Math.round(totalAmount * 100);
    const primaryEvent = order.items[0]?.eventId;

    // Call Paystack API
    const paystackRes = await paystackService.initializeTransaction({
      email: req.user.email,
      amountInKobo,
      reference: order.orderNumber,
      metadata: {
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        userId: req.user._id.toString(),
        eventId: primaryEvent?._id?.toString() || primaryEvent?.toString(),
        organizerId: primaryEvent?.organizerId?.toString() || '',
      },
    });

    order.paymentReference = order.orderNumber;
    order.paymentMethod = 'PAYSTACK';
    await order.save();

    return res.json({
      success: true,
      message: 'Payment initialized successfully.',
      data: {
        authorizationUrl: paystackRes.authorizationUrl,
        accessCode: paystackRes.accessCode,
        reference: order.orderNumber,
        amount: totalAmount,
        currency: 'NGN',
      },
    });
  } catch (error) {
    console.error('[Payment Initialize Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Verify Paystack payment and fulfill paid tickets idempotently
 * @route   POST /api/payments/verify
 * @access  Private
 */
export const verifyPayment = async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference) {
      return res.status(400).json({ success: false, message: 'Transaction reference is required.' });
    }

    // 1. Locate Order
    const order = await Order.findOne({
      $or: [{ orderNumber: reference }, { paymentReference: reference }],
    }).populate('items.eventId');

    if (!order) {
      return res.status(404).json({ success: false, message: 'Associated order not found for this reference.' });
    }

    // 2. Idempotency Check: if already paid, return existing tickets immediately
    if (order.status === 'PAID') {
      let existingTickets = await Ticket.find({ orderId: order._id });
      // If order is marked PAID but tickets are still being issued by a concurrent process:
      if (!existingTickets || existingTickets.length === 0) {
        const buyer = await User.findById(order.userId);
        const primaryEvent = order.items[0]?.eventId;
        existingTickets = await issueTicketsForOrder(order, buyer, primaryEvent);
      }
      return res.json({
        success: true,
        alreadyProcessed: true,
        message: 'Order has already been confirmed and paid.',
        data: {
          order,
          tickets: existingTickets,
        },
      });
    }

    // 3. Verify directly with Paystack API
    const verification = await paystackService.verifyTransaction(reference);

    // Check for ongoing / pending states from Paystack
    const statusLower = String(verification.status || '').toLowerCase();
    if (['ongoing', 'pending', 'processing', 'queued'].includes(statusLower)) {
      return res.json({
        success: true,
        pending: true,
        status: 'PENDING',
        message: 'Payment is currently being processed by your bank. Awaiting final settlement confirmation.',
        details: verification.gatewayResponse || 'Processing',
      });
    }

    if (!verification.isSuccessful) {
      return res.status(400).json({
        success: false,
        message: `Payment verification failed. Paystack status: ${verification.status || 'unknown'}.`,
        details: verification.gatewayResponse,
      });
    }

    // 4. Verify Amount and Currency integrity
    const expectedKobo = Math.round(order.totalAmount * 100);
    if (verification.amount !== expectedKobo) {
      console.error(`[Fraud Alert] Amount mismatch for ${reference}: expected ${expectedKobo}, got ${verification.amount}`);
      return res.status(400).json({
        success: false,
        message: 'Payment amount mismatch. Order verification rejected.',
      });
    }

    if (verification.currency !== 'NGN') {
      return res.status(400).json({
        success: false,
        message: 'Currency mismatch. Expected NGN.',
      });
    }

    // 5. Fetch platform commission settings
    const settings = await getPlatformCommissionSettings();
    const commissionRate = settings.commissionRate;
    const grossAmountNaira = order.totalAmount;
    const grossKobo = Math.round(grossAmountNaira * 100);
    const commissionKobo = Math.round((grossKobo * commissionRate) / 100);
    const vendorShareKobo = grossKobo - commissionKobo;

    // 6. Update Order status
    order.status = 'PAID';
    order.paymentReference = reference;
    order.paidAt = verification.paidAt || new Date();
    order.commissionRate = commissionRate;
    order.commissionAmount = commissionKobo / 100;
    order.vendorShare = vendorShareKobo / 100;
    await order.save();

    const primaryEvent = order.items[0]?.eventId;
    const organizerId = primaryEvent?.organizerId;

    // 7. Record PaymentTransaction (guarded against concurrent webhook race conditions)
    let transaction = await PaymentTransaction.findOne({ reference });
    if (!transaction && organizerId) {
      try {
        transaction = await PaymentTransaction.create({
          reference,
          orderId: order._id,
          eventId: primaryEvent._id,
          organizerId,
          customerId: order.userId,
          grossAmountKobo: grossKobo,
          currency: 'NGN',
          commissionRate,
          commissionAmountKobo: commissionKobo,
          paystackFeeKobo: verification.fees || 0,
          vendorNetShareKobo: vendorShareKobo,
          status: 'SUCCESS',
          channel: verification.channel || 'paystack',
          gatewayResponse: verification.gatewayResponse || 'Successful',
          paidAt: order.paidAt,
          metadata: verification.metadata,
        });

        // 8. Credit Vendor Ledger atomically
        await creditVendorForTicketSale({
          vendorId: organizerId,
          eventId: primaryEvent._id,
          orderId: order._id,
          transactionId: transaction._id,
          grossAmountNaira,
          commissionRate,
          reference,
        });
      } catch (insertErr) {
        if (insertErr.code === 11000) {
          // Concurrent insert by webhook
          transaction = await PaymentTransaction.findOne({ reference });
        } else {
          throw insertErr;
        }
      }
    }

    // 9. Issue Tickets with Cryptographic TICKZA-V1 QR Tokens (guarded against duplicates)
    let tickets = await Ticket.find({ orderId: order._id });
    if (!tickets || tickets.length === 0) {
      const buyer = await User.findById(order.userId);
      tickets = await issueTicketsForOrder(order, buyer, primaryEvent);
    }

    // 10. Notifications & Audit Logging
    await Notification.create({
      userId: order.userId,
      title: 'Tickets Confirmed! 🎉',
      message: `Payment verified! You have secured ${tickets.length} ticket(s) for "${primaryEvent?.title || 'Event'}". View in My Tickets.`,
      type: 'TICKET_PURCHASED',
      data: { orderId: order._id, eventId: primaryEvent?._id },
    });

    emitToUser(order.userId, 'notification', {
      title: 'Tickets Confirmed!',
      message: `Payment verified for ${primaryEvent?.title || 'Event'}`,
    });

    await logAudit({
      actorId: order.userId,
      actorName: `${buyer.firstName} ${buyer.lastName}`,
      actorRole: buyer.role,
      action: 'PAYMENT_VERIFIED',
      targetType: 'ORDER',
      targetId: order._id,
      details: {
        orderNumber: order.orderNumber,
        reference,
        amount: order.totalAmount,
        commissionRate,
        ticketsCount: tickets.length,
      },
      req,
    });

    return res.json({
      success: true,
      message: 'Payment verified and tickets issued successfully!',
      data: {
        order,
        tickets,
        transaction,
      },
    });
  } catch (error) {
    console.error('[Payment Verification Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Process incoming Paystack Webhooks securely
 * @route   POST /api/payments/webhook
 * @access  Public (Validated with x-paystack-signature)
 */
export const handlePaystackWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const rawBody = req.rawBody || JSON.stringify(req.body);

    // Verify signature
    const isValid = paystackService.verifyWebhookSignature(signature, rawBody);
    if (!isValid) {
      console.warn('[Paystack Webhook] Invalid signature rejected.');
      return res.status(400).send('Invalid signature.');
    }

    const { event, data } = req.body;
    console.log(`[Paystack Webhook Received] Event: ${event}, Ref: ${data?.reference}`);

    // Acknowledge Paystack immediately with 200 OK
    res.status(200).send('Webhook received.');

    // 1. Successful payment charge
    if (event === 'charge.success') {
      const reference = data.reference;
      const order = await Order.findOne({
        $or: [{ orderNumber: reference }, { paymentReference: reference }],
      }).populate('items.eventId');

      if (order && order.status !== 'PAID') {
        const settings = await getPlatformCommissionSettings();
        const commissionRate = settings.commissionRate;
        const grossAmountNaira = order.totalAmount;
        const grossKobo = Math.round(grossAmountNaira * 100);
        const commissionKobo = Math.round((grossKobo * commissionRate) / 100);
        const vendorShareKobo = grossKobo - commissionKobo;

        order.status = 'PAID';
        order.paymentReference = reference;
        order.paidAt = data.paid_at ? new Date(data.paid_at) : new Date();
        order.commissionRate = commissionRate;
        order.commissionAmount = commissionKobo / 100;
        order.vendorShare = vendorShareKobo / 100;
        await order.save();

        const primaryEvent = order.items[0]?.eventId;
        const organizerId = primaryEvent?.organizerId;

        if (organizerId) {
          const transaction = await PaymentTransaction.create({
            reference,
            orderId: order._id,
            eventId: primaryEvent._id,
            organizerId,
            customerId: order.userId,
            grossAmountKobo: grossKobo,
            currency: 'NGN',
            commissionRate,
            commissionAmountKobo: commissionKobo,
            paystackFeeKobo: data.fees || 0,
            vendorNetShareKobo: vendorShareKobo,
            status: 'SUCCESS',
            channel: data.channel || 'paystack',
            gatewayResponse: data.gateway_response || 'Successful',
            paidAt: order.paidAt,
            metadata: data.metadata,
          });

          await creditVendorForTicketSale({
            vendorId: organizerId,
            eventId: primaryEvent._id,
            orderId: order._id,
            transactionId: transaction._id,
            grossAmountNaira,
            commissionRate,
            reference,
          });
        }

        const buyer = await User.findById(order.userId);
        if (buyer) {
          await issueTicketsForOrder(order, buyer, primaryEvent);
        }
      }
    }

    // 2. Transfer success (Payout disbursed)
    if (event === 'transfer.success') {
      const transferCode = data.transfer_code;
      const reference = data.reference;

      const payout = await Payout.findOne({
        $or: [{ paystackTransferCode: transferCode }, { reference }],
      });

      if (payout && payout.status !== 'PAID') {
        payout.status = 'PAID';
        payout.paystackTransferStatus = 'success';
        payout.processedAt = new Date();
        await payout.save();

        await finalizeVendorPayoutDisbursed({
          vendorId: payout.organizerId,
          amountKobo: payout.amountKobo,
          payoutId: payout._id,
          transferReference: reference,
        });

        await Notification.create({
          userId: payout.organizerId,
          title: 'Payout Disbursed 💰',
          message: `Your withdrawal of ₦${(payout.amountKobo / 100).toLocaleString()} has been successfully deposited to your bank account.`,
          type: 'PAYOUT_PROCESSED',
          data: { payoutId: payout._id },
        });

        emitToUser(payout.organizerId, 'notification', {
          title: 'Payout Disbursed',
          message: `₦${(payout.amountKobo / 100).toLocaleString()} paid to your bank account.`,
        });
      }
    }

    // 3. Transfer failed or reversed
    if (event === 'transfer.failed' || event === 'transfer.reversed') {
      const transferCode = data.transfer_code;
      const reference = data.reference;

      const payout = await Payout.findOne({
        $or: [{ paystackTransferCode: transferCode }, { reference }],
      });

      if (payout && payout.status !== 'FAILED') {
        payout.status = 'FAILED';
        payout.paystackTransferStatus = event === 'transfer.reversed' ? 'reversed' : 'failed';
        payout.paystackFailures = data;
        await payout.save();

        // Release reserved funds back to vendor
        await releaseVendorReservedBalance({
          vendorId: payout.organizerId,
          amountKobo: payout.amountKobo,
          payoutId: payout._id,
          reason: `Paystack transfer ${event}: ${data.reason || 'bank network decline'}`,
        });

        await Notification.create({
          userId: payout.organizerId,
          title: 'Payout Transfer Failed ⚠️',
          message: `Your withdrawal of ₦${(payout.amountKobo / 100).toLocaleString()} could not be processed by your bank. Your balance has been restored.`,
          type: 'PAYOUT_PROCESSED',
          data: { payoutId: payout._id },
        });
      }
    }
  } catch (error) {
    console.error('[Paystack Webhook Handler Error]', error);
  }
};
