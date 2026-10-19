import express from 'express';
import { createOrder, getMyOrders, registerFreeEvent } from '../controllers/orderController.js';
import { verifyPayment } from '../controllers/paymentController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// @route   POST /api/orders          — Private: place a new ticket order
router.post('/', protect, createOrder);

// @route   POST /api/orders/verify-payment — Private: verify Paystack payment for an order
router.post('/verify-payment', protect, verifyPayment);

// @route   POST /api/orders/free-register — Private: register for a free event pass
router.post('/free-register', protect, registerFreeEvent);

// @route   GET  /api/orders/my-orders — Private: current user's orders
router.get('/my-orders', protect, getMyOrders);

export default router;
