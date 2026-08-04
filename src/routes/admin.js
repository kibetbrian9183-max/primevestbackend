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

const router = express.Router();

// ---------------------------------------------------------------------------
// Admin auth
// ---------------------------------------------------------------------------
router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });

  const validEmail = email.trim().toLowerCase() === (process.env.ADMIN_EMAIL || "").toLowerCase();
  const validPassword = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH || "");

  if (!validEmail || !validPassword) {
    return res.status(401).json({ error: "Invalid admin credentials" });
  }

  const token = signAdminToken(email.toLowerCase());
  setAdminCookie(req, res, token);
  res.json({ ok: true, email: email.toLowerCase() });
});

router.post("/logout", requireAdmin, (req, res) => {
  clearAdminCookie(req, res);
  res.json({ ok: true });
});

router.get("/me", requireAdmin, (req, res) => {
  res.json({ email: req.adminEmail });
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

/** Marks a pending withdrawal as paid after the admin has manually sent the M-Pesa payout. */
router.patch("/payments/:id/mark-paid", requireAdmin, async (req, res, next) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ error: "Payment not found" });
    if (payment.type !== "withdrawal") return res.status(400).json({ error: "Only withdrawals can be marked paid" });
    if (payment.status !== "pending") return res.status(400).json({ error: "This withdrawal is already processed" });

    payment.status = "completed";
    payment.processedByAdmin = req.adminEmail;
    payment.processedAt = new Date();
    if (req.body?.note) payment.adminNote = req.body.note;
    await payment.save();

    res.json({ payment });
  } catch (err) {
    next(err);
  }
});

/** Rejects a pending withdrawal and refunds the user's Real balance. */
router.patch("/payments/:id/reject", requireAdmin, async (req, res, next) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ error: "Payment not found" });
    if (payment.type !== "withdrawal") return res.status(400).json({ error: "Only withdrawals can be rejected" });
    if (payment.status !== "pending") return res.status(400).json({ error: "This withdrawal is already processed" });

    payment.status = "rejected";
    payment.processedByAdmin = req.adminEmail;
    payment.processedAt = new Date();
    payment.adminNote = req.body?.note || "Rejected by admin";
    await payment.save();

    await User.findByIdAndUpdate(payment.user, { $inc: { realBalance: payment.usdAmount } });

    res.json({ payment });
  } catch (err) {
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
