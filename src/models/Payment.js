const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: ["deposit", "withdrawal"], required: true, index: true },
    amountKes: { type: Number, required: true },
    usdAmount: { type: Number, required: true },
    phone: { type: String, required: true },
    reference: { type: String, unique: true, sparse: true },
    mpesaReceiptNumber: { type: String },

    // deposits: pending -> success | failed (set by the Daraja callback)
    // withdrawals: pending -> completed | rejected (set manually by an admin)
    status: {
      type: String,
      enum: ["pending", "success", "completed", "failed", "rejected"],
      default: "pending",
      index: true,
    },

    processedByAdmin: { type: String, default: null }, // admin email
    processedAt: { type: Date },
    adminNote: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", paymentSchema);
