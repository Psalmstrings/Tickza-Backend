import mongoose from 'mongoose';

const ticketHistorySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      enum: ['ISSUED', 'TRANSFERRED', 'LISTED_RESALE', 'RESOLD', 'CHECKED_IN', 'CANCELLED'],
      required: true,
    },
    fromUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    toUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    timestamp: { type: Date, default: Date.now },
    notes: { type: String, default: '' },
  },
  { _id: false }
);

const ticketSchema = new mongoose.Schema(
  {
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
      index: true,
    },
    ticketTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TicketType',
      required: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      index: true,
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    ticketNumber: {
      type: String,
      unique: true,
      index: true,
    },
    section: {
      type: String,
      default: 'General',
    },
    row: {
      type: String,
      default: 'GA',
    },
    seat: {
      type: String,
      default: 'Open',
    },
    price: {
      type: Number,
      required: true,
      default: 0,
    },
    currency: {
      type: String,
      default: 'NGN',
    },
    format: {
      type: String,
      enum: ['INDIVIDUAL', 'GROUP_BUNDLE', 'RESERVED_TABLE', 'CUSTOM'],
      default: 'INDIVIDUAL',
    },
    admittedCapacity: {
      type: Number,
      default: 1, // Number of attendees this physical ticket admits
    },
    attendeesCheckedIn: {
      type: Number,
      default: 0, // For group/table tickets supporting partial scan
    },
    passIndex: {
      type: Number,
      default: 1, // e.g., Attendee #1 of 5
    },
    parentTicketId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ticket',
      default: null, // If split into individual sub-passes
    },
    tableNumber: {
      type: String,
      default: '',
    },
    benefits: {
      type: [String],
      default: [],
    },
    qrToken: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    status: {
      type: String,
      enum: [
        'AVAILABLE',
        'RESERVED',
        'SOLD',
        'TRANSFER_PENDING',
        'TRANSFERRED',
        'LISTED',
        'USED',
        'PARTIALLY_USED',
        'CANCELLED',
        'REFUNDED',
      ],
      default: 'SOLD',
      index: true,
    },
    transferable: {
      type: Boolean,
      default: true,
    },
    resellable: {
      type: Boolean,
      default: true,
    },
    checkedInAt: {
      type: Date,
    },
    checkedInBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    history: [ticketHistorySchema],
  },
  {
    timestamps: true,
  }
);

export const Ticket = mongoose.model('Ticket', ticketSchema);
