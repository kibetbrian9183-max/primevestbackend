const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: ["deposit", "withdrawal"], required: true, index: true },
    method: { type: String, enum: ["mpesa", "usdt_trc20"], default: "mpesa", index: true },
    amountKes: { type: Number, required: true },
    usdAmount: { type: Number, required: true },
    // phone: required for M-Pesa payments only. walletAddress: required for
    // USDT payments only — the deposit address we own for deposits, or the
    // user-supplied destination address for withdrawals.
    phone: { type: String, required: function () { return this.method === "mpesa"; } },
    walletAddress: { type: String, required: function () { return this.method === "usdt_trc20"; } },
    reference: { type: String, unique: true, sparse: true },
    mpesaReceiptNumber: { type: String },
    txHash: { type: String, default: "" }, // optional — user-supplied TRC20 transaction hash for a deposit

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
