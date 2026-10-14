import QRCode from 'qrcode';
import crypto from 'crypto';

const QR_SECRET = process.env.JWT_SECRET || 'tickapp_qr_secret_salt_2026';

/**
 * Generate a cryptographically secure signed ticket QR token
 */
export const generateSecureQRToken = (ticketId, eventId, ownerId) => {
  const nonce = crypto.randomBytes(12).toString('hex');
  const payload = `${ticketId}:${eventId}:${ownerId}:${nonce}`;
  const signature = crypto
    .createHmac('sha256', QR_SECRET)
    .update(payload)
    .digest('hex');
  return `TICKAPP-V1.${Buffer.from(payload).toString('base64url')}.${signature.slice(0, 16)}`;
};

/**
 * Verify signed QR token
 */
export const verifySecureQRToken = (token) => {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'TICKAPP-V1') {
      return { valid: false, error: 'Invalid QR token format' };
    }
    const payload = Buffer.from(parts[1], 'base64url').toString();
    const signature = parts[2];
    const expectedSig = crypto
      .createHmac('sha256', QR_SECRET)
      .update(payload)
      .digest('hex')
      .slice(0, 16);

    if (signature !== expectedSig) {
      return { valid: false, error: 'QR signature mismatch or tampered token' };
    }

    const [ticketId, eventId, ownerId] = payload.split(':');
    return { valid: true, ticketId, eventId, ownerId };
  } catch (err) {
    return { valid: false, error: err.message };
  }
};

/**
 * Generate Data URL for QR Code image
 */
export const generateQRCodeDataURL = async (token) => {
  return await QRCode.toDataURL(token, {
    errorCorrectionLevel: 'H',
    margin: 2,
    scale: 8,
    color: {
      dark: '#1e1b4b',
      light: '#ffffff',
    },
  });
};
