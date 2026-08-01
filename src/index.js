const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");

const config = require("./config");
const { connectDB } = require("./db");
const authRoutes = require("./routes/auth").router;
const tradeRoutes = require("./routes/trades");
const paymentRoutes = require("./routes/payments");
const notificationRoutes = require("./routes/notifications");
const adminRoutes = require("./routes/admin");
const { errorHandler } = require("./middleware/errorHandler");

const app = express();

// The admin panel is served from this same origin, so it needs relaxed CSP
// for its own inline bits to work; keep helmet's other protections on.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(cookieParser());
app.use(
  cors({
    origin: config.corsOrigin.length ? config.corsOrigin : true,
    credentials: true,
  })
);

// Basic abuse protection on the endpoints the frontend hits directly.
const initiateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/payments/deposit", initiateLimiter);
app.use("/api/payments/withdraw", initiateLimiter);
app.use("/api/auth/login", initiateLimiter);
app.use("/api/admin/login", initiateLimiter);

app.get("/health", (req, res) => {
  res.json({ ok: true, env: config.env });
});

app.use("/api/auth", authRoutes);
app.use("/api/trades", tradeRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/admin", adminRoutes);

// Admin dashboard — plain static files, no build step.
app.use("/admin", express.static(path.join(__dirname, "admin/public")));

app.use(errorHandler);

async function start() {
  await connectDB();
  app.listen(config.port, () => {
    console.log(`PrimeVest server listening on :${config.port} [${config.env}]`);
    console.log(`Admin dashboard at /admin`);
  });
}

start().catch((err) => {
  console.error("[boot] failed to start:", err.message);
  process.exit(1);
});
