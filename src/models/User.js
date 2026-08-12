const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    phone: { type: String, required: true, unique: true, sparse: true, index: true }, // 254XXXXXXXXX — the registered line OTPs are sent to
    passwordHash: { type: String, required: true },
    referralCode: { type: String, unique: true, sparse: true },
    referredBy: { type: String, default: null }, // referralCode of whoever referred this user

    demoBalance: { type: Number, default: 10000 },
    realBalance: { type: Number, default: 0 },

    // Password-reset via SMS OTP. Both the OTP and the follow-up reset
    // token are stored as hashes only — never plaintext.
    resetOtpHash: { type: String, default: null },
    resetOtpExpires: { type: Date, default: null },
    resetOtpAttempts: { type: Number, default: 0 },
    resetTokenHash: { type: String, default: null },
    resetTokenExpires: { type: Date, default: null },

    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret: { type: String, default: null }, // base32 TOTP secret, set once confirmed
    twoFactorPendingSecret: { type: String, default: null }, // awaiting verification during setup
    identityStatus: { type: String, enum: ["unverified", "pending", "verified"], default: "unverified" },
    identity: {
      firstName: String,
      lastName: String,
      contactEmail: String,
      contactPhone: String,
      middleName: String,
      dateOfBirth: String, // stored as YYYY-MM-DD
      idType: String, // "National ID" | "Passport" | "Driver's License" | ...
      idNumber: String,
      issuingCountry: String,
      addressLine: String,
      city: String,
      stateCounty: String,
      postalCode: String,
      country: String,
      submittedAt: Date,
    },

    status: { type: String, enum: ["active", "suspended"], default: "active" },
  },
  { timestamps: true }
);

// Never let a query accidentally leak the hash to a JSON response.
userSchema.set("toJSON", {
  transform: (doc, ret) => {
    delete ret.passwordHash;
    delete ret.twoFactorSecret;
    delete ret.twoFactorPendingSecret;
    delete ret.resetOtpHash;
    delete ret.resetOtpExpires;
    delete ret.resetOtpAttempts;
    delete ret.resetTokenHash;
    delete ret.resetTokenExpires;
    return ret;
  },
});

module.exports = mongoose.model("User", userSchema);
