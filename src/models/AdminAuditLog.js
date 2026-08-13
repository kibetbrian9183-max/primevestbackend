const mongoose = require("mongoose");

// Records every admin action taken on a payment (withdrawal approve/
// reject/mark-paid, deposit confirm/reject), regardless of whether it
// came from the REST admin dashboard or the Telegram bot — both paths
// write here via the same service functions, so this is a single,
// trustworthy audit trail rather than two.
const adminAuditLogSchema = new mongoose.Schema(
  {
    payment: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", required: true, index: true },
    paymentReference: { type: String }, // denormalized for quick reading without a populate
    action: { type: String, required: true }, // "approve" | "reject" | "mark_paid" | "confirm_deposit" | "reject_deposit"
    previousStatus: { type: String, required: true },
    newStatus: { type: String, required: true },
    actor: { type: String, required: true }, // admin email, or "telegram:<user id>" for bot-originated actions
    note: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AdminAuditLog", adminAuditLogSchema);
