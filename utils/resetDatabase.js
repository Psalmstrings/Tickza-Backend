/**
 * server/utils/resetDatabase.js
 *
 * Purges seed and transaction collections for fresh production provisioning.
 * Initializes only the configured Super Admin account using ADMIN_EMAIL and ADMIN_PASSWORD.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { connectDB } from '../config/db.js';
import { User } from '../models/User.js';
import { Event } from '../models/Event.js';
import { TicketType } from '../models/TicketType.js';
import { Ticket } from '../models/Ticket.js';
import { Order } from '../models/Order.js';
import { PromoCode } from '../models/PromoCode.js';
import { Notification } from '../models/Notification.js';
import { CheckIn } from '../models/CheckIn.js';
import { ResaleListing } from '../models/ResaleListing.js';
import { Transfer } from '../models/Transfer.js';
import { Payout } from '../models/Payout.js';
import { AuditLog } from '../models/AuditLog.js';
import { TeamMember } from '../models/TeamMember.js';

const SUPER_ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const SUPER_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SUPER_ADMIN_FIRST = process.env.ADMIN_FIRST || 'Super';
const SUPER_ADMIN_LAST = process.env.ADMIN_LAST || 'Admin';
const SUPER_ADMIN_PHONE = process.env.ADMIN_PHONE || '+2340000000000';

async function resetDB() {
  try {
    console.log('Connecting to database...');
    await connectDB();

    console.log('\n--- Purging collections ---');
    const eventRes = await Event.deleteMany({});
    console.log(`Deleted ${eventRes.deletedCount} events.`);

    const ttRes = await TicketType.deleteMany({});
    console.log(`Deleted ${ttRes.deletedCount} ticket types.`);

    const ticketRes = await Ticket.deleteMany({});
    console.log(`Deleted ${ticketRes.deletedCount} tickets.`);

    const orderRes = await Order.deleteMany({});
    console.log(`Deleted ${orderRes.deletedCount} orders.`);

    const promoRes = await PromoCode.deleteMany({});
    console.log(`Deleted ${promoRes.deletedCount} promo codes.`);

    const notifRes = await Notification.deleteMany({});
    console.log(`Deleted ${notifRes.deletedCount} notifications.`);

    const checkInRes = await CheckIn.deleteMany({});
    console.log(`Deleted ${checkInRes.deletedCount} check-ins.`);

    const resaleRes = await ResaleListing.deleteMany({});
    console.log(`Deleted ${resaleRes.deletedCount} resale listings.`);

    const transferRes = await Transfer.deleteMany({});
    console.log(`Deleted ${transferRes.deletedCount} transfers.`);

    const payoutRes = await Payout.deleteMany({});
    console.log(`Deleted ${payoutRes.deletedCount} payouts.`);

    const auditRes = await AuditLog.deleteMany({});
    console.log(`Deleted ${auditRes.deletedCount} audit logs.`);

    const teamRes = await TeamMember.deleteMany({});
    console.log(`Deleted ${teamRes.deletedCount} team members.`);

    const userRes = await User.deleteMany({});
    console.log(`Deleted ${userRes.deletedCount} existing users.`);

    if (SUPER_ADMIN_EMAIL && SUPER_ADMIN_PASSWORD) {
      console.log('\n--- Creating Super Admin from environment ---');
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(SUPER_ADMIN_PASSWORD, salt);

      const superAdmin = await User.create({
        firstName: SUPER_ADMIN_FIRST,
        lastName: SUPER_ADMIN_LAST,
        email: SUPER_ADMIN_EMAIL.toLowerCase(),
        phone: SUPER_ADMIN_PHONE,
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'APPROVED',
        emailVerified: true,
        acceptedTerms: true,
        acceptedTermsAt: new Date(),
        balance: 0,
        avatar: {
          url: `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(SUPER_ADMIN_FIRST + ' ' + SUPER_ADMIN_LAST)}`,
          publicId: '',
        },
      });

      console.log(`\n🎉 Super Admin successfully created:`);
      console.log(`   Email:    ${superAdmin.email}`);
      console.log(`   Role:     ${superAdmin.role}`);
      console.log(`   Status:   ${superAdmin.status}`);
      console.log(`   ID:       ${superAdmin._id}`);
    } else {
      console.log('\n--- Skipping Super Admin creation: Set ADMIN_EMAIL and ADMIN_PASSWORD in .env to create admin ---');
    }

    console.log('\n--- Final Verification ---');
    console.log('Events count:     ', await Event.countDocuments());
    console.log('Tickets count:    ', await Ticket.countDocuments());
    console.log('TicketTypes count:', await TicketType.countDocuments());
    console.log('Orders count:     ', await Order.countDocuments());
    console.log('Users count:      ', await User.countDocuments());
    const users = await User.find({}, 'email role status');
    console.log('Current users:    ', users);

    await mongoose.disconnect();
    console.log('\nDone!');
    process.exit(0);
  } catch (err) {
    console.error('Reset failed:', err);
    process.exit(1);
  }
}

resetDB();
