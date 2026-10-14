import mongoose from 'mongoose';

const checkInSchema = new mongoose.Schema(
  {
    ticketId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ticket',
      required: true,
      index: true,
    },
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
      index: true,
    },
    staffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    checkInTime: {
      type: Date,
      default: Date.now,
    },
    status: {
      type: String,
      enum: ['VALID', 'DUPLICATE', 'INVALID', 'PARTIAL'],
      default: 'VALID',
    },
    attendeesAdmitted: {
      type: Number,
      default: 1, // Number admitted in this scan
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

export const CheckIn = mongoose.model('CheckIn', checkInSchema);
