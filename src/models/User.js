const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    passwordHash: { type: String, required: true },
    referralCode: { type: String, unique: true, sparse: true },
    referredBy: { type: String, default: null }, // referralCode of whoever referred this user

    demoBalance: { type: Number, default: 10000 },
    realBalance: { type: Number, default: 0 },

    twoFactorEnabled: { type: Boolean, default: false },
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
    return ret;
  },
});

module.exports = mongoose.model("User", userSchema);
