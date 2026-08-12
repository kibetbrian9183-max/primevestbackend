const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const config = require("../config");
const { getAccessToken } = require("../utils/darajaAuth");
const { timestamp, stkPassword, normalizeMsisdn } = require("../utils/mpesaHelpers");
const { requireAuth } = require("../middleware/auth");
const User = require("../models/User");
const Payment = require("../models/Payment");
const { getSettings } = require("../models/Settings");

const router = express.Router();

/**
 * POST /api/payments/deposit
 * Body: { phone, amountKes }
 * Starts a real M-Pesa STK push and records a pending Payment. The
 * actual balance credit happens in the callback once Safaricom
 * confirms the payment — never here, and never based on anything the
 * client claims succeeded.
 */
router.post("/deposit", requireAuth, async (req, res, next) => {
  try {
    const { phone, amountKes } = req.body || {};
    const msisdn = normalizeMsisdn(phone);
    const amt = Math.round(Number(amountKes));

    const settings = await getSettings();
    if (!msisdn) return res.status(400).json({ error: "Invalid phone number" });
    if (!amt || amt < settings.minDepositKes) {
      return res.status(400).json({ error: `Minimum deposit is KES ${settings.minDepositKes}` });
    }

    const token = await getAccessToken();
    const ts = timestamp();

    const { data } = await axios.post(
      `${config.daraja.baseUrl}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: config.daraja.shortcode,
        Password: stkPassword(ts),
        Timestamp: ts,
        TransactionType: "CustomerPayBillOnline",
        Amount: amt,
        PartyA: msisdn,
        PartyB: config.daraja.shortcode,
        PhoneNumber: msisdn,
        CallBackURL: config.daraja.stkCallbackUrl,
        AccountReference: "PrimeVest",
        TransactionDesc: "PrimeVest deposit",
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const usdAmount = Number((amt / settings.usdKesRate).toFixed(2));

    await Payment.create({
      user: req.userId,
      type: "deposit",
      amountKes: amt,
      usdAmount,
      phone: msisdn,
      reference: data.CheckoutRequestID,
      status: "pending",
    });

    res.json({ checkoutRequestId: data.CheckoutRequestID, customerMessage: data.CustomerMessage });
  } catch (err) {
    next(err);
  }
});

/** Called by Safaricom — not the frontend. See stk.js history for IP-allowlist notes. */
router.post("/deposit/callback", async (req, res) => {
  const body = req.body?.Body?.stkCallback;
  if (!body) return res.status(400).json({ ResultCode: 1, ResultDesc: "Bad payload" });

  const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = body;
  const payment = await Payment.findOne({ reference: CheckoutRequestID });
  if (!payment) return res.json({ ResultCode: 0, ResultDesc: "Accepted" }); // unknown ref, nothing to do

  if (ResultCode === 0) {
    const items = Object.fromEntries((CallbackMetadata?.Item || []).map((i) => [i.Name, i.Value]));
    payment.status = "success";
    payment.mpesaReceiptNumber = items.MpesaReceiptNumber;
    await payment.save();

    // Credit the user's Real account now that Safaricom has actually confirmed payment.
    await User.findByIdAndUpdate(payment.user, { $inc: { realBalance: payment.usdAmount } });
  } else {
    payment.status = "failed";
    payment.adminNote = ResultDesc;
    await payment.save();
  }

  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

/** Polled by the frontend while showing "Check your phone". */
router.get("/deposit/status/:reference", requireAuth, async (req, res, next) => {
  try {
    const payment = await Payment.findOne({ reference: req.params.reference, user: req.userId });
    if (!payment) return res.status(404).json({ status: "unknown" });
    res.json({ status: payment.status, usdAmount: payment.usdAmount, amountKes: payment.amountKes });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/payments/withdraw
 * Body: { amountUsd }
 * Payouts always go to the phone number the user registered at signup —
 * never a client-supplied number — so a compromised session can't be used
 * to redirect a withdrawal to an attacker's own M-Pesa line.
 * No live B2C payout is wired up — this validates against the real
 * balance, deducts it immediately, and records a pending withdrawal
 * for an admin to disburse manually and mark paid.
 */
router.post("/withdraw", requireAuth, async (req, res, next) => {
  try {
    const { amountUsd } = req.body || {};
    const amt = Number(amountUsd);

    const settings = await getSettings();
    if (!amt || amt < settings.minWithdrawalUsd) {
      return res.status(400).json({ error: `Minimum withdrawal is $${settings.minWithdrawalUsd}` });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.phone) {
      return res.status(400).json({ error: "Add a phone number to your account in Settings before withdrawing" });
    }
    if (user.realBalance <= 0) return res.status(400).json({ error: "Insufficient balance" });
    if (amt > user.realBalance) return res.status(400).json({ error: "Insufficient balance for this amount" });

    user.realBalance = Number((user.realBalance - amt).toFixed(2));
    await user.save();

    const amountKes = Math.round(amt * settings.usdKesRate);
    const reference = `WD-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

    const payment = await Payment.create({
      user: user._id,
      type: "withdrawal",
      amountKes,
      usdAmount: amt,
      phone: user.phone,
      reference,
      status: "pending",
    });

    res.status(201).json({ reference: payment.reference, amountKes, balance: user.realBalance });
  } catch (err) {
    next(err);
  }
});

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const payments = await Payment.find({ user: req.userId }).sort({ createdAt: -1 }).limit(200);
    res.json({ payments });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
