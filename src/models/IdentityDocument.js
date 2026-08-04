const mongoose = require("mongoose");

const identityDocumentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    kind: { type: String, enum: ["id_front", "id_back", "selfie"], required: true },
    mimeType: { type: String, required: true },
    // Small-scale MVP storage: the file itself, base64-encoded, right in
    // Mongo. Fine at low volume; if this ever needs to scale, swap this
    // field for a URL pointing at real object storage (S3, Cloudinary,
    // etc.) instead of inlining bytes into documents.
    data: { type: String, required: true },
    size: { type: Number, required: true },
  },
  { timestamps: true }
);

// One document per (user, kind) — resubmitting replaces the previous file.
identityDocumentSchema.index({ user: 1, kind: 1 }, { unique: true });

module.exports = mongoose.model("IdentityDocument", identityDocumentSchema);
