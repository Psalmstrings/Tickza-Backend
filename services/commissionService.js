import { PlatformSetting } from '../models/PlatformSetting.js';
import { VendorLedger } from '../models/VendorLedger.js';
import { User } from '../models/User.js';

// Default platform constants
const DEFAULT_COMMISSION_RATE = 10; // 10%
const DEFAULT_MIN_PAYOUT_KOBO = 200000; // ₦2,000 in kobo
const DEFAULT_FEE_BEARER = 'VENDOR'; // VENDOR or PLATFORM

/**
 * Get active platform financial settings
 */
export const getPlatformCommissionSettings = async () => {
  const [rateSetting, minPayoutSetting, feeBearerSetting] = await Promise.all([
    PlatformSetting.findOne({ key: 'platform_commission_rate' }),
    PlatformSetting.findOne({ key: 'minimum_payout_amount_kobo' }),
    PlatformSetting.findOne({ key: 'paystack_fee_bearer' }),
  ]);

  return {
    commissionRate: rateSetting ? Number(rateSetting.value) : DEFAULT_COMMISSION_RATE,
    minimumPayoutKobo: minPayoutSetting ? Number(minPayoutSetting.value) : DEFAULT_MIN_PAYOUT_KOBO,
    minimumPayoutNaira: minPayoutSetting ? Number(minPayoutSetting.value) / 100 : DEFAULT_MIN_PAYOUT_KOBO / 100,
    feeBearer: feeBearerSetting ? String(feeBearerSetting.value) : DEFAULT_FEE_BEARER,
  };
};

/**
 * Update platform financial settings (Admin only)
 */
export const updatePlatformCommissionSettings = async ({
  commissionRate,
  minimumPayoutNaira,
  feeBearer,
  adminId,
}) => {
  const numRate = Number(commissionRate);
  if (isNaN(numRate) || numRate < 0 || numRate > 50) {
    throw new Error('Platform commission rate must be between 0% and 50%.');
  }

  const numMinNaira = Number(minimumPayoutNaira);
  if (isNaN(numMinNaira) || numMinNaira < 500) {
    throw new Error('Minimum payout threshold must be at least ₦500.');
  }

  const minKobo = Math.round(numMinNaira * 100);

  await Promise.all([
    PlatformSetting.findOneAndUpdate(
      { key: 'platform_commission_rate' },
      {
        key: 'platform_commission_rate',
        value: numRate,
        category: 'financials',
        description: 'Percentage commission deducted on paid ticket sales',
      },
      { upsert: true, new: true }
    ),
    PlatformSetting.findOneAndUpdate(
      { key: 'minimum_payout_amount_kobo' },
      {
        key: 'minimum_payout_amount_kobo',
        value: minKobo,
        category: 'financials',
        description: 'Minimum vendor balance required to request a payout in kobo',
      },
      { upsert: true, new: true }
    ),
    PlatformSetting.findOneAndUpdate(
      { key: 'paystack_fee_bearer' },
      {
        key: 'paystack_fee_bearer',
        value: feeBearer === 'PLATFORM' ? 'PLATFORM' : 'VENDOR',
        category: 'financials',
        description: 'Designates whether vendor or platform absorbs gateway fees',
      },
      { upsert: true, new: true }
    ),
  ]);

  return {
    commissionRate: numRate,
    minimumPayoutKobo: minKobo,
    minimumPayoutNaira: numMinNaira,
    feeBearer: feeBearer === 'PLATFORM' ? 'PLATFORM' : 'VENDOR',
  };
};

/**
 * Calculate commission and net vendor earnings in minor units (kobo)
 */
export const calculateEarnings = ({ grossAmountNaira, commissionRate }) => {
  const grossKobo = Math.round((Number(grossAmountNaira) || 0) * 100);
  const rate = Number(commissionRate) || DEFAULT_COMMISSION_RATE;
  const commissionKobo = Math.round((grossKobo * rate) / 100);
  const vendorShareKobo = Math.max(0, grossKobo - commissionKobo);

  return {
    grossKobo,
    commissionKobo,
    vendorShareKobo,
    commissionRate: rate,
    grossNaira: grossKobo / 100,
    commissionNaira: commissionKobo / 100,
    vendorShareNaira: vendorShareKobo / 100,
  };
};

/**
 * Credit vendor for verified ticket sale using atomic ledger entry
 */
export const creditVendorForTicketSale = async ({
  vendorId,
  eventId,
  orderId,
  transactionId,
  grossAmountNaira,
  commissionRate,
  reference,
}) => {
  const { grossKobo, commissionKobo, vendorShareKobo, commissionRate: rate } = calculateEarnings({
    grossAmountNaira,
    commissionRate,
  });

  const idempotencyKey = `SALE-${reference || orderId}-${vendorId}`;

  // Check if ledger entry already posted
  const existingLedger = await VendorLedger.findOne({ idempotencyKey });
  if (existingLedger) {
    return existingLedger;
  }

  // Atomically credit vendor's balance
  const updatedVendor = await User.findByIdAndUpdate(
    vendorId,
    {
      $inc: {
        availableBalanceKobo: vendorShareKobo,
        balance: vendorShareKobo / 100,
      },
    },
    { new: true }
  );

  if (!updatedVendor) {
    throw new Error(`Vendor user ${vendorId} not found to credit earnings.`);
  }

  // Write immutable ledger entry
  const ledgerEntry = await VendorLedger.create({
    vendorId,
    eventId,
    orderId,
    transactionId,
    type: 'TICKET_SALE_NET',
    amountKobo: vendorShareKobo,
    currency: 'NGN',
    direction: 'CREDIT',
    classification: 'AVAILABLE',
    balanceAfterKobo: updatedVendor.availableBalanceKobo,
    idempotencyKey,
    description: `Net earnings from ticket sale (${rate}% platform commission deducted)`,
    metadata: {
      grossKobo,
      commissionKobo,
      commissionRate: rate,
      reference,
    },
  });

  return ledgerEntry;
};

/**
 * Atomically reserve vendor balance when payout is requested
 */
export const reserveVendorBalanceForPayout = async ({
  vendorId,
  amountKobo,
  payoutId,
  reference,
}) => {
  const idempotencyKey = `RESERVE-${payoutId}`;

  // Check if already reserved
  const existingLedger = await VendorLedger.findOne({ idempotencyKey });
  if (existingLedger) {
    return existingLedger;
  }

  // Atomically debit available balance and credit reserved balance
  // Only succeeds if availableBalanceKobo >= amountKobo
  const updatedVendor = await User.findOneAndUpdate(
    {
      _id: vendorId,
      availableBalanceKobo: { $gte: amountKobo },
    },
    {
      $inc: {
        availableBalanceKobo: -amountKobo,
        reservedBalanceKobo: amountKobo,
        balance: -(amountKobo / 100),
      },
    },
    { new: true }
  );

  if (!updatedVendor) {
    throw new Error('Insufficient available balance to process this payout request.');
  }

  const ledgerEntry = await VendorLedger.create({
    vendorId,
    payoutId,
    type: 'PAYOUT_RESERVED',
    amountKobo,
    currency: 'NGN',
    direction: 'DEBIT',
    classification: 'RESERVED',
    balanceAfterKobo: updatedVendor.availableBalanceKobo,
    idempotencyKey,
    description: `Funds reserved for payout request (${reference})`,
    metadata: { reference },
  });

  return ledgerEntry;
};

/**
 * Release reserved funds back to vendor's available balance (on rejection or failure)
 */
export const releaseVendorReservedBalance = async ({
  vendorId,
  amountKobo,
  payoutId,
  reason = 'Payout rejected or cancelled',
}) => {
  // Use a stable idempotency key so concurrent calls for the same payout cannot
  // double-credit the vendor's available balance.
  const reasonSlug = reason.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_]/g, '').slice(0, 32);
  const idempotencyKey = `RELEASE-${payoutId}-${reasonSlug}`;

  // Guard: if already released for this payout+reason combination, return early
  const existingLedger = await VendorLedger.findOne({ idempotencyKey });
  if (existingLedger) {
    return existingLedger;
  }

  // Atomically move from reserved back to available
  const updatedVendor = await User.findOneAndUpdate(
    {
      _id: vendorId,
      reservedBalanceKobo: { $gte: amountKobo },
    },
    {
      $inc: {
        availableBalanceKobo: amountKobo,
        reservedBalanceKobo: -amountKobo,
        balance: amountKobo / 100,
      },
    },
    { new: true }
  );

  if (!updatedVendor) {
    // Fallback: reserved balance already adjusted or insufficient — return null gracefully
    return null;
  }

  const ledgerEntry = await VendorLedger.create({
    vendorId,
    payoutId,
    type: 'PAYOUT_RELEASED',
    amountKobo,
    currency: 'NGN',
    direction: 'CREDIT',
    classification: 'AVAILABLE',
    balanceAfterKobo: updatedVendor.availableBalanceKobo,
    idempotencyKey,
    description: `Reserved funds released back to available balance. Reason: ${reason}`,
    metadata: { reason },
  });

  return ledgerEntry;
};

/**
 * Mark payout as disbursed after Paystack confirmation
 */
export const finalizeVendorPayoutDisbursed = async ({
  vendorId,
  amountKobo,
  payoutId,
  transferReference,
}) => {
  const idempotencyKey = `DISBURSED-${payoutId}`;

  const existingLedger = await VendorLedger.findOne({ idempotencyKey });
  if (existingLedger) {
    return existingLedger;
  }

  // Atomically clear the reserved balance
  const updatedVendor = await User.findOneAndUpdate(
    {
      _id: vendorId,
      reservedBalanceKobo: { $gte: amountKobo },
    },
    {
      $inc: {
        reservedBalanceKobo: -amountKobo,
      },
    },
    { new: true }
  );

  const ledgerEntry = await VendorLedger.create({
    vendorId,
    payoutId,
    type: 'PAYOUT_DISBURSED',
    amountKobo,
    currency: 'NGN',
    direction: 'DEBIT',
    classification: 'SETTLED',
    balanceAfterKobo: updatedVendor ? updatedVendor.availableBalanceKobo : 0,
    idempotencyKey,
    description: `Payout successfully disbursed to bank account via Paystack (${transferReference})`,
    metadata: { transferReference },
  });

  return ledgerEntry;
};

export default {
  getPlatformCommissionSettings,
  updatePlatformCommissionSettings,
  calculateEarnings,
  creditVendorForTicketSale,
  reserveVendorBalanceForPayout,
  releaseVendorReservedBalance,
  finalizeVendorPayoutDisbursed,
};
