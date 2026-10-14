/**
 * utils/seed.js
 *
 * Seeder for the Super Admin account.
 * Run standalone:  node utils/seed.js
 * Called on start: imported and invoked from server.js
 */

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { connectDB } from '../config/db.js';

const ADMIN_EMAIL     = process.env.ADMIN_EMAIL || 'psalmstringsdigital@gmail.com';
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD || 'Admin@1234';
const ADMIN_FIRST     = process.env.ADMIN_FIRST || 'Super';
const ADMIN_LAST      = process.env.ADMIN_LAST || 'Admin';
const ADMIN_PHONE     = process.env.ADMIN_PHONE || '+10000000000';

/**
 * Seed events - disabled (no seed events or tickets).
 */
export const seedEvents = async () => {
  // Seed events removed per user configuration
};

/**
 * Seed the Super Admin user.
 * Safe to call multiple times.
 */
export const seedAdmin = async () => {
  try {
    let admin = await User.findOne({ email: ADMIN_EMAIL });

    if (!admin) {
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, salt);

      admin = await User.create({
        firstName: ADMIN_FIRST,
        lastName: ADMIN_LAST,
        email: ADMIN_EMAIL,
        phone: ADMIN_PHONE,
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'APPROVED',
        emailVerified: true,
        avatar: {
          url: `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(ADMIN_FIRST + ' ' + ADMIN_LAST)}`,
          publicId: '',
        },
      });

      console.log(`\n✅ [Seed] Super Admin created:`);
      console.log(`   Email:    ${ADMIN_EMAIL}`);
      console.log(`   Role:     SUPER_ADMIN`);
      console.log(`   ID:       ${admin._id}\n`);
    } else {
      let updated = false;
      if (admin.role !== 'SUPER_ADMIN') {
        admin.role = 'SUPER_ADMIN';
        updated = true;
      }
      if (admin.status !== 'APPROVED') {
        admin.status = 'APPROVED';
        updated = true;
      }
      if (updated) {
        await admin.save();
        console.log('[Seed] Super Admin permissions updated to SUPER_ADMIN & APPROVED.');
      } else {
        console.log('[Seed] Super Admin already exists.');
      }
    }
  } catch (error) {
    if (error.code === 11000) {
      console.log('[Seed] Admin already exists (duplicate key) — skipping.');
      return;
    }
    console.error('[Seed Error]', error.message);
  }
};

// ── Standalone execution ──────────────────────────────────────────────────────
const isMain = process.argv[1]?.endsWith('seed.js');
if (isMain) {
  (async () => {
    try {
      await connectDB();
      await seedAdmin();
      console.log('[Seed] Done.');
      process.exit(0);
    } catch (err) {
      console.error('[Seed] Fatal error:', err.message);
      process.exit(1);
    }
  })();
}
