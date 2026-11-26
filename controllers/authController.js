import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { User } from '../models/User.js';
import { Notification } from '../models/Notification.js';
import { logAudit } from '../services/auditService.js';
import { sendVerificationEmail, sendPasswordResetEmail } from '../services/emailService.js';

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET || 'tickapp_jwt_super_secret_key_2026_production', {
    expiresIn: '30d',
  });
};

// @desc    Register a new user
// @route   POST /api/auth/register
// @access  Public
export const register = async (req, res) => {
  try {
    const { firstName, lastName, email, phone, password, confirmPassword, acceptedTerms } = req.body;

    if (!firstName || !lastName || !email || !phone || !password) {
      return res.status(400).json({ success: false, message: 'All fields are required.' });
    }

    // Strict validation for Terms & Conditions acceptance
    if (acceptedTerms !== true && acceptedTerms !== 'true') {
      return res.status(400).json({
        success: false,
        message: 'You must read and accept the Terms and Conditions to complete your registration.',
      });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'Passwords do not match.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters long.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const existingUser = await User.findOne({ email: cleanEmail });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'An account with this email already exists.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Generate 6-digit verification code with 24-hour expiration
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    const verificationCodeExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Initial user account is active as an attendee, requiring only Gmail email verification
    const user = await User.create({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: cleanEmail,
      phone: phone.trim(),
      passwordHash,
      role: 'USER',
      status: 'APPROVED',
      organizerStatus: 'NOT_REQUESTED',
      balance: 0,
      emailVerified: false,
      verificationCode,
      verificationCodeExpires,
      acceptedTerms: true,
      acceptedTermsAt: new Date(),
      avatar: {
        url: `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(firstName.trim() + ' ' + lastName.trim())}`,
        publicId: '',
      },
    });

    // Send verification email via Gmail / SMTP with fallback
    let mailResult = { success: false };
    try {
      mailResult = await sendVerificationEmail({
        to: user.email,
        name: user.firstName,
        verificationCode,
        req,
      });
    } catch (mailError) {
      console.error('[Register] Notice: Verification email sending encountered an error:', mailError.message);
    }

    // Create welcoming notification
    await Notification.create({
      userId: user._id,
      title: 'Welcome to Tickza! 🎉',
      message: 'Your account is ready. Discover exciting live concerts, festivals, conferences, and entertainment passes.',
      type: 'ACCOUNT_CREATED',
    });

    await logAudit({
      actorId: user._id,
      actorName: `${user.firstName} ${user.lastName}`,
      actorRole: 'USER',
      action: 'USER_REGISTERED',
      targetType: 'USER',
      targetId: user._id,
      req,
    });

    return res.status(201).json({
      success: true,
      requiresVerification: true,
      emailSent: mailResult?.success && !mailResult?.simulated,
      simulated: Boolean(mailResult?.simulated),
      message: mailResult?.success && !mailResult?.simulated
        ? 'Account created! A 6-digit confirmation code has been sent to your email.'
        : 'Account created! Please enter the 6-digit verification code to activate your account.',
      email: user.email,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        status: user.status,
        organizerStatus: user.organizerStatus,
        emailVerified: false,
        acceptedTerms: user.acceptedTerms,
      },
    });
  } catch (error) {
    console.error('[Register Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Verify email with 6-digit OTP code or link
// @route   POST /api/auth/verify-email
// @access  Public
export const verifyEmail = async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ success: false, message: 'Email and verification code are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanCode = code.toString().trim();

    const user = await User.findOne({ email: cleanEmail });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Account not found with this email.' });
    }

    if (user.emailVerified) {
      const token = generateToken(user._id);
      return res.json({
        success: true,
        message: 'Your email is already verified.',
        token,
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phone: user.phone,
          role: user.role,
          status: user.status,
          organizerStatus: user.organizerStatus || 'NOT_REQUESTED',
          organizationName: user.organizationName || '',
          avatar: user.avatar,
          balance: user.balance,
          emailVerified: true,
        },
      });
    }

    if (!user.verificationCode || user.verificationCode !== cleanCode) {
      return res.status(400).json({
        success: false,
        message: 'Invalid verification code. Please check your email and enter the correct 6-digit code.',
      });
    }

    if (user.verificationCodeExpires && user.verificationCodeExpires < new Date()) {
      return res.status(400).json({
        success: false,
        message: 'Verification code has expired. Please request a new code.',
      });
    }

    // Successfully verified
    user.emailVerified = true;
    user.verificationCode = null;
    user.verificationCodeExpires = null;
    await user.save();

    await logAudit({
      actorId: user._id,
      actorName: `${user.firstName} ${user.lastName}`,
      actorRole: user.role,
      action: 'EMAIL_VERIFIED',
      targetType: 'USER',
      targetId: user._id,
      req,
    });

    const token = generateToken(user._id);

    return res.json({
      success: true,
      message: 'Email verified successfully! Welcome to Tickza.',
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        status: user.status,
        organizerStatus: user.organizerStatus || 'NOT_REQUESTED',
        organizationName: user.organizationName || '',
        avatar: user.avatar,
        balance: user.balance,
        emailVerified: true,
      },
    });
  } catch (error) {
    console.error('[Verify Email Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Resend email verification code
// @route   POST /api/auth/resend-verification
// @access  Public
export const resendVerification = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email address is required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: cleanEmail });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Account not found with this email.' });
    }

    if (user.emailVerified) {
      return res.json({ success: true, message: 'Your email address is already verified.' });
    }

    // Generate new code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    user.verificationCode = verificationCode;
    user.verificationCodeExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await user.save();

    await sendVerificationEmail({
      to: user.email,
      name: user.firstName,
      verificationCode,
      req,
    });

    return res.json({
      success: true,
      message: 'A new 6-digit verification code has been sent to your email.',
    });
  } catch (error) {
    console.error('[Resend Verification Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Authenticate user & get token
// @route   POST /api/auth/login
// @access  Public
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    const cleanEmail = (email || '').trim().toLowerCase();
    const user = await User.findOne({ email: cleanEmail, isDeleted: false });
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    if (user.status === 'SUSPENDED') {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_SUSPENDED',
        message: `Your account is suspended. Reason: ${user.suspensionReason || 'Contact support for assistance.'}`,
      });
    }

    // Check if email is verified
    if (!user.emailVerified) {
      // Regenerate verification code if expired or missing
      if (!user.verificationCode || (user.verificationCodeExpires && user.verificationCodeExpires < new Date())) {
        user.verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        user.verificationCodeExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await user.save();
        sendVerificationEmail({
          to: user.email,
          name: user.firstName,
          verificationCode: user.verificationCode,
          req,
        }).catch((e) => console.error('[Login Verification Email]', e.message));
      }

      return res.status(403).json({
        success: false,
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Please verify your email address to access your account.',
        email: user.email,
      });
    }

    const token = generateToken(user._id);

    return res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        status: user.status,
        organizerStatus: user.organizerStatus || 'NOT_REQUESTED',
        organizationName: user.organizationName || '',
        avatar: user.avatar,
        balance: user.balance,
        emailVerified: user.emailVerified,
      },
    });
  } catch (error) {
    console.error('[Login Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get current user profile
// @route   GET /api/auth/me
// @access  Private
export const getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-passwordHash');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    return res.json({
      success: true,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        status: user.status,
        organizerStatus: user.organizerStatus || 'NOT_REQUESTED',
        organizationName: user.organizationName || '',
        avatar: user.avatar,
        balance: user.balance,
        emailVerified: user.emailVerified,
        acceptedTerms: user.acceptedTerms,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Logout user
// @route   POST /api/auth/logout
// @access  Public
export const logout = async (req, res) => {
  return res.json({ success: true, message: 'Logged out successfully' });
};

// @desc    Update current user profile (name, phone)
// @route   PUT /api/auth/me
// @access  Private
export const updateMe = async (req, res) => {
  try {
    const { firstName, lastName, phone } = req.body;
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (firstName) user.firstName = firstName.trim();
    if (lastName) user.lastName = lastName.trim();
    if (phone) user.phone = phone.trim();
    await user.save();
    return res.json({
      success: true,
      message: 'Profile updated',
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        status: user.status,
        avatar: user.avatar,
        balance: user.balance,
        emailVerified: user.emailVerified,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Forgot Password Request
// @route   POST /api/auth/forgot-password
// @access  Public
export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email address is required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: cleanEmail, isDeleted: false });
    if (!user) {
      // Return generic success to prevent email enumeration
      return res.json({
        success: true,
        message: 'If an account with that email exists, password reset instructions have been sent.',
      });
    }

    // Generate secure random reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save();

    try {
      await sendPasswordResetEmail({
        to: user.email,
        name: user.firstName,
        resetToken,
        req,
      });
    } catch (mailError) {
      console.error('[Forgot Password] Mail Error:', mailError.message);
    }

    return res.json({
      success: true,
      message: 'Password reset link sent successfully. Please check your inbox.',
      resetToken: process.env.NODE_ENV === 'development' ? resetToken : undefined,
    });
  } catch (error) {
    console.error('[Forgot Password Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Reset Password
// @route   POST /api/auth/reset-password
// @access  Public
export const resetPassword = async (req, res) => {
  try {
    const { token, newPassword, confirmPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ success: false, message: 'Reset token and new password are required.' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'Passwords do not match.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters long.' });
    }

    // Find user with matching token and valid expiry
    let user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: new Date() },
    });

    // Fallback: check if token was JWT signed token
    if (!user) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'tickapp_jwt_super_secret_key_2026_production');
        user = await User.findById(decoded.id);
      } catch (jwtErr) {
        // Not a valid JWT either
      }
    }

    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired password reset link. Please request a new password reset.',
      });
    }

    const salt = await bcrypt.genSalt(10);
    user.passwordHash = await bcrypt.hash(newPassword, salt);
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    user.emailVerified = true;
    user.verificationCode = null;
    user.verificationCodeExpires = null;
    await user.save();

    await logAudit({
      actorId: user._id,
      actorName: `${user.firstName} ${user.lastName}`,
      actorRole: user.role,
      action: 'PASSWORD_RESET',
      targetType: 'USER',
      targetId: user._id,
      req,
    });

    return res.json({
      success: true,
      message: 'Password has been reset successfully. You can now log in with your new password.',
    });
  } catch (error) {
    console.error('[Reset Password Error]', error);
    return res.status(400).json({ success: false, message: 'Failed to reset password. Please try again.' });
  }
};

// @desc    Top up wallet balance (Buy Credit)
// @route   POST /api/auth/topup
// @access  Private
export const topUpBalance = async (req, res) => {
  try {
    const { amount } = req.body;
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Please enter a valid amount' });
    }
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    user.balance = (user.balance || 0) + numAmount;
    await user.save();

    await Notification.create({
      userId: user._id,
      title: 'Wallet Funded 💳',
      message: `Successfully added ₦${numAmount.toLocaleString()} to your Tickza wallet. New balance: ₦${(user.balance || 0).toLocaleString()}`,
      type: 'PAYMENT_RECEIVED',
    });

    await logAudit({
      actorId: user._id,
      actorName: `${user.firstName} ${user.lastName}`,
      actorRole: user.role,
      action: 'WALLET_TOPUP',
      targetType: 'USER',
      targetId: user._id,
      details: { amount: numAmount, newBalance: user.balance },
      req,
    });

    return res.json({
      success: true,
      message: `Added ₦${numAmount.toLocaleString()} to your balance`,
      balance: user.balance,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        status: user.status,
        avatar: user.avatar,
        balance: user.balance,
        emailVerified: user.emailVerified,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
