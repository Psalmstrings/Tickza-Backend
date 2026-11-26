import nodemailer from 'nodemailer';

/**
 * Clean and extract environment variables
 */
const getCleanEnv = () => {
  const user = (process.env.EMAIL_USER || '').trim().replace(/^["']|["']$/g, '');
  // Strip quotes and internal whitespace from passwords/keys
  const pass = (process.env.EMAIL_PASS || '').replace(/["'\s]/g, '');
  const service = (process.env.EMAIL_SERVICE || 'gmail').trim().replace(/^["']|["']$/g, '');
  const host = (process.env.EMAIL_HOST || 'smtp.gmail.com').trim().replace(/^["']|["']$/g, '');
  const port = process.env.EMAIL_PORT ? parseInt(process.env.EMAIL_PORT, 10) : 465;
  const secure = process.env.EMAIL_SECURE !== undefined
    ? (process.env.EMAIL_SECURE === 'true' || process.env.EMAIL_SECURE === true)
    : (port === 465);

  const resendApiKey = (process.env.RESEND_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  const brevoApiKey = (process.env.BREVO_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  const sendgridApiKey = (process.env.SENDGRID_API_KEY || '').trim().replace(/^["']|["']$/g, '');

  return {
    user,
    pass,
    service,
    host,
    port,
    secure,
    resendApiKey,
    brevoApiKey,
    sendgridApiKey,
  };
};

/**
 * Resolves the client URL dynamically from the incoming request or environment.
 * Ensures verification and password reset links never point to localhost in production.
 */
export const resolveClientUrl = (req) => {
  if (req) {
    const origin = req.get ? req.get('origin') : (req.headers && req.headers.origin);
    if (origin && typeof origin === 'string' && origin.startsWith('http')) {
      return origin.replace(/\/+$/, '');
    }
    const referer = req.get ? req.get('referer') : (req.headers && req.headers.referer);
    if (referer && typeof referer === 'string' && referer.startsWith('http')) {
      try {
        const u = new URL(referer);
        return u.origin;
      } catch (e) {}
    }
  }

  if (process.env.CLIENT_URL && process.env.CLIENT_URL.trim()) {
    const envUrl = process.env.CLIENT_URL.trim().replace(/\/+$/, '');
    if (!envUrl.includes('localhost') || process.env.NODE_ENV === 'development') {
      return envUrl;
    }
  }

  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
    return 'https://tickza.vercel.app';
  }

  return process.env.CLIENT_URL || 'http://localhost:5173';
};

const getFromAddress = () => {
  const { user } = getCleanEnv();
  if (process.env.EMAIL_FROM && process.env.EMAIL_FROM.includes('@')) {
    return process.env.EMAIL_FROM.replace(/"/g, '');
  }
  return `Tickza <${user || 'onboarding@resend.dev'}>`;
};

// ── HTTP API Transporters (Port 443 — Bypasses Cloud Host SMTP Port Blocks) ─────

const sendViaResend = async ({ apiKey, to, subject, html, text }) => {
  const fromAddress = process.env.EMAIL_FROM && !process.env.EMAIL_FROM.includes('gmail.com')
    ? process.env.EMAIL_FROM.replace(/"/g, '')
    : 'Tickza <onboarding@resend.dev>';

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress,
      to: [to],
      subject,
      html,
      text,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || data.error || `Resend Error (${response.status})`);
  }
  return { success: true, messageId: data.id, provider: 'Resend (HTTPS Port 443)' };
};

const sendViaBrevo = async ({ apiKey, to, subject, html, text }) => {
  const { user } = getCleanEnv();
  const senderEmail = user || 'no-reply@tickza.com';

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'Tickza', email: senderEmail },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || `Brevo Error (${response.status})`);
  }
  return { success: true, messageId: data.messageId, provider: 'Brevo (HTTPS Port 443)' };
};

const sendViaSendGrid = async ({ apiKey, to, subject, html, text }) => {
  const { user } = getCleanEnv();
  const senderEmail = user || 'no-reply@tickza.com';

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: senderEmail, name: 'Tickza' },
      subject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SendGrid Error (${response.status}): ${errorText}`);
  }
  return { success: true, provider: 'SendGrid (HTTPS Port 443)' };
};

// ── Standard SMTP Transporters (Nodemailer) ───────────────────────────────────

const getTransporters = () => {
  const { user, pass, service, host, port, secure } = getCleanEnv();

  if (!user || !pass) {
    return { primary: null, fallback: null };
  }

  let primary;
  if (service.toLowerCase() === 'gmail' && host === 'smtp.gmail.com') {
    primary = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 8000,
      greetingTimeout: 8000,
    });
  } else {
    primary = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 8000,
      greetingTimeout: 8000,
    });
  }

  const fallback = nodemailer.createTransport({
    host: host || 'smtp.gmail.com',
    port: 587,
    secure: false, // STARTTLS
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
  });

  return { primary, fallback };
};

/**
 * Verifies email service connectivity on application startup.
 */
export const verifyEmailTransporter = async () => {
  const { user, pass, resendApiKey, brevoApiKey, sendgridApiKey } = getCleanEnv();

  // 1. Check HTTP API providers first (Immune to Render SMTP port blocks)
  if (resendApiKey) {
    console.log('✓ [Email Service] Resend HTTPS API configured (Port 443). Active & port-block immune.');
    return true;
  }
  if (brevoApiKey) {
    console.log('✓ [Email Service] Brevo HTTPS API configured (Port 443). Active & port-block immune.');
    return true;
  }
  if (sendgridApiKey) {
    console.log('✓ [Email Service] SendGrid HTTPS API configured (Port 443). Active & port-block immune.');
    return true;
  }

  // 2. SMTP Check
  if (!user || !pass) {
    console.warn('\n⚠️  [Email Service] Notice: No email API key or SMTP credentials detected.');
    console.warn('   Emails will run in console SIMULATION mode until configured.\n');
    return false;
  }

  const { primary, fallback } = getTransporters();
  try {
    await primary.verify();
    console.log(`✓ [Email Service] Connected to SMTP service (${user}). Email delivery is ACTIVE.`);
    return true;
  } catch (primaryErr) {
    console.warn(`⚠️ [Email Service] Primary transport verification failed: ${primaryErr.message}`);
    try {
      await fallback.verify();
      console.log(`✓ [Email Service] Fallback STARTTLS transport (Port 587) verified successfully.`);
      return true;
    } catch (fallbackErr) {
      console.error(`✗ [Email Service] Fallback transport verification failed: ${fallbackErr.message}`);
      if (fallbackErr.message.includes('timeout') || fallbackErr.message.includes('ETIMEDOUT')) {
        console.warn('\n💡 [Email Tip] Outbound SMTP ports (465, 587) appear to be blocked by your host (e.g. Render Free plan).');
        console.warn('   To send emails without port blocks, add a free RESEND_API_KEY (from resend.com) or BREVO_API_KEY (from brevo.com) to your environment.\n');
      }
      return false;
    }
  }
};

/**
 * Master send email function with multi-tier delivery:
 * Tier 1: Resend HTTP API (Port 443)
 * Tier 2: Brevo HTTP API (Port 443)
 * Tier 3: SendGrid HTTP API (Port 443)
 * Tier 4: Primary Nodemailer SMTP
 * Tier 5: Fallback Nodemailer STARTTLS
 * Tier 6: Console simulation fallback
 */
export const sendMail = async ({ to, subject, html, text }) => {
  const { user, pass, resendApiKey, brevoApiKey, sendgridApiKey } = getCleanEnv();

  // Tier 1: Resend HTTPS API
  if (resendApiKey) {
    try {
      const res = await sendViaResend({ apiKey: resendApiKey, to, subject, html, text });
      console.log(`✓ [Email Sent] Message to ${to} sent via Resend API: ${res.messageId}`);
      return res;
    } catch (err) {
      console.error(`[Email Error] Resend API failed: ${err.message}. Trying next provider...`);
    }
  }

  // Tier 2: Brevo HTTPS API
  if (brevoApiKey) {
    try {
      const res = await sendViaBrevo({ apiKey: brevoApiKey, to, subject, html, text });
      console.log(`✓ [Email Sent] Message to ${to} sent via Brevo API: ${res.messageId}`);
      return res;
    } catch (err) {
      console.error(`[Email Error] Brevo API failed: ${err.message}. Trying next provider...`);
    }
  }

  // Tier 3: SendGrid HTTPS API
  if (sendgridApiKey) {
    try {
      const res = await sendViaSendGrid({ apiKey: sendgridApiKey, to, subject, html, text });
      console.log(`✓ [Email Sent] Message to ${to} sent via SendGrid API`);
      return res;
    } catch (err) {
      console.error(`[Email Error] SendGrid API failed: ${err.message}. Trying next provider...`);
    }
  }

  // Tier 4 & 5: Nodemailer SMTP
  const { primary, fallback } = getTransporters();

  if (!primary) {
    console.log('\n======================================================');
    console.log('✉️  [EMAIL SIMULATION] No email credentials detected in environment');
    console.log(`To:      ${to}`);
    console.log(`Subject: ${subject}`);
    console.log('------------------------------------------------------');
    console.log(text || 'HTML Email Body (Check browser or API response)');
    console.log('======================================================\n');
    return { success: true, simulated: true };
  }

  const mailOptions = {
    from: getFromAddress(),
    to,
    subject,
    text,
    html,
  };

  try {
    const info = await primary.sendMail(mailOptions);
    console.log(`✓ [Email Sent] Message to ${to} sent successfully via SMTP: ${info.messageId}`);
    return { success: true, messageId: info.messageId, simulated: false };
  } catch (primaryError) {
    console.warn(`[Email Notice] Primary SMTP to ${to} failed: ${primaryError.message}. Trying fallback port 587...`);

    try {
      const info = await fallback.sendMail(mailOptions);
      console.log(`✓ [Email Sent - Fallback] Message to ${to} sent via fallback: ${info.messageId}`);
      return { success: true, messageId: info.messageId, simulated: false, viaFallback: true };
    } catch (fallbackError) {
      console.error(`✗ [Email Error] Both primary and fallback SMTP to ${to} failed.`);
      console.error(`   Primary error:  ${primaryError.message}`);
      console.error(`   Fallback error: ${fallbackError.message}`);
      throw fallbackError;
    }
  }
};

/**
 * Send 6-Digit Email Verification Code & Link
 */
export const sendVerificationEmail = async ({ to, name, verificationCode, verificationLink, req }) => {
  const clientUrl = verificationLink ? null : resolveClientUrl(req);
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
export const sendPasswordResetEmail = async ({ to, name, resetToken, resetLink, req }) => {
  const clientUrl = resetLink ? null : resolveClientUrl(req);
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
