import type { SceneObject, SceneObjectKind, ShopScene, Vec3 } from '@/lib/schema';

const KIND_HEIGHT_CAP_RATIO: Record<SceneObjectKind, number> = {
  shelf: 0.82,
  rack: 0.78,
  lamp: 0.76,
  plant: 0.68,
  art: 0.65,
  counter: 0.52,
  table: 0.55,
};

const KIND_FOOTPRINT_CAP_RATIO: Record<SceneObjectKind, number> = {
  shelf: 0.48,
  rack: 0.44,
  lamp: 0.24,
  plant: 0.28,
  art: 0.42,
  counter: 0.50,
  table: 0.52,
};

/**
 * Scales an object's `[width, height, depth]` uniformly so its aspect ratio
 * remains natural while giving every furniture piece a substantial, realistic
 * presence proportional to the room's width, depth, and ceiling height.
 */
export function normalizeObjectSizeForRoom(
  size: Vec3,
  kind: SceneObjectKind,
  room: ShopScene['room'],
  label = ''
): Vec3 {
  let [w, h, d] = size;
  if (!Number.isFinite(w) || w <= 0) w = 0.9;
  if (!Number.isFinite(h) || h <= 0) h = 0.9;
  if (!Number.isFinite(d) || d <= 0) d = 0.7;

  const text = label.toLowerCase();
  const isBed = /\b(bed|mattress|daybed)\b/.test(text);
  const isSofa = /\b(sofa|couch|sectional|loveseat|settee)\b/.test(text);
  const isFloorLamp = kind === 'lamp' && !/\b(desk|table)\s+lamp\b/.test(text);

  // Larger rooms (e.g. 24x18 ft flagship) need proportionally fuller furniture presence
  const roomDiag = Math.hypot(room.width, room.depth);
  const roomScale = Math.max(1.0, Math.min(1.38, roomDiag / 6.0));

  const maxH = Math.max(
    0.75,
    Math.min(2.65, room.height * (KIND_HEIGHT_CAP_RATIO[kind] ?? 0.72))
  );
  const footprintCap = isBed || isSofa ? 0.56 : (KIND_FOOTPRINT_CAP_RATIO[kind] ?? 0.48);
  const maxW = Math.max(0.75, Math.min(2.9, room.width * footprintCap));
  const maxD = Math.max(0.65, Math.min(isBed ? 2.55 : 1.9, room.depth * footprintCap));

  // Target realistic minimums by furniture type & room scale
  let minW = 0.62 * roomScale;
  let minD = 0.52 * roomScale;
  let minH = 0.62 * roomScale;

  if (isBed) {
    minW = 1.85 * Math.min(1.2, roomScale);
    minD = 2.05 * Math.min(1.2, roomScale);
    minH = 1.05 * Math.min(1.18, roomScale);
  } else if (isSofa) {
    minW = 1.95 * Math.min(1.22, roomScale);
    minD = 0.92 * Math.min(1.15, roomScale);
    minH = 0.88 * Math.min(1.15, roomScale);
  } else if (kind === 'plant') {
    minW = 0.62 * roomScale;
    minD = 0.62 * roomScale;
    minH = 1.05 * roomScale;
  } else if (isFloorLamp) {
    minW = 0.52 * roomScale;
    minD = 0.52 * roomScale;
    minH = 1.65 * Math.min(1.18, roomScale);
  } else if (kind === 'shelf' || kind === 'rack') {
    minW = 0.95 * Math.min(1.2, roomScale);
    minD = 0.42 * Math.min(1.15, roomScale);
    minH = 1.75 * Math.min(1.18, roomScale);
  } else if (kind === 'counter') {
    minW = 1.35 * Math.min(1.2, roomScale);
    minD = 0.65 * Math.min(1.15, roomScale);
    minH = 0.96 * Math.min(1.12, roomScale);
  }

  // First grow uniformly if object is too small for the room
  const growRatio = Math.max(
    1,
    minW / Math.max(w, 0.05),
    minH / Math.max(h, 0.05),
    minD / Math.max(d, 0.05)
  );
  // Cap growth so aspect ratio stays natural without blowing past room bounds
  const cappedGrow = Math.min(growRatio, 1.55);
  w *= cappedGrow;
  h *= cappedGrow;
  d *= cappedGrow;

  // Then shrink uniformly only if it exceeds room envelope caps
  const shrinkScale = Math.min(1, maxW / w, maxH / h, maxD / d);
  w *= shrinkScale;
  h *= shrinkScale;
  d *= shrinkScale;

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
