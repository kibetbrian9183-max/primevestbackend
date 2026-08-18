const Payment = require("../models/Payment");
const { sendMessage } = require("./telegramBot");
const {
  newWithdrawalMessage,
  newWithdrawalKeyboard,
  ambiguousWithdrawalMessage,
  ambiguousWithdrawalKeyboard,
} = require("./telegramMessages");

/**
 * Fire-and-forget by design — called right after a withdrawal is already
 * saved as "pending" in MongoDB (see routes/payments.js). If Telegram is
 * unreachable or misconfigured, the withdrawal must NOT be lost or rolled
 * back; it just sits pending until an admin processes it through the
 * regular admin dashboard instead. Never throws.
 */
async function notifyNewWithdrawal(payment, user) {
  try {
    const result = await sendMessage(
      newWithdrawalMessage(payment, user),
      newWithdrawalKeyboard(payment.reference)
    );
    if (result?.ok && result.result?.message_id) {
      await Payment.findByIdAndUpdate(payment._id, { telegramMessageId: result.result.message_id });
    } else {
      console.error("[telegramNotify] withdrawal notification not sent:", payment.reference, result);
    }
  } catch (err) {
    console.error("[telegramNotify] unexpected error sending withdrawal notification:", err);
  }
}

/**
 * Same fire-and-forget contract as notifyNewWithdrawal, but for the
 * ambiguous-timeout case: SmartPay's B2C send call got no response, so
 * the withdrawal is sitting "processing" with no payoutRef. This sends a
 * visually distinct alert (⚠️ NEEDS MANUAL CHECK) with Mark Paid / Refund
 * buttons instead of the normal Approve/Reject ones, since there's
 * nothing left to "approve" — the send either already happened or didn't.
 */
async function notifyAmbiguousWithdrawal(payment, user) {
  try {
    const result = await sendMessage(
      ambiguousWithdrawalMessage(payment, user),
      ambiguousWithdrawalKeyboard(payment.reference)
    );
    if (result?.ok && result.result?.message_id) {
      await Payment.findByIdAndUpdate(payment._id, { telegramMessageId: result.result.message_id });
    } else {
      console.error("[telegramNotify] ambiguous withdrawal notification not sent:", payment.reference, result);
    }
  } catch (err) {
    console.error("[telegramNotify] unexpected error sending ambiguous withdrawal notification:", err);
  }
}

module.exports = { notifyNewWithdrawal, notifyAmbiguousWithdrawal };
