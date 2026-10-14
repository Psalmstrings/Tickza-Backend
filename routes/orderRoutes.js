import express from 'express';
import { createOrder, getMyOrders } from '../controllers/orderController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// @route   POST /api/orders          — Private: place a new (free) order
router.post('/', protect, createOrder);

// @route   GET  /api/orders/my-orders — Private: current user's orders
router.get('/my-orders', protect, getMyOrders);

export default router;
