import {
  FT_TO_METERS,
  type ConstraintIssue,
  type SceneObject,
  type SceneValidator,
  type ShopScene,
  type Vec3,
} from '@/lib/schema';

/**
 * SpaceStage Spatial & Commerce Constraint Engine
 *
 * Conventions (aligned with `lib/schema.ts` & `TEAM_INTEGRATION.md`):
 * - All lengths are in meters (`FT_TO_METERS = 0.3048`; 3 ft walkway = `0.9144` m).
 * - Floor is on the X/Z plane at Y = 0, centered at (0, 0):
 *     X in [-room.width / 2, +room.width / 2]
 *     Z in [-room.depth / 2, +room.depth / 2]
 *     Y in [0, room.height]
 * - Walls: `north` (z = -depth/2), `south` (z = +depth/2),
 *          `west` (x = -width/2), `east` (x = +width/2).
 * - `SceneObject.position`: `[x, y, z]` where `x, z` is footprint center and `y` is bottom elevation (`0` = floor).
 * - `SceneObject.rotationY`: counter-clockwise radians around +Y.
 * - Prices are integer cents; `source === 'owned'` objects always contribute 0 cents to new purchases.
 */

export const FEET_TO_METERS = FT_TO_METERS;
export const DEFAULT_MIN_WALKWAY_METERS = Number((3 * FT_TO_METERS).toFixed(4)); // 0.9144 m

const GEOM_EPS = 1e-3; // 1 mm geometric tolerance so flush items touching walls/each other are valid
const ELEVATED_THRESHOLD_M = 0.05; // > 5 cm above floor counts as elevated unless supported

export type CoordinateOrigin = 'center' | 'corner';

export interface ValidateSceneOptions {
  origin?: CoordinateOrigin;
}

export interface ValidationSummary {
  errorCount: number;
  warningCount: number;
  newPurchaseCents: number;
  budgetCents: number;
  remainingBudgetCents: number;
}

export interface ValidationResult {
  valid: boolean;
  issues: ConstraintIssue[];
  summary: ValidationSummary;
}

export interface RoomBounds2D {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface OBB2D {
  center: [number, number];
  halfExtents: [number, number];
  /** Unit axis along local +X in world (X, Z) */
  axisU: [number, number];
  /** Unit axis along local +Z in world (X, Z) */
  axisV: [number, number];
  corners: Array<[number, number]>;
}

const DRILLING_KEYWORDS =
  /\b(wall[- ]?mount(?:ed)?|floating\s+shelf|ceiling[- ]?mount(?:ed)?|hanging|pendant|sconce|drilled|screw[- ]?in|anchored|wall[- ]?bracket|wall[- ]?hung)\b/i;

const NON_DRILLING_QUALIFIERS =
  /\b(freestanding|free[- ]?standing|floor[- ]?standing|floor[- ]?leaning|tabletop|countertop|leaning|easel|adhesive|command[- ]?strip|suction|tension)\b/i;

const SUPPORT_SURFACE_KINDS = new Set<SceneObject['kind']>([
  'counter',
  'table',
  'shelf',
]);

const PRIMARY_SHOP_FIXTURE_KINDS = new Set<SceneObject['kind']>([
  'counter',
  'shelf',
  'table',
  'rack',
]);

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export function normalizeRadians(rotationY: number): number {
  if (!Number.isFinite(rotationY)) return 0;
  if (Math.abs(rotationY) > Math.PI * 2 + 0.01) {
    return (rotationY * Math.PI) / 180;
  }
  return rotationY;
}

export function getRoomBounds(
  room: ShopScene['room'],
  origin: CoordinateOrigin = 'center'
): RoomBounds2D {
  if (origin === 'corner') {
    return {
      minX: 0,
      maxX: room.width,
      minZ: 0,
      maxZ: room.depth,
    };
  }
  return {
    minX: -room.width / 2,
    maxX: room.width / 2,
    minZ: -room.depth / 2,
    maxZ: room.depth / 2,
  };
}

/**
 * Returns `[minY, maxY]` in meters where `position[1]` is bottom elevation (`0` = floor).
 */
export function getVerticalSpan(obj: SceneObject): [number, number] {
  const minY = obj.position[1];
  const height = Math.max(0, obj.size[1]);
  return [minY, minY + height];
}

export function getObjectOBB2D(obj: SceneObject): OBB2D {
  const [cx, , cz] = obj.position;
  const hx = Math.max(0, obj.size[0]) / 2;
  const hz = Math.max(0, obj.size[2]) / 2;
  const theta = normalizeRadians(obj.rotationY);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  // Matches Three.js Y-up right-handed rotation around +Y:
  // local +X -> (cos, -sin), local +Z -> (sin, cos)
  const axisU: [number, number] = [cos, -sin];
  const axisV: [number, number] = [sin, cos];

  const corners: Array<[number, number]> = [
    [cx - hx * axisU[0] - hz * axisV[0], cz - hx * axisU[1] - hz * axisV[1]],
    [cx + hx * axisU[0] - hz * axisV[0], cz + hx * axisU[1] - hz * axisV[1]],
    [cx + hx * axisU[0] + hz * axisV[0], cz + hx * axisU[1] + hz * axisV[1]],
    [cx - hx * axisU[0] + hz * axisV[0], cz - hx * axisU[1] + hz * axisV[1]],
  ];

  return {
    center: [cx, cz],
    halfExtents: [hx, hz],
    axisU,
    axisV,
    corners,
  };
}

function projectCorners(
  corners: Array<[number, number]>,
  axis: [number, number]
): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const [x, z] of corners) {
    const proj = x * axis[0] + z * axis[1];
    if (proj < min) min = proj;
    if (proj > max) max = proj;
  }
  return [min, max];
}

/**
 * Exact 2D Separating Axis Theorem (SAT) intersection check for two rotated rectangles.
 * Touching edges within `shrinkTolerance` (default 1 mm) are NOT treated as colliding.
 */
export function obbIntersectsOBB(
  a: OBB2D,
  b: OBB2D,
  shrinkTolerance: number = GEOM_EPS
): boolean {
  const axes: Array<[number, number]> = [
    a.axisU,
    a.axisV,
    b.axisU,
    b.axisV,
  ];

  for (const axis of axes) {
    const [minA, maxA] = projectCorners(a.corners, axis);
    const [minB, maxB] = projectCorners(b.corners, axis);
    if (maxA <= minB + shrinkTolerance || maxB <= minA + shrinkTolerance) {
      return false;
    }
  }
  return true;
}

/**
 * Minimum distance from a 2D point (px, pz) to an oriented bounding box (0 if inside).
 */
export function distancePointToOBB(
  px: number,
  pz: number,
  obb: OBB2D
): number {
  const dx = px - obb.center[0];
  const dz = pz - obb.center[1];
  const localU = dx * obb.axisU[0] + dz * obb.axisU[1];
  const localV = dx * obb.axisV[0] + dz * obb.axisV[1];

  const clampedU = Math.max(
    -obb.halfExtents[0],
    Math.min(obb.halfExtents[0], localU)
  );
  const clampedV = Math.max(
    -obb.halfExtents[1],
    Math.min(obb.halfExtents[1], localV)
  );

  return Math.hypot(localU - clampedU, localV - clampedV);
}

function makeAxisAlignedOBB(
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number
): OBB2D {
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const hx = Math.max(0, maxX - minX) / 2;
  const hz = Math.max(0, maxZ - minZ) / 2;
  return {
    center: [cx, cz],
    halfExtents: [hx, hz],
    axisU: [1, 0],
    axisV: [0, 1],
    corners: [
      [minX, minZ],
      [maxX, minZ],
      [maxX, maxZ],
      [minX, maxZ],
    ],
  };
}

/**
 * Computes the entrance doorway center along its wall and the required clear vestibule rectangle
 * extending `clearanceDepth` (3 ft = 0.9144 m) inward from the doorway.
 */
export function getEntranceClearanceOBB(
  room: ShopScene['room'],
  minWalkwayWidth: number,
  origin: CoordinateOrigin = 'center'
): {
  clearanceOBB: OBB2D;
  doorCenter: [number, number];
  inwardDir: [number, number];
} {
  const bounds = getRoomBounds(room, origin);
  const { wall, offset, width: rawDoorWidth } = room.entrance;
  const doorWidth = Math.max(rawDoorWidth || DEFAULT_MIN_WALKWAY_METERS, 0.5);
  const clearanceWidth = Math.max(doorWidth, minWalkwayWidth);
  const clearanceDepth = Math.min(
    Math.max(minWalkwayWidth, 0.75),
    wall === 'north' || wall === 'south' ? room.depth : room.width
  );

  if (wall === 'north' || wall === 'south') {
    const halfW = clearanceWidth / 2;
    const centerX = Math.max(
      bounds.minX + Math.min(halfW, room.width / 2),
      Math.min(bounds.maxX - Math.min(halfW, room.width / 2), offset)
    );
    const minX = Math.max(bounds.minX, centerX - halfW);
    const maxX = Math.min(bounds.maxX, centerX + halfW);

    if (wall === 'north') {
      return {
        clearanceOBB: makeAxisAlignedOBB(
          minX,
          maxX,
          bounds.minZ,
          bounds.minZ + clearanceDepth
        ),
        doorCenter: [centerX, bounds.minZ],
        inwardDir: [0, 1],
      };
    }
    return {
      clearanceOBB: makeAxisAlignedOBB(
        minX,
        maxX,
        bounds.maxZ - clearanceDepth,
        bounds.maxZ
      ),
      doorCenter: [centerX, bounds.maxZ],
      inwardDir: [0, -1],
    };
  }

  const halfW = clearanceWidth / 2;
  const centerZ = Math.max(
    bounds.minZ + Math.min(halfW, room.depth / 2),
    Math.min(bounds.maxZ - Math.min(halfW, room.depth / 2), offset)
  );
  const minZ = Math.max(bounds.minZ, centerZ - halfW);
  const clampedMaxZ = Math.min(bounds.maxZ, centerZ + halfW);

  if (wall === 'west') {
    return {
      clearanceOBB: makeAxisAlignedOBB(
        bounds.minX,
        bounds.minX + clearanceDepth,
        minZ,
        clampedMaxZ
      ),
      doorCenter: [bounds.minX, centerZ],
      inwardDir: [1, 0],
    };
  }
  return {
    clearanceOBB: makeAxisAlignedOBB(
      bounds.maxX - clearanceDepth,
      bounds.maxX,
      minZ,
      clampedMaxZ
    ),
    doorCenter: [bounds.maxX, centerZ],
    inwardDir: [-1, 0],
  };
}

function isSupportedBySurface(
  target: SceneObject,
  targetBottomY: number,
  allObjects: SceneObject[]
): boolean {
  const [tx, , tz] = target.position;
  for (const candidate of allObjects) {
    if (candidate.id === target.id) continue;
    if (!SUPPORT_SURFACE_KINDS.has(candidate.kind)) continue;
    const [, surfaceTopY] = getVerticalSpan(candidate);
    if (Math.abs(targetBottomY - surfaceTopY) <= 0.08) {
      const surfaceOBB = getObjectOBB2D(candidate);
      if (distancePointToOBB(tx, tz, surfaceOBB) <= 0.02) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Checks whether a continuous walkway of width `minWalkwayWidth` (default 3 ft = 0.9144 m)
 * connects the entrance into the shop interior and reaches primary retail fixtures.
 */
function checkWalkwayConnectivity(
  scene: ShopScene,
  floorObstacles: Array<{ obj: SceneObject; obb: OBB2D }>,
  minWalkwayWidth: number,
  origin: CoordinateOrigin
): { blocked: boolean; culpritIds: string[]; reason?: string } {
  const { room } = scene;
  if (room.width < minWalkwayWidth || room.depth < minWalkwayWidth) {
    return {
      blocked: true,
      culpritIds: [],
      reason: `Room dimensions (${room.width.toFixed(2)}m x ${room.depth.toFixed(2)}m) are narrower than required ${minWalkwayWidth.toFixed(2)}m walkway.`,
    };
  }

  const bounds = getRoomBounds(room, origin);
  const radius = minWalkwayWidth / 2;
  const step = 0.05; // 5 cm grid resolution (~0.3 ms execution)
  const clearanceMargin = 0.025; // half-grid-cell discretization allowance

  const usableMinX = bounds.minX + radius - GEOM_EPS;
  const usableMaxX = bounds.maxX - radius + GEOM_EPS;
  const usableMinZ = bounds.minZ + radius - GEOM_EPS;
  const usableMaxZ = bounds.maxZ - radius + GEOM_EPS;

  const cols = Math.max(1, Math.floor((usableMaxX - usableMinX) / step) + 1);
  const rows = Math.max(1, Math.floor((usableMaxZ - usableMinZ) / step) + 1);

  const cellX = (c: number) =>
    cols === 1 ? (usableMinX + usableMaxX) / 2 : usableMinX + c * step;
  const cellZ = (r: number) =>
    rows === 1 ? (usableMinZ + usableMaxZ) / 2 : usableMinZ + r * step;

  const free = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    const z = cellZ(r);
    for (let c = 0; c < cols; c++) {
      const x = cellX(c);
      let ok = true;
      for (const { obb } of floorObstacles) {
        if (distancePointToOBB(x, z, obb) < radius - clearanceMargin) {
          ok = false;
          break;
        }
      }
      if (ok) free[r * cols + c] = 1;
    }
  }

  const { doorCenter, inwardDir } = getEntranceClearanceOBB(
    room,
    minWalkwayWidth,
    origin
  );
  const entryTargetX = Math.max(
    usableMinX,
    Math.min(usableMaxX, doorCenter[0] + inwardDir[0] * radius)
  );
  const entryTargetZ = Math.max(
    usableMinZ,
    Math.min(usableMaxZ, doorCenter[1] + inwardDir[1] * radius)
  );

  const visited = new Uint8Array(rows * cols);
  const queue: number[] = [];
  const seedBand = Math.max(room.entrance.width / 2, step * 1.5);

  for (let r = 0; r < rows; r++) {
    const z = cellZ(r);
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (!free[idx]) continue;
      const x = cellX(c);
      const distAlongNormal =
        Math.abs(inwardDir[0]) > 0
          ? Math.abs(x - entryTargetX)
          : Math.abs(z - entryTargetZ);
      const distAlongWall =
        Math.abs(inwardDir[0]) > 0
          ? Math.abs(z - entryTargetZ)
          : Math.abs(x - entryTargetX);
      if (distAlongNormal <= step * 1.6 && distAlongWall <= seedBand) {
        visited[idx] = 1;
        queue.push(idx);
      }
    }
  }

  if (queue.length === 0) {
    const culprits = floorObstacles
      .filter(
        ({ obb }) =>
          distancePointToOBB(entryTargetX, entryTargetZ, obb) <
          minWalkwayWidth
      )
      .map(({ obj }) => obj.id);
    return {
      blocked: true,
      culpritIds: culprits,
      reason: `Entrance access does not have a clear ${minWalkwayWidth.toFixed(2)}m (3 ft) wide opening into the room.`,
    };
  }

  // 8-connected BFS across navigable 3ft walkway configuration space
  let head = 0;
  let maxPenetration = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const r = Math.floor(idx / cols);
    const c = idx % cols;
    const x = cellX(c);
    const z = cellZ(r);

    const pen =
      (x - doorCenter[0]) * inwardDir[0] + (z - doorCenter[1]) * inwardDir[1];
    if (pen > maxPenetration) maxPenetration = pen;

    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const nIdx = nr * cols + nc;
        if (free[nIdx] && !visited[nIdx]) {
          visited[nIdx] = 1;
          queue.push(nIdx);
        }
      }
    }
  }

  const roomSpanAlongEntry =
    Math.abs(inwardDir[0]) > 0 ? room.width : room.depth;
  const requiredPenetration = Math.min(
    roomSpanAlongEntry - radius,
    Math.max(minWalkwayWidth * 1.35, roomSpanAlongEntry * 0.45)
  );

  if (maxPenetration + step < requiredPenetration) {
    const midX = (bounds.minX + bounds.maxX) / 2;
    const midZ = (bounds.minZ + bounds.maxZ) / 2;
    const culprits = floorObstacles
      .filter(({ obb }) => {
        const dEntry = distancePointToOBB(entryTargetX, entryTargetZ, obb);
        const dMid = distancePointToOBB(midX, midZ, obb);
        return Math.min(dEntry, dMid) < minWalkwayWidth;
      })
      .map(({ obj }) => obj.id);

    return {
      blocked: true,
      culpritIds: culprits,
      reason: `Fixtures pinch the main walkway below ${minWalkwayWidth.toFixed(2)}m (3 ft), blocking access into the shop interior.`,
    };
  }

  // Ensure every primary retail fixture can be approached from the continuous 3ft walkway
  const maxApproachDist = radius + 0.45;
  const unreachableIds: string[] = [];

  for (const { obj, obb } of floorObstacles) {
    if (!PRIMARY_SHOP_FIXTURE_KINDS.has(obj.kind)) continue;
    let reachable = false;
    for (let i = 0; i < queue.length; i++) {
      const idx = queue[i];
      const r = Math.floor(idx / cols);
      const c = idx % cols;
      if (distancePointToOBB(cellX(c), cellZ(r), obb) <= maxApproachDist) {
        reachable = true;
        break;
      }
    }
    if (!reachable) {
      unreachableIds.push(obj.id);
    }
  }

  if (unreachableIds.length > 0) {
    return {
      blocked: true,
      culpritIds: unreachableIds,
      reason: `No ${minWalkwayWidth.toFixed(2)}m (3 ft) continuous walkway reaches fixture(s): ${unreachableIds.join(', ')}.`,
    };
  }

  return { blocked: false, culpritIds: [] };
}

/**
 * Evaluates all geometric and commerce rules and returns `{ valid, issues, summary }`.
 */
export function evaluateScene(
  scene: ShopScene,
  options: ValidateSceneOptions = {}
): ValidationResult {
  const origin: CoordinateOrigin = options.origin ?? 'center';
  const issues: ConstraintIssue[] = [];
  const bounds = getRoomBounds(scene.room, origin);
  const minWalkwayWidth =
    scene.minWalkwayWidth > 0
      ? scene.minWalkwayWidth
      : DEFAULT_MIN_WALKWAY_METERS;

  const objectGeometry = scene.objects.map((obj) => ({
    obj,
    obb: getObjectOBB2D(obj),
    verticalSpan: getVerticalSpan(obj),
  }));

  // 1. OUT_OF_BOUNDS, NO_DRILLING, and UNVERIFIED_DIMENSIONS
  for (const { obj, obb, verticalSpan } of objectGeometry) {
    const [w, h, d] = obj.size;
    if (
      !Number.isFinite(w) ||
      !Number.isFinite(h) ||
      !Number.isFinite(d) ||
      w <= 0 ||
      h <= 0 ||
      d <= 0
    ) {
      issues.push({
        code: 'OUT_OF_BOUNDS',
        objectIds: [obj.id],
        message: `${obj.label} has invalid non-positive dimensions.`,
        severity: 'error',
      });
      continue;
    }

    const outX = obb.corners.some(
      ([x]) => x < bounds.minX - GEOM_EPS || x > bounds.maxX + GEOM_EPS
    );
    const outZ = obb.corners.some(
      ([, z]) => z < bounds.minZ - GEOM_EPS || z > bounds.maxZ + GEOM_EPS
    );
    const [minY, maxY] = verticalSpan;
    const outY = minY < -GEOM_EPS || maxY > scene.room.height + GEOM_EPS;

    if (outX || outZ || outY) {
      issues.push({
        code: 'OUT_OF_BOUNDS',
        objectIds: [obj.id],
        message: `${obj.label} extends outside the room envelope.`,
        severity: 'error',
      });
    }

    if (scene.noDrilling) {
      const hasDrillLabel =
        DRILLING_KEYWORDS.test(obj.label) &&
        !NON_DRILLING_QUALIFIERS.test(obj.label);
      const isElevatedUnsupported =
        minY > ELEVATED_THRESHOLD_M &&
        !isSupportedBySurface(obj, minY, scene.objects) &&
        !NON_DRILLING_QUALIFIERS.test(obj.label);

      if (hasDrillLabel || isElevatedUnsupported) {
        issues.push({
          code: 'NO_DRILLING',
          objectIds: [obj.id],
          message: `${obj.label} requires wall/ceiling drilling or is suspended above the floor (no-drilling lease enabled).`,
          severity: 'error',
        });
      }
    }

    if (!obj.dimensionsVerified) {
      issues.push({
        code: 'UNVERIFIED_DIMENSIONS',
        objectIds: [obj.id],
        message: `${obj.label} uses estimated dimensions until verified against a product spec.`,
        severity: 'warning',
      });
    }
  }

  // 2. COLLISION checks (exact 2D SAT on rotated OBBs + vertical overlap, allowing tabletop support)
  for (let i = 0; i < objectGeometry.length; i++) {
    for (let j = i + 1; j < objectGeometry.length; j++) {
      const a = objectGeometry[i];
      const b = objectGeometry[j];

      const [minYA, maxYA] = a.verticalSpan;
      const [minYB, maxYB] = b.verticalSpan;
      const verticalOverlap =
        minYA < maxYB - GEOM_EPS && minYB < maxYA - GEOM_EPS;
      if (!verticalOverlap) continue;

      const aOnB =
        SUPPORT_SURFACE_KINDS.has(b.obj.kind) &&
        !PRIMARY_SHOP_FIXTURE_KINDS.has(a.obj.kind) &&
        Math.abs(minYA - maxYB) <= 0.08;
      const bOnA =
        SUPPORT_SURFACE_KINDS.has(a.obj.kind) &&
        !PRIMARY_SHOP_FIXTURE_KINDS.has(b.obj.kind) &&
        Math.abs(minYB - maxYA) <= 0.08;
      if (aOnB || bOnA) continue;

      if (obbIntersectsOBB(a.obb, b.obb, GEOM_EPS)) {
        issues.push({
          code: 'COLLISION',
          objectIds: [a.obj.id, b.obj.id],
          message: `${a.obj.label} overlaps with ${b.obj.label}.`,
          severity: 'error',
        });
      }
    }
  }

  // 3. BLOCKED_PATH checks (entrance clearance zone + continuous 3ft walkway BFS)
  const floorObstacles = objectGeometry.filter(
    ({ verticalSpan }) => verticalSpan[0] < 2.1
  );
  const { clearanceOBB } = getEntranceClearanceOBB(
    scene.room,
    minWalkwayWidth,
    origin
  );

  const entranceBlockingObjs = floorObstacles.filter(({ obb }) =>
    obbIntersectsOBB(obb, clearanceOBB, GEOM_EPS)
  );

  if (entranceBlockingObjs.length > 0) {
    for (const { obj } of entranceBlockingObjs) {
      issues.push({
        code: 'BLOCKED_PATH',
        objectIds: [obj.id],
        message: `${obj.label} obstructs the ${scene.room.entrance.wall} entrance clearance zone.`,
        severity: 'error',
      });
    }
  } else if (floorObstacles.length > 0) {
    const connectivity = checkWalkwayConnectivity(
      scene,
      floorObstacles,
      minWalkwayWidth,
      origin
    );
    if (connectivity.blocked) {
      issues.push({
        code: 'BLOCKED_PATH',
        objectIds: connectivity.culpritIds,
        message:
          connectivity.reason ??
          `Required ${minWalkwayWidth.toFixed(2)}m (3 ft) walkway from entrance is blocked.`,
        severity: 'error',
      });
    }
  }

  // 4. OVER_BUDGET check (owned objects always contribute 0 cents)
  let newPurchaseCents = 0;
  const purchasedObjectIds: string[] = [];

  for (const obj of scene.objects) {
    if (obj.source !== 'owned' && obj.product) {
      newPurchaseCents += Math.round(obj.product.priceCents);
      purchasedObjectIds.push(obj.id);
    }
  }

  if (newPurchaseCents > scene.budgetCents) {
    const overCents = newPurchaseCents - scene.budgetCents;
    issues.push({
      code: 'OVER_BUDGET',
      objectIds: purchasedObjectIds,
      message: `Selected purchases (${formatCents(newPurchaseCents)}) exceed the ${formatCents(scene.budgetCents)} budget by ${formatCents(overCents)}.`,
      severity: 'error',
    });
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;

  return {
    valid: errorCount === 0,
    issues,
    summary: {
      errorCount,
      warningCount,
      newPurchaseCents,
      budgetCents: scene.budgetCents,
      remainingBudgetCents: scene.budgetCents - newPurchaseCents,
    },
  };
}

/**
 * Primary `SceneValidator` export (`(scene: ShopScene) => ConstraintIssue[]`),
 * directly pluggable into `<SpaceCanvas validator={validateScene} />` and
 * `useSceneStore.getState().setValidator(validateScene)`.
 */
export const validateScene: SceneValidator = (
  scene: ShopScene
): ConstraintIssue[] => {
  return evaluateScene(scene).issues;
};

export function feetToMeters(feet: number): number {
  return Number((feet * FT_TO_METERS).toFixed(4));
}

export function clampPositionToRoom(
  pos: Vec3,
  size: Vec3,
  room: ShopScene['room'],
  origin: CoordinateOrigin = 'center'
): Vec3 {
  const bounds = getRoomBounds(room, origin);
  const hx = Math.min(size[0] / 2, room.width / 2);
  const hz = Math.min(size[2] / 2, room.depth / 2);
  return [
    Math.max(bounds.minX + hx, Math.min(bounds.maxX - hx, pos[0])),
    Math.max(0, Math.min(Math.max(0, room.height - size[1]), pos[1])),
    Math.max(bounds.minZ + hz, Math.min(bounds.maxZ - hz, pos[2])),
  ];
}
