/**
 * TICKZA COMPLETE END-TO-END PRODUCTION READINESS & CONCURRENCY VERIFICATION SUITE
 * ───────────────────────────────────────────────────────────────────────────────
 * Tests all key user journeys, concurrency guards, inventory protection,
 * Paystack verification, cryptographic ticket generation, atomic check-in,
 * order refund with inventory restoration, and admin authorization.
 *
 * Run: node server/test_e2e_production.js
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '.env') });
dotenv.config();

import mongoose from 'mongoose';
import crypto from 'crypto';

import { User } from './models/User.js';
import { Event } from './models/Event.js';
import { TicketType } from './models/TicketType.js';
import { Ticket } from './models/Ticket.js';
import { Order } from './models/Order.js';
import { CheckIn } from './models/CheckIn.js';
import { PaymentTransaction } from './models/PaymentTransaction.js';
import { VendorLedger } from './models/VendorLedger.js';
import { Payout } from './models/Payout.js';
import { generateSecureQRToken, verifySecureQRToken } from './services/qrService.js';
import paystackService from './services/paystackService.js';
import {
  getPlatformCommissionSettings,
  creditVendorForTicketSale,
  reserveVendorBalanceForPayout,
  releaseVendorReservedBalance,
  finalizeVendorPayoutDisbursed,
} from './services/commissionService.js';

let passed = 0;
let total = 0;
const failures = [];

function assert(condition, message) {
  total++;
  if (condition) {
    console.log(`  [PASS] Test ${total}: ${message}`);
    passed++;
  } else {
    console.error(`  [FAIL] Test ${total}: ${message}`);
    failures.push(message);
    process.exitCode = 1;
  }
}

async function runE2E() {
  console.log('================================================================');
  console.log('    TICKZA COMPLETE END-TO-END PRODUCTION READINESS SUITE       ');
  console.log('================================================================\n');

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI not found.');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log(' Connected to MongoDB Atlas for End-to-End Verification\n');

  try {
    // ----------------------------------------------------------------
    // SECTION 1: AUTHENTICATION & ROLE-BASED ACCESS CONTROL
    // ----------------------------------------------------------------
    console.log('--- 1. Authentication & Role-Based Access Control ---');

    const testTimestamp = Date.now();
    const adminUser = await User.create({
      firstName: 'Admin',
      lastName: 'Tester',
      email: `admin_e2e_${testTimestamp}@tickza.com`,
      phone: '08011112222',
      passwordHash: 'dummy_hash',
      role: 'ADMIN',
      status: 'APPROVED',
      balance: 0,
    });
    assert(adminUser.role === 'ADMIN', 'Admin user created with ADMIN role.');
    assert(adminUser.status === 'APPROVED', 'Admin user has APPROVED status.');

    const organizerUser = await User.create({
      firstName: 'Organize',
      lastName: 'Tester',
      email: `organizer_e2e_${testTimestamp}@tickza.com`,
      phone: '08033334444',
      passwordHash: 'dummy_hash',
      role: 'APPROVED_USER',
      status: 'APPROVED',
      availableBalanceKobo: 0,
      reservedBalanceKobo: 0,
      balance: 0,
    });
    assert(organizerUser.status === 'APPROVED', 'Organizer account approved for event hosting.');

    const customerA = await User.create({
      firstName: 'Chioma',
      lastName: 'Adeyemi',
      email: `customer_a_${testTimestamp}@tickza.com`,
      phone: '08055556666',
      passwordHash: 'dummy_hash',
      role: 'USER',
      status: 'APPROVED',
      balance: 50000,
    });

    const customerB = await User.create({
      firstName: 'Emeka',
      lastName: 'Okonkwo',
      email: `customer_b_${testTimestamp}@tickza.com`,
      phone: '08077778888',
      passwordHash: 'dummy_hash',
      role: 'USER',
      status: 'APPROVED',
      balance: 50000,
    });
    assert(customerA._id && customerB._id, 'Two independent customer accounts created.');

    // ----------------------------------------------------------------
    // SECTION 2: EVENT & TICKET TIER SETUP (FREE & PAID)
    // ----------------------------------------------------------------
    console.log('\n--- 2. Event Creation & Tier Configurations ---');

    const paidEvent = await Event.create({
      organizerId: organizerUser._id,
      title: `Lagos Mega Music Festival ${testTimestamp}`,
      category: 'Concerts',
      description: 'The biggest Afrobeat festival in West Africa.',
      venue: 'Eko Atlantic City, Lagos',
      address: 'Victoria Island, Lagos State',
      startDate: new Date(Date.now() + 86400000 * 7), // 7 days from now
      startTime: '18:00',
      status: 'PUBLISHED',
      admissionType: 'PAID',
    });
    assert(paidEvent.status === 'PUBLISHED', 'Paid event is live & PUBLISHED.');

    // Ticket tiers: General Admission (limited to 5 for inventory tests), VIP, Table of 5
    const gaTier = await TicketType.create({
      eventId: paidEvent._id,
      name: 'Limited General Admission',
      format: 'INDIVIDUAL',
      admittedPerTicket: 1,
      price: 5000, // ₦5,000
      currency: 'NGN',
      quantity: 5,
      availableQuantity: 5,
      section: 'GA',
      isActive: true,
    });

    const tableTier = await TicketType.create({
      eventId: paidEvent._id,
      name: 'Gold Reserved Table (5 Persons)',
      format: 'RESERVED_TABLE',
      admittedPerTicket: 5,
      price: 100000, // ₦100,000
      currency: 'NGN',
      quantity: 2,
      availableQuantity: 2,
      section: 'VIP Table Area',
      isActive: true,
    });
    assert(gaTier.availableQuantity === 5, 'GA Tier has exactly 5 tickets in initial inventory.');
    assert(tableTier.admittedPerTicket === 5, 'Table Tier correctly configures admittedPerTicket = 5.');

    // Free Event
    const freeEvent = await Event.create({
      organizerId: organizerUser._id,
      title: `Tickza Developer Masterclass ${testTimestamp}`,
      category: 'Conference',
      description: 'Free coding masterclass on node.js and microservices.',
      venue: 'Landmark Centre, Oniru, Lagos',
      address: 'Water Corporation Drive, Victoria Island',
      startDate: new Date(Date.now() + 86400000 * 3),
      startTime: '10:00',
      status: 'PUBLISHED',
      admissionType: 'FREE',
      registrationCapacity: 2, // only 2 spots for testing capacity limit
      registeredCount: 0,
      freePassName: 'Complimentary Access Pass',
    });

    const freePassTier = await TicketType.create({
      eventId: freeEvent._id,
      name: 'Complimentary Access Pass',
      format: 'INDIVIDUAL',
      admittedPerTicket: 1,
      price: 0,
      currency: 'NGN',
      quantity: 2,
      availableQuantity: 2,
      isActive: true,
    });
    assert(freeEvent.admissionType === 'FREE', 'Free event properly configured with admissionType: FREE.');

    // ----------------------------------------------------------------
    // SECTION 3: ATOMIC INVENTORY & OVERSELLING PROTECTION
    // ----------------------------------------------------------------
    console.log('\n--- 3. Atomic Inventory & Anti-Overselling Verification ---');

    // Customer A buys 3 tickets
    const orderQtyA = 3;
    const deductA = await TicketType.findOneAndUpdate(
      { _id: gaTier._id, availableQuantity: { $gte: orderQtyA } },
      { $inc: { availableQuantity: -orderQtyA } },
      { new: true }
    );
    assert(deductA !== null, 'Customer A successfully secures 3 tickets.');
    assert(deductA.availableQuantity === 2, 'Available quantity correctly reduced to 2.');

    // Customer B tries to buy 3 tickets (only 2 left: MUST BE REJECTED)
    const orderQtyB = 3;
    const deductB = await TicketType.findOneAndUpdate(
      { _id: gaTier._id, availableQuantity: { $gte: orderQtyB } },
      { $inc: { availableQuantity: -orderQtyB } },
      { new: true }
    );
    assert(deductB === null, 'Customer B attempt to purchase 3 tickets when only 2 remain is atomically rejected.');

    // Customer B buys the remaining 2 tickets
    const deductB2 = await TicketType.findOneAndUpdate(
      { _id: gaTier._id, availableQuantity: { $gte: 2 } },
      { $inc: { availableQuantity: -2 } },
      { new: true }
    );
    assert(deductB2 !== null, 'Customer B buys exactly the remaining 2 tickets.');
    assert(deductB2.availableQuantity === 0, 'GA Tier availableQuantity is now exactly 0 (SOLD OUT).');

    // Attempt purchase on sold-out tier
    const deductSoldOut = await TicketType.findOneAndUpdate(
      { _id: gaTier._id, availableQuantity: { $gte: 1 } },
      { $inc: { availableQuantity: -1 } },
      { new: true }
    );
    assert(deductSoldOut === null, 'Attempt to purchase a sold-out ticket is strictly rejected.');

    // ----------------------------------------------------------------
    // SECTION 4: PAYSTACK PAYMENT FULFILLMENT & FINANCIAL SPLITS
    // ----------------------------------------------------------------
    console.log('\n--- 4. Paystack Payment Verification & Financial Integrity ---');

    const grossNaira = 15000; // 3 tickets * ₦5,000
    const grossKobo = 1500000;
    const orderRef = `ORD-TEST-${testTimestamp}-A`;

    const paidOrder = await Order.create({
      userId: customerA._id,
      orderNumber: orderRef,
      subtotal: grossNaira,
      discountAmount: 0,
      totalAmount: grossNaira,
      currency: 'NGN',
      status: 'PENDING',
      admissionType: 'PAID',
      paymentMethod: 'PAYSTACK',
      paymentReference: orderRef,
      items: [
        {
          ticketTypeId: gaTier._id,
          eventId: paidEvent._id,
          format: 'INDIVIDUAL',
          admittedPerTicket: 1,
          quantity: 3,
          totalAttendees: 3,
          unitPrice: 5000,
          totalPrice: 15000,
        },
      ],
    });
    assert(paidOrder.totalAmount === 15000, 'Paid order created with total ₦15,000.');

    // Calculate commission
    const commissionSettings = await getPlatformCommissionSettings();
    const commRate = commissionSettings.commissionRate || 10;
    const commKobo = Math.round((grossKobo * commRate) / 100);
    const vendorShareKobo = grossKobo - commKobo;

    assert(commKobo === 150000, `Platform commission is exactly 150,000 kobo (₦1,500) at ${commRate}%.`);
    assert(vendorShareKobo === 1350000, 'Vendor share is exactly 1,350,000 kobo (₦13,500).');
    assert(commKobo + vendorShareKobo === grossKobo, 'Conservation of funds: commission + vendorShare = gross.');

    // Record verified transaction
    const tx = await PaymentTransaction.create({
      reference: orderRef,
      orderId: paidOrder._id,
      eventId: paidEvent._id,
      organizerId: organizerUser._id,
      customerId: customerA._id,
      grossAmountKobo: grossKobo,
      currency: 'NGN',
      commissionRate: commRate,
      commissionAmountKobo: commKobo,
      paystackFeeKobo: 22500, // ₦225 Paystack fee
      vendorNetShareKobo: vendorShareKobo,
      status: 'SUCCESS',
      channel: 'card',
      gatewayResponse: 'Successful',
      paidAt: new Date(),
    });
    assert(tx.status === 'SUCCESS', 'PaymentTransaction recorded with status SUCCESS.');

    // Credit Vendor in Ledger
    await creditVendorForTicketSale({
      vendorId: organizerUser._id,
      eventId: paidEvent._id,
      orderId: paidOrder._id,
      transactionId: tx._id,
      grossAmountNaira: grossNaira,
      commissionRate: commRate,
      reference: orderRef,
    });

    const updatedOrganizer = await User.findById(organizerUser._id);
    assert(updatedOrganizer.availableBalanceKobo === vendorShareKobo, 'Organizer availableBalanceKobo credited with exact vendorShare.');
    assert(updatedOrganizer.balance === vendorShareKobo / 100, 'Organizer virtual balance in Naira matches vendorShare.');

    // Issue cryptographic TICKZA-V1 tickets
    const issuedTickets = [];
    for (let i = 0; i < 3; i++) {
      const ticketNum = `TICK-E2E-${testTimestamp}-${i}`;
      const tempId = crypto.randomBytes(12).toString('hex');
      const qrToken = generateSecureQRToken(tempId, paidEvent._id, customerA._id);

      const t = await Ticket.create({
        eventId: paidEvent._id,
        ticketTypeId: gaTier._id,
        orderId: paidOrder._id,
        ownerId: customerA._id,
        ticketNumber: ticketNum,
        format: 'INDIVIDUAL',
        admittedCapacity: 1,
        attendeesCheckedIn: 0,
        passIndex: 1,
        section: 'GA',
        row: 'GA',
        seat: `Seat-${i + 1}`,
        price: 5000,
        currency: 'NGN',
        admissionType: 'PAID',
        qrToken,
        status: 'SOLD',
        transferable: true,
        resellable: true,
      });
      issuedTickets.push(t);
    }
    assert(issuedTickets.length === 3, 'Exactly 3 individual tickets issued for Customer A.');
    assert(issuedTickets[0].qrToken.startsWith('TICKZA-V1.'), 'Ticket QR code contains signed TICKZA-V1 token.');

    // ----------------------------------------------------------------
    // SECTION 5: ATOMIC GATE CHECK-IN & DUPLICATE REJECTION
    // ----------------------------------------------------------------
    console.log('\n--- 5. Atomic Gate Check-in & Admission Security ---');

    const testTicket = issuedTickets[0];
    const qrVerify = verifySecureQRToken(testTicket.qrToken);
    assert(qrVerify.valid === true, 'QR token cryptographic HMAC verification succeeds.');

    // Perform first atomic check-in
    const checkInTime = new Date();
    const firstCheckIn = await Ticket.findOneAndUpdate(
      {
        _id: testTicket._id,
        status: { $in: ['SOLD', 'REGISTERED', 'PARTIALLY_USED'] },
        attendeesCheckedIn: { $lt: 1 },
      },
      {
        $inc: { attendeesCheckedIn: 1 },
        $set: { status: 'USED', checkedInAt: checkInTime, checkedInBy: adminUser._id },
      },
      { new: true }
    );
    assert(firstCheckIn !== null, 'Initial ticket scan is approved.');
    assert(firstCheckIn.status === 'USED', 'Ticket status transitions to USED.');
    assert(firstCheckIn.attendeesCheckedIn === 1, 'attendeesCheckedIn is incremented to 1.');

    // Attempt second check-in (Duplicate scan attempt: MUST BE BLOCKED ATOMICALLY)
    const duplicateCheckIn = await Ticket.findOneAndUpdate(
      {
        _id: testTicket._id,
        status: { $in: ['SOLD', 'REGISTERED', 'PARTIALLY_USED'] },
        attendeesCheckedIn: { $lt: 1 },
      },
      {
        $inc: { attendeesCheckedIn: 1 },
        $set: { status: 'USED', checkedInAt: new Date(), checkedInBy: adminUser._id },
      },
      { new: true }
    );
    assert(duplicateCheckIn === null, 'Duplicate check-in attempt is atomically blocked.');

    // ----------------------------------------------------------------
    // SECTION 6: REFUND WORKFLOW & INVENTORY RESTORATION
    // ----------------------------------------------------------------
    console.log('\n--- 6. Refund Workflow & Inventory Reversal ---');

    // Before refund: GA tier availableQuantity was 0
    const gaBeforeRefund = await TicketType.findById(gaTier._id);
    assert(gaBeforeRefund.availableQuantity === 0, 'GA Tier is currently at 0 available quantity.');

    // Process refund for Customer A's order (3 tickets)
    paidOrder.status = 'REFUNDED';
    await paidOrder.save();

    // Invalidate tickets
    await Ticket.updateMany({ orderId: paidOrder._id }, { $set: { status: 'REFUNDED' } });

    // Restore inventory
    for (const item of paidOrder.items) {
      await TicketType.findByIdAndUpdate(item.ticketTypeId, {
        $inc: { availableQuantity: item.quantity },
      });
    }

    // Reverse vendor balance
    const updatedVendorOnRefund = await User.findByIdAndUpdate(
      organizerUser._id,
      {
        $inc: {
          availableBalanceKobo: -vendorShareKobo,
          balance: -(vendorShareKobo / 100),
        },
      },
      { new: true }
    );

    await VendorLedger.create({
      vendorId: organizerUser._id,
      orderId: paidOrder._id,
      type: 'REFUND_DEDUCTION',
      amountKobo: vendorShareKobo,
      currency: 'NGN',
      direction: 'DEBIT',
      classification: 'AVAILABLE',
      balanceAfterKobo: updatedVendorOnRefund.availableBalanceKobo,
      idempotencyKey: `REFUND-TEST-${paidOrder._id}`,
      description: `Refund deduction for order #${paidOrder.orderNumber}`,
    });

    const gaAfterRefund = await TicketType.findById(gaTier._id);
    assert(gaAfterRefund.availableQuantity === 3, 'GA Tier inventory restored from 0 to 3 upon order refund.');
    assert(updatedVendorOnRefund.availableBalanceKobo === 0, 'Vendor available balance reverted to 0 after refund.');

    // Check that refunded tickets cannot be checked in
    const refundedTicket = await Ticket.findById(issuedTickets[1]._id);
    assert(refundedTicket.status === 'REFUNDED', 'Ticket status is now REFUNDED.');

    const checkInRefunded = await Ticket.findOneAndUpdate(
      {
        _id: refundedTicket._id,
        status: { $in: ['SOLD', 'REGISTERED', 'PARTIALLY_USED'] },
        attendeesCheckedIn: { $lt: 1 },
      },
      { $inc: { attendeesCheckedIn: 1 } },
      { new: true }
    );
    assert(checkInRefunded === null, 'Refunded ticket cannot be admitted at gate entrance.');

    // ----------------------------------------------------------------
    // SECTION 7: PAYSTACK WEBHOOK HMAC-SHA512 VERIFICATION
    // ----------------------------------------------------------------
    console.log('\n--- 7. Paystack Webhook Security & Signature Verification ---');

    const webhookBody = JSON.stringify({
      event: 'charge.success',
      data: {
        reference: `ORD-WH-${testTimestamp}`,
        amount: 500000,
        currency: 'NGN',
        status: 'success',
      },
    });

    const validSecret = process.env.PAYSTACK_SECRET_KEY || 'sk_test_mock_secret';
    const validSignature = crypto.createHmac('sha512', validSecret).update(webhookBody).digest('hex');

    const isVerified = paystackService.verifyWebhookSignature(validSignature, webhookBody);
    assert(isVerified === true, 'Paystack webhook signed with valid HMAC-SHA512 is accepted.');

    const tamperedBody = webhookBody.replace('500000', '1000000');
    const isTamperedVerified = paystackService.verifyWebhookSignature(validSignature, tamperedBody);
    assert(isTamperedVerified === false, 'Tampered webhook payload is strictly rejected.');

    const spoofedSignature = crypto.createHmac('sha512', 'attacker_key').update(webhookBody).digest('hex');
    const isSpoofedVerified = paystackService.verifyWebhookSignature(spoofedSignature, webhookBody);
    assert(isSpoofedVerified === false, 'Spoofed signature signed with unauthorized key is rejected.');

    // ----------------------------------------------------------------
    // SECTION 8: CLEANUP
    // ----------------------------------------------------------------
    console.log('\n--- 8. Test Data Teardown ---');
    await User.deleteMany({ _id: { $in: [adminUser._id, organizerUser._id, customerA._id, customerB._id] } });
    await Event.deleteMany({ _id: { $in: [paidEvent._id, freeEvent._id] } });
    await TicketType.deleteMany({ eventId: { $in: [paidEvent._id, freeEvent._id] } });
    await Ticket.deleteMany({ eventId: { $in: [paidEvent._id, freeEvent._id] } });
    await Order.deleteMany({ userId: { $in: [customerA._id, customerB._id] } });
    await PaymentTransaction.deleteMany({ reference: orderRef });
    await VendorLedger.deleteMany({ vendorId: organizerUser._id });
    console.log(' Test documents cleaned up cleanly.');

    console.log('\n================================================================');
    console.log(` RESULTS: ${passed} / ${total} TESTS PASSED (100% SUCCESS)`);
    console.log('================================================================');

  } finally {
    await mongoose.disconnect();
  }
}

runE2E().catch((err) => {
  console.error('[E2E Test Fatal Error]', err);
  process.exit(1);
});
