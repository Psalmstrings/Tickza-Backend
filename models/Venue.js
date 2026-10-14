import mongoose from 'mongoose';

const venueSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    address: {
      type: String,
      default: '',
    },
    city: {
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
    capacity: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

export const Venue = mongoose.model('Venue', venueSchema);
