import type { SceneObject } from '@/lib/schema';

export const GLB_MODEL_PATHS = {
  plant: '/models/plant.glb',
  lamp: '/models/lamp.glb',
  vase: '/models/vase.glb',
  chair: '/models/chair.glb',
} as const;

export type GlbModelSpec = {
  url: string;
  fitMode: 'contain' | 'height';
  yOffset?: number;
};

const CHAIR_LABEL_PATTERN = /chair|lounge|seat/i;

/**
 * Resolves a real PBR GLB asset for a scene object when appropriate.
 *
 * When a fixture has been replaced with a live Shopify product (`source === 'shopify'`),
 * lamps, tables, shelves, racks, and counters render via our product-faithful PBR
 * fixture generator so clicking "Replace in 3D scene" immediately transforms the 3D
 * silhouette, color/finish, lighting, and proportions to match the selected SKU.
 */
export function resolveGlbForObject(obj: SceneObject): GlbModelSpec | null {
  if (obj.kind === 'plant') {
    return { url: GLB_MODEL_PATHS.plant, fitMode: 'contain' };
  }

  if (obj.kind === 'lamp') {
    // Use the sculpted antique Khronos GLB for default/proposal lamps,
    // and switch to our product-faithful modern LED/standing PBR lamps when replaced with a Shopify SKU.
    if (obj.source === 'shopify' && obj.product) {
      return null;
    }
    return { url: GLB_MODEL_PATHS.lamp, fitMode: 'height' };
  }

  if (
    CHAIR_LABEL_PATTERN.test(obj.label) &&
    !(obj.source === 'shopify' && obj.product && obj.kind !== 'table')
  ) {
    if (obj.source === 'shopify' && obj.product && !CHAIR_LABEL_PATTERN.test(obj.product.title)) {
      return null;
    }
    return { url: GLB_MODEL_PATHS.chair, fitMode: 'contain' };
  }

  return null;
}
