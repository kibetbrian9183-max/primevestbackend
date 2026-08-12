const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const config = require("../config");
const { getAccessToken } = require("../utils/darajaAuth");
const {
  timestamp,
  stkPassword,
  normalizeMsisdn,
} = require("../utils/mpesaHelpers");

const { requireAuth } = require("../middleware/auth");

const User = require("../models/User");
const Payment = require("../models/Payment");
const { getSettings } = require("../models/Settings");

const { sendSms } = require("../utils/smartpaySms");

const router = express.Router();

// ============================================================
// TRC20 ADDRESS VALIDATION
// ============================================================

const TRC20_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;


// ============================================================
// PAYMENT CONFIG
// GET /api/payments/config
// ============================================================

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


// ============================================================
// M-PESA DEPOSIT
// POST /api/payments/deposit
//
// Body:
// {
//   phone: "0712345678",
//   amountKes: 1000
// }
// ============================================================

router.post("/deposit", requireAuth, async (req, res, next) => {
  try {
    const { phone, amountKes } = req.body || {};

    const msisdn = normalizeMsisdn(phone);
    const amt = Math.round(Number(amountKes));

    const settings = await getSettings();

    // Validate phone
    if (!msisdn) {
      return res.status(400).json({
        error: "Invalid phone number",
      });
    }

    // Validate amount
    if (!amt || amt < settings.minDepositKes) {
      return res.status(400).json({
        error: `Minimum deposit is KES ${settings.minDepositKes}`,
      });
    }

    // Get Daraja access token
    const token = await getAccessToken();

    // Generate timestamp
    const ts = timestamp();

    // STK Push
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
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Calculate USD value
    const usdAmount = Number(
      (amt / settings.usdKesRate).toFixed(2)
    );

    // Make sure Safaricom returned a CheckoutRequestID
    if (!data?.CheckoutRequestID) {
      return res.status(502).json({
        error: "M-Pesa did not return a checkout request ID",
        details: data,
      });
    }

    // Store pending payment
    await Payment.create({
      user: req.userId,
      type: "deposit",
      method: "mpesa",
      amountKes: amt,
      usdAmount,
      phone: msisdn,
      reference: data.CheckoutRequestID,
      status: "pending",
    });

    // Respond to frontend
    res.json({
      checkoutRequestId: data.CheckoutRequestID,
      customerMessage:
        data.CustomerMessage || "Check your phone and enter your M-Pesa PIN.",
    });
  } catch (err) {
    next(err);
  }
});


// ============================================================
// M-PESA DEPOSIT CALLBACK
// POST /api/payments/deposit/callback
//
// Called by Safaricom.
// NEVER trust the frontend to confirm a payment.
// ============================================================

router.post("/deposit/callback", async (req, res) => {
  try {
    const body = req.body?.Body?.stkCallback;

    if (!body) {
      return res.status(400).json({
        ResultCode: 1,
        ResultDesc: "Bad payload",
      });
    }

    const {
      CheckoutRequestID,
      ResultCode,
      ResultDesc,
      CallbackMetadata,
    } = body;

    // Find payment
    const payment = await Payment.findOne({
      reference: CheckoutRequestID,
    });

    // Unknown payment
    if (!payment) {
      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted",
      });
    }

    // ========================================================
    // IMPORTANT:
    // Prevent duplicate callback from crediting balance twice.
    // ========================================================

    if (payment.status === "success") {
      return res.json({
        ResultCode: 0,
        ResultDesc: "Already processed",
      });
    }

    // ========================================================
    // PAYMENT SUCCESS
    // ========================================================

    if (Number(ResultCode) === 0) {
      const items = Object.fromEntries(
        (CallbackMetadata?.Item || []).map((item) => [
          item.Name,
          item.Value,
        ])
      );

      payment.status = "success";

      payment.mpesaReceiptNumber =
        items.MpesaReceiptNumber || "";

      await payment.save();

      // Credit user's real balance only after Safaricom confirmation.
      await User.findByIdAndUpdate(
        payment.user,
        {
          $inc: {
            realBalance: payment.usdAmount,
          },
        }
      );

      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted",
      });
    }

    // ========================================================
    // PAYMENT FAILED / CANCELLED
    // ========================================================

    payment.status = "failed";
    payment.adminNote = ResultDesc || "M-Pesa payment failed";

    await payment.save();

    return res.json({
      ResultCode: 0,
      ResultDesc: "Accepted",
    });
  } catch (err) {
    console.error("M-Pesa callback error:", err);

    // Safaricom should still receive a valid response.
    return res.json({
      ResultCode: 0,
      ResultDesc: "Accepted",
    });
  }
});


// ============================================================
// M-PESA DEPOSIT STATUS
// GET /api/payments/deposit/status/:reference
// ============================================================

router.get(
  "/deposit/status/:reference",
  requireAuth,
  async (req, res, next) => {
    try {
      const payment = await Payment.findOne({
        reference: req.params.reference,
        user: req.userId,
      });

      if (!payment) {
        return res.status(404).json({
          status: "unknown",
        });
      }

      res.json({
        status: payment.status,
        usdAmount: payment.usdAmount,
        amountKes: payment.amountKes,
        reference: payment.reference,
      });
    } catch (err) {
      next(err);
    }
  }
);


// ============================================================
// CRYPTO DEPOSIT
// POST /api/payments/deposit/crypto
//
// Body:
// {
//   amountUsd: 10,
//   txHash: "optional transaction hash"
// }
// ============================================================

router.post(
  "/deposit/crypto",
  requireAuth,
  async (req, res, next) => {
    try {
      if (!config.usdtTrc20Address) {
        return res.status(503).json({
          error: "Crypto deposits aren't set up yet",
        });
      }

      const amt = Number(req.body?.amountUsd);

      if (!amt || amt <= 0) {
        return res.status(400).json({
          error: "Enter a valid amount",
        });
      }

      const settings = await getSettings();

      const amountKes = Math.round(
        amt * settings.usdKesRate
      );

      const reference =
        `DEP-C-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

      const payment = await Payment.create({
        user: req.userId,
        type: "deposit",
        method: "usdt_trc20",
        amountKes,
        usdAmount: Number(amt.toFixed(2)),
        walletAddress: config.usdtTrc20Address,
        txHash: (req.body?.txHash || "").trim(),
        reference,
        status: "pending",
      });

      res.status(201).json({
        reference: payment.reference,
        address: config.usdtTrc20Address,
        amountUsd: payment.usdAmount,
        amountKes,
        status: payment.status,
      });
    } catch (err) {
      next(err);
    }
  }
);


// ============================================================
// M-PESA WITHDRAWAL
// POST /api/payments/withdraw
//
// Body:
// {
//   amountUsd: 10
// }
//
// The withdrawal is sent to the phone number registered
// on the user's account.
// ============================================================

router.post(
  "/withdraw",
  requireAuth,
  async (req, res, next) => {
    try {
      const { amountUsd } = req.body || {};

      const amt = Number(amountUsd);

      const settings = await getSettings();

      // Validate amount
      if (!amt || amt < settings.minWithdrawalUsd) {
        return res.status(400).json({
          error: `Minimum withdrawal is $${settings.minWithdrawalUsd}`,
        });
      }

      // Find user
      const user = await User.findById(req.userId);

      if (!user) {
        return res.status(404).json({
          error: "User not found",
        });
      }

      // Registered phone is required
      if (!user.phone) {
        return res.status(400).json({
          error:
            "Add a phone number to your account in Settings before withdrawing",
        });
      }

      // Check balance
      if (Number(user.realBalance) <= 0) {
        return res.status(400).json({
          error: "Insufficient balance",
        });
      }

      if (amt > Number(user.realBalance)) {
        return res.status(400).json({
          error: "Insufficient balance for this amount",
        });
      }

      // Round amount
      const withdrawalAmount = Number(
        amt.toFixed(2)
      );

      // Deduct balance
      user.realBalance = Number(
        (Number(user.realBalance) - withdrawalAmount).toFixed(2)
      );

      await user.save();

      // Convert USD to KES
      const amountKes = Math.round(
        withdrawalAmount * settings.usdKesRate
      );

      // Generate withdrawal reference
      const reference =
        `WD-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

      // Create pending withdrawal
      const payment = await Payment.create({
        user: user._id,
        type: "withdrawal",
        method: "mpesa",
        amountKes,
        usdAmount: withdrawalAmount,
        phone: user.phone,
        reference,
        status: "pending",
      });

      // Send confirmation SMS.
      // This does NOT mean the actual payout has been sent.
      try {
        await sendSms(
          user.phone,
          `Congratulations! 🎉

Your withdrawal of KSh ${amountKes.toLocaleString()} has been successfully received and will be processed shortly.

Thank you for using PrimeVest. We appreciate your trust and continued support.

PrimeVest Support Team`
        );
      } catch (smsError) {
        console.error(
          "Withdrawal SMS failed:",
          smsError.message
        );
      }

      res.status(201).json({
        reference: payment.reference,
        amountUsd: withdrawalAmount,
        amountKes,
        balance: user.realBalance,
        status: payment.status,
      });
    } catch (err) {
      next(err);
    }
  }
);


// ============================================================
// CRYPTO WITHDRAWAL
// POST /api/payments/withdraw/crypto
//
// Body:
// {
//   amountUsd: 10,
//   walletAddress: "TRC20 ADDRESS"
// }
// ============================================================

router.post(
  "/withdraw/crypto",
  requireAuth,
  async (req, res, next) => {
    try {
      const amt = Number(req.body?.amountUsd);

      const walletAddress =
        (req.body?.walletAddress || "").trim();

      const settings = await getSettings();

      // Validate amount
      if (!amt || amt < settings.minWithdrawalUsd) {
        return res.status(400).json({
          error: `Minimum withdrawal is $${settings.minWithdrawalUsd}`,
        });
      }

      // Validate TRC20 wallet
      if (!TRC20_ADDRESS_RE.test(walletAddress)) {
        return res.status(400).json({
          error: "Enter a valid TRC20 (USDT) wallet address",
        });
      }

      // Find user
      const user = await User.findById(req.userId);

      if (!user) {
        return res.status(404).json({
          error: "User not found",
        });
      }

      // Check balance
      if (Number(user.realBalance) <= 0) {
        return res.status(400).json({
          error: "Insufficient balance",
        });
      }

      if (amt > Number(user.realBalance)) {
        return res.status(400).json({
          error: "Insufficient balance for this amount",
        });
      }

      const withdrawalAmount = Number(
        amt.toFixed(2)
      );

      // Deduct balance
      user.realBalance = Number(
        (Number(user.realBalance) - withdrawalAmount).toFixed(2)
      );

      await user.save();

      // Convert USD to KES
      const amountKes = Math.round(
        withdrawalAmount * settings.usdKesRate
      );

      // Generate reference
      const reference =
        `WD-C-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

      // Create pending crypto withdrawal
      const payment = await Payment.create({
        user: user._id,
        type: "withdrawal",
        method: "usdt_trc20",
        amountKes,
        usdAmount: withdrawalAmount,
        walletAddress,
        reference,
        status: "pending",
      });

      // Send SMS if phone exists
      if (user.phone) {
        try {
          await sendSms(
            user.phone,
            `Congratulations! 🎉

Your withdrawal of $${withdrawalAmount.toFixed(2)} USDT has been successfully received and will be processed shortly.

Thank you for using PrimeVest. We appreciate your trust and continued support.

PrimeVest Support Team`
          );
        } catch (smsError) {
          console.error(
            "Crypto withdrawal SMS failed:",
            smsError.message
          );
        }
      }

      res.status(201).json({
        reference: payment.reference,
        amountUsd: withdrawalAmount,
        amountKes,
        balance: user.realBalance,
        status: payment.status,
      });
    } catch (err) {
      next(err);
    }
  }
);


// ============================================================
// GET USER PAYMENT HISTORY
// GET /api/payments/
// ============================================================

router.get(
  "/",
  requireAuth,
  async (req, res, next) => {
    try {
      const payments = await Payment.find({
        user: req.userId,
      })
        .sort({ createdAt: -1 })
        .limit(200);

      res.json({
        payments,
      });
    } catch (err) {
      next(err);
    }
  }
);


// ============================================================
// EXPORT ROUTER
// ============================================================

module.exports = router;
