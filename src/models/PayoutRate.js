const mongoose = require("mongoose");

/**
 * Per-instrument, per-side payout override. A trade on "vol10" (Volatility
 * 10) with side "matches" can pay a completely different rate than
 * "differs" on that same instrument — that's the whole point of this
 * collection existing separately from the single global Settings.payoutRate.
 *
 * `rate` is a multiplier applied to stake on a win: 1.95 means a $10
 * stake returns $19.50 total (95% profit), matching how routes/trades.js
 * already computes payout = stake * rate. This is NOT a percentage
 * string — admin-facing UI should convert (rate - 1) * 100 to display
 * "95.0%" the way the trading screen's payout labels do.
 */
const payoutRateSchema = new mongoose.Schema(
  {
    // The traded instrument's stable id from the frontend's SYMBOLS array
    // — "vol10", "vol25", "vol50", "vol75", "vol100" — NOT the `market`
    // field on Trade (that's the trade-type tab: matches/evenodd/overunder).
    symbolId: { type: String, required: true },
    side: {
      type: String,
      required: true,
      enum: ["matches", "differs", "even", "odd", "over", "under"],
    },
    rate: { type: Number, required: true, min: 1 },
    updatedByAdmin: { type: String, default: null },
  },
  { timestamps: true }
);

// One rate per (symbolId, side) pair — upserts key off this.
payoutRateSchema.index({ symbolId: 1, side: 1 }, { unique: true });

module.exports = mongoose.model("PayoutRate", payoutRateSchema);
