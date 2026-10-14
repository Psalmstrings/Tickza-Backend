import mongoose from 'mongoose';

const ticketTypeSchema = new mongoose.Schema(
  {
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Ticket type name is required'],
      trim: true,
    },
    description: {
      type: String,
      default: '',
    },
    format: {
      type: String,
      enum: ['INDIVIDUAL', 'GROUP_BUNDLE', 'RESERVED_TABLE', 'CUSTOM'],
      default: 'INDIVIDUAL',
      index: true,
    },
    admittedPerTicket: {
      type: Number,
      default: 1, // 1 for individual, 2+ for bundles/tables/groups
      min: 1,
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
    quantity: {
      type: Number,
      required: true,
      default: 100,
    },
    availableQuantity: {
      type: Number,
      required: true,
      default: 100,
    },
    section: {
      type: String,
      default: 'General',
    },
    row: {
      type: String,
      default: '',
    },
    benefits: {
      type: [String],
      default: [],
    },
    minPerOrder: {
      type: Number,
      default: 1,
      min: 1,
    },
    maxPerCustomer: {
      type: Number,
      default: null,
    },
    transferable: {
      type: Boolean,
      default: true,
    },
    resellable: {
      type: Boolean,
      default: true,
    },
    saleStartDate: {
      type: Date,
      default: null,
    },
    saleEndDate: {
      type: Date,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    visibility: {
      type: String,
      enum: ['PUBLIC', 'HIDDEN', 'INVITE_ONLY'],
      default: 'PUBLIC',
    },
    terms: {
      type: String,
      default: '',
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

export const TicketType = mongoose.model('TicketType', ticketTypeSchema);

