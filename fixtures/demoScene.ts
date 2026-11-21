import { FT_TO_METERS, type ShopScene } from '@/lib/schema';

export type ScenePresetKey = 'flagship' | 'compact';

export type ScenePresetDefinition = {
  id: ScenePresetKey;
  name: string;
  subtitle: string;
  scene: ShopScene;
};

/**
 * Spacious 24 ft x 18 ft x 10.5 ft (7.3152 x 5.4864 x 3.2004 m) luxury skincare
 * & wellness flagship boutique with a wide 360-degree circular walkthrough loop
 * around a central honed-travertine hero island.
 */
export const flagshipScene: ShopScene = {
  room: {
    width: Number((24 * FT_TO_METERS).toFixed(4)), // 7.3152 m
    depth: Number((18 * FT_TO_METERS).toFixed(4)), // 5.4864 m
    height: Number((10.5 * FT_TO_METERS).toFixed(4)), // 3.2004 m
    entrance: {
      wall: 'south',
      offset: 0,
      width: 1.22, // 4 ft grand storefront entry
    },
  },
  purpose: 'Luxury skincare & botanical wellness flagship boutique',
  style: 'Warm minimalist travertine, fluted white oak & brushed champagne brass',
  budgetCents: 120000,
  minWalkwayWidth: Number((3 * FT_TO_METERS).toFixed(4)), // 0.9144 m (3 ft)
  noDrilling: true,
  warnings: [],
  objects: [
    {
      id: 'owned-shelf-west',
      kind: 'shelf',
      label: 'Owned West Wall Apothecary Shelving',
      source: 'owned',
      position: [-3.36, 0, -0.55],
      size: [2.4, 2.3, 0.44],
      rotationY: Math.PI / 2,
      dimensionsVerified: true,
    },
    {
      id: 'owned-counter-ne',
      kind: 'counter',
      label: 'Owned Fluted Oak Checkout & Consultation Bar',
      source: 'owned',
      position: [1.85, 0, -2.05],
      size: [2.1, 0.98, 0.66],
      rotationY: 0,
      dimensionsVerified: true,
    },
    {
      id: 'proposal-island-center',
      kind: 'table',
      label: 'Proposed Honed Travertine Hero Island',
      source: 'proposal',
      position: [-0.05, 0, -0.15],
      size: [2.0, 0.86, 0.94],
      rotationY: 0,
      dimensionsVerified: false,
    },
    {
      id: 'proposal-shelf-nw',
      kind: 'shelf',
      label: 'Proposed Architectural Oak Display Unit',
      source: 'proposal',
      position: [-1.45, 0, -2.44],
      size: [2.0, 2.2, 0.44],
      rotationY: 0,
      dimensionsVerified: false,
    },
    {
      id: 'proposal-rack-east',
      kind: 'rack',
      label: 'Proposed Brushed Brass Textile Display Rack',
      source: 'proposal',
      position: [3.26, 0, -0.18],
      size: [1.5, 1.76, 0.48],
      rotationY: -Math.PI / 2,
      dimensionsVerified: false,
    },
    {
      id: 'proposal-chair-sw',
      kind: 'table',
      label: 'Proposed Consultation Lounge Chair',
      source: 'proposal',
      position: [-2.35, 0, 1.18],
      size: [0.82, 0.88, 0.82],
      rotationY: Math.PI / 4,
      dimensionsVerified: false,
    },
    {
      id: 'proposal-lamp-nw',
      kind: 'lamp',
      label: 'Proposed Architectural Floor Lamp',
      source: 'proposal',
      position: [-3.05, 0, -2.18],
      size: [0.58, 1.78, 0.58],
      rotationY: Math.PI / 4,
      dimensionsVerified: false,
    },
    {
      id: 'proposal-plant-se',
      kind: 'plant',
      label: 'Proposed Sunlit Corner Botanical',
      source: 'proposal',
      position: [2.98, 0, 2.16],
      size: [0.9, 1.65, 0.9],
      rotationY: 0,
      dimensionsVerified: false,
    },
    {
      id: 'proposal-plant-sw',
      kind: 'plant',
      label: 'Proposed Window Alcove Botanical',
      source: 'proposal',
      position: [-3.08, 0, 2.22],
      size: [0.82, 1.48, 0.82],
      rotationY: Math.PI / 2,
      dimensionsVerified: false,
    },
    {
      id: 'proposal-art-east',
      kind: 'art',
      label: 'Proposed Floor-Leaning Linen Relief Canvas',
      source: 'proposal',
      position: [3.38, 0, 1.12],
      size: [0.9, 1.55, 0.14],
      rotationY: -Math.PI / 2,
      dimensionsVerified: false,
    },
  ],
};

/**
 * Compact 12 ft x 10 ft x 9 ft (3.6576 x 3.048 x 2.7432 m) skincare boutique
 * matching the tight urban studio brief with a clear 3 ft south entrance and
 * $400 display refresh budget.
 */
export const compactDemoScene: ShopScene = {
  room: {
    width: Number((12 * FT_TO_METERS).toFixed(4)), // 3.6576 m
    depth: Number((10 * FT_TO_METERS).toFixed(4)), // 3.0480 m
    height: Number((9 * FT_TO_METERS).toFixed(4)), // 2.7432 m
    entrance: {
      wall: 'south',
      offset: 0,
      width: Number((3 * FT_TO_METERS).toFixed(4)), // 0.9144 m (3 ft)
    },
  },
  purpose: 'Compact neighborhood skincare & apothecary boutique',
  style: 'Warm white oak, honed travertine & soft botanical gallery light',
  budgetCents: 40000,
  minWalkwayWidth: Number((3 * FT_TO_METERS).toFixed(4)), // 0.9144 m (3 ft)
  noDrilling: true,
  warnings: [],
  objects: [
    {
      id: 'compact-owned-counter',
      kind: 'counter',
      label: 'Owned Checkout Counter',
      source: 'owned',
      position: [0.92, 0, -1.16],
      size: [1.44, 0.96, 0.52],
      rotationY: 0,
      dimensionsVerified: true,
    },
    {
      id: 'compact-owned-shelf',
      kind: 'shelf',
      label: 'Owned Natural Oak Wall Shelf',
      source: 'owned',
      position: [-1.54, 0, 0.12],
      size: [1.46, 2.05, 0.4],
      rotationY: Math.PI / 2,
      dimensionsVerified: true,
    },
    {
      id: 'compact-proposal-table',
      kind: 'table',
      label: 'Proposed Travertine Hero Display Table',
      source: 'proposal',
      position: [0.1, 0, 0.02],
      size: [1.04, 0.84, 0.6],
      rotationY: 0,
      dimensionsVerified: false,
    },
    {
      id: 'compact-proposal-lamp',
      kind: 'lamp',
      label: 'Proposed Architectural Floor Lamp',
      source: 'proposal',
      position: [-1.42, 0, -1.15],
      size: [0.48, 1.72, 0.48],
      rotationY: Math.PI / 4,
      dimensionsVerified: false,
    },
    {
      id: 'compact-proposal-plant',
      kind: 'plant',
      label: 'Proposed Corner Botanical Plant',
      source: 'proposal',
      position: [1.34, 0, 1.06],
      size: [0.68, 1.42, 0.68],
      rotationY: 0,
      dimensionsVerified: false,
    },
  ],
};

export const demoScene: ShopScene = flagshipScene;

export const SCENE_PRESETS: Record<ScenePresetKey, ScenePresetDefinition> = {
  flagship: {
    id: 'flagship',
    name: 'Flagship Boutique',
    subtitle: '24 × 18 ft · $1,200 budget · 360° hero island loop',
    scene: flagshipScene,
  },
  compact: {
    id: 'compact',
    name: 'Compact Studio',
    subtitle: '12 × 10 ft · $400 budget · 3 ft clear entry',
    scene: compactDemoScene,
  },
};
