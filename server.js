import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename  = fileURLToPath(import.meta.url);
const __dirname   = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '.env') });
dotenv.config(); // fallback to cwd .env if any

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import morgan from 'morgan';

import { connectDB } from './config/db.js';
import { initSocket } from './services/socketService.js';
import { seedAdmin } from './utils/seed.js';

// ── Route imports ─────────────────────────────────────────────────────────────
import authRoutes         from './routes/authRoutes.js';
import eventRoutes        from './routes/eventRoutes.js';
import ticketRoutes       from './routes/ticketRoutes.js';
import orderRoutes        from './routes/orderRoutes.js';
import transferRoutes     from './routes/transferRoutes.js';
import resaleRoutes       from './routes/resaleRoutes.js';
import adminRoutes        from './routes/adminRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import uploadRoutes       from './routes/uploadRoutes.js';
import organizerRoutes    from './routes/organizerRoutes.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT || 5000;
const CLIENT_URL  = process.env.CLIENT_URL || 'http://localhost:5173';
const NODE_ENV    = process.env.NODE_ENV || 'development';

// ── App & HTTP server ─────────────────────────────────────────────────────────
const app    = express();
const server = createServer(app);

// ── CORS Helper ───────────────────────────────────────────────────────────────
const allowedOrigins = [
  CLIENT_URL,
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://ticket-app-frontend.vercel.app',
];

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
};

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      callback(null, isAllowedOrigin(origin));
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
});
initSocket(io);

// ── Core Middleware ───────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS policy: origin ${origin} is not allowed.`));
    }
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

if (NODE_ENV !== 'test') {
  app.use(morgan(NODE_ENV === 'development' ? 'dev' : 'combined'));
}

// ── Static Uploads ────────────────────────────────────────────────────────────
// Serve locally stored uploads (fallback when Cloudinary is not configured)
const uploadsPath = path.join(__dirname, 'uploads');
app.use('/uploads', express.static(uploadsPath));

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'TickApp API is running',
    environment: NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/events',        eventRoutes);
app.use('/api/tickets',       ticketRoutes);
app.use('/api/orders',        orderRoutes);
app.use('/api/transfers',     transferRoutes);
app.use('/api/resale',        resaleRoutes);
app.use('/api/admin',         adminRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/upload',        uploadRoutes);
app.use('/api/organizer',     organizerRoutes);

// ── 404 Handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// ── Global Error Handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[Global Error Handler]', err.stack || err.message);

  // Multer errors (file upload)
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, message: 'File too large. Maximum size is 10MB.' });
  }
  if (err.message && err.message.includes('Only JPG, PNG')) {
    return res.status(400).json({ success: false, message: err.message });
  }

  // CORS error
  if (err.message && err.message.startsWith('CORS policy')) {
    return res.status(403).json({ success: false, message: err.message });
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({ success: false, message: messages.join(', ') });
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    return res.status(400).json({
      success: false,
      message: `Duplicate value for ${field}. Please use a different value.`,
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ success: false, message: 'Invalid token.' });
  }
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Token expired. Please log in again.' });
  }

  const statusCode = err.statusCode || err.status || 500;
  return res.status(statusCode).json({
    success: false,
    message: err.message || 'Internal Server Error',
    ...(NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await connectDB();

    // Seed the default admin user if none exists
    await seedAdmin();

    server.listen(PORT, () => {
      console.log(`\n🚀 TickApp server running on port ${PORT} [${NODE_ENV}]`);
      console.log(`   API:    http://localhost:${PORT}/api`);
      console.log(`   Health: http://localhost:${PORT}/api/health`);
      console.log(`   Client: ${CLIENT_URL}\n`);
    });
  } catch (error) {
    console.error('❌ Failed to start TickApp server:', error.message);
    process.exit(1);
  }
};

start();

export { app, server };
