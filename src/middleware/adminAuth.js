const jwt = require("jsonwebtoken");

const ADMIN_COOKIE = "primevest_admin_session";

// Must match between setAdminCookie and clearAdminCookie, or the browser
// treats clearCookie's expired cookie as a different cookie and the
// original session cookie never actually gets removed on logout.
function cookieOptions(req) {
  return {
    httpOnly: true,
    // req.secure reflects the real client-facing protocol (works
    // correctly now that index.js sets `trust proxy`) — true on Render's
    // HTTPS, false on plain-HTTP local dev, where a hardcoded `true`
    // would make the browser silently discard the cookie.
    secure: req.secure,
    sameSite: "lax",
  };
}

function signAdminToken(email) {
  return jwt.sign({ admin: true, email }, process.env.ADMIN_JWT_SECRET, { expiresIn: "12h" });
}

function setAdminCookie(req, res, token) {
  res.cookie(ADMIN_COOKIE, token, {
    ...cookieOptions(req),
    maxAge: 12 * 60 * 60 * 1000,
  });
}

function clearAdminCookie(req, res) {
  res.clearCookie(ADMIN_COOKIE, cookieOptions(req));
}

function requireAdmin(req, res, next) {
  const token = req.cookies?.[ADMIN_COOKIE];
  if (!token) return res.status(401).json({ error: "Admin login required" });
  try {
    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    if (!payload.admin) throw new Error("not admin");
    req.adminEmail = payload.email;
    next();
  } catch {
    return res.status(401).json({ error: "Admin session expired — log in again" });
  }
}

module.exports = { signAdminToken, setAdminCookie, clearAdminCookie, requireAdmin, ADMIN_COOKIE };
