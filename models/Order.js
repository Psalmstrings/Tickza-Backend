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
      enum: ['PENDING', 'PAID', 'CANCELLED', 'REFUNDED'],
      default: 'PAID', // In free mode, immediately marked PAID
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
