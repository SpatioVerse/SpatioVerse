import { getEntranceClearanceOBB, getObjectOBB2D, obbIntersectsOBB } from '@/lib/constraints';
import {
  FT_TO_METERS,
  type ConstraintIssue,
  type RoomWall,
  type SceneObject,
  type SceneValidator,
  type ShopScene,
  type Vec3,
} from '@/lib/schema';
import {
  applyPoseToScene,
  computePoseAlongWall,
  findValidatedAlternative,
  getNearestWall,
  getOppositeWall,
} from '@/lib/voiceActions';

export interface ObjectPose {
  position: Vec3;
  rotationY: number;
}

export interface LayoutOption {
  /** Stable 1-based option number shown on thumbnails and referenced by voice */
  index: number;
  id: string;
  name: string;
  tradeoff: string;
  metricsSummary: string;
  poses: Record<string, ObjectPose>;
  movedObjectIds: string[];
}

export interface ProactiveSuggestion {
  id: string;
  fingerprint: string;
  title: string;
  spokenPrompt: string;
  objectId: string;
  targetPosition: Vec3;
  targetRotationY: number;
  targetLabel: string;
  reasonCode: 'BLOCKED_PATH' | 'COLLISION' | 'OUT_OF_BOUNDS' | 'TIGHT_ENTRANCE';
  clearanceGainMeters?: number;
  createdEpoch: number;
}

function snap(value: number): number {
  return Number((Math.round(value / 0.02) * 0.02).toFixed(3));
}

function metersToFeetText(meters: number): string {
  return `${(meters / FT_TO_METERS).toFixed(1)} ft`;
}

function poseDistance(a: ObjectPose, b: ObjectPose): number {
  const dx = a.position[0] - b.position[0];
  const dz = a.position[2] - b.position[2];
  const dRot = Math.abs(((a.rotationY - b.rotationY + Math.PI) % (Math.PI * 2)) - Math.PI);
  return Math.hypot(dx, dz) + dRot * 0.35;
}

function layoutDifferenceScore(
  a: Record<string, ObjectPose>,
  b: Record<string, ObjectPose>
): number {
  let total = 0;
  for (const id of Object.keys(a)) {
    if (b[id]) {
      total += poseDistance(a[id], b[id]);
    }
  }
  return total;
}

function applyPosesToScene(
  scene: ShopScene,
  poses: Record<string, ObjectPose>
): ShopScene {
  return {
    ...scene,
    objects: scene.objects.map((o) => {
      const p = poses[o.id];
      return p
        ? {
            ...o,
            position: [p.position[0], p.position[1], p.position[2]],
            rotationY: p.rotationY,
          }
        : o;
    }),
  };
}

function extractCurrentPoses(scene: ShopScene): Record<string, ObjectPose> {
  const poses: Record<string, ObjectPose> = {};
  for (const obj of scene.objects) {
    poses[obj.id] = {
      position: [...obj.position],
      rotationY: obj.rotationY,
    };
  }
  return poses;
}

/**
 * Measures the minimum real distance (meters) from the entrance doorway center
 * to the nearest floor fixture edge in `scene`.
 */
export function measureEntranceClearanceMeters(scene: ShopScene): number {
  const { doorCenter, inwardDir } = getEntranceClearanceOBB(
    scene.room,
    scene.minWalkwayWidth,
    'center'
  );
  let minDist = Math.max(scene.room.width, scene.room.depth);

  for (const obj of scene.objects) {
    if (obj.position[1] >= 2.1) continue;
    const obb = getObjectOBB2D(obj);
    for (const [cx, cz] of obb.corners) {
      const dx = cx - doorCenter[0];
      const dz = cz - doorCenter[1];
      const alongInward = dx * inwardDir[0] + dz * inwardDir[1];
      const lateral = Math.abs(
        inwardDir[0] !== 0 ? cz - doorCenter[1] : cx - doorCenter[0]
      );
      if (lateral <= Math.max(scene.room.entrance.width, scene.minWalkwayWidth) * 0.9 && alongInward >= 0) {
        minDist = Math.min(minDist, alongInward);
      }
    }
  }

  return Number(Math.max(0, minDist).toFixed(2));
}

function getMovedObjectIds(
  scene: ShopScene,
  poses: Record<string, ObjectPose>
): string[] {
  const moved: string[] = [];
  for (const obj of scene.objects) {
    const p = poses[obj.id];
    if (!p) continue;
    if (poseDistance({ position: obj.position, rotationY: obj.rotationY }, p) > 0.08) {
      moved.push(obj.id);
    }
  }
  return moved;
}

/**
 * Attempts to place a subset of unlocked objects into candidate poses along
 * preferred walls while validating each placement incrementally so collisions
 * and blocked paths never occur.
 */
function placeObjectsSequentially(
  scene: ShopScene,
  targetIds: string[],
  wallOrder: RoomWall[],
  validator: SceneValidator,
  preferLateralFractions: number[],
  allowCenterForTables = false
): Record<string, ObjectPose> {
  let workingScene = structuredClone(scene);
  const poses = extractCurrentPoses(scene);

  for (const id of targetIds) {
    const obj = workingScene.objects.find((o) => o.id === id);
    if (!obj || obj.locked) continue;

    let placed = false;

    if (allowCenterForTables && obj.kind === 'table') {
      const { inwardDir } = getEntranceClearanceOBB(
        scene.room,
        scene.minWalkwayWidth,
        'center'
      );
      const centerCandidates: Array<{ pos: Vec3; rot: number }> = [
        {
          pos: [
            snap(inwardDir[0] * 0.45),
            obj.position[1],
            snap(inwardDir[1] * 0.45),
          ],
          rot: 0,
        },
        {
          pos: [
            snap(inwardDir[0] * 0.55),
            obj.position[1],
            snap(inwardDir[1] * 0.55),
          ],
          rot: Math.PI / 2,
        },
        {
          pos: [0, obj.position[1], 0],
          rot: 0,
        },
      ];

      for (const cand of centerCandidates) {
        const nextScene = applyPoseToScene(workingScene, id, cand.pos, cand.rot);
        const errs = validator(nextScene).filter((i) => i.severity === 'error');
        if (errs.length === 0) {
          workingScene = nextScene;
          poses[id] = { position: cand.pos, rotationY: cand.rot };
          placed = true;
          break;
        }
      }
      if (placed) continue;
    }

    for (const wall of wallOrder) {
      const span =
        wall === 'north' || wall === 'south'
          ? scene.room.width / 2
          : scene.room.depth / 2;

      for (const frac of preferLateralFractions) {
        const pose = computePoseAlongWall(obj, scene.room, wall, frac * span, true);
        const nextScene = applyPoseToScene(
          workingScene,
          id,
          pose.position,
          pose.rotationY
        );
        const errs = validator(nextScene).filter((i) => i.severity === 'error');
        if (errs.length === 0) {
          workingScene = nextScene;
          poses[id] = { position: pose.position, rotationY: pose.rotationY };
          placed = true;
          break;
        }
      }
      if (placed) break;
    }
  }

  return poses;
}

/**
 * Generates up to 3 genuinely different, validator-verified room layouts using
 * the current furniture, respecting locked items, budget, and required clearances.
 * Offers fewer options when fewer genuinely distinct valid layouts are feasible.
 */
export function generateValidatedLayouts(
  scene: ShopScene,
  validator: SceneValidator
): LayoutOption[] {
  const entranceWall = scene.room.entrance.wall;
  const backWall = getOppositeWall(entranceWall);
  const sideWalls: RoomWall[] =
    entranceWall === 'north' || entranceWall === 'south'
      ? ['west', 'east']
      : ['north', 'south'];

  const unlocked = scene.objects.filter((o) => !o.locked);
  if (unlocked.length === 0) {
    return [];
  }

  const basePoses = extractCurrentPoses(scene);
  const baseClearance = measureEntranceClearanceMeters(scene);

  const candidates: Array<{
    id: string;
    name: string;
    tradeoff: string;
    poses: Record<string, ObjectPose>;
  }> = [];

  // Candidate 1: "Wider entrance" — push movable fixtures toward back & upper side walls
  {
    const orderedIds = [...unlocked]
      .sort((a, b) => {
        const rank = (k: SceneObject['kind']) =>
          k === 'counter' ? 0 : k === 'shelf' ? 1 : k === 'rack' ? 2 : k === 'table' ? 3 : 4;
        return rank(a.kind) - rank(b.kind);
      })
      .map((o) => o.id);

    const poses = placeObjectsSequentially(
      scene,
      orderedIds,
      [backWall, sideWalls[0], sideWalls[1]],
      validator,
      [-0.55, 0.55, 0, -0.25, 0.25, -0.78, 0.78],
      true
    );

    candidates.push({
      id: 'layout-wider-entrance',
      name: 'Wider entrance',
      tradeoff:
        'Maximizes open arrival space inside the doorway, but shifts display fixtures deeper toward the back wall.',
      poses,
    });
  }

  // Candidate 2: "More display space" — perimeter gallery loop on opposing side walls + open center
  {
    const orderedIds = [...unlocked]
      .sort((a, b) => {
        const rank = (k: SceneObject['kind']) =>
          k === 'shelf' ? 0 : k === 'rack' ? 1 : k === 'table' ? 2 : k === 'counter' ? 3 : 4;
        return rank(a.kind) - rank(b.kind);
      })
      .map((o) => o.id);

    const poses = placeObjectsSequentially(
      scene,
      orderedIds,
      [sideWalls[1], sideWalls[0], backWall],
      validator,
      [0.35, -0.35, 0, 0.68, -0.68, 0.15, -0.15],
      false
    );

    candidates.push({
      id: 'layout-more-display',
      name: 'More display space',
      tradeoff:
        'Opens the center floor for browsing and perimeter merchandising, but moves the checkout counter further toward the side.',
      poses,
    });
  }

  // Candidate 3: "Reuse existing furniture" — keep all owned fixtures anchored, arrange only proposed/new items
  {
    const movableNonOwned = unlocked
      .filter((o) => o.source !== 'owned')
      .map((o) => o.id);

    if (movableNonOwned.length > 0) {
      const poses = placeObjectsSequentially(
        scene,
        movableNonOwned,
        [sideWalls[1], backWall, sideWalls[0]],
        validator,
        [0.45, -0.45, 0, 0.72, -0.72],
        true
      );

      candidates.push({
        id: 'layout-reuse-owned',
        name: 'Reuse existing furniture',
        tradeoff:
          'Leaves your owned fixtures in place with zero heavy moving, but offers slightly tighter flow than a full reset.',
        poses,
      });
    } else {
      // Fallback distinct option if all fixtures are owned: mirrored wall swap
      const poses = placeObjectsSequentially(
        scene,
        unlocked.map((o) => o.id),
        [sideWalls[1], backWall, sideWalls[0]],
        validator,
        [0.5, -0.5, 0, 0.75, -0.75],
        false
      );
      candidates.push({
        id: 'layout-mirrored-flow',
        name: 'Mirrored wall flow',
        tradeoff:
          'Flips primary fixtures to the opposite wall to refresh sightlines, but requires moving existing pieces.',
        poses,
      });
    }
  }

  const accepted: LayoutOption[] = [];

  for (const cand of candidates) {
    const candidateScene = applyPosesToScene(scene, cand.poses);
    const errors = validator(candidateScene).filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      continue;
    }

    const movedIds = getMovedObjectIds(scene, cand.poses);
    if (movedIds.length === 0) {
      continue;
    }

    // Ensure genuinely distinct from current room and from previously accepted options
    const diffFromBase = layoutDifferenceScore(basePoses, cand.poses);
    if (diffFromBase < 0.35) {
      continue;
    }

    const tooSimilar = accepted.some(
      (prev) => layoutDifferenceScore(prev.poses, cand.poses) < 0.55
    );
    if (tooSimilar) {
      continue;
    }

    const clearM = measureEntranceClearanceMeters(candidateScene);
    const deltaM = clearM - baseClearance;
    const entryNote =
      deltaM >= 0.15
        ? `+${metersToFeetText(deltaM)} clearer entry (${metersToFeetText(clearM)} open)`
        : `${metersToFeetText(clearM)} clear entry`;

    accepted.push({
      index: accepted.length + 1,
      id: cand.id,
      name: cand.name,
      tradeoff: cand.tradeoff,
      metricsSummary: `${entryNote} · ${movedIds.length} item${movedIds.length === 1 ? '' : 's'} adjusted · Valid`,
      poses: cand.poses,
      movedObjectIds: movedIds,
    });
  }

  return accepted;
}

/**
 * Evaluates the current committed room after a drag, voice edit, or constraint
 * change and returns ONE grounded, validated proactive improvement—or `null`
 * if there is nothing meaningful to suggest or the suggestion was already dismissed.
 */
export function computeProactiveSuggestion(
  scene: ShopScene,
  validator: SceneValidator,
  dismissedFingerprints: string[],
  editEpoch: number,
  lastEditedObjectId?: string | null
): ProactiveSuggestion | null {
  const dismissed = new Set(dismissedFingerprints);
  const issues = validator(scene);
  const errors = issues.filter((i) => i.severity === 'error');

  // 1. Highest priority: fix an actual blocking spatial error (BLOCKED_PATH, COLLISION, OUT_OF_BOUNDS)
  const spatialError: ConstraintIssue | undefined =
    errors.find(
      (i) =>
        (i.code === 'BLOCKED_PATH' ||
          i.code === 'COLLISION' ||
          i.code === 'OUT_OF_BOUNDS') &&
        lastEditedObjectId &&
        i.objectIds.includes(lastEditedObjectId)
    ) ??
    errors.find(
      (i) =>
        i.code === 'BLOCKED_PATH' ||
        i.code === 'COLLISION' ||
        i.code === 'OUT_OF_BOUNDS'
    );

  if (spatialError) {
    const culpritId =
      (lastEditedObjectId &&
        spatialError.objectIds.includes(lastEditedObjectId) &&
        lastEditedObjectId) ||
      spatialError.objectIds[0];

    const culprit = scene.objects.find((o) => o.id === culpritId && !o.locked);
    if (culprit) {
      const alt = findValidatedAlternative(
        scene,
        culprit.id,
        culprit.position,
        validator
      );
      if (alt) {
        const fingerprint = `${spatialError.code}:${culprit.id}:${alt.wall}:${Math.round(culprit.position[0] * 5)}:${Math.round(culprit.position[2] * 5)}`;
        if (!dismissed.has(fingerprint)) {
          const beforeClear = measureEntranceClearanceMeters(scene);
          const afterScene = applyPoseToScene(
            scene,
            culprit.id,
            alt.position,
            alt.rotationY
          );
          const afterClear = measureEntranceClearanceMeters(afterScene);
          const gainM = Math.max(0, Number((afterClear - beforeClear).toFixed(2)));

          const wallPhrase =
            alt.wall === getOppositeWall(scene.room.entrance.wall)
              ? 'the back wall'
              : `the ${alt.wall} wall`;

          const spokenPrompt =
            spatialError.code === 'BLOCKED_PATH'
              ? `Moving ${culprit.label} to ${wallPhrase} would clear the entrance${gainM >= 0.2 ? ` and add ${metersToFeetText(gainM)} of walkway` : ''}. Want to see it?`
              : spatialError.code === 'COLLISION'
                ? `Moving ${culprit.label} to ${wallPhrase} resolves the overlap cleanly. Want to see it?`
                : `Shifting ${culprit.label} along ${wallPhrase} brings it back inside the room bounds. Want to see it?`;

          return {
            id: `suggest-${editEpoch}`,
            fingerprint,
            title: `Move ${culprit.label} to ${wallPhrase}`,
            spokenPrompt,
            objectId: culprit.id,
            targetPosition: alt.position,
            targetRotationY: alt.rotationY,
            targetLabel: alt.label,
            reasonCode: spatialError.code as ProactiveSuggestion['reasonCode'],
            clearanceGainMeters: gainM,
            createdEpoch: editEpoch,
          };
        }
      }
    }
  }

  // 2. Proactive entrance-breathing improvement: if a recently moved unlocked fixture
  // sits right near the entrance zone (within an expanded 1.55m vestibule) and moving it
  // to the back/side wall adds >= 0.45m (~1.5 ft) of real measured entrance clearance
  if (errors.length === 0 && lastEditedObjectId) {
    const target = scene.objects.find(
      (o) => o.id === lastEditedObjectId && !o.locked
    );
    if (target) {
      const expandedVestibule = getEntranceClearanceOBB(
        scene.room,
        Math.max(scene.minWalkwayWidth + 0.65, 1.55),
        'center'
      ).clearanceOBB;

      const nearEntrance = obbIntersectsOBB(
        getObjectOBB2D(target),
        expandedVestibule,
        0
      );

      if (nearEntrance) {
        const alt = findValidatedAlternative(
          scene,
          target.id,
          target.position,
          validator
        );
        if (alt && alt.wall !== getNearestWall(target.position, scene.room)) {
          const beforeClear = measureEntranceClearanceMeters(scene);
          const afterScene = applyPoseToScene(
            scene,
            target.id,
            alt.position,
            alt.rotationY
          );
          const afterClear = measureEntranceClearanceMeters(afterScene);
          const gainM = Number((afterClear - beforeClear).toFixed(2));

          if (gainM >= 0.45) {
            const fingerprint = `TIGHT_ENTRANCE:${target.id}:${alt.wall}:${Math.round(target.position[0] * 4)}:${Math.round(target.position[2] * 4)}`;
            if (!dismissed.has(fingerprint)) {
              const wallPhrase =
                alt.wall === getOppositeWall(scene.room.entrance.wall)
                  ? 'the back wall'
                  : `the ${alt.wall} wall`;
              return {
                id: `suggest-${editEpoch}`,
                fingerprint,
                title: `Open +${metersToFeetText(gainM)} at the entrance`,
                spokenPrompt: `Moving ${target.label} to ${wallPhrase} would give you ${metersToFeetText(gainM)} more room at the entrance. Want to see it?`,
                objectId: target.id,
                targetPosition: alt.position,
                targetRotationY: alt.rotationY,
                targetLabel: alt.label,
                reasonCode: 'TIGHT_ENTRANCE',
                clearanceGainMeters: gainM,
                createdEpoch: editEpoch,
              };
            }
          }
        }
      }
    }
  }

  return null;
}
