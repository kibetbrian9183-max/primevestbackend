const Payment = require("../models/Payment");
const { sendMessage } = require("./telegramBot");
const { newWithdrawalMessage, newWithdrawalKeyboard } = require("./telegramMessages");

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

module.exports = { notifyNewWithdrawal };
