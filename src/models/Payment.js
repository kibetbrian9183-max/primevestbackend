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

    // SmartPay's own B2C reference (distinct from `reference` above) —
    // needed to poll GET /v1/b2c/{ref} for the payout's real outcome,
    // since B2C results aren't delivered via webhook.
    payoutRef: { type: String, default: null },
    fee: { type: Number, default: 0 }, // KES fee SmartPay deducted for a B2C payout

    // deposits: pending -> success | failed (set by the SmartPay STK callback)
    // withdrawals (mpesa): pending -> processing -> completed, or
    // pending/processing -> rejected (balance auto-refunded on failure —
    // see routes/payments.js). Sent automatically via SmartPay B2C, no
    // admin approval step.
    // withdrawals (usdt_trc20): pending -> approved -> completed, or
    // pending/approved -> rejected. Still manual — set by an admin via the
    // REST admin routes or the Telegram bot, both going through the same
    // service functions (services/withdrawalActions.js).
    status: {
      type: String,
      enum: ["pending", "processing", "approved", "success", "completed", "failed", "rejected"],
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
