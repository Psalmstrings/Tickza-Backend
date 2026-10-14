import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';

export const protect = async (req, res, next) => {
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET || 'tickapp_jwt_super_secret_key_2026_production'
      );
      const user = await User.findById(decoded.id).select('-passwordHash');

      if (!user) {
        return res.status(401).json({ success: false, message: 'User not found' });
      }

      if (user.isDeleted) {
        return res.status(401).json({ success: false, message: 'Account has been removed' });
      }

      if (user.status === 'SUSPENDED') {
        return res.status(403).json({
          success: false,
          code: 'ACCOUNT_SUSPENDED',
          message: `Your account is suspended. Reason: ${user.suspensionReason || 'Contact support'}`,
        });
      }

      req.user = user;
      next();
    } catch (error) {
      console.error('[Auth Error]', error.message);
      return res.status(401).json({ success: false, message: 'Not authorized, token invalid or expired' });
    }
  }

  if (!token) {
    return res.status(401).json({ success: false, message: 'Not authorized, no token provided' });
  }
};

/**
 * CRITICAL PERMISSION RULE:
 * Only APPROVED users (or ADMIN) who are NOT suspended may create tickets,
 * create events, or transfer tickets.
 */
export const requireApproved = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  if (req.user.status === 'SUSPENDED') {
    return res.status(403).json({
      success: false,
      code: 'ACCOUNT_SUSPENDED',
      message: 'Account is suspended. You cannot perform this action.',
    });
  }

  // Admins always have access
  if (req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN') {
    return next();
  }

  if (req.user.status !== 'APPROVED') {
    return res.status(403).json({
      success: false,
      code: 'ACCOUNT_APPROVAL_REQUIRED',
      message: 'Your account is pending approval. You will be able to create events, create tickets, and transfer tickets once your account has been approved by an administrator.',
    });
  }

  next();
};

export const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({
      success: false,
      code: 'ADMIN_ACCESS_REQUIRED',
      message: 'Administrative privileges required for this action.',
    });
  }

  next();
};
