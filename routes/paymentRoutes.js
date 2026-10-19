import express from 'express';
import {
  initializeOrderPayment,
  verifyPayment,
  handlePaystackWebhook,
} from '../controllers/paymentController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// Public webhook route (signature verified internally)
router.post('/webhook', handlePaystackWebhook);

// Protected payment routes
router.post('/initialize', protect, initializeOrderPayment);
router.post('/verify', protect, verifyPayment);

export default router;
