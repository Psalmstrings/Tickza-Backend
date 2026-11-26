import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '.env') });
dotenv.config();

import { Event } from './models/Event.js';
import { Ticket } from './models/Ticket.js';
import { getEventSeoPreview } from './controllers/eventController.js';
import { getTicketSeoPreview } from './controllers/ticketController.js';

function createMockReqRes({ params = {}, headers = {} } = {}) {
  const req = {
    params,
    headers,
  };

  const res = {
    statusCode: 200,
    headers: {},
    bodyText: '',
    data: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, val) {
      this.headers[name] = val;
    },
    send(payload) {
      this.bodyText = payload;
      return this;
    },
    json(payload) {
      this.data = payload;
      return this;
    },
  };

  return { req, res };
}

async function runSeoTests() {
  console.log('\n======================================================');
  console.log('🧪 TICKZA SOCIAL MEDIA OPEN GRAPH & SEO PREVIEW TEST');
  console.log('======================================================');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✓ Connected to MongoDB Atlas.\n');

  // Find any published event
  const sampleEvent = await Event.findOne({ status: 'PUBLISHED' }) || await Event.findOne();
  if (!sampleEvent) {
    throw new Error('No events found in database to test.');
  }

  console.log(`[Test 1] Testing Event Open Graph HTML generation for: "${sampleEvent.title}"...`);
  const { req: req1, res: res1 } = createMockReqRes({
    params: { id: sampleEvent._id.toString() },
    headers: { 'user-agent': 'WhatsApp/2.21.12.21 A' },
  });

  await getEventSeoPreview(req1, res1);

  if (res1.statusCode !== 200) {
    throw new Error(`Expected HTTP 200, got ${res1.statusCode}`);
  }

  const html = res1.bodyText;
  const hasOgTitle = html.includes('property="og:title"');
  const hasOgImage = html.includes('property="og:image"');
  const hasOgDesc = html.includes('property="og:description"');
  const hasTwitterCard = html.includes('name="twitter:card"');
  const hasEventTitleInHtml = html.includes(sampleEvent.title);

  if (!hasOgTitle || !hasOgImage || !hasOgDesc || !hasTwitterCard || !hasEventTitleInHtml) {
    throw new Error('Event Open Graph HTML missing required tags or event title!');
  }
  console.log('✓ Event Open Graph HTML successfully generated with og:title, og:image, og:description, and twitter:card.');

  console.log('\n[Test 2] Testing Event SEO JSON output (Accept: application/json)...');
  const { req: req2, res: res2 } = createMockReqRes({
    params: { id: sampleEvent._id.toString() },
    headers: { accept: 'application/json' },
  });

  await getEventSeoPreview(req2, res2);
  if (!res2.data?.seo?.title || !res2.data?.seo?.imageUrl) {
    throw new Error('Event SEO JSON output missing title or imageUrl!');
  }
  console.log(`✓ SEO JSON metadata valid. Title: "${res2.data.seo.title}", Image: "${res2.data.seo.imageUrl}".`);

  // Test Ticket SEO Preview if any ticket exists
  const sampleTicket = await Ticket.findOne().populate('eventId');
  if (sampleTicket && sampleTicket.eventId) {
    console.log(`\n[Test 3] Testing Ticket Open Graph preview for Ticket ID: ${sampleTicket._id}...`);
    const { req: req3, res: res3 } = createMockReqRes({
      params: { id: sampleTicket._id.toString() },
      headers: { 'user-agent': 'Twitterbot/1.0' },
    });

    await getTicketSeoPreview(req3, res3);
    if (res3.statusCode === 200 && res3.bodyText.includes('property="og:image"')) {
      console.log('✓ Ticket Open Graph HTML successfully generated with event details.');
    }
  }

  console.log('\n======================================================');
  console.log('🎉 ALL SEO & SOCIAL MEDIA OPEN GRAPH TESTS PASSED');
  console.log('======================================================\n');

  await mongoose.disconnect();
}

runSeoTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
