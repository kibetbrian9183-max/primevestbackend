const jwt = require("jsonwebtoken");

const ADMIN_COOKIE = "primevest_admin_session";

function signAdminToken(email) {
  return jwt.sign({ admin: true, email }, process.env.ADMIN_JWT_SECRET, { expiresIn: "12h" });
}

function setAdminCookie(res, token) {
  res.cookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 12 * 60 * 60 * 1000,
  });
}

function clearAdminCookie(res) {
  res.clearCookie(ADMIN_COOKIE);
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
