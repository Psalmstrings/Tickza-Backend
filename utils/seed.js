/**
 * utils/seed.js
 *
 * Safe Super Admin initialization.
 * Reads solely from environment variables (ADMIN_EMAIL, ADMIN_PASSWORD).
 * Never hardcodes personal credentials or seed passwords into source control.
 */

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { connectDB } from '../config/db.js';

export const seedEvents = async () => {
  // No default seed events per production readiness requirements
};

/**
 * Seed the Super Admin user only if ADMIN_EMAIL and ADMIN_PASSWORD are provided.
 */
export const seedAdmin = async () => {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    // Gracefully skip seeding if no admin credentials are configured in .env
    return;
  }

  const adminFirst = process.env.ADMIN_FIRST || 'Super';
  const adminLast = process.env.ADMIN_LAST || 'Admin';
  const adminPhone = process.env.ADMIN_PHONE || '+2340000000000';

  try {
    let admin = await User.findOne({ email: adminEmail.toLowerCase() });

    if (!admin) {
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(adminPassword, salt);

      admin = await User.create({
        firstName: adminFirst,
        lastName: adminLast,
        email: adminEmail.toLowerCase(),
        phone: adminPhone,
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'APPROVED',
        emailVerified: true,
        acceptedTerms: true,
        acceptedTermsAt: new Date(),
        avatar: {
          url: `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(adminFirst + ' ' + adminLast)}`,
          publicId: '',
        },
      });

      console.log(`\n✅ [Seed] Configured Super Admin initialized from environment: ${adminEmail}\n`);
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
      if (!admin.emailVerified) {
        admin.emailVerified = true;
        updated = true;
      }
      if (updated) {
        await admin.save();
        console.log('[Seed] Super Admin permissions verified.');
      }
    }
  } catch (error) {
    if (error.code === 11000) {
      return;
    }
    console.error('[Seed Error]', error.message);
  }
};

// Standalone execution
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
