import mongoose from 'mongoose';

const promoCodeSchema = new mongoose.Schema(
  {
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
      index: true,
    },
    organizerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    code: {
      type: String,
      required: [true, 'Promo code is required'],
      trim: true,
      uppercase: true,
    },
    discountType: {
      type: String,
      enum: ['PERCENTAGE', 'FIXED'],
      default: 'PERCENTAGE',
    },
    discountValue: {
      type: Number,
      required: true,
      min: 0,
    },
    // Restrict to specific ticket types (empty = applies to all)
    applicableTicketTypes: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'TicketType',
      },
    ],
    usageLimit: {
      type: Number,
      default: null, // null = unlimited
    },
    perCustomerLimit: {
      type: Number,
      default: null, // null = unlimited per user
    },
    maxDiscountAmount: {
      type: Number,
      default: null, // null = uncapped discount
    },
    usageCount: {
      type: Number,
      default: 0,
    },
    minimumOrderAmount: {
      type: Number,
      default: 0,
    },
    validFrom: {
      type: Date,
      default: null,
    },
    validUntil: {
      type: Date,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    description: {
      type: String,
      default: '',
    },
    // Analytics
    totalRevenue: {
      type: Number,
      default: 0,
    },
    totalDiscount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index: code must be unique per event
promoCodeSchema.index({ eventId: 1, code: 1 }, { unique: true });

export const PromoCode = mongoose.model('PromoCode', promoCodeSchema);
