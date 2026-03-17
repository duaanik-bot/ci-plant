# Colour Impressions — Plant Management System
## Developer Setup Guide

### What Is This
Full-stack Next.js 14 plant management system for Colour Impressions pharmaceutical packaging plant, Patiala.
Solves two critical operational problems:
1. Sheet wastage bypass (hard-limit enforcer)
2. Artwork printed without approval (4-lock gate)

### Stack
- **Frontend**: Next.js 14 + React 18 + Tailwind CSS + shadcn/ui
- **Backend**: Next.js API routes + Prisma ORM
- **Database**: PostgreSQL (Neon.tech)
- **Auth**: NextAuth.js (email + PIN)
- **Files**: Cloudflare R2
- **Notifications**: Wati (WhatsApp Business)
- **Deploy**: Vercel

---

## STEP 1 — Prerequisites (Install Once)

```bash
# Node.js 20+ required
node --version   # must be v20+

# Install pnpm (faster than npm)
npm install -g pnpm

# Install Cursor IDE
# Download from: https://cursor.sh
```

---

## STEP 2 — Set Up Cloud Services (Do This First)

### Neon PostgreSQL (Free)
1. Go to neon.tech → Sign up → New project → Name: "ci-plant"
2. Copy the connection string (looks like: postgresql://user:pass@host.neon.tech/ci_plant)

### Vercel (Free)
1. Go to vercel.com → Sign up with GitHub
2. Will connect later when pushing code  
3. **To deploy:** see **[DEPLOYMENT.md](./DEPLOYMENT.md)** for step-by-step Vercel deployment and required env vars.

### Cloudflare R2 (Free tier)
1. Go to cloudflare.com → Sign up → R2 → Create bucket: "ci-plant-files"
2. Create API token with R2 read/write permissions

### Wati WhatsApp (Trial)
1. Go to wati.io → Start trial
2. Connect your WhatsApp Business number
3. Get API key from dashboard

---

## STEP 3 — Project Setup

```bash
# 1. Open this folder in Cursor IDE
cd ci-plant-system

# 2. Install dependencies
npm install

# 3. Copy environment file
cp .env.example .env.local
# Edit .env.local and fill in all values from Step 2

# 4. Generate Prisma client
npx prisma generate

# 5. Push schema to database (creates all 14 tables)
npx prisma db push

# 6. Seed the database (loads machines CI-01→CI-12, roles, admin user)
npx prisma db seed

# 7. Verify — open Prisma Studio to see data
npx prisma studio
# Should see 12 machines and 8 roles

# 8. Start development server
npm run dev
# Open http://localhost:3000
```

---

## STEP 4 — Build With Cursor AI

1. Open **CURSOR_PROMPTS.md** in this project
2. Open Cursor Chat (Ctrl+L / Cmd+L)
3. Copy the **PHASE 1 PROMPT** and paste it into Cursor Chat
4. Press Enter — Cursor will start writing files
5. When it finishes, run `npm run dev` and test in browser
6. For any error: copy the error → paste to Cursor: "Fix this error: [paste error]"
7. When Phase 1 works: `git commit -m "Phase 1 complete"`
8. Copy **PHASE 2 PROMPT** and repeat

---

## STEP 5 — Deploy to Production

```bash
# 1. Push to GitHub
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/your-org/ci-plant-system.git
git push -u origin main

# 2. Deploy to Vercel
npx vercel --prod
# Follow prompts — connects your GitHub repo

# 3. Add environment variables in Vercel dashboard
# Project → Settings → Environment Variables
# Add all variables from .env.local

# 4. Set custom domain (optional)
# Vercel dashboard → Domains → Add: app.colourimpressions.in
```

---

## Default Login (After Seed)

| Field | Value |
|-------|-------|
| Email | dua.anik@gmail.com |
| PIN | 123456 |
| Role | MD (full access) |

**⚠️ Change PIN immediately after first login!**

---

## Machine Reference

| Code | Machine | Capacity | Waste % |
|------|---------|----------|---------|
| CI-01 | Komori 5C+Coat (20×28) | 10,000/hr | 3.0% |
| CI-02 | Komori 5C (20×28) | 8,000/hr | 3.5% |
| CI-03 | Komori 5C Small (19×26) | 7,500/hr | 4.0% |
| CI-04 | UV/Varnish (3 units) | 6,000/hr | 2.0% |
| CI-05 | Lamination Royal | 8,000/shift | 1.5% |
| CI-06 | Heidelberg Die (3 units) | 12,000/shift | 2.0% |
| CI-07 | Manual Die (4 units) | 12,000/shift | 2.5% |
| CI-08 | Lock Bottom Pasting | 300,000/shift | 1.0% |
| CI-09 | Side Pasting Cortonal | 400,000/shift | 1.0% |
| CI-10 | ACE Board Cutter | 12,000/shift | 0.5% |
| CI-11 | Jindal Label Cutter | 20,000/shift | 1.0% |
| CI-12 | Kodak CTP | 200 plates/shift | N/A |

---

## Support

- Operations Contact: Mr. Anik Dua — dua.anik@gmail.com — 9780020225
- Plant: Shamdo, Chandigarh Road, Patiala, Punjab – 140402
- GSTIN: 03ASYPT7185M2ZJ
