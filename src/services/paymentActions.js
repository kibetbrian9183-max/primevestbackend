const Payment = require("../models/Payment");
const User = require("../models/User");
const AdminAuditLog = require("../models/AdminAuditLog");

/**
 * Typed error so callers (REST routes, Telegram webhook) can map to the
 * right response without string-matching messages.
 *   "not_found"     — no payment with that id/reference
 *   "wrong_type"    — e.g. tried to approve a deposit as a withdrawal
 *   "bad_transition" — payment exists but isn't in the state this action requires
 */
class PaymentActionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function log(payment, action, previousStatus, actor, note = "") {
  await AdminAuditLog.create({
    payment: payment._id,
    paymentReference: payment.reference,
    action,
    previousStatus,
    newStatus: payment.status,
    actor,
    note,
  });
}

function findPaymentQuery(idOrRef) {
  // Accepts either a Mongo _id or the human-facing "WD-XXXX" / "DEP-C-XXXX"
  // reference string — Telegram callback_data uses the reference since
  // it's shorter and more legible in a message than a full ObjectId.
  return /^[a-f0-9]{24}$/i.test(idOrRef) ? { _id: idOrRef } : { reference: idOrRef };
}

/**
 * pending -> approved. Doesn't move any money and doesn't touch the
 * user's balance (that already happened at withdrawal-request time — see
 * routes/payments.js). This just records that an admin has signed off,
 * distinct from the payout having actually been sent.
 */
async function approveWithdrawal(idOrRef, actor) {
  const existing = await Payment.findOne(findPaymentQuery(idOrRef));
  if (!existing) throw new PaymentActionError("not_found", "Withdrawal not found");
  if (existing.type !== "withdrawal") throw new PaymentActionError("wrong_type", "Not a withdrawal");

  const updated = await Payment.findOneAndUpdate(
    { _id: existing._id, status: "pending" }, // atomic guard — only transitions from pending
    { $set: { status: "approved", processedByAdmin: actor, processedAt: new Date() } },
    { new: true }
  );
  if (!updated) throw new PaymentActionError("bad_transition", "This withdrawal is no longer pending");

  await log(updated, "approve", "pending", actor);
  return updated;
}

/**
 * pending OR approved -> rejected, and refunds the user's Real balance —
 * reusing the exact same $inc pattern the existing REST route already
 * used, not a second balance mechanism.
 */
async function rejectWithdrawal(idOrRef, actor, note = "") {
  const existing = await Payment.findOne(findPaymentQuery(idOrRef));
  if (!existing) throw new PaymentActionError("not_found", "Withdrawal not found");
  if (existing.type !== "withdrawal") throw new PaymentActionError("wrong_type", "Not a withdrawal");

  const previousStatus = existing.status;
  const updated = await Payment.findOneAndUpdate(
    { _id: existing._id, status: { $in: ["pending", "approved"] } },
    { $set: { status: "rejected", processedByAdmin: actor, processedAt: new Date(), adminNote: note || "Rejected by admin" } },
    { new: true }
  );
  if (!updated) throw new PaymentActionError("bad_transition", "This withdrawal can't be rejected from its current state");

  await User.findByIdAndUpdate(updated.user, { $inc: { realBalance: updated.usdAmount } });
  await log(updated, "reject", previousStatus, actor, note);
  return updated;
}

/**
 * approved -> completed. This is the ONLY transition that means money
 * actually left — it must never be reachable directly from "pending",
 * which is what keeps "approve" from silently doubling as "paid".
 */
async function markWithdrawalPaid(idOrRef, actor) {
  const existing = await Payment.findOne(findPaymentQuery(idOrRef));
  if (!existing) throw new PaymentActionError("not_found", "Withdrawal not found");
  if (existing.type !== "withdrawal") throw new PaymentActionError("wrong_type", "Not a withdrawal");

  const now = new Date();
  const updated = await Payment.findOneAndUpdate(
    { _id: existing._id, status: "approved" },
    { $set: { status: "completed", processedByAdmin: actor, processedAt: now, paidAt: now } },
    { new: true }
  );
  if (!updated) throw new PaymentActionError("bad_transition", "This withdrawal must be approved before it can be marked paid");

  await log(updated, "mark_paid", "approved", actor);
  return updated;
}

/** pending -> success, and credits the user's Real balance. Crypto deposits only. */
async function confirmCryptoDeposit(idOrRef, actor, { txHash, note } = {}) {
  const existing = await Payment.findOne(findPaymentQuery(idOrRef));
  if (!existing) throw new PaymentActionError("not_found", "Deposit not found");
  if (existing.type !== "deposit" || existing.method !== "usdt_trc20") {
    throw new PaymentActionError("wrong_type", "Only pending crypto deposits can be confirmed here");
  }

  const patch = { status: "success", processedByAdmin: actor, processedAt: new Date() };
  if (txHash) patch.txHash = txHash;
  if (note) patch.adminNote = note;

  const updated = await Payment.findOneAndUpdate(
    { _id: existing._id, status: "pending" },
    { $set: patch },
    { new: true }
  );
  if (!updated) throw new PaymentActionError("bad_transition", "This deposit is already processed");

  await User.findByIdAndUpdate(updated.user, { $inc: { realBalance: updated.usdAmount } });
  await log(updated, "confirm_deposit", "pending", actor, note);
  return updated;
}

/** pending -> failed. No refund needed — nothing was ever credited. */
async function rejectCryptoDeposit(idOrRef, actor, note = "") {
  const existing = await Payment.findOne(findPaymentQuery(idOrRef));
  if (!existing) throw new PaymentActionError("not_found", "Deposit not found");
  if (existing.type !== "deposit" || existing.method !== "usdt_trc20") {
    throw new PaymentActionError("wrong_type", "Only pending crypto deposits can be rejected here");
  }

  const updated = await Payment.findOneAndUpdate(
    { _id: existing._id, status: "pending" },
    { $set: { status: "failed", processedByAdmin: actor, processedAt: new Date(), adminNote: note || "Rejected by admin" } },
    { new: true }
  );
  if (!updated) throw new PaymentActionError("bad_transition", "This deposit is already processed");

  await log(updated, "reject_deposit", "pending", actor, note);
  return updated;
}

module.exports = {
  PaymentActionError,
  approveWithdrawal,
  rejectWithdrawal,
  markWithdrawalPaid,
  confirmCryptoDeposit,
  rejectCryptoDeposit,
};
