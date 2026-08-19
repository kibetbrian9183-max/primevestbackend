const express = require("express");
const User = require("../models/User");
const Trade = require("../models/Trade");
const PayoutRate = require("../models/PayoutRate");
const { requireAuth } = require("../middleware/auth");
const { getSettings } = require("../models/Settings");

const router = express.Router();

function evaluateWin(side, digit, resultDigit) {
  if (side === "matches") return resultDigit === digit;
  if (side === "differs") return resultDigit !== digit;
  if (side === "even") return resultDigit % 2 === 0;
  if (side === "odd") return resultDigit % 2 === 1;
  if (side === "over") return resultDigit > digit;
  if (side === "under") return resultDigit < digit;
  return false;
}

/**
 * Baseline payout multipliers by side, used whenever an admin hasn't set
 * an explicit per-instrument PayoutRate override. These exist because a
 * single flat Settings.payoutRate genuinely can't be correct for both
 * "matches" and "differs" — matching one specific digit is a 1-in-10 shot
 * (resultDigit === digit), while differing from it is 9-in-10 — so a fair
 * (or house-edged) rate for one is never a fair rate for the other. Without
 * this, every side pays out identically regardless of its actual odds,
 * which is what was happening before this existed.
 *
 * "over"/"under" are deliberately excluded — their odds depend on which
 * digit threshold the user picked (over 7 is a very different bet than
 * over 2), so no single default is honest for them; they keep falling
 * back to Settings.payoutRate until given the same digit-aware treatment.
 */
const DEFAULT_SIDE_RATES = {
  matches: 9.5, // 850% profit — 1-in-10 odds (adjust via Telegram: /setrate <symbol> matches <percent>)
  differs: 1.056, // 5.6% profit — 9-in-10 odds
  even: 1.95, // ~50/50 odds
  odd: 1.95,
};

/**
 * Looks up a per-instrument, per-side payout rate override. Falls back to
 * DEFAULT_SIDE_RATES (a sensible odds-based default per side) and, for
 * anything not covered there, to the global Settings.payoutRate.
 */
async function resolvePayoutRate(symbolId, side, settings) {
  if (symbolId) {
    const override = await PayoutRate.findOne({ symbolId, side });
    if (override) return override.rate;
  }
  if (DEFAULT_SIDE_RATES[side] !== undefined) return DEFAULT_SIDE_RATES[side];
  return settings.payoutRate;
}

/**
 * GET /api/trades/payout-rates
 * Public (logged-in-user) read access to current rates, keyed by
 * symbolId+side — e.g. { vol10: { matches: 1.95, differs: 1.056 } }.
 * This is what the trade screen's live payout preview should call
 * instead of using a hardcoded constant, so admin-configured rates are
 * actually visible to a user BEFORE they commit a stake, not just
 * reflected in what they're paid after the fact.
 */
router.get("/payout-rates", requireAuth, async (req, res, next) => {
  try {
    const settings = await getSettings();
    const overrides = await PayoutRate.find();

    const bySymbol = {};
    for (const o of overrides) {
      if (!bySymbol[o.symbolId]) bySymbol[o.symbolId] = {};
      bySymbol[o.symbolId][o.side] = o.rate;
    }

    res.json({ defaultRate: settings.payoutRate, sideDefaults: DEFAULT_SIDE_RATES, rates: bySymbol });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/trades
 * Opens a trade: validates + deducts the stake server-side so a client
 * can't spoof its own balance, then returns the trade id to resolve later.
 */
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const { accountType, symbolLabel, symbolId, market, marketLabel, side, sideLabel, digit, stake } = req.body || {};
    const stakeAmt = Number(stake);

    if (!["demo", "real"].includes(accountType)) return res.status(400).json({ error: "Invalid account type" });
    if (!stakeAmt || stakeAmt <= 0) return res.status(400).json({ error: "Invalid stake" });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const balanceField = accountType === "demo" ? "demoBalance" : "realBalance";
    if (user[balanceField] < stakeAmt) return res.status(400).json({ error: "Insufficient balance" });

    const settings = await getSettings();
    const rate = await resolvePayoutRate(symbolId, side, settings);
    const payout = Number((stakeAmt * rate).toFixed(2));

    user[balanceField] = Number((user[balanceField] - stakeAmt).toFixed(2));
    await user.save();

    const trade = await Trade.create({
      user: user._id,
      accountType,
      symbolLabel,
      symbolId,
      market,
      marketLabel,
      side,
      sideLabel,
      digit,
      stake: stakeAmt,
      payout,
      status: "open",
    });

    res.status(201).json({ tradeId: trade._id, balance: user[balanceField], payout });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/trades/:id/resolve
 * Resolves an open trade with a result digit, credits a win, and
 * returns the updated balance.
 */
router.patch("/:id/resolve", requireAuth, async (req, res, next) => {
  try {
    const trade = await Trade.findOne({ _id: req.params.id, user: req.userId });
    if (!trade) return res.status(404).json({ error: "Trade not found" });
    if (trade.status !== "open") return res.status(400).json({ error: "Trade already resolved" });

    const resultDigit = Math.floor(Math.random() * 10);
    const won = evaluateWin(trade.side, trade.digit, resultDigit);

    trade.status = won ? "won" : "lost";
    trade.resultDigit = resultDigit;
    trade.closeTime = new Date();
    await trade.save();

    const user = await User.findById(req.userId);
    const balanceField = trade.accountType === "demo" ? "demoBalance" : "realBalance";
    if (won) {
      user[balanceField] = Number((user[balanceField] + trade.payout).toFixed(2));
      await user.save();
    }

    res.json({
      won,
      resultDigit,
      payout: trade.payout,
      stake: trade.stake,
      balance: user[balanceField],
    });
  } catch (err) {
    next(err);
  }
});

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const trades = await Trade.find({ user: req.userId }).sort({ createdAt: -1 }).limit(200);
    res.json({ trades });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
