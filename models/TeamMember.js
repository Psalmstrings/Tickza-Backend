import mongoose from 'mongoose';

const teamMemberSchema = new mongoose.Schema(
  {
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      default: null, // null = all organizer events
      index: true,
    },
    organizerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null, // null if not yet registered
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    firstName: {
      type: String,
      default: '',
    },
    lastName: {
      type: String,
      default: '',
    },
    role: {
      type: String,
      enum: ['OWNER', 'MANAGER', 'CHECKIN_STAFF', 'FINANCE', 'MARKETING'],
      default: 'CHECKIN_STAFF',
    },
    status: {
      type: String,
      enum: ['PENDING', 'ACTIVE', 'SUSPENDED', 'REMOVED'],
      default: 'PENDING',
    },
    invitedAt: {
      type: Date,
      default: Date.now,
    },
    acceptedAt: {
      type: Date,
      default: null,
    },
    // What this member can access
    permissions: {
      viewEvents: { type: Boolean, default: true },
      editEvents: { type: Boolean, default: false },
      viewTickets: { type: Boolean, default: true },
      manageTickets: { type: Boolean, default: false },
      viewAttendees: { type: Boolean, default: true },
      checkIn: { type: Boolean, default: false },
      viewOrders: { type: Boolean, default: false },
      viewAnalytics: { type: Boolean, default: false },
      viewPayouts: { type: Boolean, default: false },
      managePromos: { type: Boolean, default: false },
      manageTeam: { type: Boolean, default: false },
    },
  },
  {
    timestamps: true,
  }
);

// A user can only be in a team once per organizer
teamMemberSchema.index({ organizerId: 1, email: 1 }, { unique: true });

export const TeamMember = mongoose.model('TeamMember', teamMemberSchema);
