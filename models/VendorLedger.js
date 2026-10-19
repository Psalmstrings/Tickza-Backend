import mongoose from 'mongoose';

const vendorLedgerSchema = new mongoose.Schema(
  {
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      default: null,
      index: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      default: null,
      index: true,
    },
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PaymentTransaction',
      default: null,
      index: true,
    },
    payoutId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Payout',
      default: null,
      index: true,
    },
    type: {
      type: String,
      enum: [
        'TICKET_SALE_NET',        // Vendor share credited from ticket sale
        'PLATFORM_COMMISSION',    // Platform fee record
        'PAYOUT_RESERVED',        // Balance locked upon withdrawal request
        'PAYOUT_RELEASED',        // Reserved balance released if payout rejected/failed
        'PAYOUT_DISBURSED',       // Funds successfully settled to bank via Paystack
        'REFUND_DEDUCTION',       // Earnings deducted due to customer refund
        'COMMISSION_REVERSAL',    // Platform commission reversed on refund
        'ADMIN_ADJUSTMENT',       // Traceable audit adjustment
      ],
      required: true,
      index: true,
    },
    // Amount stored in minor units (kobo for NGN)
    amountKobo: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: 'NGN',
    },
    direction: {
      type: String,
      enum: ['CREDIT', 'DEBIT'],
      required: true,
    },
    classification: {
      type: String,
      enum: ['AVAILABLE', 'PENDING', 'RESERVED', 'SETTLED'],
      default: 'AVAILABLE',
      index: true,
    },
    // Running balance snapshot in kobo after this transaction (for auditing)
    balanceAfterKobo: {
      type: Number,
      required: true,
    },
    // Idempotency key to guarantee no transaction is posted twice
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

export const VendorLedger = mongoose.model('VendorLedger', vendorLedgerSchema);
