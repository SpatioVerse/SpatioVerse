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
 * Returns `null` for bespoke architectural fixtures (counters, shelves, tables,
 * racks, wall art), which render with handcrafted procedural PBR cabinetry and
 * may embed `GLB_MODEL_PATHS.vase` as a sculptural floral centerpiece.
 */
export function resolveGlbForObject(obj: SceneObject): GlbModelSpec | null {
  if (obj.kind === 'plant') {
    return { url: GLB_MODEL_PATHS.plant, fitMode: 'contain' };
  }

  if (obj.kind === 'lamp') {
    return { url: GLB_MODEL_PATHS.lamp, fitMode: 'height' };
  }

  if (CHAIR_LABEL_PATTERN.test(obj.label)) {
    return { url: GLB_MODEL_PATHS.chair, fitMode: 'contain' };
  }

  return null;
}
