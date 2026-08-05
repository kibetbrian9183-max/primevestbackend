const jwt = require("jsonwebtoken");

const ADMIN_COOKIE = "primevest_admin_session";

// Must match between setAdminCookie and clearAdminCookie, or the browser
// treats clearCookie's expired cookie as a different cookie and the
// original session cookie never actually gets removed on logout.
//
// The admin panel is deployed separately from this backend (Vercel vs
// Render — two different domains), so this is a cross-site cookie.
// Browsers require SameSite=None for any cookie sent cross-site, and
// SameSite=None is only honored when Secure is also set — so both are
// hardcoded true here, not conditional on the request's protocol like
// before. This only works over real HTTPS in both directions, which is
// what both Render and Vercel give you in production.
function cookieOptions() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "none",
  };
}

function signAdminToken(email) {
  return jwt.sign({ admin: true, email }, process.env.ADMIN_JWT_SECRET, { expiresIn: "12h" });
}

function setAdminCookie(req, res, token) {
  res.cookie(ADMIN_COOKIE, token, {
    ...cookieOptions(),
    maxAge: 12 * 60 * 60 * 1000,
  });
}

function clearAdminCookie(req, res) {
  res.clearCookie(ADMIN_COOKIE, cookieOptions());
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
