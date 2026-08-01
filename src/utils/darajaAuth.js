const axios = require("axios");
const config = require("../config");

// Access tokens are valid for 3600s. Cache in memory and refresh
// a little early so we never fire a request with an expired token.
let cachedToken = null;
let cachedExpiry = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedExpiry) {
    return cachedToken;
  }

  const credentials = Buffer.from(
    `${config.daraja.consumerKey}:${config.daraja.consumerSecret}`
  ).toString("base64");

  const { data } = await axios.get(
    `${config.daraja.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${credentials}` } }
  );

  cachedToken = data.access_token;
  // Refresh 60s before actual expiry as a safety margin.
  cachedExpiry = now + (Number(data.expires_in || 3599) - 60) * 1000;
  return cachedToken;
}

module.exports = { getAccessToken };
