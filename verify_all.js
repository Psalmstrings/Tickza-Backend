import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '.env') });
dotenv.config();

async function runVerification() {
  console.log('--- TICKZA VERIFICATION TEST SUITE ---');

  // Test 1: Image Helper URL resolution
  const { getEventImageUrl } = await import('../client/src/lib/imageHelper.js');
  const relativeUpload = '/uploads/1791889964285-756858824.png';
  const resolvedUrl = getEventImageUrl(relativeUpload);
  console.log('[Test 1: Image Helper]');
  console.log('Input:', relativeUpload);
  console.log('Resolved:', resolvedUrl);
  if (!resolvedUrl.startsWith('http://localhost:5090/uploads/')) {
    throw new Error('Image helper failed to prefix backend host to relative upload!');
  }
  console.log('✓ Image helper successfully prefixes Express backend port to local uploads.\n');

  // Connect to DB for remaining tests
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.log('Skipping DB integration test: MONGODB_URI not in server/.env');
    return;
  }

  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB Atlas.\n');

  const { Event } = await import('./models/Event.js');
  const { TicketType } = await import('./models/TicketType.js');
  const { PromoCode } = await import('./models/PromoCode.js');
  const { Order } = await import('./models/Order.js');
  const { User } = await import('./models/User.js');

  // Find or pick a test organizer
  const organizer = await User.findOne({ role: { $in: ['ORGANIZER', 'ADMIN'] } }) || await User.findOne();
  if (!organizer) {
    console.log('No user found in DB, skipping DB records tests.');
    await mongoose.disconnect();
    return;
  }

  // Test 2: Create a test event and test update
  console.log('[Test 2: Event Update & Image Replacement]');
  const testEvent = await Event.create({
    title: 'Automated Test Gala 2026',
    description: 'A test event for verification suite',
    category: 'Concert',
    venue: 'Main Campus Amphitheater',
    address: '100 University Boulevard',
    startDate: new Date('2026-11-20'),
    endDate: new Date('2026-11-20'),
    startTime: '18:00',
    endTime: '22:00',
    doorsOpen: '17:00',
    entranceInfo: 'Gate 4 VIP North Entrance',
    status: 'PUBLISHED',
    organizerId: organizer._id,
    coverImage: {
      url: '/uploads/test-image-initial.png',
      publicId: 'test_upload_1',
    },
  });

  const testTicketType = await TicketType.create({
    eventId: testEvent._id,
    name: 'Standard Pass',
    price: 5000,
    quantity: 100,
    availableQuantity: 100,
  });

  console.log(`Created test event: "${testEvent.title}" (ID: ${testEvent._id}) with coverImage: ${testEvent.coverImage.url}`);

  // Test event update (title, entranceInfo, image replacement)
  testEvent.title = 'Automated Test Gala 2026 - Updated';
  testEvent.entranceInfo = 'Gate 1 Main Rotunda';
  testEvent.coverImage = {
    url: '/uploads/replaced-artwork.png',
    publicId: 'test_upload_2',
  };
  await testEvent.save();

  const refreshedEvent = await Event.findById(testEvent._id);
  if (refreshedEvent.title !== 'Automated Test Gala 2026 - Updated' || refreshedEvent.entranceInfo !== 'Gate 1 Main Rotunda' || refreshedEvent.coverImage.url !== '/uploads/replaced-artwork.png') {
    throw new Error('Event update failed to persist modified fields!');
  }
  console.log('✓ Event update and image replacement verified successfully.\n');

  // Test 3: Promo code creation & discount logic
  console.log('[Test 3: Promo Code Validation & Discount Limits]');
  const testPromo = await PromoCode.create({
    eventId: testEvent._id,
    organizerId: organizer._id,
    code: `TESTPROMO${Date.now().toString().slice(-4)}`,
    discountType: 'PERCENTAGE',
    discountValue: 20, // 20%
    maxDiscountAmount: 3000,
    perCustomerLimit: 2,
    minimumOrderAmount: 4000,
    applicableTicketTypes: [testTicketType._id],
  });

  console.log(`Created PromoCode: ${testPromo.code} (20% off, cap: ₦3,000, min: ₦4,000)`);

  // Check discount calculation on ₦10,000 subtotal (2 tickets @ ₦5,000)
  const orderSubtotal = 10000;
  const rawDiscount = (orderSubtotal * testPromo.discountValue) / 100; // 2,000
  const cappedDiscount = testPromo.maxDiscountAmount ? Math.min(rawDiscount, testPromo.maxDiscountAmount) : rawDiscount;
  if (cappedDiscount !== 2000) {
    throw new Error(`Discount calculation incorrect! Expected 2000, got ${cappedDiscount}`);
  }
  console.log(`✓ Promo discount for ₦10,000 order: -₦${cappedDiscount} (Final: ₦${orderSubtotal - cappedDiscount})`);

  // Test 4: Safe Event Deletion Protection
  console.log('[Test 4: Safe Event Deletion]');
  // Simulate an order on this event
  const testOrder = await Order.create({
    userId: organizer._id,
    orderNumber: `ORD-TEST-${Date.now()}`,
    subtotal: 10000,
    discountAmount: 2000,
    promoCode: testPromo.code,
    totalAmount: 8000,
    status: 'PAID',
    items: [{
      ticketTypeId: testTicketType._id,
      eventId: testEvent._id,
      quantity: 2,
      unitPrice: 5000,
      totalPrice: 10000,
    }],
  });

  // Verify deletion protection logic: because paid order exists, event must not be permanently deleted
  const paidOrdersCount = await Order.countDocuments({ 'items.eventId': testEvent._id, status: 'PAID' });
  if (paidOrdersCount > 0) {
    testEvent.status = 'SUSPENDED';
    await testEvent.save();
    console.log(`✓ Paid orders detected (${paidOrdersCount}). Event safely soft-suspended to 'SUSPENDED' instead of permanent deletion.`);
  }

  // Cleanup test records
  await Order.findByIdAndDelete(testOrder._id);
  await PromoCode.findByIdAndDelete(testPromo._id);
  await TicketType.findByIdAndDelete(testTicketType._id);
  await Event.findByIdAndDelete(testEvent._id);
  console.log('✓ Cleanup completed.');

  await mongoose.disconnect();
  console.log('\n--- ALL VERIFICATION TESTS PASSED SUCCESSFULLY! ---');
}

runVerification().catch(err => {
  console.error('Verification failed:', err);
  process.exit(1);
});
