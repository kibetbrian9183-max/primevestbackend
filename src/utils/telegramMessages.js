// Formats the withdrawal notification messages and their inline keyboards
// at each stage. Kept separate from the webhook/route logic so the wording
// can change without touching anything that handles Telegram's protocol.

function destinationLine(payment) {
  if (payment.method === "usdt_trc20") return `Destination: ${payment.walletAddress} (USDT · TRC20)`;
  return `Destination: ${payment.phone} (M-Pesa)`;
}

function newWithdrawalMessage(payment, user) {
  return [
    "🔔 NEW WITHDRAWAL REQUEST",
    "",
    `Withdrawal ID: ${payment.reference}`,
    `User: ${user.name || "—"} (${user.email})`,
    `Phone: ${user.phone || "—"}`,
    `Amount: KSh ${Number(payment.amountKes).toLocaleString()} ($${Number(payment.usdAmount).toFixed(2)})`,
    destinationLine(payment),
    "Status: PENDING",
  ].join("\n");
}

function newWithdrawalKeyboard(reference) {
  return [
    [
      { text: "✅ APPROVE", callback_data: `wd_approve:${reference}` },
      { text: "❌ REJECT", callback_data: `wd_reject:${reference}` },
    ],
  ];
}

function approvedMessage(payment, user) {
  return [
    "✅ WITHDRAWAL APPROVED",
    "",
    `Withdrawal ID: ${payment.reference}`,
    `User: ${user?.name || "—"}`,
    `Amount: KSh ${Number(payment.amountKes).toLocaleString()} ($${Number(payment.usdAmount).toFixed(2)})`,
    "Status: APPROVED — not yet paid out",
  ].join("\n");
}

function approvedKeyboard(reference) {
  return [[{ text: "💰 MARK AS PAID", callback_data: `wd_paid:${reference}` }]];
}

function rejectedMessage(payment, user) {
  return [
    "❌ WITHDRAWAL REJECTED",
    "",
    `Withdrawal ID: ${payment.reference}`,
    `User: ${user?.name || "—"}`,
    `Amount: KSh ${Number(payment.amountKes).toLocaleString()} ($${Number(payment.usdAmount).toFixed(2)})`,
    "Status: REJECTED — balance refunded",
  ].join("\n");
}

function completedMessage(payment, user) {
  return [
    "✅ WITHDRAWAL COMPLETED",
    "",
    `Withdrawal ID: ${payment.reference}`,
    `User: ${user?.name || "—"}`,
    `Amount: KSh ${Number(payment.amountKes).toLocaleString()} ($${Number(payment.usdAmount).toFixed(2)})`,
    "Status: COMPLETED",
  ].join("\n");
}

module.exports = {
  newWithdrawalMessage,
  newWithdrawalKeyboard,
  approvedMessage,
  approvedKeyboard,
  rejectedMessage,
  completedMessage,
};
