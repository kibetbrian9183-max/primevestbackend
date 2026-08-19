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
 * "over"/"under" are NOT listed here — see overUnderPayoutRate() below,
 * which computes their rate per-digit instead of using a single constant.
 */
const DEFAULT_SIDE_RATES = {
  matches: 9.5, // 850% profit — 1-in-10 odds (adjust via Telegram: /setrate <symbol> matches <percent>)
  differs: 1.056, // 5.6% profit — 9-in-10 odds
  even: 1.95, // ~50/50 odds
  odd: 1.95,
};

/**
 * House edge applied to over/under contracts. Chosen to match the edge
 * already implicit in DEFAULT_SIDE_RATES above: matches is 9.5 against
 * fair odds of 1/0.1 = 10 -> 9.5/10 = 0.95, and differs is 1.056 against
 * fair odds of 1/0.9 = 1.111 -> 1.056/1.111 = 0.95. Both bake in a 5%
 * edge, so over/under uses the same figure for consistency. Kept as its
 * own constant so it can be tuned independently later.
 */
const OVER_UNDER_HOUSE_EDGE = 0.05;

/**
 * Win probability for an over/under digit contract, out of the 10
 * possible result digits (0-9).
 *   "over N"  wins on result digit > N  -> (9 - N) out of 10 digits win
 *   "under N" wins on result digit < N  -> N out of 10 digits win
 * Over 9 and Under 0 have zero win probability and must never be offered
 * as selectable barriers on the client — there's no fair finite payout
 * for a bet that can't win.
 */
function overUnderWinProbability(side, digit) {
  const d = Number(digit);
  if (!Number.isInteger(d) || d < 0 || d > 9) return null;
  if (side === "over") return (9 - d) / 10;
  if (side === "under") return d / 10;
  return null;
}

/**
 * Fair-odds payout multiplier for a given over/under selection, with the
 * house edge removed — the same "pay 95% of fair odds" treatment used for
 * matches/differs above. Lower win probability (e.g. Over 8, 10% chance)
 * -> higher payout. Higher win probability (e.g. Over 1, 80% chance) ->
 * lower payout. Returns null for barriers with zero win probability
 * (Over 9, Under 0), which callers must reject rather than silently
 * falling back to some other rate.
 */
function overUnderPayoutRate(side, digit) {
  const prob = overUnderWinProbability(side, digit);
  if (!prob || prob <= 0 || prob > 1) return null;
  return Number(((1 / prob) * (1 - OVER_UNDER_HOUSE_EDGE)).toFixed(4));
}

/**
 * Explicit acceptability check for an over/under barrier, with a
 * human-readable reason so the API can tell the client exactly why a
 * trade was rejected (rather than a generic "invalid contract").
 *   - "over 9"   is unrealistic: no digit is ever greater than 9.
 *   - "under 0"  is unrealistic: no digit is ever less than 0.
 * Valid ranges: over 0-8, under 1-9. Anything outside 0-9 entirely
 * (non-integers, negatives, digit > 9) is also rejected here.
 */
function validateOverUnderBarrier(side, digit) {
  const d = Number(digit);
  if (!Number.isInteger(d) || d < 0 || d > 9) {
    return { valid: false, reason: "Digit must be a whole number between 0 and 9" };
  }
  if (side === "over" && d === 9) {
    return { valid: false, reason: "Over 9 is not a valid contract — no digit is ever greater than 9" };
  }
  if (side === "under" && d === 0) {
    return { valid: false, reason: "Under 0 is not a valid contract — no digit is ever less than 0" };
  }
  return { valid: true, reason: null };
}

/**
 * Looks up a per-instrument, per-side payout rate override. Falls back to:
 *   - overUnderPayoutRate(side, digit) for "over"/"under" (digit-aware), then
 *   - DEFAULT_SIDE_RATES for matches/differs/even/odd, then
 *   - settings.payoutRate as the last resort.
 * Returns null only when the side is over/under AND the digit makes the
 * contract unwinnable (Over 9, Under 0) AND there's no admin override —
 * callers must treat null as "reject this trade", not fall through further.
 */
async function resolvePayoutRate(symbolId, side, digit, settings) {
  if (symbolId) {
    const override = await PayoutRate.findOne({ symbolId, side });
    if (override) return override.rate;
  }
  if (side === "over" || side === "under") {
    return overUnderPayoutRate(side, digit);
  }
  if (DEFAULT_SIDE_RATES[side] !== undefined) return DEFAULT_SIDE_RATES[side];
  return settings.payoutRate;
}

/**
 * GET /api/trades/payout-rates
 * Public (logged-in-user) read access to current rates, keyed by
 * symbolId+side — e.g. { vol10: { matches: 1.95, differs: 1.056 } }.
 * Also returns overUnderRates, a precomputed digit->rate table for both
 * directions, since over/under rates depend on the digit and can't be
 * expressed as one constant per side the way sideDefaults can.
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

    const overUnderRates = { over: {}, under: {} };
    for (let d = 0; d <= 9; d++) {
      overUnderRates.over[d] = overUnderPayoutRate("over", d);
      overUnderRates.under[d] = overUnderPayoutRate("under", d);
    }

    res.json({
      defaultRate: settings.payoutRate,
      sideDefaults: DEFAULT_SIDE_RATES,
      overUnderRates,
      rates: bySymbol,
    });
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

    if (side === "over" || side === "under") {
      const barrierCheck = validateOverUnderBarrier(side, digit);
      if (!barrierCheck.valid) {
        return res.status(400).json({ error: barrierCheck.reason });
      }
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const balanceField = accountType === "demo" ? "demoBalance" : "realBalance";
    if (user[balanceField] < stakeAmt) return res.status(400).json({ error: "Insufficient balance" });

    const settings = await getSettings();
    const rate = await resolvePayoutRate(symbolId, side, digit, settings);
    if (rate === null || rate === undefined) {
      return res.status(400).json({ error: "No payout rate available for this contract" });
    }
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
