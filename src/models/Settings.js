const mongoose = require("mongoose");

const settingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "site" }, // singleton document
    usdKesRate: { type: Number, default: 129 },
    minDepositKes: { type: Number, default: 10 },
    minWithdrawalUsd: { type: Number, default: 1 },
    payoutRate: { type: Number, default: 1.952 },
    referralRate: { type: Number, default: 0.1 },
    maintenanceMode: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const Settings = mongoose.model("Settings", settingsSchema);

async function getSettings() {
  let doc = await Settings.findById("site");
  if (!doc) doc = await Settings.create({ _id: "site" });
  return doc;
}

module.exports = Settings;
module.exports.getSettings = getSettings;
