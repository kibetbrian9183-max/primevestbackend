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

module.exports = { timestamp, stkPassword, normalizeMsisdn };
