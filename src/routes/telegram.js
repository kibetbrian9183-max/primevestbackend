const express = require("express");
const User = require("../models/User");
const { editMessage, answerCallbackQuery } = require("../utils/telegramBot");
const { approvedMessage, approvedKeyboard, rejectedMessage, completedMessage } = require("../utils/telegramMessages");
const {
  PaymentActionError,
  approveWithdrawal,
  rejectWithdrawal,
  markWithdrawalPaid,
} = require("../services/paymentActions");

const router = express.Router();

const CALLBACK_RE = /^(wd_approve|wd_reject|wd_paid):(.+)$/;

function friendlyErrorText(err) {
  if (err.code === "not_found") return "Withdrawal not found.";
  if (err.code === "wrong_type") return "That's not a withdrawal.";
  if (err.code === "bad_transition") return `Already processed — ${err.message}`;
  return "Something went wrong.";
}

/**
 * POST /api/telegram/webhook
 *
 * Telegram calls this on every update for the bot. We only act on
 * callback_query updates (inline button presses) with recognized
 * withdrawal action data — everything else gets a bare 200 and is ignored.
 *
 * Security, in order:
 *   1. Optional shared-secret header (X-Telegram-Bot-Api-Secret-Token),
 *      set via TELEGRAM_WEBHOOK_SECRET + Telegram's setWebhook secret_token
 *      param — proves the request actually came from Telegram's servers,
 *      not someone who found/guessed this URL.
 *   2. The callback's sender (from.id) AND the chat it was sent in
 *      (message.chat.id) must both match TELEGRAM_CHAT_ID — proves it's
 *      the configured admin, not just anyone who can message the bot.
 * Both checks happen BEFORE any database lookup or mutation.
 */
router.post("/webhook", async (req, res) => {
  // Always acknowledge quickly with 200 once we've done our work — Telegram
  // retries/backs off a webhook that doesn't respond, which we don't want
  // for updates we're intentionally ignoring.
  const done = () => res.sendStatus(200);

  if (process.env.TELEGRAM_WEBHOOK_SECRET) {
    const header = req.header("X-Telegram-Bot-Api-Secret-Token");
    if (header !== process.env.TELEGRAM_WEBHOOK_SECRET) {
      console.warn("[telegram webhook] rejected — bad or missing secret token header");
      return res.sendStatus(401);
    }
  }

  const update = req.body || {};
  const cq = update.callback_query;
  if (!cq) return done(); // not a button press — nothing for us to do

  const configuredChatId = String(process.env.TELEGRAM_CHAT_ID || "");
  const senderId = String(cq.from?.id || "");
  const chatId = String(cq.message?.chat?.id || "");

  if (!configuredChatId || senderId !== configuredChatId || chatId !== configuredChatId) {
    console.warn(`[telegram webhook] unauthorized action attempt from user ${senderId} in chat ${chatId}`);
    await answerCallbackQuery(cq.id, "❌ Unauthorized admin action.", true);
    return done(); // deliberately does NOT touch the database
  }

  const match = CALLBACK_RE.exec(cq.data || "");
  if (!match) {
    await answerCallbackQuery(cq.id, "Unrecognized action.");
    return done();
  }

  const [, action, reference] = match;
  const actor = `telegram:${senderId}`;

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
