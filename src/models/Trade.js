const mongoose = require("mongoose");

const tradeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    accountType: { type: String, enum: ["demo", "real"], required: true },
    symbolLabel: { type: String },
    // The actual traded instrument's stable id — "vol10", "vol25", etc.
    // from frontend SYMBOLS array. Distinct from `market` below, which is
    // the trade-TYPE tab, not the instrument. This is what payout rates
    // are keyed against (see models/PayoutRate.js) — without it there's
    // no way to price Volatility 10 differently from Volatility 75.
    symbolId: { type: String, index: true },
    market: { type: String }, // "matches" | "evenodd" | "overunder"
    marketLabel: { type: String },
    side: { type: String }, // "matches" | "differs" | "even" | "odd" | "over" | "under"
    sideLabel: { type: String },
    digit: { type: Number },
    resultDigit: { type: Number },
    stake: { type: Number, required: true },
    payout: { type: Number, required: true },
    status: { type: String, enum: ["open", "won", "lost"], default: "open", index: true },
    openTime: { type: Date, default: Date.now },
    closeTime: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Trade", tradeSchema);
