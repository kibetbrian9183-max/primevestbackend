const express = require("express");
const User = require("../models/User");
const Trade = require("../models/Trade");
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
 * POST /api/trades
 * Opens a trade: validates + deducts the stake server-side so a client
 * can't spoof its own balance, then returns the trade id to resolve later.
 */
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const { accountType, symbolLabel, market, marketLabel, side, sideLabel, digit, stake } = req.body || {};
    const stakeAmt = Number(stake);

    if (!["demo", "real"].includes(accountType)) return res.status(400).json({ error: "Invalid account type" });
    if (!stakeAmt || stakeAmt <= 0) return res.status(400).json({ error: "Invalid stake" });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const balanceField = accountType === "demo" ? "demoBalance" : "realBalance";
    if (user[balanceField] < stakeAmt) return res.status(400).json({ error: "Insufficient balance" });

    const settings = await getSettings();
    const payout = Number((stakeAmt * settings.payoutRate).toFixed(2));

    user[balanceField] = Number((user[balanceField] - stakeAmt).toFixed(2));
    await user.save();

    const trade = await Trade.create({
      user: user._id,
      accountType,
      symbolLabel,
      market,
      marketLabel,
      side,
      sideLabel,
      digit,
      stake: stakeAmt,
      payout,
      status: "open",
    });

    res.status(201).json({ tradeId: trade._id, balance: user[balanceField] });
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
