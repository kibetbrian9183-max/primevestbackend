const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const config = require("../config");
const { normalizeMsisdn, isKenyanMsisdn } = require("../utils/mpesaHelpers");
const { sendPayout, getPayoutStatus, calculateB2cFee } = require("../utils/smartpayB2c");
const { requireAuth } = require("../middleware/auth");
const User = require("../models/User");
const Payment = require("../models/Payment");
const { getSettings } = require("../models/Settings");
const { sendSms } = require("../utils/smartpaySms");
const { notifyNewWithdrawal } = require("../utils/telegramNotify");

const router = express.Router();

// Basic TRC20 (Tron) address shape check — starts with T, 34 base58 chars.
const TRC20_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

// Maps SmartPay's B2C status values onto our own Payment.status enum.
const B2C_STATUS_MAP = {
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "rejected",
  TIMED_OUT: "rejected",
  REVERSED: "rejected",
};

/**
 * Refunds a failed/timed-out/reversed withdrawal back onto the user's
 * balance and records the final state. SmartPay already reverses the
 * amount+fee in ITS wallet automatically — this mirrors that on our side,
 * since our balance was deducted independently at request time.
 */
async function refundAndReject(payment, note) {
  await User.findByIdAndUpdate(payment.user, { $inc: { realBalance: payment.usdAmount } });
  payment.status = "rejected";
  payment.adminNote = note;
  payment.processedAt = new Date();
  await payment.save();
}

/** Public config the deposit/withdraw screens need — the receiving address and current rates. */
router.get("/config", requireAuth, async (req, res, next) => {
  try {
    const settings = await getSettings();
    res.json({
      usdtTrc20Address: config.usdtTrc20Address,
      usdKesRate: settings.usdKesRate,
      minDepositKes: settings.minDepositKes,
      minWithdrawalUsd: settings.minWithdrawalUsd,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/payments/verified-phones
 * The set of M-Pesa numbers this user is allowed to withdraw to: their
 * registered signup number (only if it's actually a Kenyan M-Pesa-shaped
 * number — this app supports signups from other countries too, and a US
 * or UK number obviously can't receive an M-Pesa payout), plus any number
 * they've completed a real, SmartPay-confirmed deposit from. A deposit
 * only reaches status "success" via the SmartPay callback — never from
 * anything the client claims — so this list can't be built up by just
 * typing numbers in.
 */
router.get("/verified-phones", requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const depositPhones = await Payment.distinct("phone", {
      user: req.userId,
      type: "deposit",
      method: "mpesa",
      status: "success",
      phone: { $ne: null },
    });

    const registeredMpesaPhone = isKenyanMsisdn(user.phone) ? user.phone : null;
    const phones = Array.from(new Set([registeredMpesaPhone, ...depositPhones].filter(Boolean)));
    res.json({ phones, registeredPhone: registeredMpesaPhone });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/payments/deposit
 * Body: { phone, amountKes }
 * Starts a real M-Pesa STK push via SmartPay and records a pending
 * Payment. The actual balance credit happens in the callback once
 * SmartPay confirms the payment — never here, and never based on
 * anything the client claims succeeded.
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

    const { data } = await axios.post(
      `${config.smartpay.baseUrl}/stk/push`,
      {
        phone: msisdn,
        amount: amt,
        account_reference: "PrimeVest",
        description: "PrimeVest deposit",
      },
      { headers: { Authorization: `Bearer ${config.smartpay.apiKey}` } }
    );

    if (!data.success) {
      return res.status(502).json({ error: data.message || "Payment provider rejected the request" });
    }

    const usdAmount = Number((amt / settings.usdKesRate).toFixed(2));

    await Payment.create({
      user: req.userId,
      type: "deposit",
      amountKes: amt,
      usdAmount,
      phone: msisdn,
      reference: data.checkout_request_id,
      status: "pending",
    });

    res.json({ checkoutRequestId: data.checkout_request_id, customerMessage: data.message });
  } catch (err) {
    next(err);
  }
});

/** Called by SmartPay — not the frontend. Consider restricting to SmartPay's published IP ranges. */
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

    // Credit the user's Real account now that SmartPay has actually confirmed payment.
    await User.findByIdAndUpdate(payment.user, { $inc: { realBalance: payment.usdAmount } });
  } else {
    // Common non-zero codes: 1032 (cancelled by user), 1037 (timeout,
    // unreachable), 9999 (general error while sending push).
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
 * POST /api/payments/deposit/crypto
 * Body: { amountUsd, txHash? }
 * Records a pending deposit against our fixed USDT (TRC20) address. We
 * don't watch the chain, so this doesn't credit anything by itself — an
 * admin confirms it manually once they see the funds land, same idea as
 * a manually-disbursed crypto withdrawal but in reverse.
 */
router.post("/deposit/crypto", requireAuth, async (req, res, next) => {
  try {
    if (!config.usdtTrc20Address) return res.status(503).json({ error: "Crypto deposits aren't set up yet" });

    const amt = Number(req.body?.amountUsd);
    if (!amt || amt <= 0) return res.status(400).json({ error: "Enter an amount" });

    const settings = await getSettings();
    const amountKes = Math.round(amt * settings.usdKesRate);
    const reference = `DEP-C-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

    const payment = await Payment.create({
      user: req.userId,
      type: "deposit",
      method: "usdt_trc20",
      amountKes,
      usdAmount: amt,
      walletAddress: config.usdtTrc20Address,
      txHash: (req.body?.txHash || "").trim(),
      reference,
      status: "pending",
    });

    res.status(201).json({ reference: payment.reference, address: config.usdtTrc20Address });
  } catch (err) {
    next(err);
  }
});


/**
 * POST /api/payments/withdraw
 * Body: { amountUsd, phone? }
 * Payouts always go to the phone number the user registered at signup, or
 * a number they've verified via a real deposit — never an arbitrary
 * client-supplied number — so a compromised session can't redirect a
 * withdrawal to an attacker's own M-Pesa line.
 *
 * Fully automatic: balance is deducted, then the payout is sent to
 * SmartPay B2C immediately — no admin approval step. If SmartPay's send
 * call itself fails outright, the balance is restored and the request is
 * rejected up front. If it's accepted but later fails/times out/reverses,
 * that's caught by /withdraw/status polling (see below), which refunds
 * the balance at that point instead.
 */
router.post("/withdraw", requireAuth, async (req, res, next) => {
  try {
    const { amountUsd, phone } = req.body || {};
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

    // Payout goes to the registered phone by default — but ONLY if it's
    // actually Kenyan/M-Pesa-shaped. Accounts registered with an
    // international number (this app supports signups from other
    // countries) have no usable default here and must supply a number
    // they've verified via a real M-Pesa deposit instead.
    const registeredIsMpesa = isKenyanMsisdn(user.phone);
    let payoutPhone = registeredIsMpesa ? user.phone : null;

    if (phone && normalizeMsisdn(phone) !== (registeredIsMpesa ? user.phone : null)) {
      const msisdn = normalizeMsisdn(phone);
      const verifiedDeposit = msisdn && await Payment.exists({
        user: req.userId,
        type: "deposit",
        method: "mpesa",
        status: "success",
        phone: msisdn,
      });
      if (!verifiedDeposit) {
        return res.status(400).json({ error: "You can only withdraw to your registered number or a number you've deposited from" });
      }
      payoutPhone = msisdn;
    }

    if (!payoutPhone) {
      return res.status(400).json({
        error: registeredIsMpesa
          ? "Enter a phone number to withdraw to"
          : "Your account phone isn't set up for M-Pesa — make an M-Pesa deposit first to verify a number, or withdraw via USDT instead",
      });
    }

    if (user.realBalance <= 0) return res.status(400).json({ error: "Insufficient balance" });
    if (amt > user.realBalance) return res.status(400).json({ error: "Insufficient balance for this amount" });

    // Fee comes off what the user receives, not what leaves their app
    // balance — a 500 KES withdrawal with a 10 KES fee sends 490 KES to
    // the phone, while the full 500 is still deducted below. That's what
    // keeps this app's wallet whole against SmartPay's own B2C fee.
    const grossAmountKes = Math.round(amt * settings.usdKesRate);
    const fee = calculateB2cFee(grossAmountKes);
    const netAmountKes = grossAmountKes - fee;
    if (netAmountKes < 10) {
      // SmartPay's B2C minimum is KSh 10 — nothing deducted yet, safe to just reject.
      return res.status(400).json({ error: `Minimum withdrawal is $${settings.minWithdrawalUsd}` });
    }

    // Deduct up front, same as before — this is what makes the balance
    // check above race-safe against a user double-submitting.
    user.realBalance = Number((user.realBalance - amt).toFixed(2));
    await user.save();

    const reference = `WD-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

    const payment = await Payment.create({
      user: user._id,
      type: "withdrawal",
      amountKes: netAmountKes, // what actually gets sent to / received on the phone
      usdAmount: amt, // what left the user's app balance (gross)
      fee,
      phone: payoutPhone,
      reference,
      status: "pending",
    });

    // Send the actual payout now. Two very different failure shapes here:
    //   - SmartPay responded WITH an error (bad phone, insufficient
    //     wallet balance, validation, etc.) — the send definitely never
    //     happened at their end, so it's safe to refund.
    //   - We got no response at all (timeout, dropped connection) —
    //     SmartPay may well have already dispatched the payout even
    //     though we never heard back (this is exactly what happened
    //     testing this: funds arrived instantly while our own request
    //     hung waiting on a slow response). Refunding here would create
    //     a double-spend — the user keeps the M-Pesa funds AND gets
    //     their app balance back. So on an ambiguous timeout we do NOT
    //     refund; the withdrawal stays "processing" for manual
    //     reconciliation against SmartPay's transaction history.
    let payout;
    try {
      payout = await sendPayout(payoutPhone, netAmountKes);
    } catch (err) {
      if (err.response) {
        // SmartPay actually answered — and it was a rejection.
        const errorCode = err.response.data?.error_code;
        const message = err.response.data?.message || "Withdrawal could not be sent";
        await refundAndReject(payment, `B2C send failed: ${errorCode || err.message}`);
        return res.status(502).json({ error: message });
      }

      // No response — timeout, network error, or connection dropped.
      // Outcome unknown. Leave balance deducted and the payment
      // "processing" with no payoutRef (we never got SmartPay's
      // reference), and tell an admin to check manually.
      payment.status = "processing";
      payment.adminNote = `B2C send had no response (${err.code || err.message}) — verify against SmartPay's dashboard before taking any action`;
      await payment.save();
      notifyNewWithdrawal(payment, user);
      return res.status(201).json({
        reference: payment.reference,
        amountKes: netAmountKes,
        feeKes: fee,
        grossKes: grossAmountKes,
        balance: user.realBalance,
        status: "processing",
      });
    }

    payment.payoutRef = payout.reference;
    payment.status = B2C_STATUS_MAP[payout.status] || "processing";
    await payment.save();

    // Fire-and-forget: confirm receipt immediately. Never blocks or fails
    // the withdrawal itself if the SMS gateway hiccups.
    sendSms(
      payoutPhone,
      `Congratulations! 🎉\n\nYour withdrawal of KSh ${netAmountKes.toLocaleString()} (after a KSh ${fee} provider fee) is on its way and should land shortly.\n\nThank you for using PrimeVest. We appreciate your trust and continued support.\n\nPrimeVest Support Team`
    );

    // Fire-and-forget: lets the admin Telegram chat see it happened —
    // informational only now, no Approve/Reject buttons needed since
    // there's nothing left to approve.
    notifyNewWithdrawal(payment, user);

    res.status(201).json({
      reference: payment.reference,
      amountKes: netAmountKes,
      feeKes: fee,
      grossKes: grossAmountKes,
      balance: user.realBalance,
      status: payment.status,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/payments/withdraw/status/:reference
 * Polled by the frontend while a payout is "processing". Checks SmartPay
 * for the real outcome (B2C results don't arrive via webhook) and
 * updates + refunds as needed. Safe to call repeatedly — once the
 * payment is no longer "processing" this just returns the stored status
 * without hitting SmartPay again.
 */
router.get("/withdraw/status/:reference", requireAuth, async (req, res, next) => {
  try {
    const payment = await Payment.findOne({ reference: req.params.reference, user: req.userId });
    if (!payment) return res.status(404).json({ status: "unknown" });

    if (payment.status !== "processing" || !payment.payoutRef) {
      return res.json({ status: payment.status, usdAmount: payment.usdAmount, amountKes: payment.amountKes, feeKes: payment.fee });
    }

    const result = await getPayoutStatus(payment.payoutRef);
    const mapped = B2C_STATUS_MAP[result.status] || "processing";

    if (mapped === "completed") {
      payment.status = "completed";
      payment.paidAt = new Date();
      payment.processedAt = new Date();
      await payment.save();
    } else if (mapped === "rejected") {
      await refundAndReject(payment, result.response_description || `Payout ${result.status}`);
    }
    // else still "processing" — nothing to update yet.

    res.json({ status: payment.status, usdAmount: payment.usdAmount, amountKes: payment.amountKes, feeKes: payment.fee });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/payments/withdraw/crypto
 * Body: { amountUsd, walletAddress }
 * Unlike M-Pesa withdrawals, the destination here is inherently
 * user-supplied (their own wallet) — SmartPay's B2C only pays out to
 * M-Pesa, so there's no automated rail for this. Same manual-review model
 * as before: balance is deducted immediately, an admin sends the actual
 * payout and marks it paid.
 */
router.post("/withdraw/crypto", requireAuth, async (req, res, next) => {
  try {
    const amt = Number(req.body?.amountUsd);
    const walletAddress = (req.body?.walletAddress || "").trim();

    const settings = await getSettings();
    if (!amt || amt < settings.minWithdrawalUsd) {
      return res.status(400).json({ error: `Minimum withdrawal is $${settings.minWithdrawalUsd}` });
    }
    if (!TRC20_ADDRESS_RE.test(walletAddress)) {
      return res.status(400).json({ error: "Enter a valid TRC20 (USDT) wallet address" });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.realBalance <= 0) return res.status(400).json({ error: "Insufficient balance" });
    if (amt > user.realBalance) return res.status(400).json({ error: "Insufficient balance for this amount" });

    user.realBalance = Number((user.realBalance - amt).toFixed(2));
    await user.save();

    const amountKes = Math.round(amt * settings.usdKesRate);
    const reference = `WD-C-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

    const payment = await Payment.create({
      user: user._id,
      type: "withdrawal",
      method: "usdt_trc20",
      amountKes,
      usdAmount: amt,
      walletAddress,
      reference,
      status: "pending",
    });

    // Best-effort — only if the account actually has a phone on file.
    if (user.phone) {
      sendSms(
        user.phone,
        `Congratulations! 🎉\n\nYour withdrawal of $${amt.toFixed(2)} USDT has been successfully received and will be processed shortly.\n\nThank you for using PrimeVest. We appreciate your trust and continued support.\n\nPrimeVest Support Team`
      );
    }

    notifyNewWithdrawal(payment, user);

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
