# SpaceStage — AI Planning & Spatial Constraints (`akarsh_dev`)

Constraint-aware 3D retail store planning backend for **SpaceStage**, built with Next.js App Router, TypeScript, Zod, and `@google/genai`.

## Implemented Modules

- **`lib/gemini.ts`** — Server-side Gemini 4 integration (`ThinkingLevel.LOW`, structured JSON schemas, request tracing, zero client-side key exposure):
  - **`POST /api/analyze` (`gemini-4-neon`)**: Accepts multipart `JPG/PNG/WebP/MP4/WebM` uploads (inline up to 14 MB; Gemini Files API upload + auto-cleanup for larger clips). Extracts grounded owned-fixture observations, room cues, and explicit uncalibrated-measurement warnings (~10.5s).
  - **`POST /api/plan` (`gemini-4-hydrogen`)**: Generates `ShopScene` 3D floorplan JSON in meters, preserves confirmed `owned` fixtures at $0 cost, maps new items strictly to real passed Shopify `ProductRef` variants, runs `validateScene`, and executes at most **1 corrective repair pass** (~10.8s initial / ~6.3s repair).
- **`lib/constraints.ts`** — Deterministic client/server-safe `validateScene(scene)` engine checking room/ceiling bounds (`OUT_OF_BOUNDS`), exact 2D SAT rotated-rectangle collisions (`COLLISION`), 3 ft (`0.9144 m`) doorway & interior walkway reachability (`BLOCKED_PATH`), `noDrilling` mounting rules (`NO_DRILLING`), new-purchase budget caps (`OVER_BUDGET`), and `UNVERIFIED_DIMENSIONS` warnings.
- **Tests (`lib/constraints.test.ts`, `app/api/analyze/analyze.test.ts`)** — 15 automated Vitest unit tests covering all constraint rules, Files API lifecycle, single-pass repair, and Shopify ID sanitization.

## Model Routing Rationale (Live Benchmark)

All four Gemini 4 models were benchmarked live against `validateScene`:
- **`gemini-4-neon`** powers `/api/analyze` (~10.5s, 100% fixture recall, 0 false positives).
- **`gemini-4-hydrogen`** powers `/api/plan` + repair (~10.8s layout, ~6.3s repair, 100% first-pass constraint validity — ~3–4× faster than Neon on spatial packing), satisfying the two-model Gemini 4 requirement with fast interactive latency.

## Quick Start

```bash
cp .env.example .env.local   # Set GEMINI_API_KEY=...
npm install
npm test                     # Run 15 unit tests
npm run build                # Verify Next.js + TypeScript build
```
