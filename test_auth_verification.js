import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '.env') });
dotenv.config();

import { User } from './models/User.js';
import {
  register,
  verifyEmail,
  resendVerification,
  login,
  forgotPassword,
  resetPassword,
} from './controllers/authController.js';

function createMockReqRes({ body = {}, params = {}, query = {}, user = null } = {}) {
  const req = {
    body,
    params,
    query,
    user,
    ip: '127.0.0.1',
    headers: { 'user-agent': 'Tickza-Test-Agent' },
  };

  const res = {
    statusCode: 200,
    data: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.data = payload;
      return this;
    },
  };

  return { req, res };
}

async function runAuthSuite() {
  console.log('\n======================================================');
  console.log('🧪 TICKZA AUTHENTICATION, VERIFICATION & SECURITY SUITE');
  console.log('======================================================\n');

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI is missing in server/.env');
  }

  await mongoose.connect(mongoUri);
  console.log('✓ Connected to MongoDB Atlas.\n');

  const testEmail = `test_user_${Date.now()}@example.com`;
  const testPassword = 'Password123!';
  const testNewPassword = 'NewPassword456!';

  // Clean up any test user with this email
  await User.deleteMany({ email: testEmail });

  try {
    // -------------------------------------------------------------------
    // Test 1: Registration rejected when Terms & Conditions are not accepted
    // -------------------------------------------------------------------
    console.log('[Test 1] Registration requires Terms & Conditions acceptance...');
    {
      const { req, res } = createMockReqRes({
        body: {
          firstName: 'Chidi',
          lastName: 'Okeke',
          email: testEmail,
          phone: '+2348011223344',
          password: testPassword,
          confirmPassword: testPassword,
          acceptedTerms: false, // NOT ACCEPTED
        },
      });

      await register(req, res);
      if (res.statusCode !== 400 || !res.data?.message?.includes('Terms and Conditions')) {
        throw new Error(`Expected 400 rejection for missing Terms. Got: ${res.statusCode} ${JSON.stringify(res.data)}`);
      }
      console.log('✓ Correctly rejected registration without terms acceptance (400).\n');
    }

    // -------------------------------------------------------------------
    // Test 2: Successful registration with Terms & Conditions
    // -------------------------------------------------------------------
    console.log('[Test 2] Registration with Terms acceptance & verification code generation...');
    let userRecord = null;
    {
      const { req, res } = createMockReqRes({
        body: {
          firstName: 'Chidi',
          lastName: 'Okeke',
          email: testEmail,
          phone: '+2348011223344',
          password: testPassword,
          confirmPassword: testPassword,
          acceptedTerms: true, // ACCEPTED
        },
      });

      await register(req, res);
      if (res.statusCode !== 201 || !res.data?.requiresVerification) {
        throw new Error(`Expected 201 with requiresVerification: true. Got: ${res.statusCode} ${JSON.stringify(res.data)}`);
      }

      userRecord = await User.findOne({ email: testEmail });
      if (!userRecord) throw new Error('User not found in database after registration!');
      if (userRecord.emailVerified !== false) throw new Error('user.emailVerified must be false on registration!');
      if (!userRecord.verificationCode || userRecord.verificationCode.length !== 6) {
        throw new Error(`Invalid verificationCode: ${userRecord.verificationCode}`);
      }
      if (userRecord.acceptedTerms !== true) throw new Error('acceptedTerms should be true!');

      console.log(`✓ User created successfully with emailVerified: false and 6-digit code: ${userRecord.verificationCode}\n`);
    }

    // -------------------------------------------------------------------
    // Test 3: Login blocked for unverified email
    // -------------------------------------------------------------------
    console.log('[Test 3] Login attempt before verification is blocked...');
    {
      const { req, res } = createMockReqRes({
        body: {
          email: testEmail,
          password: testPassword,
        },
      });

      await login(req, res);
      if (res.statusCode !== 403 || res.data?.code !== 'EMAIL_NOT_VERIFIED') {
        throw new Error(`Expected 403 EMAIL_NOT_VERIFIED. Got: ${res.statusCode} ${JSON.stringify(res.data)}`);
      }
      console.log('✓ Login correctly blocked with code: EMAIL_NOT_VERIFIED (403).\n');
    }

    // -------------------------------------------------------------------
    // Test 4: Verification rejected with wrong code
    // -------------------------------------------------------------------
    console.log('[Test 4] Verification with invalid code is rejected...');
    {
      const { req, res } = createMockReqRes({
        body: {
          email: testEmail,
          code: '000000', // Invalid code
        },
      });

      await verifyEmail(req, res);
      if (res.statusCode !== 400 || !res.data?.message?.includes('Invalid verification code')) {
        throw new Error(`Expected 400 invalid code error. Got: ${res.statusCode} ${JSON.stringify(res.data)}`);
      }
      console.log('✓ Invalid code correctly rejected (400).\n');
    }

    // -------------------------------------------------------------------
    // Test 5: Successful email verification with valid 6-digit code
    // -------------------------------------------------------------------
    console.log('[Test 5] Verification with valid 6-digit code...');
    {
      const { req, res } = createMockReqRes({
        body: {
          email: testEmail,
          code: userRecord.verificationCode,
        },
      });

      await verifyEmail(req, res);
      if (res.statusCode !== 200 || !res.data?.token || !res.data?.user?.emailVerified) {
        throw new Error(`Verification failed. Got: ${res.statusCode} ${JSON.stringify(res.data)}`);
      }

      const refreshedUser = await User.findOne({ email: testEmail });
      if (refreshedUser.emailVerified !== true || refreshedUser.verificationCode !== null) {
        throw new Error('User record was not properly updated to emailVerified = true!');
      }
      console.log('✓ Email verified successfully! Token and verified user returned.\n');
    }

    // -------------------------------------------------------------------
    // Test 6: Login succeeds after email verification
    // -------------------------------------------------------------------
    console.log('[Test 6] Login succeeds after email verification...');
    {
      const { req, res } = createMockReqRes({
        body: {
          email: testEmail,
          password: testPassword,
        },
      });

      await login(req, res);
      if (res.statusCode !== 200 || !res.data?.token) {
        throw new Error(`Login failed for verified user. Got: ${res.statusCode} ${JSON.stringify(res.data)}`);
      }
      console.log('✓ Login successful for verified user (200).\n');
    }

    // -------------------------------------------------------------------
    // Test 7: Forgot password request
    // -------------------------------------------------------------------
    console.log('[Test 7] Forgot password request generates secure token...');
    let resetToken = null;
    {
      const { req, res } = createMockReqRes({
        body: {
          email: testEmail,
        },
      });

      await forgotPassword(req, res);
      if (res.statusCode !== 200) {
        throw new Error(`Forgot password failed. Got: ${res.statusCode} ${JSON.stringify(res.data)}`);
      }

      const userWithReset = await User.findOne({ email: testEmail });
      if (!userWithReset.resetPasswordToken || !userWithReset.resetPasswordExpires) {
        throw new Error('User does not have resetPasswordToken or resetPasswordExpires set!');
      }
      resetToken = userWithReset.resetPasswordToken;
      console.log(`✓ Forgot password processed, token stored in DB: ${resetToken.substring(0, 10)}...\n`);
    }

    // -------------------------------------------------------------------
    // Test 8: Reset password with token
    // -------------------------------------------------------------------
    console.log('[Test 8] Reset password with valid token...');
    {
      const { req, res } = createMockReqRes({
        body: {
          token: resetToken,
          newPassword: testNewPassword,
          confirmPassword: testNewPassword,
        },
      });

      await resetPassword(req, res);
      if (res.statusCode !== 200 || !res.data?.success) {
        throw new Error(`Reset password failed. Got: ${res.statusCode} ${JSON.stringify(res.data)}`);
      }

      const updatedUser = await User.findOne({ email: testEmail });
      if (updatedUser.resetPasswordToken !== null || updatedUser.resetPasswordExpires !== null) {
        throw new Error('Reset token was not cleared after password reset!');
      }

      // Check if new password matches hash
      const isMatch = await bcrypt.compare(testNewPassword, updatedUser.passwordHash);
      if (!isMatch) throw new Error('New password hash does not match testNewPassword!');
      console.log('✓ Password reset successfully! Token cleared and new hash persisted.\n');
    }

    // -------------------------------------------------------------------
    // Test 9: Login with new password
    // -------------------------------------------------------------------
    console.log('[Test 9] Login with new password...');
    {
      const { req, res } = createMockReqRes({
        body: {
          email: testEmail,
          password: testNewPassword,
        },
      });

      await login(req, res);
      if (res.statusCode !== 200 || !res.data?.token) {
        throw new Error(`Login with new password failed. Got: ${res.statusCode} ${JSON.stringify(res.data)}`);
      }
      console.log('✓ Successfully logged in with new password!\n');
    }

    // Clean up test user
    await User.deleteMany({ email: testEmail });
    console.log('✓ Cleaned up test user data.\n');

    console.log('======================================================');
    console.log('🎉 ALL 9 AUTH & SECURITY TESTS PASSED WITH 100% SUCCESS');
    console.log('======================================================\n');
  } finally {
    await mongoose.disconnect();
  }
}

runAuthSuite().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
