const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const speakeasy = require("speakeasy");
const qrcode = require("qrcode");
const User = require("../models/User");
const IdentityDocument = require("../models/IdentityDocument");
const { signUserToken, requireAuth } = require("../middleware/auth");
const { normalizePhoneInternational } = require("../utils/mpesaHelpers");
const { sendSms } = require("../utils/smartpaySms");
const { sendEmail } = require("../utils/brevoEmail");

const router = express.Router();

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const RESET_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

function genReferralCode() {
  return crypto.randomBytes(5).toString("hex").toUpperCase().slice(0, 8);
}

function gen6DigitOtp() {
  // crypto.randomInt is uniform, unlike Math.random() — matters for a code
  // that gates account access.
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function hashToken(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function publicUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
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
    const { name, email, phone, password, referredBy } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

    const msisdn = normalizePhoneInternational(phone);
    if (!msisdn) {
      return res.status(400).json({
        error: "Enter a valid phone number — a Kenyan number (07XX XXX XXX) or an international number with country code (e.g. +1 415 555 0100)",
      });
    }

    const existingEmail = await User.findOne({ email: email.toLowerCase() });
    if (existingEmail) return res.status(409).json({ error: "An account with this email already exists" });

    const existingPhone = await User.findOne({ phone: msisdn });
    if (existingPhone) return res.status(409).json({ error: "An account with this phone number already exists" });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      name: name || "",
      email: email.toLowerCase(),
      phone: msisdn,
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
    const { name, phone } = req.body || {};
    const patch = {};
    if (typeof name === "string" && name.trim()) patch.name = name.trim();

    if (typeof phone === "string" && phone.trim()) {
      const msisdn = normalizePhoneInternational(phone);
      if (!msisdn) {
        return res.status(400).json({
          error: "Enter a valid phone number — a Kenyan number (07XX XXX XXX) or an international number with country code (e.g. +1 415 555 0100)",
        });
      }
      const existing = await User.findOne({ phone: msisdn, _id: { $ne: req.userId } });
      if (existing) return res.status(409).json({ error: "That phone number is already linked to another account" });
      patch.phone = msisdn;
    }

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

// ---------------------------------------------------------------------------
// Forgot password — SMS or Email OTP flow
//
//   1. POST /forgot-password    { phone } OR { email }       -> sends a 6-digit OTP by SMS or email
//   2. POST /verify-reset-otp   { phone, otp } OR { email, otp } -> returns a short-lived resetToken
//   3. POST /reset-password     { resetToken, newPassword }   -> sets the new password
//
// The OTP itself is never sent back in step 2's response, and step 3 only
// accepts the one-time resetToken — never the OTP, phone, or email again —
// so a leaked network log from step 1/2 can't be replayed once step 2 succeeds.
// Both channels share the same resetOtp*/resetToken* fields on the user —
// only one reset can be in flight at a time regardless of which channel
// started it, which is fine since starting a new one always supersedes the old.
// ---------------------------------------------------------------------------

function otpEmailHtml(otp) {
  return `
    <div style="font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 420px; margin: 0 auto; padding: 32px 24px; background: #0B0F1A; color: #FFFFFF; border-radius: 16px;">
      <div style="font-size: 15px; color: #8A94A6; margin-bottom: 4px;">PrimeVest</div>
      <h1 style="font-size: 20px; margin: 0 0 16px;">Reset your password</h1>
      <p style="font-size: 14px; color: #8A94A6; margin: 0 0 24px;">Use this code to reset your PrimeVest password. It expires in 10 minutes.</p>
      <div style="font-size: 32px; font-weight: 700; letter-spacing: 6px; background: #1A1F2E; border-radius: 12px; padding: 16px; text-align: center; margin-bottom: 24px;">${otp}</div>
      <p style="font-size: 12px; color: #8A94A6; margin: 0;">If you didn't request this, you can safely ignore this email — your password won't change unless this code is used.</p>
    </div>
  `;
}

router.post("/forgot-password", async (req, res, next) => {
  try {
    const rawPhone = req.body?.phone;
    const rawEmail = req.body?.email;

    let user = null;
    let channel = null; // "sms" | "email"
    let destination = null;

    if (rawEmail) {
      const email = String(rawEmail).trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address" });
      user = await User.findOne({ email });
      channel = "email";
      destination = email;
    } else {
      const msisdn = normalizePhoneInternational(rawPhone);
      if (!msisdn) {
        return res.status(400).json({
          error: "Enter a valid phone number, including country code if you're outside Kenya",
        });
      }
      user = await User.findOne({ phone: msisdn });
      channel = "sms";
      destination = msisdn;
    }

    // Same response whether or not the account is registered — otherwise
    // this endpoint becomes a way to enumerate accounts. The OTP only
    // actually goes out if we found someone.
    if (user) {
      const otp = gen6DigitOtp();
      user.resetOtpHash = await bcrypt.hash(otp, 10);
      user.resetOtpExpires = new Date(Date.now() + OTP_TTL_MS);
      user.resetOtpAttempts = 0;
      user.resetTokenHash = null;
      user.resetTokenExpires = null;
      await user.save();

      if (channel === "email") {
        await sendEmail(destination, "Your PrimeVest password reset code", otpEmailHtml(otp), {
          throwOnError: true,
          toName: user.name || "",
        });
      } else {
        // NOTE: SmartPay's documented format examples are Kenyan-only
        // (07XX/01XX/254XX) — international SMS delivery isn't confirmed.
        await sendSms(
          destination,
          `Your PrimeVest password reset code is ${otp}. It expires in 10 minutes. If you didn't request this, ignore this message.`,
          { throwOnError: true }
        );
      }
    }

    res.json({
      message:
        channel === "email"
          ? "If that email is registered, we've sent a reset code."
          : "If that number is registered, we've sent a reset code.",
    });
  } catch (err) {
    // sendSms/sendEmail throw if genuinely misconfigured/unreachable —
    // surface that distinctly rather than leaving the user staring at a
    // code that will never arrive.
    const transientErrors = [
      "Could not send SMS — try again shortly",
      "SMS service is not configured",
      "Could not send the email — try again shortly",
      "Email service is not configured",
    ];
    if (transientErrors.includes(err.message)) {
      return res.status(502).json({ error: "Couldn't send the reset code — try again shortly" });
    }
    next(err);
  }
});

router.post("/verify-reset-otp", async (req, res, next) => {
  try {
    const otp = String(req.body?.otp || "").trim();
    if (!otp) return res.status(400).json({ error: "Enter the code" });

    let user = null;
    if (req.body?.email) {
      const email = String(req.body.email).trim().toLowerCase();
      user = await User.findOne({ email });
    } else {
      const msisdn = normalizePhoneInternational(req.body?.phone);
      if (!msisdn) return res.status(400).json({ error: "Phone and code are required" });
      user = await User.findOne({ phone: msisdn });
    }

    if (!user || !user.resetOtpHash || !user.resetOtpExpires) {
      return res.status(400).json({ error: "Request a new code and try again" });
    }
    if (user.resetOtpExpires < new Date()) {
      return res.status(400).json({ error: "That code has expired — request a new one" });
    }
    if (user.resetOtpAttempts >= MAX_OTP_ATTEMPTS) {
      return res.status(429).json({ error: "Too many incorrect attempts — request a new code" });
    }

    const ok = await bcrypt.compare(otp, user.resetOtpHash);
    if (!ok) {
      user.resetOtpAttempts += 1;
      await user.save();
      return res.status(401).json({ error: "Incorrect code — check and try again" });
    }

    // OTP consumed — issue a one-time reset token for the final step.
    const resetToken = crypto.randomBytes(32).toString("hex");
    user.resetTokenHash = hashToken(resetToken);
    user.resetTokenExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    user.resetOtpHash = null;
    user.resetOtpExpires = null;
    user.resetOtpAttempts = 0;
    await user.save();

    res.json({ resetToken });
  } catch (err) {
    next(err);
  }
});

router.post("/reset-password", async (req, res, next) => {
  try {
    const { resetToken, newPassword } = req.body || {};
    if (!resetToken || !newPassword) return res.status(400).json({ error: "Missing reset token or new password" });
    if (newPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });

    const user = await User.findOne({ resetTokenHash: hashToken(resetToken) });
    if (!user || !user.resetTokenExpires || user.resetTokenExpires < new Date()) {
      return res.status(400).json({ error: "This reset link has expired — start over" });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.resetTokenHash = null;
    user.resetTokenExpires = null;
    await user.save();

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, publicUser };
