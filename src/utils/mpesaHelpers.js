const config = require("../config");

/** Safaricom's required timestamp format: yyyyMMddHHmmss */
function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

/** Password for Lipa Na M-Pesa Online = base64(shortcode + passkey + timestamp) */
function stkPassword(ts) {
  return Buffer.from(`${config.daraja.shortcode}${config.daraja.passkey}${ts}`).toString(
    "base64"
  );
}

/**
 * Normalizes a Kenyan phone number to Safaricom's expected 2547XXXXXXXX /
 * 2541XXXXXXXX format. Accepts 07.., 01.., 7.., 254.. inputs.
 * Returns null if the number doesn't look valid.
 */
function normalizeMsisdn(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  let n = digits;
  if (n.startsWith("0")) n = "254" + n.slice(1);
  else if (n.startsWith("7") || n.startsWith("1")) n = "254" + n;
  if (!/^254(7|1)\d{8}$/.test(n)) return null;
  return n;
}

/** True if this is already in the strict Kenyan 254(7|1)XXXXXXXX shape M-Pesa/SmartPay require. */
function isKenyanMsisdn(phone) {
  return /^254(7|1)\d{8}$/.test(String(phone || ""));
}

/**
 * Normalizes ANY country's phone number for account-level use (signup,
 * login, password-reset lookup) — not just Kenya. This app serves other
 * countries too, and M-Pesa is only one of several deposit/withdraw rails
 * (crypto works from anywhere), so the account phone itself can't be
 * Kenya-only.
 *
 * - Input starting with "+": treated as international E.164, stored as
 *   "+<digits>" (8-15 digits after the +).
 * - Otherwise: tried against the Kenyan shapes above (07.., 01.., 7..,
 *   254..) first, since that's this app's primary market and lets
 *   existing Kenyan users keep typing numbers the way they always have,
 *   with no + prefix required.
 * - Anything else (bare digits with no + and not a recognizable Kenyan
 *   shape) is rejected as ambiguous — we can't infer a country code.
 *
 * Returns null if nothing above matches.
 */
function normalizePhoneInternational(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) return null;
    return "+" + digits;
  }

  return normalizeMsisdn(trimmed);
}

module.exports = { timestamp, stkPassword, normalizeMsisdn, isKenyanMsisdn, normalizePhoneInternational };
