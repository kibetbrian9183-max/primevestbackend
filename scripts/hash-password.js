/**
 * Generates the bcrypt hash you put in ADMIN_PASSWORD_HASH.
 * Run locally — never put your plaintext admin password in any .env
 * file or in code; only the hash goes into Render's environment variables.
 *
 * Usage:
 *   node scripts/hash-password.js "your-chosen-password"
 */
const bcrypt = require("bcryptjs");

const password = process.argv[2];
if (!password) {
  console.error("Usage: node scripts/hash-password.js \"your-chosen-password\"");
  process.exit(1);
}

bcrypt.hash(password, 10).then((hash) => {
  console.log("\nADMIN_PASSWORD_HASH=" + hash + "\n");
  console.log("Paste that whole line's value into Render's ADMIN_PASSWORD_HASH env var.");
});
