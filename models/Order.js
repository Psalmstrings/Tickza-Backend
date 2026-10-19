import mongoose from 'mongoose';

const orderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    orderNumber: {
      type: String,
      unique: true,
      index: true,
    },
    subtotal: {
      type: Number,
      default: 0,
    },
    discountAmount: {
      type: Number,
      default: 0,
    },
    promoCode: {
      type: String,
      default: '',
    },
    totalAmount: {
      type: Number,
      required: true,
      default: 0,
    },
    status: {
      type: String,
      enum: ['PENDING', 'PAID', 'FREE_REGISTERED', 'CANCELLED', 'REFUNDED'],
      default: 'PAID', // In free mode, immediately marked PAID or FREE_REGISTERED
      index: true,
    },
    admissionType: {
      type: String,
      enum: ['PAID', 'FREE'],
      default: 'PAID',
      index: true,
    },
    paymentMethod: {
      type: String,
      default: 'FREE_CHECKOUT',
    },
    currency: {
      type: String,
      default: 'NGN',
    },
    paymentReference: {
      type: String,
      default: '',
      index: true,
    },
    paidAt: {
      type: Date,
      default: null,
    },
    commissionRate: {
      type: Number,
      default: 0,
    },
    commissionAmount: {
      type: Number,
      default: 0,
    },
    vendorShare: {
      type: Number,
      default: 0,
    },
    items: [
      {
        ticketTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'TicketType' },
        eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event' },
        format: { type: String, default: 'INDIVIDUAL' },
        admittedPerTicket: { type: Number, default: 1 },
        quantity: { type: Number, default: 1 }, // Number of packages or tickets
        totalAttendees: { type: Number, default: 1 }, // quantity * admittedPerTicket
        unitPrice: { type: Number, default: 0 },
        totalPrice: { type: Number, default: 0 },
      },
    ],
  },
  {
    timestamps: true,
  }
);

export const Order = mongoose.model('Order', orderSchema);
