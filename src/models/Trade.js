const mongoose = require("mongoose");

const tradeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    accountType: { type: String, enum: ["demo", "real"], required: true },
    symbolLabel: { type: String },
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
