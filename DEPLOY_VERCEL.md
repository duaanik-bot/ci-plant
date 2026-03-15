# Deploy CI Plant System to Vercel

Follow these steps **in your terminal** (Vercel CLI must run on your machine so you can log in).

---

## 1. Install Vercel CLI (if not already)

```bash
npm install -g vercel
```

Or use the project-local one (already installed):

```bash
npx vercel
```

---

## 2. Log in to Vercel (if needed)

```bash
vercel login
```

(or `npx vercel login`)

Use your browser or token as prompted.

---

## 3. Deploy (first time)

From the project root:

```bash
cd /Users/anikdua/Downloads/ci-plant
vercel
```

When prompted:

- **Set up and deploy?** → **Y**
- **Which scope?** → Select your account
- **Link to existing project?** → **N**
- **Project name?** → **ci-plant-system**
- **In which directory is your code?** → **./**
- **Override settings?** → **N**

Note the **Preview URL** Vercel prints (e.g. `https://ci-plant-system-xxx.vercel.app`).

---

## 4. Add environment variables

Add these for **Production** (and optionally Preview) so the app works in production.

**NEXTAUTH_URL** (use the live URL Vercel gave you):

```bash
vercel env add NEXTAUTH_URL production
# When prompted, enter: https://ci-plant-system.vercel.app
# (or the exact URL from your first deploy)
```

**NEXTAUTH_SECRET** (same as in your `.env`):

```bash
vercel env add NEXTAUTH_SECRET production
# Paste the value from your .env (e.g. appwh7x5qtH2rmFGubFIcKgc4IVCdFrG6S5Q8U1TSJs=)
```

**DATABASE_URL** (same Neon connection string as in `.env`):

```bash
vercel env add DATABASE_URL production
# Paste your full DATABASE_URL from .env
```

To add the same vars to **Preview** (optional):

```bash
vercel env add NEXTAUTH_URL preview
vercel env add NEXTAUTH_SECRET preview
vercel env add DATABASE_URL preview
```

---

## 5. Production deploy

Redeploy so the new env vars are used:

```bash
vercel --prod
```

---

## 6. Final live URL

After `vercel --prod`, the app will be live at:

- **https://ci-plant-system.vercel.app**

(or the custom domain you set in the Vercel dashboard).

Use this URL as **NEXTAUTH_URL** in Vercel env vars if you used a different preview URL in step 4.

---

## Optional: one-off production deploy with env from .env

If your `.env` is only on your machine and you prefer not to type secrets:

1. In Vercel Dashboard: **Project → Settings → Environment Variables**
2. Add **NEXTAUTH_URL**, **NEXTAUTH_SECRET**, **DATABASE_URL** for Production (and Preview if you want).
3. Then run: `vercel --prod`
