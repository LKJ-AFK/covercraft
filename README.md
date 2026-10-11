# CoverCraft — AI Cover Letters That Don't Sound Like AI

Tailored cover letters for a job posting that don't sound like AI. Written **only from your real facts** — no invented numbers, no clichés, scored 0–100 like a hiring manager.

This repository is the **Zibby edition** of CoverCraft: a 100% static, dependency-free app that runs inside the Zibby shell (`zibby.run`). All AI calls go through `streamZibbyAi` (model: `moonshotai/kimi-k2`). There is **no backend, no database, no API keys and no secrets** in this repository.

## Features

- **Generate** — 3 tailored cover letters (different angles), each scored 0–100 with a 4-dimension breakdown (job match / ATS / persuasion / length)
- **Diagnose** — paragraph-level diagnosis: every sentence tagged good / weak / bad, issues, improvements, JD-match check
- **Rewrite** — a full improved version of your letter, fact-preserving (never adds facts you didn't write)
- **Interview prep** — 5 predicted interview questions with answer points
- **Email version** — a 100–150 word email body for postings that want the letter in the email
- **PDF download**, copy buttons, verify-before-send markers (yellow `«VERIFY»` marks on any AI-generated claim you must check)
- 12 copy-ready example cover letters + critique page (all static, in `pages/`)

## Run locally

Serve the repo root over any static server (no build step):

```bash
npx serve .        # or: python -m http.server 8080
# open http://localhost:8080
```

For AI calls to work locally you would need a `streamZibbyAi` host bridge (i.e. run inside Zibby). In any other environment the app still renders and explains inputs, but generation requires the Zibby shell.

## Repository layout

```
index.html            entry page (extracted from the original worker + Zibby-ified)
app.js                front-end UI (ESM)
core.js               engine: prompts, quality gates, deterministic fallbacks (ESM)
vendor/zibby/         @zibby-run/app-kit 0.7.1 root entry (vendored, MIT)
vendor/jspdf.umd.min.js
pages/                17 static pages (examples, critique, about, legal)
zibby.json            Zibby app manifest (allow-listed keys only)
build/extract.js      one-time generator: extracts index/pages from the Cloudflare worker
```

## Legal & hygiene

- MIT licensed. Original author: **Ersi** (@ersilabs). Remixes welcome with attribution.
- This repo intentionally contains **no** secrets: the Cloudflare worker's API keys, license keys and cost-watch script stay out of source control.
- All example letters and content pages are original writing; any placeholder claims are marked for the user to verify before use.
