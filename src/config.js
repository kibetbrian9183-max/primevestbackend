require("dotenv").config();

function required(name) {
  const v = process.env[name];
  if (!v) {
    // Fail loudly at boot rather than mid-request in production.
    console.warn(`[config] Missing environment variable: ${name}`);
  }
  return v;
}

const env = (process.env.MPESA_ENV || "sandbox").toLowerCase();

module.exports = {
  env,
  isProduction: env === "production",
  port: Number(process.env.PORT || 10000),

  smartpay: {
    baseUrl: "https://api.smartpaypesa.com/v1",
    apiKey: required("SMARTPAY_API_KEY"),
    // B2C (withdrawals) needs these as a second factor on top of apiKey —
    // your SmartPay dashboard login, not used for deposits/STK push.
    username: required("SMARTPAY_USERNAME"),
    password: required("SMARTPAY_PASSWORD"),
  },

  // The single wallet address deposits are shown to send USDT to. Crypto
  // deposits/withdrawals aren't chain-monitored — an admin manually
  // confirms them in the dashboard, same as before.
  usdtTrc20Address: process.env.DEPOSIT_USDT_ADDRESS || "",

  corsOrigin: (process.env.CORS_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean),
};
