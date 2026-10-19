import mongoose from 'mongoose';

const payoutSchema = new mongoose.Schema(
  {
    organizerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    reference: {
      type: String,
      unique: true,
      required: true,
      index: true,
    },
    // Amount requested in minor units (kobo)
    amountKobo: {
      type: Number,
      required: true,
      min: 0,
    },
    feeKobo: {
      type: Number,
      default: 0,
      min: 0,
    },
    netAmountKobo: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: 'NGN',
    },
    status: {
      type: String,
      enum: [
        'REQUESTED',     // Submitted by vendor, awaiting review
        'UNDER_REVIEW',  // Under admin scrutiny
        'APPROVED',      // Approved by admin, queued for transfer
        'PROCESSING',    // Paystack transfer initiated
        'PAID',          // Verified successful transfer
        'REJECTED',      // Rejected by admin, funds restored
        'FAILED',        // Transfer failed, funds restored
        'CANCELLED',     // Cancelled prior to review
      ],
      default: 'REQUESTED',
      index: true,
    },
    // Verified Bank Account Information
    bankAccount: {
      bankName: { type: String, required: true },
      bankCode: { type: String, default: '' },
      accountNumberMasked: { type: String, required: true },
      accountName: { type: String, required: true },
      recipientCode: { type: String, default: '' }, // Paystack RCP_...
    },
    // Admin decision metadata
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    adminNotes: {
      type: String,
      default: '',
    },
    rejectionReason: {
      type: String,
      default: '',
    },
    // Paystack transfer tracking
    paystackTransferCode: {
      type: String,
      default: '',
      index: true,
    },
    paystackTransferReference: {
      type: String,
      default: '',
      index: true,
    },
    paystackTransferStatus: {
      type: String,
      default: '',
    },
    paystackFailures: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    processedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Virtual getters for Naira amounts (conversion from kobo)
payoutSchema.virtual('amountNaira').get(function () {
  return (this.amountKobo || 0) / 100;
});
payoutSchema.virtual('feeNaira').get(function () {
  return (this.feeKobo || 0) / 100;
});
payoutSchema.virtual('netAmountNaira').get(function () {
  return (this.netAmountKobo || 0) / 100;
});

// Backward compatibility properties
payoutSchema.virtual('netAmount').get(function () {
  return (this.netAmountKobo || 0) / 100;
});

payoutSchema.set('toJSON', { virtuals: true });
payoutSchema.set('toObject', { virtuals: true });

export const Payout = mongoose.model('Payout', payoutSchema);
