import type { ProductRef, SceneObject, SceneObjectKind, Vec3 } from '@/lib/schema';

export type FinishPalette = {
  id: string;
  primary: string;
  secondary: string;
  accent: string;
  metal: string;
  roughness: number;
  metalness: number;
  hasLed: boolean;
  hasGlass: boolean;
};

export type LampVariantStyle = 'midcentury-globe' | 'minimal-column' | 'drum-shade' | 'arched-brass';
export type TableVariantStyle = 'round-metal' | 'pedestal-wood' | 'travertine-island';
export type ShelfVariantStyle = 'led-cabinet' | 'minimal-bookcase' | 'metal-etagere' | 'apothecary-oak';

export interface ProductVisualSpec {
  inferredKind: SceneObjectKind | null;
  finish: FinishPalette;
  lampStyle: LampVariantStyle;
  tableStyle: TableVariantStyle;
  shelfStyle: ShelfVariantStyle;
  inferredHeightM?: number;
  inferredWidthM?: number;
}

const FINISH_PRESETS: Record<string, FinishPalette> = {
  matteBlack: {
    id: 'matte-black',
    primary: '#202124',
    secondary: '#141518',
    accent: '#d4b47c',
    metal: '#1e1f22',
    roughness: 0.44,
    metalness: 0.32,
    hasLed: false,
    hasGlass: false,
  },
  crispWhite: {
    id: 'crisp-white',
    primary: '#f4f2ee',
    secondary: '#e6e2da',
    accent: '#c8b89d',
    metal: '#d8d5ce',
    roughness: 0.36,
    metalness: 0.06,
    hasLed: false,
    hasGlass: false,
  },
  walnut: {
    id: 'walnut',
    primary: '#63412b',
    secondary: '#4a2e1d',
    accent: '#232325',
    metal: '#242528',
    roughness: 0.52,
    metalness: 0.08,
    hasLed: false,
    hasGlass: false,
  },
  cherry: {
    id: 'cherry',
    primary: '#7e3b2b',
    secondary: '#5e291d',
    accent: '#c9a46c',
    metal: '#9e7d4b',
    roughness: 0.42,
    metalness: 0.06,
    hasLed: false,
    hasGlass: false,
  },
  brassGold: {
    id: 'brass-gold',
    primary: '#c9a96e',
    secondary: '#9d7d47',
    accent: '#f2ece1',
    metal: '#d1b277',
    roughness: 0.26,
    metalness: 0.82,
    hasLed: false,
    hasGlass: false,
  },
  chromeSilver: {
    id: 'chrome-silver',
    primary: '#cfd4da',
    secondary: '#9aa2ab',
    accent: '#f7f5f0',
    metal: '#dce1e6',
    roughness: 0.2,
    metalness: 0.88,
    hasLed: false,
    hasGlass: false,
  },
  sageGreen: {
    id: 'sage-green',
    primary: '#6f8776',
    secondary: '#4d6153',
    accent: '#e8e2d7',
    metal: '#b59a69',
    roughness: 0.56,
    metalness: 0.05,
    hasLed: false,
    hasGlass: false,
  },
  terracotta: {
    id: 'terracotta',
    primary: '#b6694a',
    secondary: '#8f4d34',
    accent: '#efe6d8',
    metal: '#3a3430',
    roughness: 0.64,
    metalness: 0.04,
    hasLed: false,
    hasGlass: false,
  },
  naturalOak: {
    id: 'natural-oak',
    primary: '#d4b58f',
    secondary: '#b48f63',
    accent: '#efe7dc',
    metal: '#b79763',
    roughness: 0.58,
    metalness: 0.05,
    hasLed: false,
    hasGlass: false,
  },
};

const DEFAULT_SIZE_BY_KIND: Record<SceneObjectKind, Vec3> = {
  shelf: [1.35, 1.92, 0.42],
  counter: [1.55, 0.96, 0.58],
  table: [0.95, 0.78, 0.65],
  rack: [1.28, 1.68, 0.46],
  lamp: [0.46, 1.68, 0.46],
  plant: [0.68, 1.38, 0.68],
  art: [0.85, 1.25, 0.12],
};

/**
 * Infer a valid SpaceStage fixture kind from a real Shopify product title.
 */
export function inferKindFromProductTitle(title: string): SceneObjectKind | null {
  const t = title.toLowerCase();
  if (/\b(floor\s+lamp|standing\s+lamp|table\s+lamp|lamp|torchiere|sconce|lighting)\b/.test(t)) {
    return 'lamp';
  }
  if (/\b(garment\s+rack|clothing\s+rack|clothes\s+rack|coat\s+rack|display\s+rack|boutique\s+rack)\b/.test(t)) {
    return 'rack';
  }
  if (/\b(checkout\s+counter|reception\s+counter|retail\s+counter|cash\s+wrap|bar\s+counter|counter)\b/.test(t)) {
    return 'counter';
  }
  // Check tables BEFORE generic "shelf" so "Round End Table with Open Shelf" stays a table!
  if (/\b(display\s+table|end\s+table|side\s+table|coffee\s+table|console\s+table|pedestal\s+table|tray\s+table|accent\s+table|dining\s+table|table)\b/.test(t)) {
    return 'table';
  }
  if (/\b(bookcase|bookshelf|display\s+shelf|display\s+cabinet|shelving|etagere|curio|shelf|shelves)\b/.test(t)) {
    return 'shelf';
  }
  if (/\b(planter|flower\s+pot|plant\s+stand|potted\s+plant|fiddle\s+leaf|olive\s+tree|artificial\s+plant|botanical)\b/.test(t)) {
    return 'plant';
  }
  if (/\b(wall\s+art|framed\s+art|canvas\s+print|painting|gallery\s+frame|mirror)\b/.test(t)) {
    return 'art';
  }
  return null;
}

function parseDimensionsFromTitle(title: string): {
  inferredHeightM?: number;
  inferredWidthM?: number;
} {
  // Match explicit inches like "63.7in", "63.7 in", "28-inch", "25\""
  const inchMatches = Array.from(
    title.matchAll(/(\d{1,3}(?:\.\d+)?)\s*(?:in\b|inch(?:es)?\b|["”])/gi)
  ).map((m) => Number(m[1]));

  const validInches = inchMatches.filter((n) => Number.isFinite(n) && n >= 8 && n <= 110);
  if (validInches.length === 0) return {};

  const toMeters = (inches: number) => Number((inches * 0.0254).toFixed(2));
  if (validInches.length === 1) {
    const val = validInches[0];
    // Tall single values (>= 44 in) on lamps/shelves represent height
    if (val >= 44) {
      return { inferredHeightM: toMeters(val) };
    }
    return { inferredWidthM: toMeters(val) };
  }

  // Two values like "25 in / 28 in" -> smaller as width, larger as height
  const sorted = [...validInches].sort((a, b) => a - b);
  return {
    inferredWidthM: toMeters(sorted[0]),
    inferredHeightM: toMeters(sorted[sorted.length - 1]),
  };
}

/**
 * Derive deterministic, product-faithful 3D appearance & style metadata from a real Shopify ProductRef.
 */
export function deriveProductVisuals(product?: ProductRef): ProductVisualSpec {
  const title = product?.title ?? '';
  const t = title.toLowerCase();

  const hasLed = /\b(led|dimmable|lighted|illuminated|rgb|glow)\b/.test(t);
  const hasGlass = /\b(glass|acrylic|vitrine|curio|clear|crystal)\b/.test(t);

  let baseFinish = FINISH_PRESETS.naturalOak;
  if (/\b(matte\s+black|black|charcoal|ebony|espresso|obsidian|dark\s+metal)\b/.test(t)) {
    baseFinish = FINISH_PRESETS.matteBlack;
  } else if (/\b(white|ivory|cream|alabaster|linen|pearl|off-white)\b/.test(t)) {
    baseFinish = FINISH_PRESETS.crispWhite;
  } else if (/\b(walnut|dark\s+wood|mahogany|smoked\s+oak)\b/.test(t)) {
    baseFinish = FINISH_PRESETS.walnut;
  } else if (/\b(cherry|chestnut|redwood|rustic\s+brown|brown)\b/.test(t)) {
    baseFinish = FINISH_PRESETS.cherry;
  } else if (/\b(gold|brass|champagne|bronze|amber)\b/.test(t)) {
    baseFinish = FINISH_PRESETS.brassGold;
  } else if (/\b(chrome|silver|steel|nickel|aluminum|grey|gray)\b/.test(t)) {
    baseFinish = FINISH_PRESETS.chromeSilver;
  } else if (/\b(green|sage|olive|emerald)\b/.test(t)) {
    baseFinish = FINISH_PRESETS.sageGreen;
  } else if (/\b(terracotta|clay|blush|pink|rust|coral)\b/.test(t)) {
    baseFinish = FINISH_PRESETS.terracotta;
  } else if (product) {
    // Deterministic subtle distinction so different uncolored Shopify SKUs still visibly look distinct from defaults
    const hash = Array.from(product.variantId).reduce(
      (acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 997,
      7
    );
    const pool = [
      FINISH_PRESETS.matteBlack,
      FINISH_PRESETS.walnut,
      FINISH_PRESETS.crispWhite,
      FINISH_PRESETS.brassGold,
      FINISH_PRESETS.cherry,
    ];
    baseFinish = pool[hash % pool.length];
  }

  const finish: FinishPalette = {
    ...baseFinish,
    hasLed,
    hasGlass,
  };

  let lampStyle: LampVariantStyle = 'minimal-column';
  if (/\b(mid-century|mid\s+century|globe|orb|clayton|dimmable|modern\s+led|arched|arc)\b/.test(t)) {
    lampStyle = 'midcentury-globe';
  } else if (/\b(standing\s+lamp|column|minimalist|paper|cylinder|linen|tower)\b/.test(t)) {
    lampStyle = 'minimal-column';
  } else if (/\b(brass|gold|tripod)\b/.test(t)) {
    lampStyle = 'arched-brass';
  } else {
    lampStyle = 'drum-shade';
  }

  let tableStyle: TableVariantStyle = 'travertine-island';
  if (/\b(round|circle|circular|end\s+table|side\s+table|open\s+shelf|metal\s+frame|accent)\b/.test(t)) {
    tableStyle = 'round-metal';
  } else if (/\b(flower|cherry|pedestal|wood|walnut|oak|console|tray|foldable)\b/.test(t)) {
    tableStyle = 'pedestal-wood';
  }

  let shelfStyle: ShelfVariantStyle = 'apothecary-oak';
  if (hasLed || /\b(drawer|cabinet|curio|glass|brottar|vitrine)\b/.test(t)) {
    shelfStyle = 'led-cabinet';
  } else if (/\b(bookcase|bookshelf|storage|cube|artiss|white)\b/.test(t)) {
    shelfStyle = 'minimal-bookcase';
  } else if (/\b(metal|industrial|iron|steel|ladder|open\s+frame)\b/.test(t)) {
    shelfStyle = 'metal-etagere';
  }

  const dims = parseDimensionsFromTitle(title);

  return {
    inferredKind: inferKindFromProductTitle(title),
    finish,
    lampStyle,
    tableStyle,
    shelfStyle,
    ...dims,
  };
}

/**
 * Compute updated size when replacing an object with a Shopify product (handles
 * cross-category replacements cleanly and applies any explicit title dimensions
 * without fabricating unverified precision).
 */
export function computeReplacementPatch(
  current: SceneObject,
  product: ProductRef,
  verifiedSize?: Vec3
): Partial<SceneObject> {
  const visuals = deriveProductVisuals(product);
  const nextKind = visuals.inferredKind ?? current.kind;

  let nextSize: Vec3 = verifiedSize ? [...verifiedSize] : [...current.size];

  if (!verifiedSize) {
    if (nextKind !== current.kind) {
      nextSize = [...DEFAULT_SIZE_BY_KIND[nextKind]];
    }

    // Apply explicit single/dual dimensions if clearly stated in title (still approximate!)
    if (visuals.inferredHeightM) {
      nextSize = [
        nextSize[0],
        Math.min(2.45, Math.max(0.45, visuals.inferredHeightM)),
        nextSize[2],
      ];
    }
    if (visuals.inferredWidthM && nextKind === 'table' && visuals.tableStyle === 'round-metal') {
      const diam = Math.min(1.35, Math.max(0.45, visuals.inferredWidthM));
      nextSize = [diam, nextSize[1], diam];
    } else if (nextKind === 'table' && visuals.tableStyle === 'round-metal' && nextSize[0] > 1.2) {
      // Compact round end table replaces an oversized 2m island proportionally
      nextSize = [0.72, 0.68, 0.72];
    } else if (nextKind === 'shelf' && visuals.shelfStyle === 'led-cabinet' && nextSize[0] > 1.7) {
      nextSize = [1.18, Math.min(nextSize[1], 1.82), 0.42];
    }
  }

  return {
    kind: nextKind,
    source: 'shopify',
    product,
    size: nextSize,
    dimensionsVerified: Boolean(verifiedSize),
  };
}
