const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const User = require("../models/User");
const { signUserToken, requireAuth } = require("../middleware/auth");

const router = express.Router();

function genReferralCode() {
  return crypto.randomBytes(5).toString("hex").toUpperCase().slice(0, 8);
}

function publicUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    referralCode: user.referralCode,
    demoBalance: user.demoBalance,
    realBalance: user.realBalance,
    twoFactorEnabled: user.twoFactorEnabled,
    identityStatus: user.identityStatus,
    status: user.status,
  };
}

router.post("/signup", async (req, res, next) => {
  try {
    const { name, email, password, referredBy } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ error: "An account with this email already exists" });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      name: name || "",
      email: email.toLowerCase(),
      passwordHash,
      referralCode: genReferralCode(),
      referredBy: referredBy || null,
    });

    const token = signUserToken(user);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: "No account found with that email" });
    if (user.status === "suspended") return res.status(403).json({ error: "This account has been suspended" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Incorrect password" });

    const token = signUserToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.patch("/me", requireAuth, async (req, res, next) => {
  try {
    const { name, twoFactorEnabled } = req.body || {};
    const patch = {};
    if (typeof name === "string" && name.trim()) patch.name = name.trim();
    if (typeof twoFactorEnabled === "boolean") patch.twoFactorEnabled = twoFactorEnabled;

    const user = await User.findByIdAndUpdate(req.userId, patch, { new: true });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post("/me/verify-identity", requireAuth, async (req, res, next) => {
  try {
    const { legalName, idNumber } = req.body || {};
    if (!legalName || !idNumber) return res.status(400).json({ error: "Full name and ID number are required" });
    const user = await User.findByIdAndUpdate(req.userId, { identityStatus: "pending" }, { new: true });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, publicUser };
