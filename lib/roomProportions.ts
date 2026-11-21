import type { SceneObject, SceneObjectKind, ShopScene, Vec3 } from '@/lib/schema';

interface FurnitureBounds {
  min: Vec3;
  max: Vec3;
}

function resolveFurnitureBounds(
  kind: SceneObjectKind,
  label: string
): FurnitureBounds {
  const t = label.toLowerCase();

  if (/\b(bed|mattress|daybed)\b/.test(t)) {
    return { min: [1.55, 0.8, 1.9], max: [2.15, 1.15, 2.2] };
  }
  if (/\b(sofa|couch|sectional|loveseat|settee)\b/.test(t)) {
    return { min: [1.55, 0.74, 0.78], max: [2.25, 0.95, 1.02] };
  }
  if (/\b(stool|ottoman|pouf)\b/.test(t)) {
    return { min: [0.4, 0.42, 0.4], max: [0.68, 0.78, 0.68] };
  }
  if (/\b(chair|armchair|recliner|lounger|wingback|bench)\b/.test(t)) {
    return { min: [0.55, 0.74, 0.55], max: [0.95, 1.02, 0.95] };
  }
  if (/\b(coffee\s*table)\b/.test(t)) {
    return { min: [0.85, 0.36, 0.5], max: [1.32, 0.52, 0.78] };
  }
  if (/\b(end\s*table|side\s*table|nightstand|accent\s*table|round.*table)\b/.test(t)) {
    return { min: [0.46, 0.48, 0.46], max: [0.82, 0.72, 0.82] };
  }
  if (/\b(desk|console|dining\s*table|display\s*table|table)\b/.test(t) || kind === 'table') {
    return { min: [0.8, 0.55, 0.52], max: [1.65, 0.82, 0.95] };
  }
  if (kind === 'counter') {
    return { min: [1.1, 0.86, 0.52], max: [1.8, 1.06, 0.82] };
  }
  if (kind === 'shelf' || kind === 'rack') {
    return { min: [0.75, 1.25, 0.34], max: [1.5, 2.15, 0.62] };
  }
  if (kind === 'lamp') {
    if (/\b(desk|table)\s+lamp\b/.test(t)) {
      return { min: [0.24, 0.38, 0.24], max: [0.42, 0.62, 0.42] };
    }
    return { min: [0.36, 1.35, 0.36], max: [0.58, 1.82, 0.58] };
  }
  if (kind === 'plant') {
    return { min: [0.42, 0.65, 0.42], max: [0.75, 1.45, 0.75] };
  }
  // art / mirror
  return { min: [0.55, 0.75, 0.08], max: [1.35, 1.85, 0.35] };
}

/**
 * Normalizes `[width, height, depth]` into realistic real-world furniture
 * proportions while respecting the room's physical envelope.
 */
export function normalizeObjectSizeForRoom(
  size: Vec3,
  kind: SceneObjectKind,
  room: ShopScene['room'],
  label = ''
): Vec3 {
  const bounds = resolveFurnitureBounds(kind, label);
  const rawW = Number.isFinite(size[0]) && size[0] > 0 ? size[0] : (bounds.min[0] + bounds.max[0]) / 2;
  const rawH = Number.isFinite(size[1]) && size[1] > 0 ? size[1] : (bounds.min[1] + bounds.max[1]) / 2;
  const rawD = Number.isFinite(size[2]) && size[2] > 0 ? size[2] : (bounds.min[2] + bounds.max[2]) / 2;

  const roomMaxW = Math.max(0.6, room.width * 0.45);
  const roomMaxH = Math.max(0.6, room.height * 0.76);
  const roomMaxD = Math.max(0.5, room.depth * 0.45);

  const clampAxis = (val: number, minV: number, maxV: number, roomCap: number) => {
    const cap = Math.min(maxV, roomCap);
    const floor = Math.min(minV, cap);
    return Math.max(floor, Math.min(cap, val));
  };

  const w = clampAxis(rawW, bounds.min[0], bounds.max[0], roomMaxW);
  const h = clampAxis(rawH, bounds.min[1], bounds.max[1], roomMaxH);
  const d = clampAxis(rawD, bounds.min[2], bounds.max[2], roomMaxD);

  return [
    Number(w.toFixed(2)),
    Number(h.toFixed(2)),
    Number(d.toFixed(2)),
  ];
}

function normalizeLabelKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Removes duplicate instances of the same Shopify product (`productId`) or
 * identical `(kind, normalized label)` so the 3D scene never renders stacked
 * duplicate copies of the same object.
 */
export function deduplicateSceneObjects(objects: SceneObject[]): SceneObject[] {
  const seenProductIds = new Set<string>();
  const seenLabelKeys = new Set<string>();
  const result: SceneObject[] = [];

  for (const obj of objects) {
    const pid = obj.product?.productId?.trim();
    if (pid) {
      if (seenProductIds.has(pid)) continue;
      seenProductIds.add(pid);
    }

    const labelKey = `${obj.kind}::${normalizeLabelKey(obj.label)}`;
    if (seenLabelKeys.has(labelKey)) continue;
    seenLabelKeys.add(labelKey);

    result.push(obj);
  }

  return result;
}
