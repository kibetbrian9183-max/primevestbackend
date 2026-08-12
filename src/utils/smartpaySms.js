const axios = require("axios");

const SMARTPAY_SMS_URL = "https://api.smartpaypesa.com/v1/sms/";

/**
 * Sends a single SMS via the SmartPay SMS API.
 * Docs: POST https://api.smartpaypesa.com/v1/sms/  (header: X-API-Key)
 * Accepts phone in 07XX / 01XX / 254XX format — no need to normalize first.
 *
 * Never throws on a delivery failure by default (SMS is a side effect —
 * we don't want a flaky SMS gateway to fail the underlying request, e.g.
 * a withdrawal getting marked paid). Pass `{ throwOnError: true }` for
 * flows where the SMS IS the point, like the OTP send.
 */
async function sendSms(phone, message, { throwOnError = false } = {}) {
  const apiKey = process.env.SMARTPAY_API_KEY;
  if (!apiKey) {
    console.warn("[smartpaySms] SMARTPAY_API_KEY is not set — skipping SMS send");
    if (throwOnError) throw new Error("SMS service is not configured");
    return { skipped: true };
  }

  try {
    const { data } = await axios.post(
      SMARTPAY_SMS_URL,
      { phone, message },
      {
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        timeout: 10000,
      }
    );
    return data;
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error("[smartpaySms] send failed:", detail);
    if (throwOnError) throw new Error("Could not send SMS — try again shortly");
    return { skipped: true, error: detail };
  }
}

module.exports = { sendSms };
