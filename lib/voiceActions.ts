import { z } from 'zod';
import type { CameraBasis } from '@/lib/cameraBridge';
import {
  type ConstraintIssue,
  type RoomWall,
  type SceneObject,
  type SceneValidator,
  type ShopScene,
  type Vec3,
} from '@/lib/schema';

export type VoiceDirection =
  | 'left'
  | 'right'
  | 'forward'
  | 'back'
  | 'north'
  | 'south'
  | 'east'
  | 'west';

export type VoiceWallTarget = RoomWall | 'opposite' | 'other';

export interface VoiceAlternative {
  label: string;
  wall: RoomWall;
  position: Vec3;
  rotationY: number;
  reason: string;
}

export interface VoicePreviewState {
  objectId: string;
  originalPosition: Vec3;
  originalRotationY: number;
  previewPosition: Vec3;
  previewRotationY: number;
  issues: ConstraintIssue[];
  frozen: boolean;
  suggestedAlternative: VoiceAlternative | null;
  lastActionSummary: string;
  epoch: number;
}

export const VoiceActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('select_object'),
    objectId: z.string().min(1),
  }),
  z.object({
    type: z.literal('highlight_candidates'),
    objectIds: z.array(z.string().min(1)).min(1),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('preview_move'),
    objectId: z.string().min(1).optional(),
    direction: z.enum([
      'left',
      'right',
      'forward',
      'back',
      'north',
      'south',
      'east',
      'west',
    ]),
    distanceMeters: z.number().min(0.05).max(3.5).optional(),
  }),
  z.object({
    type: z.literal('preview_move_to_wall'),
    objectId: z.string().min(1).optional(),
    wall: z.enum(['north', 'south', 'east', 'west', 'opposite', 'other']),
    alignWithWall: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('preview_rotate'),
    objectId: z.string().min(1).optional(),
    mode: z.enum(['relative', 'sideways', 'face_center']).default('relative'),
    deltaDegrees: z.number().min(-360).max(360).optional(),
  }),
  z.object({
    type: z.literal('stop_preview_motion'),
  }),
  z.object({
    type: z.literal('preview_alternative'),
  }),
  z.object({
    type: z.literal('commit_preview'),
  }),
  z.object({
    type: z.literal('cancel_preview'),
  }),
  z.object({
    type: z.literal('undo_last_edit'),
  }),
  z.object({
    type: z.literal('set_language_preference'),
    language: z.string().min(1),
  }),
]);

export type VoiceAction = z.infer<typeof VoiceActionSchema>;

export interface VoiceCommandResponse {
  understood: string;
  replyText: string;
  detectedLanguage: string;
  updatedPreferredLanguage?: string | null;
  actions: VoiceAction[];
  modelUsed: string;
}

const WALL_MARGIN_M = 0.04;
const SNAP_M = 0.02;

function snap(value: number): number {
  return Number((Math.round(value / SNAP_M) * SNAP_M).toFixed(3));
}

function normalizeAngle(rad: number): number {
  let a = rad % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a <= -Math.PI) a += Math.PI * 2;
  return Number(a.toFixed(4));
}

/**
 * Computes a unit XZ movement vector for either camera-relative
 * ("left", "right", "forward", "back") or world-cardinal directions.
 */
export function resolveDirectionVectorXZ(
  direction: VoiceDirection,
  cameraBasis: CameraBasis
): [number, number] {
  const normalize = (x: number, z: number): [number, number] => {
    const len = Math.hypot(x, z);
    if (len < 1e-5) return [1, 0];
    return [x / len || 0, z / len || 0];
  };

  switch (direction) {
    case 'left':
      return normalize(-cameraBasis.rightXZ[0], -cameraBasis.rightXZ[1]);
    case 'right':
      return normalize(cameraBasis.rightXZ[0], cameraBasis.rightXZ[1]);
    case 'forward':
      return normalize(cameraBasis.forwardXZ[0], cameraBasis.forwardXZ[1]);
    case 'back':
      return normalize(-cameraBasis.forwardXZ[0], -cameraBasis.forwardXZ[1]);
    case 'north':
      return [0, -1];
    case 'south':
      return [0, 1];
    case 'east':
      return [1, 0];
    case 'west':
      return [-1, 0];
  }
}

/**
 * Computes half-extents of a rotated object along world X and Z axes.
 */
export function getRotatedHalfExtentsXZ(
  size: Vec3,
  rotationY: number
): [number, number] {
  const halfW = size[0] / 2;
  const halfD = size[2] / 2;
  const c = Math.abs(Math.cos(rotationY));
  const s = Math.abs(Math.sin(rotationY));
  return [halfW * c + halfD * s, halfW * s + halfD * c];
}

/**
 * Computes the next preview position for a directional nudge while keeping
 * vertical elevation intact. Does NOT silently clamp out-of-bounds if the user
 * deliberately nudges far — allows gentle wall slide or triggers validation honestly.
 */
export function computeMovedPosition(
  currentPos: Vec3,
  direction: VoiceDirection,
  distanceMeters: number,
  cameraBasis: CameraBasis
): Vec3 {
  const [dx, dz] = resolveDirectionVectorXZ(direction, cameraBasis);
  return [
    snap(currentPos[0] + dx * distanceMeters),
    currentPos[1],
    snap(currentPos[2] + dz * distanceMeters),
  ];
}

/**
 * Computes next rotation around +Y (in radians) for a preview rotation action.
 */
export function computeRotatedYaw(
  currentYaw: number,
  currentPos: Vec3,
  mode: 'relative' | 'sideways' | 'face_center',
  deltaDegrees?: number
): number {
  if (mode === 'face_center') {
    const angle = Math.atan2(-currentPos[0], -currentPos[2]);
    return normalizeAngle(angle);
  }
  if (mode === 'sideways') {
    const deg = typeof deltaDegrees === 'number' && deltaDegrees !== 0 ? deltaDegrees : 90;
    return normalizeAngle(currentYaw + (deg * Math.PI) / 180);
  }
  const deg = typeof deltaDegrees === 'number' && deltaDegrees !== 0 ? deltaDegrees : 90;
  return normalizeAngle(currentYaw + (deg * Math.PI) / 180);
}

/**
 * Determines which wall an object is currently closest to.
 */
export function getNearestWall(pos: Vec3, room: ShopScene['room']): RoomWall {
  const halfW = room.width / 2;
  const halfD = room.depth / 2;
  const distances: Array<{ wall: RoomWall; dist: number }> = [
    { wall: 'north', dist: Math.abs(pos[2] - -halfD) },
    { wall: 'south', dist: Math.abs(pos[2] - halfD) },
    { wall: 'west', dist: Math.abs(pos[0] - -halfW) },
    { wall: 'east', dist: Math.abs(pos[0] - halfW) },
  ];
  distances.sort((a, b) => a.dist - b.dist);
  return distances[0].wall;
}

export function getOppositeWall(wall: RoomWall): RoomWall {
  switch (wall) {
    case 'north':
      return 'south';
    case 'south':
      return 'north';
    case 'east':
      return 'west';
    case 'west':
      return 'east';
  }
}

/**
 * Computes a clean wall-aligned candidate pose along a target wall at a given
 * lateral coordinate along that wall.
 */
export function computePoseAlongWall(
  obj: SceneObject,
  room: ShopScene['room'],
  wall: RoomWall,
  lateralCoord: number,
  alignWithWall = true
): { position: Vec3; rotationY: number } {
  const halfW = room.width / 2;
  const halfD = room.depth / 2;

  let rotationY = obj.rotationY;
  if (alignWithWall) {
    switch (wall) {
      case 'north':
        rotationY = 0;
        break;
      case 'south':
        rotationY = Math.PI;
        break;
      case 'west':
        rotationY = Math.PI / 2;
        break;
      case 'east':
        rotationY = -Math.PI / 2;
        break;
    }
  }

  const [extX, extZ] = getRotatedHalfExtentsXZ(obj.size, rotationY);
  const clampedX = Math.max(
    -halfW + extX + WALL_MARGIN_M,
    Math.min(halfW - extX - WALL_MARGIN_M, lateralCoord)
  );
  const clampedZ = Math.max(
    -halfD + extZ + WALL_MARGIN_M,
    Math.min(halfD - extZ - WALL_MARGIN_M, lateralCoord)
  );

  switch (wall) {
    case 'north':
      return {
        position: [snap(clampedX), obj.position[1], snap(-halfD + extZ + WALL_MARGIN_M)],
        rotationY: normalizeAngle(rotationY),
      };
    case 'south':
      return {
        position: [snap(clampedX), obj.position[1], snap(halfD - extZ - WALL_MARGIN_M)],
        rotationY: normalizeAngle(rotationY),
      };
    case 'west':
      return {
        position: [snap(-halfW + extX + WALL_MARGIN_M), obj.position[1], snap(clampedZ)],
        rotationY: normalizeAngle(rotationY),
      };
    case 'east':
      return {
        position: [snap(halfW - extX - WALL_MARGIN_M), obj.position[1], snap(clampedZ)],
        rotationY: normalizeAngle(rotationY),
      };
  }
}

/**
 * Returns a hypothetical ShopScene with one object placed at a preview pose.
 */
export function applyPoseToScene(
  scene: ShopScene,
  objectId: string,
  position: Vec3,
  rotationY: number
): ShopScene {
  return {
    ...scene,
    objects: scene.objects.map((o) =>
      o.id === objectId
        ? { ...o, position: [position[0], position[1], position[2]], rotationY }
        : o
    ),
  };
}

/**
 * Deterministically finds ONE validated alternative placement (0 error-severity
 * issues under `validator`) when a preview placement is invalid (e.g., blocks
 * the entrance, collides with another fixture, or goes out of bounds).
 *
 * Prioritizes clear walls away from the entrance and away from the blocking wall.
 */
export function findValidatedAlternative(
  scene: ShopScene,
  objectId: string,
  currentPreviewPos: Vec3,
  validator: SceneValidator
): VoiceAlternative | null {
  const target = scene.objects.find((o) => o.id === objectId);
  if (!target) return null;

  const currentWall = getNearestWall(currentPreviewPos, scene.room);
  const entranceWall = scene.room.entrance.wall;

  // Order walls: prefer non-entrance walls different from the currently blocking wall first
  const allWalls: RoomWall[] = ['north', 'west', 'east', 'south'];
  const orderedWalls = [...allWalls].sort((a, b) => {
    const score = (w: RoomWall): number => {
      let s = 0;
      if (w === entranceWall) s += 10;
      if (w === currentWall) s += 4;
      return s;
    };
    return score(a) - score(b);
  });

  const sampleFractions = [0, -0.32, 0.32, -0.62, 0.62, -0.82, 0.82];

  for (const wall of orderedWalls) {
    const span =
      wall === 'north' || wall === 'south'
        ? scene.room.width / 2
        : scene.room.depth / 2;

    for (const frac of sampleFractions) {
      const lateral = frac * span;
      const pose = computePoseAlongWall(target, scene.room, wall, lateral, true);
      const candidateScene = applyPoseToScene(
        scene,
        objectId,
        pose.position,
        pose.rotationY
      );
      const issues = validator(candidateScene);
      const hasError = issues.some((i) => i.severity === 'error');
      if (!hasError) {
        const wallName = wall.charAt(0).toUpperCase() + wall.slice(1);
        return {
          label: `Along ${wallName} wall`,
          wall,
          position: pose.position,
          rotationY: pose.rotationY,
          reason: `Clear ${wall} wall placement with unobstructed 3 ft entrance & zero collisions.`,
        };
      }
    }
  }

  return null;
}

/**
 * Formats a compact, grounded room context block for Gemini (both Live Audio
 * sessions and typed fallback turns) containing stable object IDs, current
 * selection, camera orientation, active preview, and constraints.
 */
export function formatGroundedRoomContext(params: {
  scene: ShopScene;
  selectedId: string | null;
  cameraBasis: CameraBasis;
  activePreview: VoicePreviewState | null;
  preferredLanguage: string | null;
  canUndo: boolean;
}): string {
  const {
    scene,
    selectedId,
    cameraBasis,
    activePreview,
    preferredLanguage,
    canUndo,
  } = params;

  const objectsSummary = scene.objects.map((o) => ({
    id: o.id,
    kind: o.kind,
    label: o.label,
    source: o.source,
    locked: Boolean(o.locked),
    position: o.position.map((v) => Number(v.toFixed(2))),
    size: o.size.map((v) => Number(v.toFixed(2))),
    rotationDeg: Math.round(((o.rotationY * 180) / Math.PI) % 360),
    nearestWall: getNearestWall(o.position, scene.room),
  }));

  const payload = {
    room: {
      widthM: scene.room.width,
      depthM: scene.room.depth,
      heightM: scene.room.height,
      entrance: scene.room.entrance,
      minWalkwayWidthM: scene.minWalkwayWidth,
      noDrilling: scene.noDrilling,
    },
    camera: {
      facingWall: cameraBasis.facingWall,
      forwardXZ: cameraBasis.forwardXZ.map((v) => Number(v.toFixed(2))),
      rightXZ: cameraBasis.rightXZ.map((v) => Number(v.toFixed(2))),
    },
    selectedObjectId: selectedId,
    canUndo,
    preferredLanguage: preferredLanguage ?? 'auto (match user language)',
    activePreview: activePreview
      ? {
          objectId: activePreview.objectId,
          frozen: activePreview.frozen,
          previewPosition: activePreview.previewPosition.map((v) =>
            Number(v.toFixed(2))
          ),
          previewRotationDeg: Math.round(
            ((activePreview.previewRotationY * 180) / Math.PI) % 360
          ),
          errors: activePreview.issues
            .filter((i) => i.severity === 'error')
            .map((i) => ({ code: i.code, message: i.message })),
          suggestedAlternative: activePreview.suggestedAlternative
            ? {
                label: activePreview.suggestedAlternative.label,
                wall: activePreview.suggestedAlternative.wall,
              }
            : null,
        }
      : null,
    objects: objectsSummary,
  };

  return JSON.stringify(payload);
}

/**
 * Shared multilingual system prompt for SpaceStage's live voice & typed room editor.
 */
export function buildVoiceSystemInstruction(initialRoomContextJson: string): string {
  return [
    'You are SpaceStage, a responsive, multilingual 3D retail-room design assistant.',
    'You help a shop owner arrange real fixtures in their 3D boutique through natural multi-turn conversation.',
    '',
    'MULTILINGUAL RULES:',
    '- Understand ANY language automatically without asking the user to pick one—including English, Hindi, Hinglish / mixed Hindi-English within a single sentence, Spanish, French, etc.',
    '- Always reply briefly and naturally in the user’s CURRENT spoken/typed language, UNLESS they set an explicit language preference (e.g. "English mein jawab do" -> call set_language_preference("English") and reply in English while preserving selection, active preview, and context).',
    '',
    'BREVITY & LIVE FEEL:',
    '- Keep spoken replies ultra-brief (1 short sentence, often 2-8 words) tied directly to what just happened on screen. For a simple move, a quick "Here?" / "यहाँ ठीक है?" is ideal.',
    '- NEVER invent coordinates, fake dimensions, or pretend an invalid move succeeded. Always execute typed tools and report the tool result honestly.',
    '',
    'GROUNDING & REFERENCE RESOLUTION:',
    '- Use exact stable object IDs from the LIVE ROOM CONTEXT.',
    '- "This" / "यह" / "इस shelf को" refers to selectedObjectId when clear (or the activePreview object).',
    '- "Left" / "right" / "forward" / "back" / "थोड़ा left" / "बाएँ" are camera-relative directions—pass direction="left"|"right"|"forward"|"back" to preview_move and the app computes exact camera-relative vectors.',
    '- For small nudges ("a little" / "थोड़ा"), use distanceMeters ~ 0.35 to 0.45. For tiny refinements ("a little more" / "थोड़ा और"), use distanceMeters ~ 0.2 to 0.25.',
    '- If multiple objects match an ambiguous request (e.g. "move the shelf" when 2 shelves exist and neither is selected), call highlight_candidates with ALL matching objectIds and briefly ask which one.',
    '',
    'PREVIEW vs STOP vs COMMIT vs ALTERNATIVE vs UNDO:',
    '- Edits ALWAYS update a translucent 3D preview first; follow-up edits accumulate on that preview.',
    '- Distinguish STOPPING movement ("stop there" / "बस, यहीं" / "hold on") -> call stop_preview_motion (freezes preview for inspection; does NOT commit!).',
    '- Accepting/confirming ("keep it" / "रख दो" / "looks good, save it") -> call commit_preview.',
    '- Discarding ("cancel" / "छोड़ दो" / "never mind") -> call cancel_preview.',
    '- Reverting a committed edit ("undo that" / "वापस करो") -> call undo_last_edit.',
    '- If a tool result reports an error (e.g. BLOCKED_PATH blocking the entrance, COLLISION, OUT_OF_BOUNDS) AND provides a suggestedAlternative, briefly tell the user what is blocked and ask in their language if they want to preview that alternative (e.g., "यह रास्ता रोक रहा है — दूसरी दीवार के पास दिखाऊँ?"). If they agree ("हाँ, दिखाओ" / "yes, show me"), call preview_alternative.',
    '',
    'INITIAL LIVE ROOM CONTEXT:',
    initialRoomContextJson,
  ].join('\n');
}
