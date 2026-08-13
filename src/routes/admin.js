const express = require("express");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const Trade = require("../models/Trade");
const Payment = require("../models/Payment");
const IdentityDocument = require("../models/IdentityDocument");
const Notification = require("../models/Notification");
const Settings = require("../models/Settings");
const { getSettings } = require("../models/Settings");
const { signAdminToken, setAdminCookie, clearAdminCookie, requireAdmin } = require("../middleware/adminAuth");
const { normalizePhoneInternational } = require("../utils/mpesaHelpers");
const { editMessage } = require("../utils/telegramBot");
const { approvedMessage, approvedKeyboard, rejectedMessage, completedMessage } = require("../utils/telegramMessages");
const {
  PaymentActionError,
  approveWithdrawal,
  rejectWithdrawal,
  markWithdrawalPaid,
  confirmCryptoDeposit,
  rejectCryptoDeposit,
} = require("../services/paymentActions");

const router = express.Router();

// ---------------------------------------------------------------------------
// Admin auth — fully MongoDB-backed. No admin credentials live in env vars;
// the only env var involved in admin auth at all is ADMIN_JWT_SECRET (signs
// the session token, same role as JWT_SECRET for regular users) and, only
// for the one-time bootstrap route below, ADMIN_SETUP_SECRET (a bootstrap
// gate, not a credential — see /setup).
// ---------------------------------------------------------------------------
router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

    // Single generic error for "no such admin" / "wrong password" / "not
    // an admin at all" — distinguishing them lets an attacker enumerate
    // which emails have (admin) accounts.
    const admin = await User.findOne({ email: email.trim().toLowerCase(), role: "admin" });
    const ok = admin && (await bcrypt.compare(password, admin.passwordHash));
    if (!ok) return res.status(401).json({ error: "Invalid admin credentials" });

    if (admin.status === "suspended") {
      return res.status(403).json({ error: "This admin account has been suspended" });
    }

    const token = signAdminToken(admin);
    setAdminCookie(req, res, token);
    res.json({ ok: true, email: admin.email, name: admin.name });
  } catch (err) {
    next(err);
  }
});

router.post("/logout", requireAdmin, (req, res) => {
  clearAdminCookie(req, res);
  res.json({ ok: true });
});

router.get("/me", requireAdmin, (req, res) => {
  res.json({ email: req.adminEmail, name: req.adminName, role: "admin" });
});

/**
 * POST /api/admin/setup — one-time bootstrap for the FIRST admin account.
 * Gated two ways, both of which must pass:
 *   1. The caller must supply ADMIN_SETUP_SECRET (set only in Render env,
 *      never in frontend code) — proves they have server config access.
 *   2. Zero admin accounts may already exist in MongoDB — this makes the
 *      route self-disabling after first use, so even a leaked setup
 *      secret can't be used to mint extra admins later. Once you've
 *      created the first admin, you can (and should) delete
 *      ADMIN_SETUP_SECRET from Render entirely; every admin after that
 *      is created via POST /api/admin/admins by an existing admin instead.
 * This is a bootstrap gate, not a stored credential — nothing here is an
 * admin username or password sitting in env vars.
 */
router.post("/setup", async (req, res, next) => {
  try {
    if (!process.env.ADMIN_SETUP_SECRET) {
      return res.status(503).json({ error: "Admin setup is not enabled on this server" });
    }
    if (req.body?.setupSecret !== process.env.ADMIN_SETUP_SECRET) {
      return res.status(401).json({ error: "Invalid setup secret" });
    }

    const existingAdminCount = await User.countDocuments({ role: "admin" });
    if (existingAdminCount > 0) {
      return res.status(403).json({ error: "An admin already exists — create additional admins from the dashboard instead" });
    }

    const { name, email, phone, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

    const msisdn = normalizePhoneInternational(phone);
    if (!msisdn) return res.status(400).json({ error: "Enter a valid phone number, including country code if outside Kenya" });

    const emailLower = email.trim().toLowerCase();
    const existing = await User.findOne({ $or: [{ email: emailLower }, { phone: msisdn }] });
    if (existing) return res.status(409).json({ error: "An account with this email or phone already exists" });

    const passwordHash = await bcrypt.hash(password, 10);
    const admin = await User.create({
      name: name || "Admin",
      email: emailLower,
      phone: msisdn,
      passwordHash,
      role: "admin",
    });

    res.status(201).json({ ok: true, email: admin.email, name: admin.name });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/admins — an existing admin creates another admin
 * account. Requires a valid admin session (requireAdmin), same as every
 * other admin route — there's no separate secret here because being an
 * authenticated admin already IS the authorization.
 */
router.post("/admins", requireAdmin, async (req, res, next) => {
  try {
    const { name, email, phone, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

    const msisdn = normalizePhoneInternational(phone);
    if (!msisdn) return res.status(400).json({ error: "Enter a valid phone number, including country code if outside Kenya" });

    const emailLower = email.trim().toLowerCase();
    const existing = await User.findOne({ $or: [{ email: emailLower }, { phone: msisdn }] });
    if (existing) return res.status(409).json({ error: "An account with this email or phone already exists" });

    const passwordHash = await bcrypt.hash(password, 10);
    const admin = await User.create({
      name: name || "Admin",
      email: emailLower,
      phone: msisdn,
      passwordHash,
      role: "admin",
    });

    res.status(201).json({ admin: { id: admin._id, name: admin.name, email: admin.email, createdAt: admin.createdAt } });
  } catch (err) {
    next(err);
  }
});

/** Lists current admin accounts — for the dashboard's admin-management view. */
router.get("/admins", requireAdmin, async (req, res, next) => {
  try {
    const admins = await User.find({ role: "admin" }).select("name email createdAt status").sort({ createdAt: 1 });
    res.json({ admins });
  } catch (err) {
    next(err);
  }
});

/**
 * Revokes another admin's access (demotes to a regular user). An admin
 * can't demote themselves through this route — do that as a deliberate
 * separate action if you ever need it, so a single mis-click can't lock
 * the only signed-in admin out.
 */
router.patch("/admins/:id/revoke", requireAdmin, async (req, res, next) => {
  try {
    if (req.params.id === req.adminId) {
      return res.status(400).json({ error: "You can't revoke your own admin access from here" });
    }
    const target = await User.findById(req.params.id);
    if (!target || target.role !== "admin") return res.status(404).json({ error: "Admin not found" });

    target.role = "user";
    await target.save();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
router.get("/users", requireAdmin, async (req, res, next) => {
  try {
    const { q } = req.query;
    const filter = q
      ? { $or: [{ email: new RegExp(q, "i") }, { name: new RegExp(q, "i") }] }
      : {};
    const users = await User.find(filter).sort({ createdAt: -1 }).limit(500);
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

router.get("/users/:id", requireAdmin, async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    const [trades, payments] = await Promise.all([
      Trade.find({ user: user._id }).sort({ createdAt: -1 }).limit(100),
      Payment.find({ user: user._id }).sort({ createdAt: -1 }).limit(100),
    ]);
    res.json({ user, trades, payments });
  } catch (err) {
    next(err);
  }
});

router.patch("/users/:id", requireAdmin, async (req, res, next) => {
  try {
    const { name, status, demoBalance, realBalance } = req.body || {};
    const patch = {};
    if (typeof name === "string") patch.name = name;
    if (["active", "suspended"].includes(status)) patch.status = status;
    if (typeof demoBalance === "number") patch.demoBalance = demoBalance;
    if (typeof realBalance === "number") patch.realBalance = realBalance;

    const user = await User.findByIdAndUpdate(req.params.id, patch, { new: true });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

router.delete("/users/:id", requireAdmin, async (req, res, next) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    await Promise.all([
      Trade.deleteMany({ user: user._id }),
      Payment.deleteMany({ user: user._id }),
      Notification.deleteMany({ user: user._id }),
      IdentityDocument.deleteMany({ user: user._id }),
    ]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Identity verification (KYC)
// ---------------------------------------------------------------------------

/** Lists which of the three documents this user has on file (no image data). */
router.get("/users/:id/documents", requireAdmin, async (req, res, next) => {
  try {
    const docs = await IdentityDocument.find({ user: req.params.id }).select("kind mimeType size createdAt");
    res.json({ documents: docs });
  } catch (err) {
    next(err);
  }
});

/** Streams one document's raw image/PDF bytes for the admin to view inline. */
router.get("/users/:id/documents/:kind", requireAdmin, async (req, res, next) => {
  try {
    const doc = await IdentityDocument.findOne({ user: req.params.id, kind: req.params.kind });
    if (!doc) return res.status(404).json({ error: "Document not found" });
    res.set("Content-Type", doc.mimeType);
    res.send(Buffer.from(doc.data, "base64"));
  } catch (err) {
    next(err);
  }
});

/** Approves or rejects a pending identity verification. */
router.patch("/users/:id/identity", requireAdmin, async (req, res, next) => {
  try {
    const { decision } = req.body || {}; // "verified" | "unverified"
    if (!["verified", "unverified"].includes(decision)) {
      return res.status(400).json({ error: "decision must be 'verified' or 'unverified'" });
    }
    const user = await User.findByIdAndUpdate(req.params.id, { identityStatus: decision }, { new: true });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Payments — approve/reject withdrawals, review deposits
// ---------------------------------------------------------------------------
router.get("/payments", requireAdmin, async (req, res, next) => {
  try {
    const { type, status } = req.query;
    const filter = {};
    if (type) filter.type = type;
    if (status) filter.status = status;
    const payments = await Payment.find(filter)
      .populate("user", "name email")
      .sort({ createdAt: -1 })
      .limit(500);
    res.json({ payments });
  } catch (err) {
    next(err);
  }
});

/**
 * Every payment action below (approve/reject/mark-paid/confirm-deposit/
 * reject-deposit) delegates to services/paymentActions.js — the SAME
 * functions the Telegram webhook calls. That's one implementation of
 * every state transition, used from two front doors, not two competing
 * withdrawal systems. When an action happens here instead of Telegram,
 * we also try to update the Telegram message so it doesn't sit showing
 * stale buttons for a withdrawal someone already handled in the dashboard.
 */
function actionErrorStatus(err) {
  if (err.code === "not_found") return 404;
  if (err.code === "wrong_type" || err.code === "bad_transition") return 400;
  return 500;
}

async function syncTelegramMessage(payment, textBuilder, keyboard = []) {
  if (!payment.telegramMessageId) return;
  try {
    const user = await User.findById(payment.user);
    await editMessage(process.env.TELEGRAM_CHAT_ID, payment.telegramMessageId, textBuilder(payment, user), keyboard);
  } catch (err) {
    console.error("[admin.js] failed to sync Telegram message for", payment.reference, err);
  }
}

/** Signs off on a pending withdrawal without paying it yet — see services/paymentActions.js. */
router.patch("/payments/:id/approve", requireAdmin, async (req, res, next) => {
  try {
    const payment = await approveWithdrawal(req.params.id, req.adminEmail);
    await syncTelegramMessage(payment, approvedMessage, approvedKeyboard(payment.reference));
    res.json({ payment });
  } catch (err) {
    if (err instanceof PaymentActionError) return res.status(actionErrorStatus(err)).json({ error: err.message });
    next(err);
  }
});

/** Marks an approved withdrawal as paid after the admin has manually sent the payout (M-Pesa or crypto). */
router.patch("/payments/:id/mark-paid", requireAdmin, async (req, res, next) => {
  try {
    const payment = await markWithdrawalPaid(req.params.id, req.adminEmail);
    await syncTelegramMessage(payment, completedMessage);
    res.json({ payment });
  } catch (err) {
    if (err instanceof PaymentActionError) return res.status(actionErrorStatus(err)).json({ error: err.message });
    next(err);
  }
});

/** Rejects a pending or approved withdrawal and refunds the user's Real balance. */
router.patch("/payments/:id/reject", requireAdmin, async (req, res, next) => {
  try {
    const payment = await rejectWithdrawal(req.params.id, req.adminEmail, req.body?.note);
    await syncTelegramMessage(payment, rejectedMessage);
    res.json({ payment });
  } catch (err) {
    if (err instanceof PaymentActionError) return res.status(actionErrorStatus(err)).json({ error: err.message });
    next(err);
  }
});

/**
 * Confirms a pending crypto (USDT TRC20) deposit after the admin has
 * checked the blockchain explorer for the incoming transfer, and credits
 * the user's Real balance. M-Pesa deposits never hit this route — those
 * confirm automatically via the Daraja callback.
 */
router.patch("/payments/:id/confirm-deposit", requireAdmin, async (req, res, next) => {
  try {
    const payment = await confirmCryptoDeposit(req.params.id, req.adminEmail, {
      txHash: req.body?.txHash,
      note: req.body?.note,
    });
    res.json({ payment });
  } catch (err) {
    if (err instanceof PaymentActionError) return res.status(actionErrorStatus(err)).json({ error: err.message });
    next(err);
  }
});

/**
 * Rejects a pending crypto deposit (e.g. funds never arrived, wrong
 * amount, suspected fraud) — no refund needed since nothing was credited.
 */
router.patch("/payments/:id/reject-deposit", requireAdmin, async (req, res, next) => {
  try {
    const payment = await rejectCryptoDeposit(req.params.id, req.adminEmail, req.body?.note);
    res.json({ payment });
  } catch (err) {
    if (err instanceof PaymentActionError) return res.status(actionErrorStatus(err)).json({ error: err.message });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Stats / reports
// ---------------------------------------------------------------------------
router.get("/stats", requireAdmin, async (req, res, next) => {
  try {
    const [userCount, tradeCount, depositAgg, withdrawalAgg, pendingWithdrawals] = await Promise.all([
      User.countDocuments(),
      Trade.countDocuments(),
      Payment.aggregate([
        { $match: { type: "deposit", status: "success" } },
        { $group: { _id: null, totalUsd: { $sum: "$usdAmount" }, totalKes: { $sum: "$amountKes" }, count: { $sum: 1 } } },
      ]),
      Payment.aggregate([
        { $match: { type: "withdrawal", status: "completed" } },
        { $group: { _id: null, totalUsd: { $sum: "$usdAmount" }, totalKes: { $sum: "$amountKes" }, count: { $sum: 1 } } },
      ]),
      Payment.countDocuments({ type: "withdrawal", status: "pending" }),
    ]);

    res.json({
      userCount,
      tradeCount,
      deposits: depositAgg[0] || { totalUsd: 0, totalKes: 0, count: 0 },
      withdrawals: withdrawalAgg[0] || { totalUsd: 0, totalKes: 0, count: 0 },
      pendingWithdrawals,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
router.get("/settings", requireAdmin, async (req, res, next) => {
  try {
    const settings = await getSettings();
    res.json({ settings });
  } catch (err) {
    next(err);
  }
});

router.patch("/settings", requireAdmin, async (req, res, next) => {
  try {
    const fields = ["usdKesRate", "minDepositKes", "minWithdrawalUsd", "payoutRate", "referralRate", "maintenanceMode"];
    const patch = {};
    for (const f of fields) if (req.body?.[f] !== undefined) patch[f] = req.body[f];
    const settings = await Settings.findByIdAndUpdate("site", patch, { new: true, upsert: true });
    res.json({ settings });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
router.post("/notifications", requireAdmin, async (req, res, next) => {
  try {
    const { userId, title, body } = req.body || {};
    if (!title || !body) return res.status(400).json({ error: "Title and body are required" });
    const notification = await Notification.create({ user: userId || null, title, body });
    res.status(201).json({ notification });
  } catch (err) {
    next(err);
  }
});

router.get("/notifications", requireAdmin, async (req, res, next) => {
  try {
    const notifications = await Notification.find().sort({ createdAt: -1 }).limit(100);
    res.json({ notifications });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
