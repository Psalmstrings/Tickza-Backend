import nodemailer from 'nodemailer';

/**
 * Creates and returns the Nodemailer transporter.
 * Uses Gmail by default when EMAIL_USER and EMAIL_PASS are set.
 */
const getTransporter = () => {
  const user = (process.env.EMAIL_USER || '').trim();
  // Strip whitespace from Google App Passwords
  const pass = (process.env.EMAIL_PASS || '').replace(/\s+/g, '');

  if (!user || !pass) {
    return null;
  }

  // Gmail service configuration with robust connection settings
  return nodemailer.createTransport({
    service: 'gmail',
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user,
      pass,
    },
    tls: {
      rejectUnauthorized: false,
    },
  });
};

const getFromAddress = () => {
  const user = (process.env.EMAIL_USER || '').trim();
  if (process.env.EMAIL_FROM && process.env.EMAIL_FROM.includes('@')) {
    return process.env.EMAIL_FROM.replace(/"/g, '');
  }
  return `Tickza <${user || 'no-reply@tickza.com'}>`;
};

/**
 * Send an email with graceful fallback to console simulation in development/unconfigured environments.
 */
export const sendMail = async ({ to, subject, html, text }) => {
  const transporter = getTransporter();

  if (!transporter) {
    console.log('\n======================================================');
    console.log('✉️  [EMAIL SIMULATION] Gmail credentials not detected in .env');
    console.log(`To:      ${to}`);
    console.log(`Subject: ${subject}`);
    console.log('------------------------------------------------------');
    console.log(text || 'HTML Email Body (Check browser or API response)');
    console.log('======================================================\n');
    return { success: true, simulated: true };
  }

  try {
    const info = await transporter.sendMail({
      from: getFromAddress(),
      to,
      subject,
      text,
      html,
    });
    console.log(`[Email Sent] Message to ${to} sent successfully: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[Email Error] Failed to send email to ${to}:`, error.message);
    throw error;
  }
};

/**
 * Send 6-Digit Email Verification Code & Link
 */
export const sendVerificationEmail = async ({ to, name, verificationCode, verificationLink }) => {
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  const directLink = verificationLink || `${clientUrl}/verify-email?email=${encodeURIComponent(to)}&code=${verificationCode}`;

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Verify your Tickza account</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F3F7F8; margin: 0; padding: 24px; color: #111827; }
        .card { max-width: 540px; margin: 0 auto; background: #FFFFFF; border-radius: 16px; border: 1px solid #E5E7EB; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.05); }
        .header { background: #0B1025; padding: 32px 24px; text-align: center; }
        .logo-title { color: #FFFFFF; font-size: 24px; font-weight: 800; letter-spacing: -0.5px; margin: 0; }
        .logo-sub { color: #2457FF; font-weight: 800; }
        .body { padding: 36px 32px; }
        .greeting { font-size: 18px; font-weight: 700; margin: 0 0 12px; color: #111827; }
        .text { font-size: 14.5px; line-height: 1.6; color: #4B5563; margin: 0 0 24px; }
        .code-box { background: #F8FAFC; border: 2px dashed #2457FF; border-radius: 12px; padding: 20px; text-align: center; margin: 28px 0; }
        .code-label { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #64748B; margin-bottom: 8px; }
        .otp-code { font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #2457FF; font-family: monospace; }
        .btn-container { text-align: center; margin: 30px 0 20px; }
        .btn { display: inline-block; background-color: #2457FF; color: #FFFFFF !important; font-size: 15px; font-weight: 700; text-decoration: none; padding: 14px 32px; border-radius: 8px; box-shadow: 0 4px 12px rgba(36, 87, 255, 0.3); }
        .footer { background: #F8FAFC; padding: 20px 32px; text-align: center; font-size: 12px; color: #94A3B8; border-top: 1px solid #E5E7EB; }
        .expiry-note { font-size: 13px; color: #64748B; margin-top: 20px; text-align: center; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <h1 class="logo-title">TICK<span class="logo-sub">ZA</span></h1>
        </div>
        <div class="body">
          <p class="greeting">Hello ${name || 'there'},</p>
          <p class="text">
            Thank you for registering on <strong>Tickza</strong>. To complete your account registration and verify your email address, please use the 6-digit verification code below:
          </p>
          
          <div class="code-box">
            <div class="code-label">Your Verification Code</div>
            <div class="otp-code">${verificationCode}</div>
          </div>

          <p class="expiry-note">This code is valid for <strong>24 hours</strong>. Do not share this code with anyone.</p>

          <div class="btn-container">
            <a href="${directLink}" class="btn">Verify Email Address</a>
          </div>

          <p class="text" style="font-size: 12.5px; color: #64748B; margin-top: 28px;">
            Or copy and paste this URL into your browser:<br/>
            <a href="${directLink}" style="color: #2457FF; word-break: break-all;">${directLink}</a>
          </p>
        </div>
        <div class="footer">
          &copy; ${new Date().getFullYear()} Tickza Ticketing Platform. All rights reserved.<br/>
          If you didn't create a Tickza account, you can safely disregard this email.
        </div>
      </div>
    </body>
    </html>
  `;

  const text = `Hello ${name || 'there'},\n\nYour Tickza verification code is: ${verificationCode}\n\nVerify online: ${directLink}\n\nThis code expires in 24 hours.`;

  return sendMail({
    to,
    subject: `Verify your Tickza account: ${verificationCode}`,
    html,
    text,
  });
};

/**
 * Send Password Reset Link & Code
 */
export const sendPasswordResetEmail = async ({ to, name, resetToken, resetLink }) => {
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  const directLink = resetLink || `${clientUrl}/reset-password?token=${resetToken}&email=${encodeURIComponent(to)}`;

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Reset your Tickza password</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F3F7F8; margin: 0; padding: 24px; color: #111827; }
        .card { max-width: 540px; margin: 0 auto; background: #FFFFFF; border-radius: 16px; border: 1px solid #E5E7EB; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.05); }
        .header { background: #0B1025; padding: 32px 24px; text-align: center; }
        .logo-title { color: #FFFFFF; font-size: 24px; font-weight: 800; letter-spacing: -0.5px; margin: 0; }
        .logo-sub { color: #2457FF; font-weight: 800; }
        .body { padding: 36px 32px; }
        .greeting { font-size: 18px; font-weight: 700; margin: 0 0 12px; color: #111827; }
        .text { font-size: 14.5px; line-height: 1.6; color: #4B5563; margin: 0 0 24px; }
        .btn-container { text-align: center; margin: 30px 0 20px; }
        .btn { display: inline-block; background-color: #2457FF; color: #FFFFFF !important; font-size: 15px; font-weight: 700; text-decoration: none; padding: 14px 32px; border-radius: 8px; box-shadow: 0 4px 12px rgba(36, 87, 255, 0.3); }
        .footer { background: #F8FAFC; padding: 20px 32px; text-align: center; font-size: 12px; color: #94A3B8; border-top: 1px solid #E5E7EB; }
        .warning-box { background: #FEF3C7; border-left: 4px solid #F59E0B; padding: 14px; border-radius: 6px; font-size: 13px; color: #92400E; margin: 24px 0; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <h1 class="logo-title">TICK<span class="logo-sub">ZA</span></h1>
        </div>
        <div class="body">
          <p class="greeting">Hello ${name || 'there'},</p>
          <p class="text">
            We received a request to reset your password for your <strong>Tickza</strong> account. Click the button below to choose a new password:
          </p>

          <div class="btn-container">
            <a href="${directLink}" class="btn">Reset My Password</a>
          </div>

          <div class="warning-box">
            ⚠️ <strong>Security Notice:</strong> This password reset link will expire in <strong>1 hour</strong>. If you did not request a password reset, please ignore this email or change your password if you suspect unauthorized activity.
          </div>

          <p class="text" style="font-size: 12.5px; color: #64748B; margin-top: 24px;">
            Or copy and paste this URL into your browser:<br/>
            <a href="${directLink}" style="color: #2457FF; word-break: break-all;">${directLink}</a>
          </p>
        </div>
        <div class="footer">
          &copy; ${new Date().getFullYear()} Tickza Ticketing Platform. All rights reserved.
        </div>
      </div>
    </body>
    </html>
  `;

  const text = `Hello ${name || 'there'},\n\nWe received a request to reset your Tickza password.\nReset your password here: ${directLink}\n\nThis link expires in 1 hour. If you did not request this, please ignore this message.`;

  return sendMail({
    to,
    subject: 'Reset your Tickza account password',
    html,
    text,
  });
};
