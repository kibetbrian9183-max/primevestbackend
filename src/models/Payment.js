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
    // withdrawals: pending -> approved -> completed, or pending/approved -> rejected.
    // "approved" means an admin signed off but the payout hasn't been
    // confirmed sent yet — "completed" is the only status that means money
    // actually left. Set manually by an admin, via the REST admin routes
    // or the Telegram bot — both paths go through the same service
    // functions (services/withdrawalActions.js), so there's exactly one
    // implementation of these transitions, not two competing ones.
    status: {
      type: String,
      enum: ["pending", "approved", "success", "completed", "failed", "rejected"],
      default: "pending",
      index: true,
    },

    processedByAdmin: { type: String, default: null }, // admin email, or "telegram:<id>" for bot-originated actions
    processedAt: { type: Date },
    paidAt: { type: Date }, // set only when status becomes "completed"
    adminNote: { type: String, default: "" },
    telegramMessageId: { type: Number, default: null }, // the notification message in the admin chat, so approve/reject/paid can edit it in place
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", paymentSchema);
