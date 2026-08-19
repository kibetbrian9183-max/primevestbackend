const express = require("express");
const User = require("../models/User");
const Settings = require("../models/Settings");
const PayoutRate = require("../models/PayoutRate");
const { sendMessage, editMessage, answerCallbackQuery } = require("../utils/telegramBot");
const {
  approvedMessage,
  approvedKeyboard,
  rejectedMessage,
  completedMessage,
} = require("../utils/telegramMessages");
const {
  PaymentActionError,
  approveWithdrawal,
  rejectWithdrawal,
  markWithdrawalPaid,
  confirmProcessingPaid,
} = require("../services/paymentActions");

const router = express.Router();

const CALLBACK_RE = /^(wd_approve|wd_reject|wd_paid|wd_confirm_paid):(.+)$/;

// Same instrument ids as the frontend's SYMBOLS array (App.jsx) — kept
// here as a validation list so a typo in a Telegram command gets a clear
// error instead of silently creating a PayoutRate for an instrument that
// doesn't exist on the trade screen.
const VALID_SYMBOLS = ["vol10", "vol25", "vol50", "vol75", "vol100"];
const VALID_SIDES = ["matches", "differs", "even", "odd", "over", "under"];

function friendlyErrorText(err) {
  if (err.code === "not_found") return "Withdrawal not found.";
  if (err.code === "wrong_type") return "That's not a withdrawal.";
  if (err.code === "bad_transition") return `Already processed — ${err.message}`;
  return "Something went wrong.";
}

function isAuthorizedSender(fromId, chatId) {
  const configuredChatId = String(process.env.TELEGRAM_CHAT_ID || "");
  return configuredChatId && String(fromId) === configuredChatId && String(chatId) === configuredChatId;
}

/**
 * Formats the current payout-rate picture: every instrument/side that
 * has an explicit admin override, plus a reminder of what unconfigured
 * combinations fall back to. Mirrors DEFAULT_SIDE_RATES in
 * routes/trades.js — if that table changes, update this text too.
 */
async function formatRatesList() {
  const overrides = await PayoutRate.find().sort({ symbolId: 1, side: 1 });
  const settings = await Settings.getSettings();

  const lines = ["📊 PAYOUT RATES", ""];
  if (overrides.length === 0) {
    lines.push("No per-instrument overrides set yet — everything is using the side defaults below.");
  } else {
    lines.push("Overrides:");
    for (const o of overrides) {
      const pct = ((o.rate - 1) * 100).toFixed(1);
      lines.push(`  ${o.symbolId} / ${o.side}: ${pct}% (rate ${o.rate})`);
    }
  }
  lines.push("");
  lines.push("Side defaults (used when no override exists):");
  lines.push("  matches: 850.0% (rate 9.5)");
  lines.push("  differs: 5.6% (rate 1.056)");
  lines.push("  even/odd: 95.0% (rate 1.95)");
  lines.push(`  over/under: ${((settings.payoutRate - 1) * 100).toFixed(1)}% — from global settings (rate ${settings.payoutRate})`);
  lines.push("");
  lines.push("Commands:");
  lines.push("/setrate <symbol> <side> <percent> — e.g. /setrate vol10 matches 950");
  lines.push("/delrate <symbol> <side> — remove an override");
  lines.push(`Symbols: ${VALID_SYMBOLS.join(", ")}`);
  lines.push(`Sides: ${VALID_SIDES.join(", ")}`);
  return lines.join("\n");
}

/**
 * Handles /setrate and /delrate text commands from the admin chat. Text
 * commands (not inline buttons) since this needs free-form input — an
 * instrument, a side, and a number — that buttons can't collect.
 */
async function handleTextCommand(text, senderId) {
  const trimmed = text.trim();

  if (trimmed === "/rates" || trimmed === "/payoutrates") {
    return formatRatesList();
  }

  const setMatch = /^\/setrate\s+(\S+)\s+(\S+)\s+(-?\d+(\.\d+)?)$/i.exec(trimmed);
  if (setMatch) {
    const [, symbolId, side, percentStr] = setMatch;
    if (!VALID_SYMBOLS.includes(symbolId)) {
      return `⚠️ Unknown symbol "${symbolId}". Valid: ${VALID_SYMBOLS.join(", ")}`;
    }
    if (!VALID_SIDES.includes(side)) {
      return `⚠️ Unknown side "${side}". Valid: ${VALID_SIDES.join(", ")}`;
    }
    const percent = Number(percentStr);
    const rate = 1 + percent / 100;
    if (!(rate > 1)) {
      return "⚠️ Percent must be a positive number (e.g. 950 for a 950% payout).";
    }

    await PayoutRate.findOneAndUpdate(
      { symbolId, side },
      { $set: { rate, updatedByAdmin: `telegram:${senderId}` } },
      { upsert: true }
    );
    return `✅ ${symbolId} / ${side} set to ${percent}% (rate ${rate.toFixed(4)})`;
  }

  const delMatch = /^\/delrate\s+(\S+)\s+(\S+)$/i.exec(trimmed);
  if (delMatch) {
    const [, symbolId, side] = delMatch;
    const deleted = await PayoutRate.findOneAndDelete({ symbolId, side });
    if (!deleted) return `⚠️ No override found for ${symbolId} / ${side} — nothing to delete.`;
    return `✅ Removed override for ${symbolId} / ${side}. It now falls back to the side default.`;
  }

  return null; // not a recognized command — caller decides what to do
}

/**
 * POST /api/telegram/webhook
 *
 * Handles two kinds of updates from Telegram:
 *   - callback_query: inline button presses (withdrawal approve/reject/paid)
 *   - message: plain text commands (/rates, /setrate, /delrate)
 *
 * Security, in order, for BOTH kinds:
 *   1. Optional shared-secret header (X-Telegram-Bot-Api-Secret-Token),
 *      set via TELEGRAM_WEBHOOK_SECRET + Telegram's setWebhook secret_token
 *      param — proves the request actually came from Telegram's servers.
 *   2. The sender AND the chat it was sent in must both match
 *      TELEGRAM_CHAT_ID — proves it's the configured admin, not just
 *      anyone who can message the bot.
 * Both checks happen BEFORE any database lookup or mutation.
 */
router.post("/webhook", async (req, res) => {
  const done = () => res.sendStatus(200);

  if (process.env.TELEGRAM_WEBHOOK_SECRET) {
    const header = req.header("X-Telegram-Bot-Api-Secret-Token");
    if (header !== process.env.TELEGRAM_WEBHOOK_SECRET) {
      console.warn("[telegram webhook] rejected — bad or missing secret token header");
      return res.sendStatus(401);
    }
  }

  const update = req.body || {};

  // --- Plain text commands (/rates, /setrate, /delrate) ---
  if (update.message?.text) {
    const senderId = update.message.from?.id;
    const chatId = update.message.chat?.id;
    if (!isAuthorizedSender(senderId, chatId)) {
      console.warn(`[telegram webhook] unauthorized command attempt from user ${senderId} in chat ${chatId}`);
      return done(); // silently ignore — don't confirm a command syntax to a non-admin
    }
    try {
      const reply = await handleTextCommand(update.message.text, senderId);
      if (reply) await sendMessage(reply);
    } catch (err) {
      console.error("[telegram webhook] error handling text command:", err);
      await sendMessage("⚠️ Something went wrong processing that command — check server logs.");
    }
    return done();
  }

  // --- Inline button presses (withdrawal actions) ---
  const cq = update.callback_query;
  if (!cq) return done();

  if (!isAuthorizedSender(cq.from?.id, cq.message?.chat?.id)) {
    console.warn(`[telegram webhook] unauthorized action attempt from user ${cq.from?.id} in chat ${cq.message?.chat?.id}`);
    await answerCallbackQuery(cq.id, "❌ Unauthorized admin action.", true);
    return done();
  }

  const match = CALLBACK_RE.exec(cq.data || "");
  if (!match) {
    await answerCallbackQuery(cq.id, "Unrecognized action.");
    return done();
  }

  const [, action, reference] = match;
  const actor = `telegram:${cq.from.id}`;

  try {
    let payment;
    let text;
    let keyboard = [];

    if (action === "wd_approve") {
      payment = await approveWithdrawal(reference, actor);
      const user = await User.findById(payment.user);
      text = approvedMessage(payment, user);
      keyboard = approvedKeyboard(payment.reference);
    } else if (action === "wd_reject") {
      payment = await rejectWithdrawal(reference, actor);
      const user = await User.findById(payment.user);
      text = rejectedMessage(payment, user);
    } else if (action === "wd_paid") {
      payment = await markWithdrawalPaid(reference, actor);
      const user = await User.findById(payment.user);
      text = completedMessage(payment, user);
    } else if (action === "wd_confirm_paid") {
      payment = await confirmProcessingPaid(reference, actor);
      const user = await User.findById(payment.user);
      text = completedMessage(payment, user);
    }

    if (cq.message?.chat?.id && cq.message?.message_id) {
      await editMessage(cq.message.chat.id, cq.message.message_id, text, keyboard);
    }
    await answerCallbackQuery(cq.id, "✅ Done");
  } catch (err) {
    if (err instanceof PaymentActionError) {
      await answerCallbackQuery(cq.id, `⚠️ ${friendlyErrorText(err)}`, true);
    } else {
      console.error("[telegram webhook] unexpected error handling", action, reference, err);
      await answerCallbackQuery(cq.id, "⚠️ Something went wrong — check server logs.", true);
    }
  }

  return done();
});

module.exports = router;
