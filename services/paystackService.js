import crypto from 'crypto';

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

const getSecretKey = () => process.env.PAYSTACK_SECRET_KEY || '';
const getPublicKey = () => process.env.PAYSTACK_PUBLIC_KEY || '';
const getCallbackUrl = () =>
  process.env.PAYSTACK_CALLBACK_URL || `${process.env.CLIENT_URL || 'http://localhost:5173'}/tickets/verify-payment`;

/**
 * Perform an authenticated request to the Paystack API
 */
async function paystackRequest(endpoint, options = {}) {
  const secretKey = getSecretKey();
  if (!secretKey) {
    throw new Error('PAYSTACK_SECRET_KEY is not configured in environment variables.');
  }

  const url = `${PAYSTACK_BASE_URL}${endpoint}`;
  const headers = {
    Authorization: `Bearer ${secretKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(options.headers || {}),
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMsg = data?.message || `Paystack request failed with status ${response.status}`;
    const error = new Error(errorMsg);
    error.statusCode = response.status;
    error.paystackData = data;
    throw error;
  }

  return data;
}

/**
 * 1. Initialize a transaction with Paystack
 * @param {Object} params
 * @param {string} params.email - Customer email
 * @param {number} params.amountInKobo - Amount in minor units (kobo)
 * @param {string} params.reference - Unique order/transaction reference
 * @param {string} [params.callbackUrl] - Custom callback redirect URL
 * @param {Object} [params.metadata] - Custom metadata (orderId, eventId, userId)
 */
export const initializeTransaction = async ({
  email,
  amountInKobo,
  reference,
  callbackUrl,
  metadata = {},
}) => {
  if (!email) throw new Error('Customer email is required for payment initialization.');
  if (!amountInKobo || amountInKobo <= 0) {
    throw new Error('Valid amount in kobo is required.');
  }
  if (!reference) throw new Error('Transaction reference is required.');

  const payload = {
    email,
    amount: Math.round(amountInKobo),
    reference,
    callback_url: callbackUrl || getCallbackUrl(),
    currency: 'NGN',
    metadata: {
      ...metadata,
      platform: 'Tickza Ticketing Platform',
    },
  };

  const result = await paystackRequest('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return {
    success: true,
    authorizationUrl: result.data?.authorization_url,
    accessCode: result.data?.access_code,
    reference: result.data?.reference,
  };
};

/**
 * 2. Verify a transaction with Paystack
 * @param {string} reference - The transaction reference to verify
 */
export const verifyTransaction = async (reference) => {
  if (!reference) throw new Error('Transaction reference is required for verification.');

  const result = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`, {
    method: 'GET',
  });

  const tx = result.data;
  return {
    success: result.status,
    isSuccessful: tx?.status === 'success',
    status: tx?.status,
    amount: tx?.amount, // In kobo
    currency: tx?.currency,
    reference: tx?.reference,
    paidAt: tx?.paid_at ? new Date(tx.paid_at) : null,
    channel: tx?.channel,
    gatewayResponse: tx?.gateway_response,
    fees: tx?.fees || 0, // Paystack fee in kobo
    customer: tx?.customer,
    metadata: tx?.metadata || {},
    rawData: tx,
  };
};

/**
 * 3. Verify Paystack Webhook Signature (HMAC SHA512)
 * @param {string} signature - Signature from 'x-paystack-signature' header
 * @param {string|Buffer} rawBody - Raw unparsed request body string
 */
export const verifyWebhookSignature = (signature, rawBody) => {
  if (!signature || !rawBody) return false;
  const secret = process.env.PAYSTACK_WEBHOOK_SECRET || getSecretKey();
  if (!secret) return false;

  const expectedSignature = crypto
    .createHmac('sha512', secret)
    .update(rawBody)
    .digest('hex');

  return signature === expectedSignature;
};

/**
 * 4. List supported Nigerian banks from Paystack
 */
export const listBanks = async () => {
  try {
    const result = await paystackRequest('/bank?country=nigeria&perPage=100', {
      method: 'GET',
    });
    return result.data || [];
  } catch (err) {
    console.warn('[Paystack listBanks Fallback]', err.message);
    // Return curated fallback list of top Nigerian commercial & digital banks
    return [
      { name: 'Access Bank', code: '044', slug: 'access-bank' },
      { name: 'Citibank Nigeria', code: '023', slug: 'citibank-nigeria' },
      { name: 'Ecobank Nigeria', code: '050', slug: 'ecobank-nigeria' },
      { name: 'Fidelity Bank', code: '070', slug: 'fidelity-bank' },
      { name: 'First Bank of Nigeria', code: '011', slug: 'first-bank-of-nigeria' },
      { name: 'First City Monument Bank (FCMB)', code: '214', slug: 'first-city-monument-bank' },
      { name: 'Guaranty Trust Bank (GTBank)', code: '058', slug: 'guaranty-trust-bank' },
      { name: 'Heritage Bank', code: '030', slug: 'heritage-bank' },
      { name: 'Keystone Bank', code: '082', slug: 'keystone-bank' },
      { name: 'Kuda Bank', code: '50211', slug: 'kuda-bank' },
      { name: 'Moniepoint MFB', code: '50515', slug: 'moniepoint-mfb' },
      { name: 'OPay Digital Services', code: '999992', slug: 'opay' },
      { name: 'PalmPay', code: '999991', slug: 'palmpay' },
      { name: 'Polaris Bank', code: '076', slug: 'polaris-bank' },
      { name: 'Providus Bank', code: '101', slug: 'providus-bank' },
      { name: 'Stanbic IBTC Bank', code: '221', slug: 'stanbic-ibtc-bank' },
      { name: 'Standard Chartered Bank', code: '068', slug: 'standard-chartered-bank' },
      { name: 'Sterling Bank', code: '232', slug: 'sterling-bank' },
      { name: 'SunTrust Bank', code: '100', slug: 'suntrust-bank' },
      { name: 'Titan Trust Bank', code: '102', slug: 'titan-trust-bank' },
      { name: 'Union Bank of Nigeria', code: '032', slug: 'union-bank-of-nigeria' },
      { name: 'United Bank for Africa (UBA)', code: '033', slug: 'united-bank-for-africa' },
      { name: 'Unity Bank', code: '215', slug: 'unity-bank' },
      { name: 'Wema Bank', code: '035', slug: 'wema-bank' },
      { name: 'Zenith Bank', code: '057', slug: 'zenith-bank' },
    ];
  }
};

/**
 * 5. Resolve a 10-digit NUBAN bank account number
 * @param {Object} params
 * @param {string} params.accountNumber - 10-digit NUBAN account number
 * @param {string} params.bankCode - 3 to 6-digit bank code
 */
export const resolveAccountNumber = async ({ accountNumber, bankCode }) => {
  if (!accountNumber || accountNumber.length !== 10) {
    throw new Error('A valid 10-digit NUBAN account number is required.');
  }
  if (!bankCode) {
    throw new Error('Bank code is required to verify account details.');
  }

  const endpoint = `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`;
  const result = await paystackRequest(endpoint, { method: 'GET' });

  return {
    success: true,
    accountNumber: result.data?.account_number,
    accountName: result.data?.account_name,
    bankId: result.data?.bank_id,
  };
};

/**
 * 6. Create a Transfer Recipient for vendor payouts
 * @param {Object} params
 * @param {string} params.name - Beneficiary account name
 * @param {string} params.accountNumber - NUBAN account number
 * @param {string} params.bankCode - Bank code
 * @param {string} [params.currency] - Defaults to NGN
 */
export const createTransferRecipient = async ({
  name,
  accountNumber,
  bankCode,
  currency = 'NGN',
}) => {
  if (!name) throw new Error('Account beneficiary name is required.');
  if (!accountNumber) throw new Error('Account number is required.');
  if (!bankCode) throw new Error('Bank code is required.');

  const payload = {
    type: 'nuban',
    name,
    account_number: accountNumber,
    bank_code: bankCode,
    currency,
  };

  const result = await paystackRequest('/transferrecipient', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return {
    success: true,
    recipientCode: result.data?.recipient_code,
    details: result.data?.details,
    recipientId: result.data?.id,
  };
};

/**
 * 7. Initiate a single Paystack Transfer (payout disburser)
 * @param {Object} params
 * @param {number} params.amountInKobo - Amount to transfer in minor units
 * @param {string} params.recipientCode - Paystack recipient code (e.g. RCP_...)
 * @param {string} params.reference - Unique internal payout reference
 * @param {string} [params.reason] - Transfer narration
 */
export const initiateTransfer = async ({
  amountInKobo,
  recipientCode,
  reference,
  reason = 'Tickza Event Earnings Payout',
}) => {
  if (!amountInKobo || amountInKobo <= 0) {
    throw new Error('Valid transfer amount in kobo is required.');
  }
  if (!recipientCode) {
    throw new Error('Paystack recipient code is required.');
  }
  if (!reference) {
    throw new Error('Unique payout reference is required.');
  }

  const payload = {
    source: 'balance',
    amount: Math.round(amountInKobo),
    recipient: recipientCode,
    reference,
    reason,
    currency: 'NGN',
  };

  const result = await paystackRequest('/transfer', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  const tx = result.data;
  return {
    success: true,
    transferCode: tx?.transfer_code,
    status: tx?.status, // 'pending', 'success', 'failed'
    reference: tx?.reference,
    amount: tx?.amount,
    id: tx?.id,
    transferredAt: tx?.createdAt,
  };
};

/**
 * 8. Verify a Transfer status
 * @param {string} referenceOrCode - Transfer reference or code
 */
export const verifyTransfer = async (referenceOrCode) => {
  if (!referenceOrCode) throw new Error('Transfer reference or code is required.');

  const result = await paystackRequest(`/transfer/verify/${encodeURIComponent(referenceOrCode)}`, {
    method: 'GET',
  });

  const tx = result.data;
  return {
    success: result.status,
    status: tx?.status, // 'success', 'pending', 'failed', 'reversed'
    transferCode: tx?.transfer_code,
    reference: tx?.reference,
    amount: tx?.amount,
    recipient: tx?.recipient,
    failures: tx?.failures,
  };
};

export default {
  initializeTransaction,
  verifyTransaction,
  verifyWebhookSignature,
  listBanks,
  resolveAccountNumber,
  createTransferRecipient,
  initiateTransfer,
  verifyTransfer,
};
