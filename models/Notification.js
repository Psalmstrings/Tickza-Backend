import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: [
        'ACCOUNT_CREATED',
        'ACCOUNT_APPROVED',
        'ACCOUNT_SUSPENDED',
        'TICKET_PURCHASED',
        'TRANSFER_SENT',
        'TRANSFER_ACCEPTED',
        'TRANSFER_RECEIVED',
        'RESALE_LISTED',
        'RESALE_SOLD',
        'CHECK_IN',
        'SYSTEM',
      ],
      default: 'SYSTEM',
    },
    read: {
      type: Boolean,
      default: false,
      index: true,
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

export const Notification = mongoose.model('Notification', notificationSchema);
