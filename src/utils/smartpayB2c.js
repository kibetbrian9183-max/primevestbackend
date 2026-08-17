const axios = require("axios");
const config = require("../config");

/**
 * B2C needs the normal Bearer API key PLUS the dashboard login as a second
 * factor (X-Username / X-Password). Unlike the API key, these never go
 * anywhere near client-side code — this file is backend-only.
 */
function b2cHeaders() {
  return {
    Authorization: `Bearer ${config.smartpay.apiKey}`,
    "X-Username": config.smartpay.username,
    "X-Password": config.smartpay.password,
  };
}

/**
 * Queues a payout. Returns SmartPay's reference immediately — a 202 here
 * means "accepted and sent to Safaricom", not "money delivered". Callers
 * must poll getPayoutStatus() (or re-check later) to learn the real
 * outcome: COMPLETED, FAILED, TIMED_OUT, or REVERSED.
 */
async function sendPayout(phone, amountKes) {
  const { data } = await axios.post(
    `${config.smartpay.baseUrl}/b2c/send`,
    { phone, amount: amountKes },
    { headers: b2cHeaders() }
  );
  return data; // { success, reference, withdrawal_id, conversation_id, fee, status, ... }
}

/** Polls a previously-queued payout for its current/final status. */
async function getPayoutStatus(reference) {
  const { data } = await axios.get(
    `${config.smartpay.baseUrl}/b2c/${encodeURIComponent(reference)}`,
    { headers: b2cHeaders() }
  );
  return data; // { success, status, response_description, transaction_id, ... }
}

module.exports = { sendPayout, getPayoutStatus };
