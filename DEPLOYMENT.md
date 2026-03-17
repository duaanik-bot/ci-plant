# Deploy to Vercel

This guide walks through deploying the Colour Impressions Plant System to Vercel.

---

## Prerequisites

- **GitHub (or GitLab/Bitbucket):** Project pushed to a Git repository.
- **Vercel account:** [vercel.com](https://vercel.com) — sign up with GitHub.
- **Production database:** PostgreSQL (e.g. [Neon](https://neon.tech)) with schema applied and seeded (see below).

---

## 1. Push code to GitHub

If the project is not in a Git repo yet:

```bash
cd /path/to/ci-plant
git init
git add .
git commit -m "Initial commit"
# Create a repo on GitHub, then:
git remote add origin https://github.com/YOUR_ORG/ci-plant.git
git branch -M main
git push -u origin main
```

---

## 2. Prepare the production database

Use a **separate** PostgreSQL database for production (e.g. a second Neon project or a production branch).

1. Copy your production `DATABASE_URL` (e.g. `postgresql://user:pass@host.neon.tech/ci_plant?sslmode=require`).
2. Locally, point Prisma at it and push schema + seed (use a dedicated `.env.production` or one-off env):

```bash
# From your machine, with DATABASE_URL set to production DB:
export DATABASE_URL="postgresql://..."
npx prisma db push
npx prisma db seed
```

Keep this `DATABASE_URL` for Step 4 (Vercel env vars).

---

## 3. Import project on Vercel

1. Go to [vercel.com/new](https://vercel.com/new).
2. **Import** the Git repository (e.g. `YOUR_ORG/ci-plant`).
3. **Framework Preset:** Next.js (auto-detected).
4. **Root Directory:** leave default (`.`).
5. **Build Command:** `npm run build` (default).
6. **Output Directory:** leave default.
7. Do **not** deploy yet — add environment variables first.

---

## 4. Environment variables

In the Vercel project: **Settings → Environment Variables**. Add these for **Production** (and optionally Preview):

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | Production PostgreSQL connection string (e.g. Neon). |
| `NEXTAUTH_SECRET` | Yes | Random string, e.g. `openssl rand -base64 32`. |
| `NEXTAUTH_URL` | Yes | Your app URL, e.g. `https://ci-plant.vercel.app` (replace with your actual Vercel URL or custom domain). |
| `NEXT_PUBLIC_APP_URL` | Yes | Same as `NEXTAUTH_URL` (e.g. `https://ci-plant.vercel.app`). |
| `NEXT_PUBLIC_APP_NAME` | No | e.g. `CI Plant System`. |
| `R2_ACCOUNT_ID` | For uploads | Cloudflare R2 account ID. |
| `R2_ACCESS_KEY_ID` | For uploads | R2 access key. |
| `R2_SECRET_ACCESS_KEY` | For uploads | R2 secret key. |
| `R2_BUCKET_NAME` | For uploads | R2 bucket name. |
| `R2_PUBLIC_URL` | For uploads | R2 public or custom URL. |
| `WATI_API_KEY` | For WhatsApp | Wati API key. |
| `WATI_BASE_URL` | For WhatsApp | e.g. `https://live-server.wati.io`. |
| `CRON_SECRET` | Optional | For cron jobs; generate with `openssl rand -base64 16`. |

**Important:** After the first deploy, set `NEXTAUTH_URL` and `NEXT_PUBLIC_APP_URL` to your **real** Vercel URL (e.g. `https://your-project.vercel.app`) and redeploy if you had used a placeholder.

---

## 5. Deploy

1. Click **Deploy** (or push to the connected branch; Vercel will build and deploy).
2. Wait for the build to finish. The build runs `prisma generate` and `next build`.
3. Open the deployment URL (e.g. `https://ci-plant-xxx.vercel.app`).
4. You should see the login page. Use the seeded admin user (see `prisma/seed.ts`).

---

## 6. Custom domain (optional)

1. **Settings → Domains** in the Vercel project.
2. Add your domain (e.g. `app.colourimpressions.in`).
3. Update `NEXTAUTH_URL` and `NEXT_PUBLIC_APP_URL` to `https://app.colourimpressions.in` and redeploy.

---

## Troubleshooting

- **Build fails on Prisma:** Ensure `DATABASE_URL` is set in Vercel so `prisma generate` can run (it does not need to connect for generate; connection is only at runtime).
- **Auth redirect / session issues:** `NEXTAUTH_URL` must match the URL you use in the browser (no trailing slash).
- **DB connection errors in production:** Check that the DB allows connections from Vercel IPs (Neon and most cloud DBs do by default).
- **R2 or Wati not configured:** App will run; file uploads or WhatsApp features may fail until those env vars are set.

---

## One-command deploy (Vercel CLI)

After linking the project once:

```bash
npm i -g vercel
vercel login
vercel link
vercel env pull .env.local   # pull env from Vercel (optional)
vercel --prod
```

This deploys the current directory to production. Env vars should be set in the Vercel dashboard (or via `vercel env add`).
