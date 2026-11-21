import type {
  ConstraintIssue,
  SceneObject,
  ShopScene,
  Vec3,
} from './schema';

/**
 * SpaceStage Spatial & Commerce Constraint Engine
 *
 * Conventions (Section 4):
 * - All lengths are in meters (1 ft = 0.3048 m; 3 ft walkway = 0.9144 m).
 * - Floor plane uses X (width: west -> east) and Z (depth: north -> south); Y is vertical up.
 * - Default room origin ('center'): floor spans X in [-width/2, +width/2], Z in [-depth/2, +depth/2],
 *   matching Three.js / React Three Fiber plane centering. Pass `{ origin: 'corner' }` if evaluating
 *   scenes defined in [0, width] x [0, depth].
 * - `rotationY` is in radians around +Y (values with |rotationY| > 2*pi are defensively converted from degrees).
 * - Prices are integer cents; `source === 'owned'` objects always contribute 0 cents to new purchases.
 */

export const FEET_TO_METERS = 0.3048;
export const DEFAULT_MIN_WALKWAY_METERS = 3 * FEET_TO_METERS; // 0.9144 m (3 ft)

const EPS = 1e-3; // 1 mm geometric tolerance so flush items touching walls/each other are allowed
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
  /** Unit axis along local X in world (X, Z) */
  axisU: [number, number];
  /** Unit axis along local Z in world (X, Z) */
  axisV: [number, number];
  corners: Array<[number, number]>;
}

const DRILLING_KEYWORDS =
  /\b(wall[- ]?mount(?:ed)?|floating\s+shelf|ceiling[- ]?mount(?:ed)?|hanging|pendant|sconce|drilled|screw[- ]?in|anchored|wall[- ]?bracket|wall[- ]?hung)\b/i;

const NON_DRILLING_QUALIFIERS =
  /\b(freestanding|free[- ]?standing|floor[- ]?standing|tabletop|countertop|leaning|easel|adhesive|command[- ]?strip|suction|tension)\b/i;

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
 * Resolves [bottomY, topY] supporting both bottom-origin (y = 0 on floor)
 * and mesh-center-origin (y = size[1]/2 on floor) R3F conventions cleanly.
 */
export function getVerticalSpan(obj: SceneObject): [number, number] {
  const [, rawY] = obj.position;
  const [, height] = obj.size;
  const h = Math.max(0, height);

  if (Math.abs(rawY) <= 0.02) {
    return [rawY, rawY + h];
  }
  if (Math.abs(rawY - h / 2) <= 0.02) {
    return [0, h];
  }
  if (rawY < 0) {
    return [rawY, rawY + h];
  }
  // Elevated object: treat y as center when h > 0 and y >= h/2, keeping bottom strictly > 0
  return [rawY - h / 2, rawY + h / 2];
}

export function getObjectOBB2D(obj: SceneObject): OBB2D {
  const [cx, , cz] = obj.position;
  const hx = Math.max(0, obj.size[0]) / 2;
  const hz = Math.max(0, obj.size[2]) / 2;
  const theta = normalizeRadians(obj.rotationY);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  // Three.js right-handed rotation around +Y: local +X -> (cos, -sin), local +Z -> (sin, cos)
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
 * Touching edges within ` shrinkTolerance ` (default 1 mm) are NOT treated as colliding.
 */
export function obbIntersectsOBB(
  a: OBB2D,
  b: OBB2D,
  shrinkTolerance: number = EPS
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

  const clampedU = Math.max(-obb.halfExtents[0], Math.min(obb.halfExtents[0], localU));
  const clampedV = Math.max(-obb.halfExtents[1], Math.min(obb.halfExtents[1], localV));

  const excessU = localU - clampedU;
  const excessV = localV - clampedV;
  return Math.hypot(excessU, excessV);
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
 * extending `clearanceDepth` (e.g. 3 ft = 0.9144 m) inward from the doorway.
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
    Math.max(minWalkwayWidth, DEFAULT_MIN_WALKWAY_METERS),
    wall === 'north' || wall === 'south' ? room.depth : room.width
  );

  if (wall === 'north' || wall === 'south') {
    const wallCenter = origin === 'center' ? 0 : offset;
    const rawCenterX = origin === 'center' ? offset : wallCenter;
    const halfW = clearanceWidth / 2;
    const centerX = Math.max(
      bounds.minX + Math.min(halfW, room.width / 2),
      Math.min(bounds.maxX - Math.min(halfW, room.width / 2), rawCenterX)
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

  // East or West wall
  const rawCenterZ = offset;
  const halfW = clearanceWidth / 2;
  const centerZ = Math.max(
    bounds.minZ + Math.min(halfW, room.depth / 2),
    Math.min(bounds.maxZ - Math.min(halfW, room.depth / 2), rawCenterZ)
  );
  const minZ = Math.max(bounds.minZ, centerZ - halfW);
  const maxZ = Math.min(bounds.maxZ, centerZ + halfW);

  if (wall === 'west') {
    return {
      clearanceOBB: makeAxisAlignedOBB(
        bounds.minX,
        bounds.minX + clearanceDepth,
        minZ,
        maxZ
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
      maxZ
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
  const step = 0.06; // 6 cm grid (~61x51 cells for 12x10 ft -> <0.3 ms)

  const usableMinX = bounds.minX + radius - EPS;
  const usableMaxX = bounds.maxX - radius + EPS;
  const usableMinZ = bounds.minZ + radius - EPS;
  const usableMaxZ = bounds.maxZ - radius + EPS;

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
        if (distancePointToOBB(x, z, obb) < radius - 0.01) {
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

  // Seed BFS with free cells within doorway entry band
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
      if (distAlongNormal <= step * 1.5 && distAlongWall <= seedBand) {
        visited[idx] = 1;
        queue.push(idx);
      }
    }
  }

  if (queue.length === 0) {
    // Identify obstacles closest to the entrance threshold
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

  // Run 4-connected BFS across the navigable configuration space
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

    const neighbors = [
      r > 0 ? (r - 1) * cols + c : -1,
      r + 1 < rows ? (r + 1) * cols + c : -1,
      c > 0 ? r * cols + (c - 1) : -1,
      c + 1 < cols ? r * cols + (c + 1) : -1,
    ];
    for (const nIdx of neighbors) {
      if (nIdx >= 0 && free[nIdx] && !visited[nIdx]) {
        visited[nIdx] = 1;
        queue.push(nIdx);
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
    // Find fixtures pinching the corridor between entrance and room center
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

  // Check that every primary retail fixture can be approached from the reachable 3ft walkway
  // Browser reach: shopper center is `radius` away from fixture edge + up to 0.35m comfortable reach margin
  const maxApproachDist = radius + 0.35;
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
 * Deterministically validates a `ShopScene` against physical bounds, rotated OBB collisions,
 * 3ft entrance & interior walkway access, new-purchase budget, no-drilling rules,
 * and dimension verification status.
 */
export function validateScene(
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

  // 1. OUT_OF_BOUNDS checks (footprint corners + vertical room height + positive dimensions)
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
        message: `"${obj.label}" (${obj.id}) has invalid non-positive dimensions [${w}, ${h}, ${d}].`,
        severity: 'error',
      });
      continue;
    }

    const outX = obb.corners.some(
      ([x]) => x < bounds.minX - EPS || x > bounds.maxX + EPS
    );
    const outZ = obb.corners.some(
      ([, z]) => z < bounds.minZ - EPS || z > bounds.maxZ + EPS
    );
    const [bottomY, topY] = verticalSpan;
    const outY = bottomY < -0.02 || topY > scene.room.height + EPS;

    if (outX || outZ || outY) {
      const reasons: string[] = [];
      if (outX || outZ) {
        reasons.push(
          `footprint extends outside the ${scene.room.width.toFixed(2)}m x ${scene.room.depth.toFixed(2)}m floor boundary`
        );
      }
      if (outY) {
        reasons.push(
          `vertical span [${bottomY.toFixed(2)}m, ${topY.toFixed(2)}m] exceeds floor/ceiling [0m, ${scene.room.height.toFixed(2)}m]`
        );
      }
      issues.push({
        code: 'OUT_OF_BOUNDS',
        objectIds: [obj.id],
        message: `"${obj.label}" (${obj.id}) is out of bounds: ${reasons.join(' and ')}.`,
        severity: 'error',
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
      const verticalOverlap = minYA < maxYB - EPS && minYB < maxYA - EPS;
      if (!verticalOverlap) continue;

      // Exempt small decor/lamps resting cleanly on top of a supporting fixture
      const aOnB =
        SUPPORT_SURFACE_KINDS.has(b.obj.kind) &&
        !PRIMARY_SHOP_FIXTURE_KINDS.has(a.obj.kind) &&
        Math.abs(minYA - maxYB) <= 0.08;
      const bOnA =
        SUPPORT_SURFACE_KINDS.has(a.obj.kind) &&
        !PRIMARY_SHOP_FIXTURE_KINDS.has(b.obj.kind) &&
        Math.abs(minYB - maxYA) <= 0.08;
      if (aOnB || bOnA) continue;

      if (obbIntersectsOBB(a.obb, b.obb, EPS)) {
        issues.push({
          code: 'COLLISION',
          objectIds: [a.obj.id, b.obj.id],
          message: `"${a.obj.label}" (${a.obj.id}) collides with "${b.obj.label}" (${b.obj.id}).`,
          severity: 'error',
        });
      }
    }
  }

  // 3. BLOCKED_PATH checks (entrance clearance box + 3ft continuous interior walkway BFS)
  const floorObstacles = objectGeometry.filter(
    ({ verticalSpan }) => verticalSpan[0] < 2.0
  );
  const { clearanceOBB } = getEntranceClearanceOBB(
    scene.room,
    minWalkwayWidth,
    origin
  );

  const entranceBlockingIds: string[] = [];
  for (const { obj, obb } of floorObstacles) {
    if (obbIntersectsOBB(obb, clearanceOBB, EPS)) {
      entranceBlockingIds.push(obj.id);
    }
  }

  if (entranceBlockingIds.length > 0) {
    issues.push({
      code: 'BLOCKED_PATH',
      objectIds: entranceBlockingIds,
      message: `Entrance on ${scene.room.entrance.wall} wall is obstructed; keep at least ${minWalkwayWidth.toFixed(2)}m (3 ft) clear inside the doorway (blocked by: ${entranceBlockingIds.join(', ')}).`,
      severity: 'error',
    });
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

  // 4. NO_DRILLING checks
  if (scene.noDrilling) {
    for (const { obj, verticalSpan } of objectGeometry) {
      const [bottomY] = verticalSpan;
      const hasDrillLabel =
        DRILLING_KEYWORDS.test(obj.label) &&
        !NON_DRILLING_QUALIFIERS.test(obj.label);
      const isUnqualifiedWallArt =
        obj.kind === 'art' && !NON_DRILLING_QUALIFIERS.test(obj.label);
      const isFloatingUnsupported =
        bottomY > ELEVATED_THRESHOLD_M &&
        !isSupportedBySurface(obj, bottomY, scene.objects) &&
        !NON_DRILLING_QUALIFIERS.test(obj.label);

      if (hasDrillLabel || isUnqualifiedWallArt || isFloatingUnsupported) {
        issues.push({
          code: 'NO_DRILLING',
          objectIds: [obj.id],
          message: `"${obj.label}" (${obj.id}) requires wall/ceiling mounting or is suspended at ${bottomY.toFixed(2)}m while noDrilling is enabled.`,
          severity: 'error',
        });
      }
    }
  }

  // 5. OVER_BUDGET check (owned objects always cost $0 toward new purchases)
  let newPurchaseCents = 0;
  const purchasedObjectIds: string[] = [];

  for (const obj of scene.objects) {
    if (obj.source === 'owned') continue;
    const priceCents = obj.product?.priceCents;
    if (typeof priceCents === 'number' && Number.isFinite(priceCents) && priceCents > 0) {
      newPurchaseCents += Math.round(priceCents);
      purchasedObjectIds.push(obj.id);
    }
  }

  if (newPurchaseCents > scene.budgetCents) {
    const spentDollars = (newPurchaseCents / 100).toFixed(2);
    const budgetDollars = (scene.budgetCents / 100).toFixed(2);
    const overDollars = ((newPurchaseCents - scene.budgetCents) / 100).toFixed(2);
    issues.push({
      code: 'OVER_BUDGET',
      objectIds: purchasedObjectIds,
      message: `New fixture purchases total $${spentDollars}, exceeding the $${budgetDollars} budget by $${overDollars}.`,
      severity: 'error',
    });
  }

  // 6. UNVERIFIED_DIMENSIONS warnings (never treated as verified pass without warning)
  const unverifiedObjects = scene.objects.filter((obj) => !obj.dimensionsVerified);
  if (unverifiedObjects.length > 0) {
    issues.push({
      code: 'UNVERIFIED_DIMENSIONS',
      objectIds: unverifiedObjects.map((o) => o.id),
      message: `Physical dimensions are unverified/approximate for ${unverifiedObjects.length} item(s) (${unverifiedObjects.map((o) => `"${o.label}"`).join(', ')}); confirm measurements before purchase.`,
      severity: 'warning',
    });
  }

  // Also flag non-owned proposals missing live product pricing as a transparent warning
  const unpricedProposals = scene.objects.filter(
    (obj) =>
      obj.source !== 'owned' &&
      (obj.product === undefined || typeof obj.product.priceCents !== 'number')
  );
  if (unpricedProposals.length > 0) {
    // Only emit UNVERIFIED_DIMENSIONS if not already covered, or append clear note so budget audit is honest
    const uncovered = unpricedProposals.filter((o) => o.dimensionsVerified);
    if (uncovered.length > 0) {
      issues.push({
        code: 'UNVERIFIED_DIMENSIONS',
        objectIds: uncovered.map((o) => o.id),
        message: `Proposed item(s) (${uncovered.map((o) => `"${o.label}"`).join(', ')}) are generic placeholders not yet linked to a verified Shopify product/price.`,
        severity: 'warning',
      });
    }
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
 * Convenience helper returning just the ConstraintIssue array for UI callbacks.
 */
export function getConstraintIssues(
  scene: ShopScene,
  options?: ValidateSceneOptions
): ConstraintIssue[] {
  return validateScene(scene, options).issues;
}

/**
 * Helper to convert Vec3 / scalar measurements from feet to meters.
 */
export function feetToMeters(feet: number): number {
  return Number((feet * FEET_TO_METERS).toFixed(4));
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
