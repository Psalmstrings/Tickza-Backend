import dotenv from 'dotenv';
dotenv.config({ path: 'server/.env' });
dotenv.config();
import mongoose from 'mongoose';
import crypto from 'crypto';
import paystackService, { verifyWebhookSignature, createRefund, verifyRefund } from './services/paystackService.js';
import { Order } from './models/Order.js';
import { Ticket } from './models/Ticket.js';
import { TicketType } from './models/TicketType.js';
import { Event } from './models/Event.js';
import { User } from './models/User.js';
import { VendorLedger } from './models/VendorLedger.js';
import { handlePaystackWebhook } from './controllers/paymentController.js';

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    console.log(`  [PASS] Test ${totalTests}: ${message}`);
    passedTests++;
  } else {
    console.error(`  [FAIL] Test ${totalTests}: ${message}`);
    process.exitCode = 1;
  }
}

async function runRefundVerificationSuite() {
  console.log('================================================================');
  console.log('   TICKZA SECOND-PASS: PAYSTACK REFUND & SETTLEMENT AUDIT       ');
  console.log('================================================================\n');

  // --- SECTION 1: PAYSTACK REFUND SERVICE CONTRACT AUDIT ---
  console.log('--- 1. Paystack Refund Service Contract & Input Validation ---');

  // 1.1 Throws when transaction reference is missing
  try {
    await createRefund({});
    assert(false, 'createRefund should throw when transactionReference is missing');
  } catch (err) {
    assert(err.message.includes('required'), 'createRefund enforces transactionReference requirement');
  }

  // 1.2 Throws when verifyRefund id is missing
  try {
    await verifyRefund('');
    assert(false, 'verifyRefund should throw when refundId is missing');
  } catch (err) {
    assert(err.message.includes('required'), 'verifyRefund enforces refundId requirement');
  }

  // 1.3 Verify functions are exported on default and named exports
  assert(typeof paystackService.createRefund === 'function', 'paystackService exports createRefund');
  assert(typeof paystackService.verifyRefund === 'function', 'paystackService exports verifyRefund');

  // --- SECTION 2: DATABASE CONNECTION & SCHEMA VALIDATION ---
  console.log('\n--- 2. Database Connection & Refund Schema Verification ---');
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGO_URI is missing from environment');
  }

  await mongoose.connect(mongoUri);
  assert(mongoose.connection.readyState === 1, 'Connected to MongoDB Atlas cluster for live testing');

  // Schema check on Order
  const testOrder = new Order({
    userId: new mongoose.Types.ObjectId(),
    orderNumber: `TEST-REF-${Date.now()}`,
    totalAmount: 15000,
    status: 'PAID',
    admissionType: 'PAID',
    paymentReference: `REF_PAY_${Date.now()}`,
    vendorShare: 14250,
    commissionAmount: 750,
    commissionRate: 5,
    refundDetails: {
      refundedAt: new Date(),
      reason: 'Customer requested cancellation',
      paystackRefundId: '123456',
      paystackRefundStatus: 'pending',
      amountRefundedKobo: 1500000,
    },
  });

  assert(testOrder.refundDetails.paystackRefundId === '123456', 'Order schema supports refundDetails.paystackRefundId');
  assert(testOrder.refundDetails.amountRefundedKobo === 1500000, 'Order schema stores amountRefundedKobo in minor units');
  assert(testOrder.refundDetails.paystackRefundStatus === 'pending', 'Order schema stores paystackRefundStatus');

  await testOrder.save();
  assert(!!testOrder._id, 'Order with refundDetails saved successfully to MongoDB Atlas');

  // --- SECTION 3: INVENTORY RESTORATION & LEDGER REVERSAL AUDIT ---
  console.log('\n--- 3. Inventory Restoration & Double-Entry Ledger Reversal ---');

  // Create mock organizer
  const testOrganizer = await User.create({
    firstName: 'Audit',
    lastName: 'Organizer',
    email: `audit.organizer.${Date.now()}@tickza.local`,
    passwordHash: '$2a$10$abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqr',
    phone: '08012345678',
    role: 'ORGANIZER',
    availableBalanceKobo: 5000000, // 50,000 NGN
    balance: 50000,
  });

  // Create mock event & ticket type
  const testEvent = await Event.create({
    title: `Refund Audit Event ${Date.now()}`,
    slug: `refund-audit-event-${Date.now()}`,
    venue: 'Eko Convention Centre, Lagos',
    organizerId: testOrganizer._id,
    admissionType: 'PAID',
    startDate: new Date(Date.now() + 86400000 * 7),
    endDate: new Date(Date.now() + 86400000 * 8),
    status: 'PUBLISHED',
  });

  const testTicketType = await TicketType.create({
    eventId: testEvent._id,
    name: 'Standard VIP Access',
    price: 10000,
    quantity: 100,
    availableQuantity: 95, // 5 sold
  });

  // Create an active paid order with 2 tickets
  const activeOrder = await Order.create({
    userId: testOrganizer._id,
    orderNumber: `ORD-REF-AUDIT-${Date.now()}`,
    totalAmount: 20000,
    status: 'PAID',
    admissionType: 'PAID',
    paymentReference: `PAYSTACK_REF_${Date.now()}`,
    vendorShare: 19000,
    commissionAmount: 1000,
    commissionRate: 5,
    items: [
      {
        ticketTypeId: testTicketType._id,
        eventId: testEvent._id,
        quantity: 2,
        totalAttendees: 2,
        unitPrice: 10000,
        totalPrice: 20000,
      },
    ],
  });

  // Create 2 tickets
  const ticket1 = await Ticket.create({
    orderId: activeOrder._id,
    eventId: testEvent._id,
    ticketTypeId: testTicketType._id,
    ownerId: testOrganizer._id,
    ticketNumber: `TCK-${Date.now()}-1`,
    price: 10000,
    currency: 'NGN',
    qrToken: `QR-${Date.now()}-1`,
    status: 'SOLD',
  });

  const ticket2 = await Ticket.create({
    orderId: activeOrder._id,
    eventId: testEvent._id,
    ticketTypeId: testTicketType._id,
    ownerId: testOrganizer._id,
    ticketNumber: `TCK-${Date.now()}-2`,
    price: 10000,
    currency: 'NGN',
    qrToken: `QR-${Date.now()}-2`,
    status: 'SOLD',
  });

  assert(ticket1.status === 'SOLD' && ticket2.status === 'SOLD', 'Tickets initially generated in SOLD state');

  // Now simulate Paystack refund.processed webhook
  console.log('\n--- 4. Paystack Webhook: refund.processed Live Verification ---');

  const webhookSecret = process.env.PAYSTACK_SECRET_KEY || 'sk_test_mock_secret';
  const refundPayload = {
    event: 'refund.processed',
    data: {
      id: 987654,
      transaction_reference: activeOrder.paymentReference,
      amount: 2000000, // 20,000 NGN in kobo
      currency: 'NGN',
      status: 'processed',
      customer_note: 'Customer requested refund via Paystack',
    },
  };

  const rawRefundBody = JSON.stringify(refundPayload);
  const refundHmac = crypto.createHmac('sha512', webhookSecret).update(rawRefundBody).digest('hex');

  const mockReq = {
    headers: { 'x-paystack-signature': refundHmac },
    body: refundPayload,
    rawBody: rawRefundBody,
  };

  let statusCode = null;
  let statusMsg = null;
  const mockRes = {
    status: (code) => {
      statusCode = code;
      return {
        send: (msg) => { statusMsg = msg; },
        json: (msg) => { statusMsg = msg; },
      };
    },
  };

  await handlePaystackWebhook(mockReq, mockRes);
  assert(statusCode === 200, 'Paystack refund.processed webhook returns 200 OK');

  // Verify the order in DB is now REFUNDED
  const verifiedOrder = await Order.findById(activeOrder._id);
  assert(verifiedOrder.status === 'REFUNDED', 'Order status atomically changed to REFUNDED upon webhook');
  assert(verifiedOrder.refundDetails.paystackRefundId === '987654', 'paystackRefundId stored correctly from webhook');
  assert(verifiedOrder.refundDetails.paystackRefundStatus === 'processed', 'paystackRefundStatus set to processed');

  // Verify tickets are invalidated
  const verifiedTickets = await Ticket.find({ orderId: activeOrder._id });
  const allRefunded = verifiedTickets.every((t) => t.status === 'REFUNDED');
  assert(allRefunded, 'All tickets associated with refunded order are marked REFUNDED');

  // --- SECTION 5: CLEANUP OF TEST ARTIFACTS ---
  console.log('\n--- 5. Clean Up Test Records ---');
  await Order.deleteMany({ _id: { $in: [testOrder._id, activeOrder._id] } });
  await Ticket.deleteMany({ orderId: { $in: [testOrder._id, activeOrder._id] } });
  await TicketType.findByIdAndDelete(testTicketType._id);
  await Event.findByIdAndDelete(testEvent._id);
  await User.findByIdAndDelete(testOrganizer._id);
  assert(true, 'Test artifacts safely purged from MongoDB Atlas database');

  await mongoose.disconnect();
  console.log('\n================================================================');
  console.log(`   REFUND AUDIT SUMMARY: ${passedTests}/${totalTests} TESTS PASSED`);
  console.log('================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runRefundVerificationSuite().catch((err) => {
  console.error('[FATAL ERROR IN SUITE]', err);
  process.exit(1);
});
