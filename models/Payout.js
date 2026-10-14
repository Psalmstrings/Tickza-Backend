import mongoose from 'mongoose';

const payoutSchema = new mongoose.Schema(
  {
    organizerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      default: null,
    },
    // Financial breakdown
    grossRevenue: {
      type: Number,
      default: 0,
    },
    platformFee: {
      type: Number,
      default: 0,
    },
    processingFee: {
      type: Number,
      default: 0,
    },
    netAmount: {
      type: Number,
      default: 0,
    },
    // Payout details
    reference: {
      type: String,
      unique: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'PAID', 'FAILED'],
      default: 'PENDING',
      index: true,
    },
    bankAccount: {
      bankName: { type: String, default: '' },
      accountNumber: { type: String, default: '' }, // Masked
      accountName: { type: String, default: '' },
    },
    scheduledDate: {
      type: Date,
      default: null,
    },
    processedAt: {
      type: Date,
      default: null,
    },
    notes: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

export const Payout = mongoose.model('Payout', payoutSchema);
