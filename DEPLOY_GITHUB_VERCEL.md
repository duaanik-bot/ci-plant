# Deploy to Vercel via GitHub

**Done for you:** Git is initialized, `.gitignore` (including `.env`) is in place, and the initial commit is created:  
`Colour Impressions Plant System v1`

Run the steps below **in your terminal** from the project root:  
`cd /Users/anikdua/Downloads/ci-plant`

---

## 1. Git (already done)

```bash
# Already done:
# git init
# git add .
# git commit -m "Colour Impressions Plant System v1"
```

---

## 2. Install GitHub CLI (if needed)

```bash
brew install gh
```

---

## 3. Log in to GitHub and create repo

```bash
gh auth login
# Follow prompts (browser or token)

gh repo create ci-plant-system --private --source=. --push
```

This creates the GitHub repo and pushes your code.

---

## 4. Install Vercel CLI and log in

```bash
npm install -g vercel
vercel login
# Use browser or token when prompted
```

---

## 5. Link and deploy

```bash
vercel --prod
```

When prompted:

- **Set up and deploy?** → **Y**
- **Which scope?** → Select your account
- **Link to existing project?** → **N** (first time)
- **Project name?** → **ci-plant-system**
- **In which directory is your code?** → **./**
- **Override settings?** → **N**

**Copy the production URL** Vercel prints (e.g. `https://ci-plant-system.vercel.app` or `https://ci-plant-system-xxxx.vercel.app`). You need it for `NEXTAUTH_URL`.

---

## 6. Add environment variables

Use the **production URL** from step 5 as `NEXTAUTH_URL`. Use the same values as in your local `.env` for the others.

**NEXTAUTH_SECRET** (from your `.env`):

```bash
vercel env add NEXTAUTH_SECRET production
# When prompted, paste: appwh7x5qtH2rmFGubFIcKgc4IVCdFrG6S5Q8U1TSJs=
```

**NEXTAUTH_URL** (the live URL from step 5):

```bash
vercel env add NEXTAUTH_URL production
# When prompted, enter: https://ci-plant-system.vercel.app
# (or the exact URL Vercel gave you)
```

**DATABASE_URL** (from your `.env`):

```bash
vercel env add DATABASE_URL production
# When prompted, paste your full DATABASE_URL from .env
```

---

## 7. Redeploy with env vars

```bash
vercel --prod
```

---

## 8. Final live URL

After the redeploy, the app is live at the production URL, for example:

- **https://ci-plant-system.vercel.app**

(or the URL shown in the Vercel dashboard for the `ci-plant-system` project).

Use this URL when signing in and for **NEXTAUTH_URL** in production.
