import mongoose from 'mongoose';

const tutorialSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      unique: true,
    },
    iconType: {
      type: String,
      enum: ['GMAIL', 'MAPS', 'TELEGRAM', 'GENERAL'],
      default: 'GENERAL',
    },
    summary: {
      type: String,
      default: '',
    },
    content: {
      type: String,
      default: '',
    },
    externalUrl: {
      type: String,
      default: '',
    },
    order: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

export const Tutorial = mongoose.model('Tutorial', tutorialSchema);
