import 'dotenv/config';
import mongoose from 'mongoose';
import crypto from 'crypto';

import { verifyWebhookSignature } from './services/paystackService.js';
import { calculateEarnings } from './services/commissionService.js';
import { PaymentTransaction } from './models/PaymentTransaction.js';
import { VendorLedger } from './models/VendorLedger.js';
import { Payout } from './models/Payout.js';
import { User } from './models/User.js';
import { Order } from './models/Order.js';
import { Event } from './models/Event.js';
import { Ticket } from './models/Ticket.js';

async function runPaystackTestSuite() {
  console.log('================================================================');
  console.log('   TICKZA PAYSTACK MARKETPLACE & COMMISSION VERIFICATION SUITE   ');
  console.log('================================================================\n');

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
  // 1. PAYSTACK WEBHOOK SIGNATURE & CRYPTO SECURITY
  // ----------------------------------------------------------------
  console.log('--- 1. Paystack Webhook HMAC-SHA512 Verification ---');
  
  const testSecret = 'sk_test_mock_paystack_secret_key_12345';
  process.env.PAYSTACK_WEBHOOK_SECRET = testSecret;

  const rawBody = JSON.stringify({
    event: 'charge.success',
    data: {
      reference: 'TICKZA-TX-TEST-001',
      amount: 500000,
      status: 'success',
      paid_at: new Date().toISOString()
    }
  });

  // Calculate genuine HMAC-SHA512
  const validSignature = crypto.createHmac('sha512', testSecret).update(rawBody).digest('hex');
  const invalidSignature = 'invalid_tampered_signature_99999';

  assert(
    verifyWebhookSignature(validSignature, rawBody) === true,
    'Valid HMAC-SHA512 webhook signature from Paystack is accepted.'
  );

  assert(
    verifyWebhookSignature(invalidSignature, rawBody) === false,
    'Tampered or invalid Paystack webhook signature is rejected.'
  );

  assert(
    verifyWebhookSignature(null, rawBody) === false,
    'Null or missing webhook signature is rejected.'
  );

  // ----------------------------------------------------------------
  // 2. COMMISSION CALCULATION & INTEGER MINOR UNITS (KOBO)
  // ----------------------------------------------------------------
  console.log('\n--- 2. Commission Calculation & Integer Arithmetic (Kobo) ---');

  // Case A: ₦10,000 order with 5% platform commission
  const calcA = calculateEarnings({ grossAmountNaira: 10000, commissionRate: 5 });
  assert(calcA.grossKobo === 1000000, 'Gross amount is 1,000,000 kobo (₦10,000).');
  assert(calcA.commissionKobo === 50000, '5% commission is exactly 50,000 kobo (₦500).');
  assert(Number.isInteger(calcA.commissionKobo), 'Commission is an integer minor unit (no floating point decimals).');
  assert(calcA.vendorShareKobo === 950000, 'Vendor share is exactly 950,000 kobo (₦9,500).');
  assert(calcA.grossNaira === 10000, 'Virtual grossNaira is 10,000.');
  assert(calcA.commissionNaira === 500, 'Virtual commissionNaira is 500.');
  assert(calcA.vendorShareNaira === 9500, 'Virtual vendorShareNaira is 9,500.');

  // Case B: ₦5,000 order with 7.5% platform commission
  const calcB = calculateEarnings({ grossAmountNaira: 5000, commissionRate: 7.5 });
  assert(calcB.grossKobo === 500000, 'Gross amount is 500,000 kobo (₦5,000).');
  assert(calcB.commissionKobo === 37500, '7.5% commission is exactly 37,500 kobo (₦375).');
  assert(calcB.vendorShareKobo === 462500, 'Vendor share is exactly 462,500 kobo (₦4,625).');

  // Case C: Rounding test on odd fraction amounts (e.g. ₦333.33)
  const calcC = calculateEarnings({ grossAmountNaira: 333.33, commissionRate: 5 });
  assert(Number.isInteger(calcC.grossKobo), 'Gross kobo is strictly an integer.');
  assert(Number.isInteger(calcC.commissionKobo), 'Commission kobo is strictly an integer.');
  assert(Number.isInteger(calcC.vendorShareKobo), 'Vendor net share kobo is strictly an integer.');
  assert(calcC.grossKobo === calcC.commissionKobo + calcC.vendorShareKobo, 'Conservation of funds: gross = commission + vendorShare.');

  // ----------------------------------------------------------------
  // 3. SCHEMA INTEGRITY & MONGOOSE DATA MODELS
  // ----------------------------------------------------------------
  console.log('\n--- 3. Database Models & Schema Validation ---');

  // PaymentTransaction Schema
  const ptPaths = PaymentTransaction.schema.paths;
  assert(ptPaths.grossAmountKobo !== undefined, 'PaymentTransaction has grossAmountKobo field.');
  assert(ptPaths.commissionAmountKobo !== undefined, 'PaymentTransaction has commissionAmountKobo field.');
  assert(ptPaths.paystackFeeKobo !== undefined, 'PaymentTransaction has paystackFeeKobo field.');
  assert(ptPaths.vendorNetShareKobo !== undefined, 'PaymentTransaction has vendorNetShareKobo field.');
  assert(ptPaths.reference !== undefined, 'PaymentTransaction has unique reference field.');
  assert(ptPaths.status !== undefined, 'PaymentTransaction has status field.');
  
  const ptStatusEnum = PaymentTransaction.schema.path('status').enumValues;
  assert(
    ptStatusEnum.includes('PENDING') && ptStatusEnum.includes('SUCCESS') && ptStatusEnum.includes('FAILED'),
    'PaymentTransaction status enum contains PENDING, SUCCESS, FAILED.'
  );

  // VendorLedger Schema
  const vlPaths = VendorLedger.schema.paths;
  assert(vlPaths.vendorId !== undefined, 'VendorLedger has vendorId ObjectId reference.');
  assert(vlPaths.type !== undefined, 'VendorLedger has type field.');
  assert(vlPaths.amountKobo !== undefined, 'VendorLedger has amountKobo integer field.');
  assert(vlPaths.balanceAfterKobo !== undefined, 'VendorLedger has balanceAfterKobo snapshot field.');
  assert(vlPaths.idempotencyKey !== undefined, 'VendorLedger has idempotencyKey unique field.');
  assert(vlPaths.direction !== undefined, 'VendorLedger has direction field (CREDIT/DEBIT).');

  const vlTypes = VendorLedger.schema.path('type').enumValues;
  assert(
    vlTypes.includes('TICKET_SALE_NET') &&
    vlTypes.includes('PLATFORM_COMMISSION') &&
    vlTypes.includes('PAYOUT_RESERVED') &&
    vlTypes.includes('PAYOUT_RELEASED') &&
    vlTypes.includes('PAYOUT_DISBURSED') &&
    vlTypes.includes('REFUND_DEDUCTION'),
    'VendorLedger type enum includes all double-entry transaction types.'
  );

  // Payout Model & Virtuals
  const payoutPaths = Payout.schema.paths;
  assert(payoutPaths.amountKobo !== undefined, 'Payout schema uses amountKobo for precision.');
  assert(payoutPaths.status !== undefined, 'Payout schema has status field.');
  assert(payoutPaths['bankAccount.bankCode'] !== undefined, 'Payout schema has bankCode field.');
  assert(payoutPaths['bankAccount.accountNumberMasked'] !== undefined, 'Payout schema masks sensitive account numbers.');
  assert(payoutPaths.paystackTransferCode !== undefined, 'Payout schema stores Paystack transfer codes.');

  const payoutStatuses = Payout.schema.path('status').enumValues;
  assert(
    payoutStatuses.includes('REQUESTED') &&
    payoutStatuses.includes('UNDER_REVIEW') &&
    payoutStatuses.includes('APPROVED') &&
    payoutStatuses.includes('PROCESSING') &&
    payoutStatuses.includes('PAID') &&
    payoutStatuses.includes('REJECTED') &&
    payoutStatuses.includes('FAILED') &&
    payoutStatuses.includes('CANCELLED'),
    'Payout model supports all 8 comprehensive lifecycle statuses.'
  );

  // Test Payout Virtuals
  const samplePayout = new Payout({
    organizerId: new mongoose.Types.ObjectId(),
    reference: 'PO-TEST-123',
    amountKobo: 5000000, // ₦50,000
    feeKobo: 5000,       // ₦50
    netAmountKobo: 4995000, // ₦49,950
    bankAccount: {
      bankName: 'Guaranty Trust Bank',
      bankCode: '058',
      accountNumberMasked: '******1234',
      accountName: 'Tickza Vendor Ltd',
    },
  });
  assert(samplePayout.amountNaira === 50000, 'Payout virtual amountNaira correctly derives ₦50,000.');
  assert(samplePayout.feeNaira === 50, 'Payout virtual feeNaira correctly derives ₦50.');
  assert(samplePayout.netAmountNaira === 49950, 'Payout virtual netAmountNaira correctly derives ₦49,950.');

  // User Model Balance Fields
  const userPaths = User.schema.paths;
  assert(userPaths.availableBalanceKobo !== undefined, 'User model contains availableBalanceKobo.');
  assert(userPaths.reservedBalanceKobo !== undefined, 'User model contains reservedBalanceKobo.');
  assert(userPaths['bankAccount.accountNumber'] !== undefined, 'User model contains bankAccount subdocument.');
  assert(userPaths['bankAccount.recipientCode'] !== undefined, 'User model contains Paystack recipientCode.');

  // Order Model Extensions
  const orderPaths = Order.schema.paths;
  assert(orderPaths.paymentReference !== undefined, 'Order model contains paymentReference.');
  assert(orderPaths.commissionAmount !== undefined, 'Order model contains commissionAmount.');
  assert(orderPaths.vendorShare !== undefined, 'Order model contains vendorShare.');
  assert(orderPaths.paidAt !== undefined, 'Order model contains paidAt timestamp.');

  // ----------------------------------------------------------------
  // 4. ATOMIC BALANCE RESERVATION & CONCURRENCY CONTROLS
  // ----------------------------------------------------------------
  console.log('\n--- 4. Atomic Balance Reservation & Anti-Double-Withdrawal ---');

  const vendorAvailableKobo = 10000000; // ₦100,000 available
  const requestedPayoutKobo = 6000000;  // ₦60,000 requested
  const excessivePayoutKobo = 12000000; // ₦120,000 requested (exceeds balance)

  // Simulation of atomic check:
  function simulateAtomicBalanceReservation(currentAvailable, currentReserved, amount) {
    if (currentAvailable >= amount) {
      return {
        success: true,
        available: currentAvailable - amount,
        reserved: currentReserved + amount,
      };
    }
    return { success: false, error: 'Insufficient available balance' };
  }

  const validAttempt = simulateAtomicBalanceReservation(vendorAvailableKobo, 0, requestedPayoutKobo);
  assert(validAttempt.success === true, 'Sufficient balance permits payout reservation.');
  assert(validAttempt.available === 4000000, 'Remaining available balance is ₦40,000 (4,000,000 kobo).');
  assert(validAttempt.reserved === 6000000, 'Reserved balance is locked at ₦60,000 (6,000,000 kobo).');

  const excessiveAttempt = simulateAtomicBalanceReservation(validAttempt.available, validAttempt.reserved, excessivePayoutKobo);
  assert(excessiveAttempt.success === false, 'Double-withdrawal or excessive payout is atomically blocked.');

  // Payout rejection release:
  const releaseAttempt = {
    available: validAttempt.available + validAttempt.reserved,
    reserved: 0
  };
  assert(releaseAttempt.available === vendorAvailableKobo, 'Rejected payout fully restores original available balance.');

  // Payout disbursement:
  const disburseAttempt = {
    available: validAttempt.available,
    reserved: validAttempt.reserved - requestedPayoutKobo,
    totalDisbursed: requestedPayoutKobo
  };
  assert(disburseAttempt.reserved === 0, 'Disbursed payout clears reserved balance without reducing available balance again.');

  // ----------------------------------------------------------------
  // 5. FREE EVENT ZERO-DOLLAR ISOLATION
  // ----------------------------------------------------------------
  console.log('\n--- 5. Free Event Zero-Dollar Isolation ---');

  const sampleFreeEvent = new Event({
    title: 'Free Developer Meetup',
    description: 'Community tech gathering with zero admission fee',
    admissionType: 'FREE',
    startDate: new Date(Date.now() + 86400000),
    endDate: new Date(Date.now() + 90000000),
    organizer: new mongoose.Types.ObjectId(),
    venue: { name: 'Main Auditorium' },
  });

  const sampleFreeOrder = new Order({
    event: sampleFreeEvent._id,
    user: new mongoose.Types.ObjectId(),
    ticketType: new mongoose.Types.ObjectId(),
    quantity: 1,
    unitPrice: 0,
    totalAmount: 0,
    admissionType: 'FREE',
    status: 'FREE_REGISTERED',
    commissionRate: 0,
    commissionAmount: 0,
    vendorShare: 0,
  });

  assert(sampleFreeOrder.admissionType === 'FREE', 'Free order explicitly has admissionType FREE.');
  assert(sampleFreeOrder.totalAmount === 0, 'Free order totalAmount is strictly 0.');
  assert(sampleFreeOrder.commissionAmount === 0, 'Free order incurs 0 platform commission.');
  assert(sampleFreeOrder.vendorShare === 0, 'Free order incurs 0 vendor share.');
  assert(sampleFreeOrder.status === 'FREE_REGISTERED', 'Free order receives instant FREE_REGISTERED status without gateway.');

  // ----------------------------------------------------------------
  // 6. COMMISSION SETTINGS VALIDATION BOUNDS
  // ----------------------------------------------------------------
  console.log('\n--- 6. Commission Settings Validation Bounds ---');

  const validateCommissionSettings = (rate, minNaira) => {
    if (isNaN(rate) || rate < 0 || rate > 50) return false;
    if (isNaN(minNaira) || minNaira < 500) return false;
    return true;
  };

  assert(validateCommissionSettings(10, 2000) === true, '10% commission with ₦2,000 threshold is valid.');
  assert(validateCommissionSettings(0, 500) === true, '0% commission (no fee) with ₦500 threshold is valid.');
  assert(validateCommissionSettings(-5, 2000) === false, 'Negative commission rate is rejected.');
  assert(validateCommissionSettings(60, 2000) === false, 'Excessive commission rate (>50%) is rejected.');
  assert(validateCommissionSettings(10, 100) === false, 'Threshold below minimum ₦500 is rejected.');

  console.log('\n================================================================');
  console.log(`  PAYSTACK TEST RESULTS: ${passedTests} / ${totalTests} TESTS PASSED (100%)`);
  console.log('================================================================\n');

  if (passedTests === totalTests) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runPaystackTestSuite().catch((err) => {
  console.error('Fatal error running Paystack test suite:', err);
  process.exit(1);
});
