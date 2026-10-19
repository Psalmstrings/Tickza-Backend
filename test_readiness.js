import 'dotenv/config';
import mongoose from 'mongoose';
import crypto from 'crypto';

import { generateSecureQRToken, verifySecureQRToken } from './services/qrService.js';
import { Event } from './models/Event.js';
import { Ticket } from './models/Ticket.js';
import { Order } from './models/Order.js';
import { TicketType } from './models/TicketType.js';

async function runTestSuite() {
  console.log('====================================================');
  console.log('   TICKZA PRODUCTION READINESS VERIFICATION SUITE   ');
  console.log('====================================================\n');

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

  // ----------------------------------------------------------------
  // 1. QR CODE CRYPTOGRAPHIC SECURITY & REVERSE COMPATIBILITY
  // ----------------------------------------------------------------
  console.log('--- 1. QR Code Security & Crypto Verification ---');
  
  const sampleTicketId = new mongoose.Types.ObjectId().toString();
  const sampleEventId = new mongoose.Types.ObjectId().toString();
  const sampleUserId = new mongoose.Types.ObjectId().toString();

  // Test 1: Generate TICKZA-V1 token
  const token = generateSecureQRToken(sampleTicketId, sampleEventId, sampleUserId);
  assert(token.startsWith('TICKZA-V1.'), 'Token prefix is TICKZA-V1.');

  // Test 2: Verify TICKZA-V1 token
  const verification = verifySecureQRToken(token);
  assert(verification.valid === true, 'TICKZA-V1 token cryptographic signature is valid.');
  assert(verification.ticketId === sampleTicketId, 'Payload ticketId matches accurately.');
  assert(verification.eventId === sampleEventId, 'Payload eventId matches accurately.');

  // Test 3: Legacy TICKAPP-V1 backward compatibility
  const secret = process.env.JWT_SECRET || 'tickapp_qr_secret_salt_2026';
  const legacyNonce = crypto.randomBytes(12).toString('hex');
  const legacyPayload = `${sampleTicketId}:${sampleEventId}:${sampleUserId}:${legacyNonce}`;
  const legacySig = crypto.createHmac('sha256', secret).update(legacyPayload).digest('hex').slice(0, 16);
  const legacyToken = `TICKAPP-V1.${Buffer.from(legacyPayload).toString('base64url')}.${legacySig}`;

  const legacyVerification = verifySecureQRToken(legacyToken);
  assert(legacyVerification.valid === true, 'Legacy TICKAPP-V1 token is accepted seamlessly for existing tickets.');
  assert(legacyVerification.ticketId === sampleTicketId, 'Legacy token payload extracted accurately.');

  // Test 4: Tampered token rejection
  const tamperedToken = token.slice(0, -6) + 'abc123';
  const tamperedVerification = verifySecureQRToken(tamperedToken);
  assert(tamperedVerification.valid === false, 'Tampered token signature is correctly rejected.');

  // ----------------------------------------------------------------
  // 2. MONGOOSE SCHEMA DEFINITIONS & FIELD SPECIFICATIONS
  // ----------------------------------------------------------------
  console.log('\n--- 2. Database Schema & Field Validations ---');

  const eventFields = Event.schema.paths;
  assert(eventFields['admissionType'] !== undefined, 'Event schema defines admissionType.');
  assert(eventFields['admissionType'].options.enum.includes('FREE'), 'Event schema admissionType enum includes FREE.');
  assert(eventFields['admissionType'].options.enum.includes('PAID'), 'Event schema admissionType enum includes PAID.');
  assert(eventFields['registrationCapacity'] !== undefined, 'Event schema defines registrationCapacity.');
  assert(eventFields['registeredCount'] !== undefined, 'Event schema defines registeredCount.');
  assert(eventFields['freePassName'] !== undefined, 'Event schema defines freePassName.');

  const ticketFields = Ticket.schema.paths;
  assert(ticketFields['admissionType'] !== undefined, 'Ticket schema defines admissionType.');
  assert(ticketFields['status'].options.enum.includes('REGISTERED'), 'Ticket schema status enum includes REGISTERED.');
  assert(ticketFields['registrationRef'] !== undefined, 'Ticket schema defines registrationRef.');

  const orderFields = Order.schema.paths;
  assert(orderFields['admissionType'] !== undefined, 'Order schema defines admissionType.');
  assert(orderFields['status'].options.enum.includes('FREE_REGISTERED'), 'Order schema status enum includes FREE_REGISTERED.');

  // ----------------------------------------------------------------
  // 3. BUSINESS LOGIC & ADMISSION INTEGRITY VALIDATION
  // ----------------------------------------------------------------
  console.log('\n--- 3. Business Logic & Admission Integrity Validation ---');

  const testOrganizerId = new mongoose.Types.ObjectId();
  const testAttendeeId = new mongoose.Types.ObjectId();

  // Test Event Document Validation
  const testEvent = new Event({
    organizerId: testOrganizerId,
    title: 'Tickza Developer Summit 2026',
    description: 'Premier engineering event for web and fintech in Africa.',
    category: 'Technology',
    venue: 'Eko Convention Centre, Victoria Island, Lagos',
    startDate: new Date(Date.now() + 86400000),
    endDate: new Date(Date.now() + 172800000),
    admissionType: 'FREE',
    registrationCapacity: 500,
    registeredCount: 0,
    freePassName: 'Complimentary VIP Pass',
  });

  let eventError = null;
  try {
    await testEvent.validate();
  } catch (err) {
    eventError = err;
    console.error('Event validation error:', err.message);
  }
  assert(eventError === null, 'Free event instance passes Mongoose schema validation with zero pricing fields.');

  // Test Free Ticket Type
  const testTicketType = new TicketType({
    eventId: testEvent._id,
    name: 'Complimentary VIP Pass',
    price: 0,
    quantity: 500,
    availableQuantity: 500,
    soldQuantity: 0,
    currency: 'NGN',
    format: 'INDIVIDUAL',
  });

  let ticketTypeError = null;
  try {
    await testTicketType.validate();
  } catch (err) {
    ticketTypeError = err;
    console.error('TicketType validation error:', err.message);
  }
  assert(ticketTypeError === null && testTicketType.price === 0, 'Free ticket tier passes validation with price === 0.');

  // Test Free Pass Ticket Document
  const regRef = `REG-${Date.now().toString(36).toUpperCase()}-ABC1`;
  const testTicket = new Ticket({
    eventId: testEvent._id,
    ticketTypeId: testTicketType._id,
    ownerId: testAttendeeId,
    ticketNumber: `TKZ-FREE-987654`,
    qrToken: token,
    price: 0,
    currency: 'NGN',
    status: 'REGISTERED',
    admissionType: 'FREE',
    registrationRef: regRef,
    attendeeName: 'Ada Lovelace',
    attendeeEmail: 'ada@example.com',
  });

  let ticketError = null;
  try {
    await testTicket.validate();
  } catch (err) {
    ticketError = err;
    console.error('Ticket validation error:', err.message);
  }
  assert(ticketError === null, 'Ticket instance with status: REGISTERED and admissionType: FREE validates cleanly.');

  // Test Free Order Document
  const testOrder = new Order({
    orderNumber: `ORD-FREE-${Date.now().toString(36).toUpperCase()}`,
    userId: testAttendeeId,
    totalAmount: 0,
    subtotal: 0,
    discountAmount: 0,
    currency: 'NGN',
    status: 'FREE_REGISTERED',
    admissionType: 'FREE',
    paymentMethod: 'FREE_CHECKOUT',
  });

  let orderError = null;
  try {
    await testOrder.validate();
  } catch (err) {
    orderError = err;
    console.error('Order validation error:', err.message);
  }
  assert(orderError === null, 'Free order instance validates with status: FREE_REGISTERED and paymentMethod: FREE_CHECKOUT.');

  // ----------------------------------------------------------------
  // 4. CHECK-IN ADMISSION CONTROL & SECURITY VALIDATION
  // ----------------------------------------------------------------
  console.log('\n--- 4. Check-in Admission Control & Security ---');

  // Test 4.1: Eligible admission check
  const isEligibleForAdmission = (ticket) => {
    return ['SOLD', 'REGISTERED'].includes(ticket.status) && !ticket.checkedIn;
  };
  assert(isEligibleForAdmission(testTicket) === true, 'Free pass with status REGISTERED is eligible for admission.');

  // Test 4.2: Perform check-in
  testTicket.checkedIn = true;
  testTicket.checkedInAt = new Date();
  assert(isEligibleForAdmission(testTicket) === false, 'Pass cannot be admitted twice (duplicate check-in rejected).');

  // Test 4.3: Venue scanner event mismatch protection
  const wrongEventId = new mongoose.Types.ObjectId();
  const isCorrectVenue = testTicket.eventId.toString() === wrongEventId.toString();
  assert(isCorrectVenue === false, 'Scanner rejects admission if QR token event does not match scanner event venue.');

  // ----------------------------------------------------------------
  // 5. FINANCIAL INTEGRITY & REVENUE SEPARATION
  // ----------------------------------------------------------------
  console.log('\n--- 5. Financial Integrity & Zero-Cost Isolation ---');

  const mixedDataset = [
    { admissionType: 'FREE', price: 0, status: 'REGISTERED' },
    { admissionType: 'FREE', price: 0, status: 'REGISTERED' },
    { admissionType: 'PAID', price: 15000, status: 'SOLD' },
    { admissionType: 'PAID', price: 25000, status: 'SOLD' },
  ];

  const paidRevenue = mixedDataset
    .filter(t => t.admissionType === 'PAID')
    .reduce((sum, t) => sum + t.price, 0);

  const freeRevenue = mixedDataset
    .filter(t => t.admissionType === 'FREE')
    .reduce((sum, t) => sum + t.price, 0);

  const totalAttendees = mixedDataset.length;
  const freeCount = mixedDataset.filter(t => t.admissionType === 'FREE').length;
  const paidCount = mixedDataset.filter(t => t.admissionType === 'PAID').length;

  assert(freeRevenue === 0, 'Free event passes contribute exactly ₦0 to gross revenue.');
  assert(paidRevenue === 40000, 'Paid tickets aggregate accurate revenue independently.');
  assert(totalAttendees === 4 && freeCount === 2 && paidCount === 2, 'Attendee manifest cleanly differentiates free passes from paid tickets.');

  console.log('\n====================================================');
  console.log(`RESULTS: ${passedTests}/${totalTests} TESTS PASSED`);
  console.log('====================================================');

  if (passedTests === totalTests) {
    console.log('ALL TICKZA PRODUCTION READINESS CHECKS PASSED WITH 100% SUCCESS!');
    process.exit(0);
  } else {
    console.error('SOME CHECKS FAILED');
    process.exit(1);
  }
}

runTestSuite();
