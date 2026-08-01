# PrimeVest Backend

Node/Express backend for PrimeVest: real M-Pesa STK Push deposits,
manually-processed withdrawals, user accounts, trades — all persisted
to MongoDB — plus an admin dashboard for managing users and payouts.
Deploys as a single service to Render.

## 1. Set up MongoDB

1. Create a free cluster at https://www.mongodb.com/cloud/atlas/register
2. **Database Access** → add a database user (username + password)
3. **Network Access** → allow `0.0.0.0/0` (or Render's static IPs if
   you've set those up)
4. **Connect → Drivers** → copy the connection string, fill in your
   user/password, and put it in `MONGODB_URI`

## 2. Set up your admin login

Never put a plaintext password in an env file. Generate the hash
locally instead:

```bash
npm install
node scripts/hash-password.js "your-chosen-password"
```

Copy the printed hash into `ADMIN_PASSWORD_HASH`, and set
`ADMIN_EMAIL` to whatever email you want to log in with. These two
env vars are the entire admin account — there's no signup flow for
admins on purpose.

## 3. Set up Daraja (M-Pesa) credentials

Same as before — see the Daraja developer portal
(https://developer.safaricom.co.ke) for `MPESA_CONSUMER_KEY`,
`MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY`. Withdrawals
are **not** sent automatically (no B2C integration) — an admin
disburses them manually via M-Pesa and marks them paid in the
dashboard, which is what updates the status on the user's side.

## 4. Configure the rest of the environment variables

Copy `.env.example` to `.env` and fill in every value — each one is
explained inline. Generate `JWT_SECRET` and `ADMIN_JWT_SECRET` with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
(run it twice, once per secret — they must be different from each other)

## 5. Run locally

```bash
npm install
cp .env.example .env   # fill in the values above
npm run dev
```

The admin dashboard is at `http://localhost:10000/admin`. Sandbox
STK push callbacks need a public URL even for local testing — use
`ngrok http 10000` and put that URL in `MPESA_STK_CALLBACK_URL`.

## 6. Deploy to Render

Push this folder to a GitHub repo, then in Render: **New → Blueprint**,
point it at the repo. It reads `render.yaml` and creates the service —
fill in the env vars marked `sync: false` in the Render dashboard.

Once deployed, your admin dashboard is at
`https://YOUR-RENDER-URL.onrender.com/admin`. Update
`MPESA_STK_CALLBACK_URL` to point at that URL and redeploy.

## 7. API reference

**User-facing** (frontend calls these with `Authorization: Bearer <token>`):

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/signup` | Create an account |
| POST | `/api/auth/login` | Log in |
| GET | `/api/auth/me` | Current user profile |
| PATCH | `/api/auth/me` | Update name / 2FA toggle |
| POST | `/api/auth/me/verify-identity` | Submit identity for review |
| POST | `/api/trades` | Open a trade (deducts stake) |
| PATCH | `/api/trades/:id/resolve` | Resolve a trade (credits a win) |
| GET | `/api/trades` | List my trades |
| POST | `/api/payments/deposit` | Start an STK push |
| GET | `/api/payments/deposit/status/:ref` | Poll deposit status |
| POST | `/api/payments/withdraw` | Submit a withdrawal request |
| GET | `/api/payments` | List my deposits/withdrawals |
| GET | `/api/notifications` | My notifications |

**Safaricom calls this one** (no auth — see hardening note below):
`POST /api/payments/deposit/callback`

**Admin-only** (cookie-based session from `/admin`):
`/api/admin/login`, `/api/admin/users`, `/api/admin/users/:id`,
`/api/admin/payments`, `/api/admin/payments/:id/mark-paid`,
`/api/admin/payments/:id/reject`, `/api/admin/stats`,
`/api/admin/settings`, `/api/admin/notifications`.

## 8. What the admin dashboard actually does

- **Overview** — total users, trades, deposits, withdrawals paid, pending withdrawals
- **Users** — search, view balances/trade history/payment history, suspend/reactivate, delete
- **Withdrawals** — every pending request; **Mark paid** flips it to `completed`
  (this is what the user sees update in their own History screen) or
  **Reject** to refund their Real balance
- **Deposits** — read-only log of what Safaricom has confirmed
- **Notifications** — send a message to one user or broadcast to everyone
- **Settings** — USD/KES rate, minimum deposit/withdrawal, payout rate, referral rate, maintenance mode

## 9. Remaining gaps to know about

- **Withdrawal payout is still manual.** There's no real B2C
  integration (that requires its own Safaricom go-live approval,
  separate from STK Push). "Mark paid" only updates status — you
  still send the actual M-Pesa payment yourself first.
- **Callback hardening**: consider restricting
  `/api/payments/deposit/callback` to Safaricom's published IP ranges.
- **Rate limits / abuse protection** on auth endpoints are basic —
  consider stricter limits and CAPTCHA if this sees real traffic.
- **Referral payouts** aren't automated — the referral rate in
  Settings and the code on each user's account exist, but nothing
  currently credits a referrer when their referral trades. That's a
  reasonable next feature if you want it enforced automatically.
