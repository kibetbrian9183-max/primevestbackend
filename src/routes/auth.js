const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const speakeasy = require("speakeasy");
const qrcode = require("qrcode");
const User = require("../models/User");
const IdentityDocument = require("../models/IdentityDocument");
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
    identity: user.identity,
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

    if (user.twoFactorEnabled) {
      // Password checks out, but don't issue a real session token yet — the
      // client still has to prove it holds a valid TOTP code. This token is
      // only good for that one purpose and expires quickly.
      const preAuthToken = jwt.sign(
        { preAuth: true, sub: user._id.toString() },
        process.env.JWT_SECRET,
        { expiresIn: "5m" }
      );
      return res.json({ requiresTwoFactor: true, preAuthToken });
    }

    const token = signUserToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post("/login/2fa", async (req, res, next) => {
  try {
    const { preAuthToken, code } = req.body || {};
    if (!preAuthToken || !code) return res.status(400).json({ error: "Missing verification code" });

    let payload;
    try {
      payload = jwt.verify(preAuthToken, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: "Login session expired — enter your password again" });
    }
    if (!payload.preAuth) return res.status(401).json({ error: "Invalid login session" });

    const user = await User.findById(payload.sub);
    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
      return res.status(400).json({ error: "Two-factor authentication is not set up on this account" });
    }

    const verified = speakeasy.totp.verify({
      secret: user.twoFactorSecret,
      encoding: "base32",
      token: String(code).trim(),
      window: 1, // allow the code from ±1 step (±30s) for clock drift
    });
    if (!verified) return res.status(401).json({ error: "Incorrect code — check the app and try again" });

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
    const { name } = req.body || {};
    const patch = {};
    if (typeof name === "string" && name.trim()) patch.name = name.trim();

    const user = await User.findByIdAndUpdate(req.userId, patch, { new: true });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.patch("/me/password", requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current and new password are required" });
    }
    if (newPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Current password is incorrect" });

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Two-factor authentication (TOTP — Google Authenticator compatible)
// ---------------------------------------------------------------------------

/** Starts setup: generates a secret and returns a QR code to scan. Does NOT enable 2FA yet — that only happens once the user proves they can generate a valid code. */
router.post("/me/2fa/setup", requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.twoFactorEnabled) return res.status(400).json({ error: "2FA is already enabled" });

    const secret = speakeasy.generateSecret({
      name: `PrimeVest (${user.email})`,
      length: 20,
    });

    user.twoFactorPendingSecret = secret.base32;
    await user.save();

    const qrCodeDataUrl = await qrcode.toDataURL(secret.otpauth_url);

    res.json({ secret: secret.base32, qrCodeDataUrl });
  } catch (err) {
    next(err);
  }
});

/** Confirms setup: only flips twoFactorEnabled on once a real code checks out. */
router.post("/me/2fa/verify", requireAuth, async (req, res, next) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: "Enter the 6-digit code" });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.twoFactorPendingSecret) {
      return res.status(400).json({ error: "Start setup again before verifying" });
    }

    const verified = speakeasy.totp.verify({
      secret: user.twoFactorPendingSecret,
      encoding: "base32",
      token: String(code).trim(),
      window: 1,
    });
    if (!verified) return res.status(401).json({ error: "Incorrect code — check the app and try again" });

    user.twoFactorSecret = user.twoFactorPendingSecret;
    user.twoFactorPendingSecret = null;
    user.twoFactorEnabled = true;
    await user.save();

    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

/** Disabling requires the current password — not just a click — since this removes a security layer. */
router.post("/me/2fa/disable", requireAuth, async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: "Enter your password to disable 2FA" });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Incorrect password" });

    user.twoFactorEnabled = false;
    user.twoFactorSecret = null;
    user.twoFactorPendingSecret = null;
    await user.save();

    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB, matches the UI copy

function decodeBase64File(dataUrl) {
  // Accepts a data URL like "data:image/png;base64,AAAA..." or a bare
  // base64 string. Returns { mimeType, buffer } or null if unusable.
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const match = dataUrl.match(/^data:([\w/+.-]+);base64,(.+)$/);
  const mimeType = match ? match[1] : "application/octet-stream";
  const base64 = match ? match[2] : dataUrl;
  try {
    const buffer = Buffer.from(base64, "base64");
    return { mimeType, buffer };
  } catch {
    return null;
  }
}

router.post("/me/verify-identity", requireAuth, async (req, res, next) => {
  try {
    const {
      firstName,
      lastName,
      contactEmail,
      contactPhone,
      middleName,
      dateOfBirth,
      idType,
      idNumber,
      issuingCountry,
      addressLine,
      city,
      stateCounty,
      postalCode,
      country,
      idFront, // base64 data URL
      idBack,
      selfie,
    } = req.body || {};

    if (!firstName || !lastName || !dateOfBirth || !idType || !idNumber || !issuingCountry) {
      return res.status(400).json({ error: "Fill in all required identification fields" });
    }
    if (!idFront || !idBack || !selfie) {
      return res.status(400).json({ error: "Upload the front and back of your ID and a selfie holding it" });
    }

    const files = { id_front: idFront, id_back: idBack, selfie };
    const decoded = {};
    for (const [kind, dataUrl] of Object.entries(files)) {
      const d = decodeBase64File(dataUrl);
      if (!d) return res.status(400).json({ error: `Couldn't read the uploaded ${kind.replace("_", " ")} file` });
      if (d.buffer.length > MAX_FILE_BYTES) {
        return res.status(400).json({ error: `Each file must be under 10MB` });
      }
      decoded[kind] = d;
    }

    await Promise.all(
      Object.entries(decoded).map(([kind, d]) =>
        IdentityDocument.findOneAndUpdate(
          { user: req.userId, kind },
          { mimeType: d.mimeType, data: d.buffer.toString("base64"), size: d.buffer.length },
          { upsert: true }
        )
      )
    );

    const user = await User.findByIdAndUpdate(
      req.userId,
      {
        identityStatus: "pending",
        identity: {
          firstName,
          lastName,
          contactEmail,
          contactPhone,
          middleName,
          dateOfBirth,
          idType,
          idNumber,
          issuingCountry,
          addressLine,
          city,
          stateCounty,
          postalCode,
          country,
          submittedAt: new Date(),
        },
      },
      { new: true }
    );

    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, publicUser };
