const express = require("express");
const PayoutRate = require("../models/PayoutRate");
const { requireAdmin } = require("../middleware/adminAuth"); // adjust path to match your project

const router = express.Router();

const VALID_SIDES = ["matches", "differs", "even", "odd", "over", "under"];

/**
 * GET /api/admin/payout-rates
 * Every configured override, for the admin dashboard's editing table.
 * Instrument/side pairs with no row here are simply using the global
 * Settings.payoutRate fallback (see routes/trades.js) — this endpoint
 * only returns explicit overrides, not a synthesized full matrix.
 */
router.get("/payout-rates", requireAdmin, async (req, res, next) => {
  try {
    const rates = await PayoutRate.find().sort({ symbolId: 1, side: 1 });
    res.json({ rates });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/payout-rates
 * Body: { symbolId, side, rate }
 * Upserts a single (symbolId, side) rate. `rate` is the win multiplier —
 * 1.95 for a 95% payout, matching how routes/trades.js already computes
 * payout = stake * rate. Sending the percentage as typed in a UI (e.g.
 * "95") needs converting to 1.95 before it reaches this endpoint; this
 * route intentionally does not guess which format was intended.
 */
router.put("/payout-rates", requireAdmin, async (req, res, next) => {
  try {
    const { symbolId, side, rate } = req.body || {};
    const rateNum = Number(rate);

    if (!symbolId || typeof symbolId !== "string") {
      return res.status(400).json({ error: "symbolId is required (e.g. 'vol10')" });
    }
    if (!VALID_SIDES.includes(side)) {
      return res.status(400).json({ error: `side must be one of: ${VALID_SIDES.join(", ")}` });
    }
    if (!rateNum || rateNum <= 1) {
      return res.status(400).json({ error: "rate must be a number greater than 1 (e.g. 1.95 for a 95% payout)" });
    }

    const updated = await PayoutRate.findOneAndUpdate(
      { symbolId, side },
      { $set: { rate: rateNum, updatedByAdmin: req.adminEmail } },
      { new: true, upsert: true }
    );

    res.json({ rate: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/payout-rates/:id
 * Removes an override, returning that (symbolId, side) pair to the
 * global Settings.payoutRate fallback.
 */
router.delete("/payout-rates/:id", requireAdmin, async (req, res, next) => {
  try {
    const deleted = await PayoutRate.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Rate not found" });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
