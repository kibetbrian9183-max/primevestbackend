const axios = require("axios");

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

/**
 * Sends a transactional email via Brevo.
 *   POST https://api.brevo.com/v3/smtp/email
 *   Header: api-key
 *   Body: { sender, to, subject, htmlContent }
 * The sender address must be a verified sender in your Brevo account —
 * an unverified sender gets silently downgraded to @brevosend.com or
 * rejected outright, so check Brevo's Senders page if delivery fails.
 *
 * Mirrors smartpaySms's error-handling shape: by default this doesn't
 * throw (email is a side effect elsewhere), but pass throwOnError: true
 * for flows where the email IS the point, like an OTP send.
 */
async function sendEmail(to, subject, htmlContent, { throwOnError = false, toName = "" } = {}) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || "PrimeVest";

  if (!apiKey || !senderEmail) {
    console.warn("[brevoEmail] BREVO_API_KEY or BREVO_SENDER_EMAIL is not set — skipping email send");
    if (throwOnError) throw new Error("Email service is not configured");
    return { skipped: true };
  }

  try {
    const { data } = await axios.post(
      BREVO_URL,
      {
        sender: { name: senderName, email: senderEmail },
        to: [{ email: to, name: toName || undefined }],
        subject,
        htmlContent,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "api-key": apiKey,
        },
        timeout: 10000,
      }
    );
    return data;
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error("[brevoEmail] send failed:", detail);
    if (throwOnError) throw new Error("Could not send the email — try again shortly");
    return { skipped: true, error: detail };
  }
}

module.exports = { sendEmail };
