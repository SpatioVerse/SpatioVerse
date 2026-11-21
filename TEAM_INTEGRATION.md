# SpaceStage — Teammate & AI Agent Integration Guide

This repository contains Tilak's verified 3D boutique foundation, shared spatial contract, and multimodal intake UI for **SpaceStage (SpatioVerse — Gemini 4 NYC Hackathon)**.

Feed this file directly to your coding agent before writing code so all four workstreams integrate with zero merge conflicts.

---

## 1. Shared Rules & Conventions (ALL Teammates)

- **Stack:** Next.js 16.4.6 (App Router, Turbopack), React 19, TypeScript, Tailwind CSS v4, Three.js / React Three Fiber / drei, Zustand, Zod.
- **Run & Verify:** `npm install && npm run dev` — verify PRs with `npm run lint && npm run build`.
- **Branching:** Create your own feature branch off `main` (e.g. `akash/gemini-api`, `mansi/shopify-commerce`, `divyansh/eval-docs`) and open small PRs into `main`.
- **File Ownership (DO NOT EDIT Tilak-owned files):**
  - `app/page.tsx`
  - `components/SpaceCanvas.tsx`, `components/BoutiqueEnvironment.tsx`, `components/FirstPersonRig.tsx`, `components/SceneObject.tsx`, `components/SceneToolbar.tsx`, `components/MediaIntakeModal.tsx`
  - `lib/textures.ts`, `lib/modelCatalog.ts`, `store/useSceneStore.ts`, `public/models/*`
- **Single Source of Truth:** Import ALL shared types and Zod schemas from `@/lib/schema` (`Vec3`, `ProductRef`, `SceneObject`, `ShopScene`, `ConstraintIssue`, `SceneValidator`, `ShopSceneSchema`, `ProductRefSchema`, `FT_TO_METERS`). Do **not** rename or remove existing fields in `lib/schema.ts`.
- **Exact Spatial Coordinate System (meters, Y-up):**
  - Floor is on the X/Z plane at `Y = 0`, room centered at `(0, 0)`:
    - `X ∈ [-room.width / 2, +room.width / 2]`
    - `Z ∈ [-room.depth / 2, +room.depth / 2]`
    - `Y ∈ [0, room.height]`
  - Walls: `north` (`z = -depth / 2`), `south` (`z = +depth / 2`), `west` (`x = -width / 2`), `east` (`x = +width / 2`).
  - `room.entrance.offset`: signed meters from the center of that wall (`0` = centered).
  - `SceneObject.position`: `[x, y, z]` where `x, z` is the object's footprint center and `y` is bottom elevation (`0` = resting on the floor).
  - `SceneObject.size`: `[width, height, depth]` in meters at `rotationY = 0`.
  - `SceneObject.rotationY`: counter-clockwise radians around Y.
- **Commerce & Honesty Rules:**
  - Prices are integer `priceCents`. Owned fixtures (`source: 'owned'`) contribute `0` cents to the new-purchase budget.
  - Never fabricate live Shopify prices, checkout links, or uncalibrated exact room measurements.
  - Keep all API keys strictly server-side in `.env.local` (never commit `.env*`).

---

## 2. Akash — Gemini 4 Hydrogen + Neon + Deterministic Constraints

**Owned files ONLY:** `lib/gemini.ts`, `lib/constraints.ts`, `app/api/analyze/route.ts`, `app/api/plan/route.ts`.

### `lib/constraints.ts`
- Export `validateScene(scene: ShopScene): ConstraintIssue[]` matching `SceneValidator` from `@/lib/schema`.
- Follow the exact centered-room meter conventions documented above and in `lib/schema.ts` (see `defaultSceneValidator` in `store/useSceneStore.ts` for reference alignment on bounds, rotated OBB collisions, entrance clearance zone `BLOCKED_PATH`, `NO_DRILLING`, `OVER_BUDGET`, and `UNVERIFIED_DIMENSIONS`).
- During integration, Tilak will wire your validator straight into `<SpaceCanvas validator={validateScene} />` and `useSceneStore.getState().setValidator(validateScene)`.

### `app/api/analyze/route.ts` (Gemini 4 Hydrogen — `gemini-4-hydrogen`)
- `components/MediaIntakeModal.tsx` already sends `POST /api/analyze` in two formats:
  1. `multipart/form-data`: `file` (JPG/PNG/MP4/WebM), `sourceType` (`video` | `image` | `camera`), `widthFt`, `depthFt`, `heightFt`, `entranceWall`, `style`, `budgetCents`, optional `notes`.
  2. `application/json` (for pasted YouTube/video URLs): `{ mediaUrl, youtubeId, sourceType: 'youtube', room, style, budgetCents }`.
- Return typed JSON: `{ observations, roomCues, warnings, modelUsed: 'gemini-4-hydrogen' }`, and typed error JSON on failure. Never claim calibrated exact measurements from raw uncalibrated video.

### `app/api/plan/route.ts` (Gemini 4 Neon — `gemini-4-neon`)
- `components/MediaIntakeModal.tsx` sends `POST /api/plan` JSON:
  `{ room, purpose, style, budgetCents, minWalkwayWidth, noDrilling, analysis?, currentScene?, items?, products? }`
  *(Also accept `{ room, items, brief, budgetCents, products? }` from the handoff doc so both `SetupWizard` and `MediaIntakeModal` work seamlessly.)*
- Validate output against `ShopSceneSchema` from `@/lib/schema` and run `validateScene(scene)`; perform at most **1** Neon repair pass if constraint errors exist.
- Return `{ scene, issues, modelUsed: 'gemini-4-neon', repairCount }`.
- `MediaIntakeModal.tsx` already parses `planJson.scene` via `ShopSceneSchema.safeParse` and renders it live in the 3D boutique as soon as `/api/plan` returns HTTP 200.

---

## 3. Mansi — Shopify Shop MCP + Onboarding & Product UI

**Owned files ONLY:** `lib/shopify.ts`, `app/api/products/route.ts`, `app/api/cart/route.ts`, `components/SetupWizard.tsx`, `components/ProductPanel.tsx`.

### Shopify Server Routes (`lib/shopify.ts`, `app/api/products/route.ts`, `app/api/cart/route.ts`)
- Connect server-side to official Shopify Shop MCP (`https://mcp.shop.com/`). Keep credentials server-side.
- `GET /api/products?q=...&maxPrice=...` → return `{ products: ProductRef[], warnings?: string[] }` where each product conforms to `ProductRef` / `ProductRefSchema` in `@/lib/schema` (real `title`, `seller`, `sellerDomain`, `productId`, `variantId`, `priceCents`, `currency`, `productUrl`, optional `imageUrl`, `available`). Zero mocked prices or invented checkout links.
- `POST /api/cart` with `{ lines: [{ variantId, seller, sellerDomain?, quantity }] }` → group by merchant and return `{ carts: [{ seller, cartUrl, checkoutUrl? }], warnings }` (or a truthful structured error/limitation with authentic external `productUrl` if cart creation is blocked).

### Controlled UI Components (`components/SetupWizard.tsx`, `components/ProductPanel.tsx`)
- Build both as controlled React components accepting props/callbacks (do **not** edit `app/page.tsx`; Tilak will mount both during integration).
- Recommended `ProductPanel` props for 1-line plug-in into Tilak's right-hand inspector:
  ```ts
  type ProductPanelProps = {
    selectedObject: SceneObject | null;
    scene: ShopScene;
    onReplaceObjectProduct: (
      objectId: string,
      product: ProductRef,
      verifiedSize?: Vec3
    ) => void;
  };
  ```
  Tilak will bind `onReplaceObjectProduct` to:
  ```ts
  useSceneStore.getState().updateObject(objectId, {
    source: 'shopify',
    product,
    dimensionsVerified: Boolean(verifiedSize),
    ...(verifiedSize ? { size: verifiedSize } : {}),
  });
  ```
- Recommended `SetupWizard` props:
  ```ts
  type SetupWizardProps = {
    initialScene: ShopScene;
    onScenePlanned: (scene: ShopScene) => void;
    onClose?: () => void;
  };
  ```

---

## 4. Divyansh — Evaluation Cases, Tests & README

**Owned files ONLY:** `tests/constraints.test.ts`, `fixtures/eval-cases.json`, `README.md`.

- Import shared types from `@/lib/schema` and baseline demo scenes from `@/fixtures/demoScene` (exports both `flagshipScene` 24×18 ft and `compactDemoScene` 12×10 ft).
- Create `fixtures/eval-cases.json` with 8 independent scenarios following the centered-room meter conventions in `lib/schema.ts` (fits, collisions, blocked entrance, reduced budget, missing dimensions, reused owned fixture, no-drilling violation, alternate entrance).
- Create `tests/constraints.test.ts` testing `validateScene` from `@/lib/constraints` (with clearly marked TODOs until Akash merges `lib/constraints.ts`).
- Replace `README.md` with SpaceStage's business pitch, architecture, Gemini 4 Hydrogen vs Neon model roles, Shop MCP commerce flow, `.env.local` placeholders, honest limitations, and measured evaluation table.
