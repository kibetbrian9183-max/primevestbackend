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

  daraja: {
    baseUrl:
      env === "production"
        ? "https://api.safaricom.co.ke"
        : "https://sandbox.safaricom.co.ke",
    consumerKey: required("MPESA_CONSUMER_KEY"),
    consumerSecret: required("MPESA_CONSUMER_SECRET"),
    shortcode: required("MPESA_SHORTCODE"),
    passkey: required("MPESA_PASSKEY"),
    stkCallbackUrl: required("MPESA_STK_CALLBACK_URL"),
  },

  corsOrigin: (process.env.CORS_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean),
};
