import mongoose from 'mongoose';

const imageSchema = new mongoose.Schema(
  {
    url: { type: String, default: '' },
    publicId: { type: String, default: '' },
    width: { type: Number },
    height: { type: Number },
  },
  { _id: false }
);

const eventSchema = new mongoose.Schema(
  {
    organizerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: [true, 'Event title is required'],
      trim: true,
    },
    slug: {
      type: String,
      unique: true,
      index: true,
    },
    description: {
      type: String,
      default: '',
    },
    category: {
      type: String,
      default: 'Music',
    },
    coverImage: imageSchema,
    thumbnail: imageSchema,
    seatMap: imageSchema,
    additionalImages: [imageSchema],
    venue: {
      type: String,
      required: [true, 'Venue name is required'],
    },
    entranceInfo: {
      type: String,
      default: '',
    },
    address: {
      type: String,
      default: '',
    },
    latitude: {
      type: Number,
      default: null,
    },
    longitude: {
      type: Number,
      default: null,
    },
    startDate: {
      type: Date,
      required: [true, 'Start date is required'],
      index: true,
    },
    startTime: {
      type: String,
      default: '19:00',
    },
    endDate: {
      type: Date,
      default: null,
    },
    endTime: {
      type: String,
      default: '',
    },
    doorsOpen: {
      type: String,
      default: '',
    },
    timeAnnounced: {
      type: Boolean,
      default: true,
    },
    multiDay: {
      type: Boolean,
      default: false,
    },
    countdownEnabled: {
      type: Boolean,
      default: true,
    },
    status: {
      type: String,
      enum: ['DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'REJECTED', 'SUSPENDED', 'ENDED'],
      default: 'PUBLISHED',
      index: true,
    },
    featured: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

eventSchema.pre('save', function (next) {
  if (this.isModified('title') && !this.slug) {
    this.slug = this.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)+/g, '') + '-' + Date.now().toString(36);
  }
  next();
});

export const Event = mongoose.model('Event', eventSchema);
