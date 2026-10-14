/**
 * utils/seed.js
 *
 * Seeder for the default TickApp admin account.
 * Run standalone:  node utils/seed.js
 * Called on start: imported and invoked from server.js
 */

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { connectDB } from '../config/db.js';

const ADMIN_EMAIL     = 'admin@tickapp.com';
const ADMIN_PASSWORD  = 'Admin@1234';
const ADMIN_FIRST     = 'Admin';
const ADMIN_LAST      = 'TickApp';
const ADMIN_PHONE     = '+10000000000';

import { Event } from '../models/Event.js';
import { TicketType } from '../models/TicketType.js';

export const seedEvents = async (adminId) => {
  try {
    const count = await Event.countDocuments();
    if (count > 0) {
      console.log('[Seed] Events already exist — skipping event seeding.');
      return;
    }

    const sampleEvents = [
      {
        title: 'Taylor Swift | The Eras Tour',
        category: 'Concerts',
        venue: 'SoFi Stadium',
        address: 'Los Angeles, CA',
        description: 'The monumental career-spanning stadium tour celebration with Taylor Swift live on stage.',
        coverImage: { url: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=1200&auto=format&fit=crop&q=80' },
        startDate: new Date('2026-11-04T19:30:00Z'),
        startTime: '19:30',
        doorsOpen: '17:30',
        entranceInfo: 'Gate 4, North Plaza Entrance',
        featured: true,
        status: 'PUBLISHED',
        ticketTypes: [
          { name: 'Upper Reserved', price: 95, quantity: 200, section: 'Sec 500', row: 'A' },
          { name: 'Lower Bowl Club', price: 185, quantity: 150, section: 'Sec 112', row: 'C' },
          { name: 'Floor VIP Pass', price: 350, quantity: 50, section: 'Floor A', row: 'GA' },
        ],
      },
      {
        title: 'Coldplay - Music of the Spheres World Tour',
        category: 'Concerts',
        venue: 'Wembley Stadium',
        address: 'London, UK',
        description: 'Coldplay live in concert featuring spectacular visuals, LED wristbands, and timeless anthems.',
        coverImage: { url: 'https://images.unsplash.com/photo-1540039155733-5bb30b53aa14?w=1200&auto=format&fit=crop&q=80' },
        startDate: new Date('2026-10-15T19:00:00Z'),
        startTime: '19:00',
        doorsOpen: '17:00',
        entranceInfo: 'Turnstiles B & C, Olympic Way',
        featured: true,
        status: 'PUBLISHED',
        ticketTypes: [
          { name: 'General Pitch Standing', price: 75, quantity: 300, section: 'Pitch', row: 'GA' },
          { name: 'Level 1 Seating', price: 125, quantity: 200, section: 'Sec 104', row: 'F' },
          { name: 'VIP Infinity Lounge', price: 260, quantity: 40, section: 'VIP 1', row: 'A' },
        ],
      },
      {
        title: 'Burna Boy Live: No Sign of Weakness Tour',
        category: 'Concerts',
        venue: 'Tafawa Balewa Square (TBS)',
        address: 'Lagos, Nigeria',
        description: 'African Giant Burna Boy electrifies Lagos with an explosive live band and cultural celebration.',
        coverImage: { url: 'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=1200&auto=format&fit=crop&q=80' },
        startDate: new Date('2026-12-18T20:00:00Z'),
        startTime: '20:00',
        doorsOpen: '18:00',
        entranceInfo: 'Gate 2, Marina Road',
        featured: true,
        status: 'PUBLISHED',
        ticketTypes: [
          { name: 'Regular Entry', price: 40, quantity: 500, section: 'General', row: 'GA' },
          { name: 'VIP Front Terrace', price: 95, quantity: 150, section: 'VIP', row: 'GA' },
          { name: 'VVIP Premium Table', price: 250, quantity: 25, section: 'VVIP', row: 'T-1' },
        ],
      },
      {
        title: 'NBA Finals 2026: Lakers vs Celtics',
        category: 'Sports',
        venue: 'Crypto.com Arena',
        address: 'Los Angeles, CA',
        description: 'The fiercest rivalry in sports history battles for the world championship Larry O\'Brien Trophy.',
        coverImage: { url: 'https://images.unsplash.com/photo-1546519638-68e109498ffc?w=1200&auto=format&fit=crop&q=80' },
        startDate: new Date('2026-06-12T18:30:00Z'),
        startTime: '18:30',
        doorsOpen: '16:30',
        entranceInfo: 'Star Plaza VIP Entrance',
        featured: true,
        status: 'PUBLISHED',
        ticketTypes: [
          { name: 'Upper Concourse', price: 110, quantity: 150, section: 'Sec 318', row: 'B' },
          { name: 'Lower Concourse Prime', price: 275, quantity: 80, section: 'Sec 102', row: 'D' },
          { name: 'Courtside Row 1', price: 850, quantity: 20, section: 'Courtside', row: '1' },
        ],
      },
      {
        title: 'Premier League: Arsenal vs Manchester City',
        category: 'Sports',
        venue: 'Emirates Stadium',
        address: 'London, UK',
        description: 'Crucial title race clash in the world\'s most thrilling football league.',
        coverImage: { url: 'https://images.unsplash.com/photo-1508098682722-e99c43a406b2?w=1200&auto=format&fit=crop&q=80' },
        startDate: new Date('2026-11-14T15:00:00Z'),
        startTime: '15:00',
        doorsOpen: '13:00',
        entranceInfo: 'Clock End Bridge Gate K',
        featured: false,
        status: 'PUBLISHED',
        ticketTypes: [
          { name: 'Standard Clock End', price: 65, quantity: 250, section: 'Sec 26', row: '12' },
          { name: 'East Stand Lower', price: 115, quantity: 100, section: 'Sec 09', row: '8' },
          { name: 'Club Level Executive', price: 290, quantity: 30, section: 'Club 72', row: '3' },
        ],
      },
      {
        title: 'Hamilton - An American Musical',
        category: 'Arts & Theater',
        venue: 'Richard Rodgers Theatre',
        address: 'New York, NY',
        description: 'Lin-Manuel Miranda\'s Pulitzer and Tony-winning revolutionary hip-hop musical.',
        coverImage: { url: 'https://images.unsplash.com/photo-1507676184212-d03ab07a01bf?w=1200&auto=format&fit=crop&q=80' },
        startDate: new Date('2026-10-20T19:00:00Z'),
        startTime: '19:00',
        doorsOpen: '18:15',
        entranceInfo: '226 W 46th St Main Doors',
        featured: true,
        status: 'PUBLISHED',
        ticketTypes: [
          { name: 'Rear Mezzanine', price: 89, quantity: 80, section: 'Rear Mezz', row: 'G' },
          { name: 'Front Mezzanine', price: 149, quantity: 60, section: 'Front Mezz', row: 'C' },
          { name: 'Orchestra Center', price: 235, quantity: 40, section: 'Orchestra', row: 'H' },
        ],
      },
      {
        title: 'The Lion King - The Broadway Musical',
        category: 'Arts & Theater',
        venue: 'Minskoff Theatre',
        address: 'New York, NY',
        description: 'Giraffes strut, birds swoop, gazelles leap: Experience Broadway\'s landmark musical.',
        coverImage: { url: 'https://images.unsplash.com/photo-1460723237483-7a6dc9d0b212?w=1200&auto=format&fit=crop&q=80' },
        startDate: new Date('2026-11-10T19:30:00Z'),
        startTime: '19:30',
        doorsOpen: '18:45',
        entranceInfo: '200 W 45th St, Broadway',
        featured: false,
        status: 'PUBLISHED',
        ticketTypes: [
          { name: 'Balcony', price: 79, quantity: 90, section: 'Balcony', row: 'E' },
          { name: 'Mezzanine', price: 130, quantity: 70, section: 'Mezzanine', row: 'B' },
          { name: 'Orchestra Prime', price: 195, quantity: 50, section: 'Orchestra', row: 'F' },
        ],
      },
      {
        title: 'Disney On Ice: Find Your Hero',
        category: 'Family',
        venue: 'United Center',
        address: 'Chicago, IL',
        description: 'Mickey Mouse, Moana, Elsa, and all your favorite Disney heroes in a magical ice extravaganza.',
        coverImage: { url: 'https://images.unsplash.com/photo-1513151233558-d860c5398176?w=1200&auto=format&fit=crop&q=80' },
        startDate: new Date('2026-12-05T14:00:00Z'),
        startTime: '14:00',
        doorsOpen: '12:30',
        entranceInfo: 'South Atrium Gate 3',
        featured: true,
        status: 'PUBLISHED',
        ticketTypes: [
          { name: 'Family Upper Bowl', price: 35, quantity: 200, section: 'Sec 305', row: 'A' },
          { name: 'Lower Bowl Family Pass', price: 65, quantity: 120, section: 'Sec 114', row: 'D' },
          { name: 'Rinkside VIP Experience', price: 130, quantity: 30, section: 'Rinkside', row: '1' },
        ],
      },
      {
        title: 'Afro Nation Music Festival 2026',
        category: 'Concerts',
        venue: 'Eko Atlantic City',
        address: 'Lagos, Nigeria',
        description: 'The world\'s biggest beach celebration of Afrobeats, Amapiano, dancehall and culture.',
        coverImage: { url: 'https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=1200&auto=format&fit=crop&q=80' },
        startDate: new Date('2026-12-28T16:00:00Z'),
        startTime: '16:00',
        doorsOpen: '14:00',
        entranceInfo: 'Ocean Promenade Main Gate',
        featured: true,
        status: 'PUBLISHED',
        ticketTypes: [
          { name: '3-Day General Access', price: 60, quantity: 400, section: 'Beach Arena', row: 'GA' },
          { name: 'VIP Golden Circle', price: 140, quantity: 150, section: 'Golden Circle', row: 'VIP' },
          { name: 'VVIP Cabana Access', price: 380, quantity: 20, section: 'Cabana Deck', row: 'VIP' },
        ],
      },
    ];

    for (const evData of sampleEvents) {
      const { ticketTypes: types, ...eventFields } = evData;
      const event = await Event.create({
        ...eventFields,
        organizerId: adminId,
      });

      for (const t of types) {
        await TicketType.create({
          eventId: event._id,
          name: t.name,
          price: t.price,
          quantity: t.quantity,
          availableQuantity: t.quantity,
          section: t.section,
          row: t.row,
          transferable: true,
          resellable: true,
        });
      }
    }
    console.log(`✅ [Seed] Successfully seeded ${sampleEvents.length} realistic Ticketmaster events.`);
  } catch (err) {
    console.error('[Seed Events Error]', err.message);
  }
};

/**
 * Seed the default admin user and initial events.
 * Safe to call multiple times.
 */
export const seedAdmin = async () => {
  try {
    let admin = await User.findOne({
      $or: [
        { role: 'ADMIN' },
        { role: 'SUPER_ADMIN' },
        { email: ADMIN_EMAIL },
      ],
    });

    if (!admin) {
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, salt);

      admin = await User.create({
        firstName: ADMIN_FIRST,
        lastName: ADMIN_LAST,
        email: ADMIN_EMAIL,
        phone: ADMIN_PHONE,
        passwordHash,
        role: 'ADMIN',
        status: 'APPROVED',
        emailVerified: true,
        avatar: {
          url: `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(ADMIN_FIRST + ' ' + ADMIN_LAST)}`,
          publicId: '',
        },
      });

      console.log(`\n✅ [Seed] Default admin created:`);
      console.log(`   Email:    ${ADMIN_EMAIL}`);
      console.log(`   Password: ${ADMIN_PASSWORD}`);
      console.log(`   ID:       ${admin._id}\n`);
    } else {
      console.log('[Seed] Admin user already exists.');
    }

    // Seed events using admin ID
    await seedEvents(admin._id);
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
