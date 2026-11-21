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

export interface PreviewObjectDelta {
  originalPosition: Vec3;
  originalRotationY: number;
  previewPosition: Vec3;
  previewRotationY: number;
}

export interface VoicePreviewState {
  objectId: string;
  originalPosition: Vec3;
  originalRotationY: number;
  previewPosition: Vec3;
  previewRotationY: number;
  /** Optional multi-object pose map when previewing a whole-room layout option */
  objectPoses?: Record<string, PreviewObjectDelta>;
  /** Stable 1-based layout option number if previewing a suggested layout */
  layoutOptionIndex?: number;
  layoutOptionName?: string;
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
  z.object({
    type: z.literal('suggest_layouts'),
  }),
  z.object({
    type: z.literal('preview_layout_option'),
    optionIndex: z.number().int().min(1).max(3),
  }),
  z.object({
    type: z.literal('preview_proactive_suggestion'),
  }),
  z.object({
    type: z.literal('dismiss_proactive_suggestion'),
  }),
  z.object({
    type: z.literal('browse_shopify_products'),
    query: z.string().optional().default(''),
    maxPriceDollars: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('apply_shopify_product'),
    productIndex: z.number().int().min(1).max(12),
    mode: z.enum(['add', 'replace']).default('add'),
    targetObjectId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('place_shopify_order'),
    productIndex: z.number().int().min(1).max(12).optional(),
  }),
  z.object({
    type: z.literal('clear_room'),
    keepObjectIds: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    type: z.literal('remove_objects'),
    objectIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    type: z.literal('redesign_room_style'),
    style: z.string().min(1),
    brief: z.string().optional(),
    budgetDollars: z.number().nonnegative().optional(),
    keepExistingObjects: z.boolean().optional(),
    keepObjectIds: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    type: z.literal('draft_design_prompt'),
    prompt: z.string().min(1),
    mode: z.enum(['redesign', 'add', 'replace']).default('replace'),
    style: z.string().optional(),
    budgetDollars: z.number().nonnegative().optional(),
    keepObjectIds: z.array(z.string().min(1)).optional(),
    targetObjectId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('render_from_prompt'),
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

export interface GroundedLayoutOptionSummary {
  index: number;
  name: string;
  tradeoff: string;
  metricsSummary: string;
}

export interface GroundedProactiveSummary {
  title: string;
  spokenPrompt: string;
  objectId: string;
  targetLabel: string;
}

/**
 * Formats a compact, grounded room context block for Gemini (both Live Audio
 * sessions and typed fallback turns) containing stable object IDs, current
 * selection, camera orientation, active preview, layout options, proactive
 * suggestions, and constraints.
 */
export function formatGroundedRoomContext(params: {
  scene: ShopScene;
  selectedId: string | null;
  cameraBasis: CameraBasis;
  activePreview: VoicePreviewState | null;
  preferredLanguage: string | null;
  canUndo: boolean;
  layoutOptions?: GroundedLayoutOptionSummary[];
  proactiveSuggestion?: GroundedProactiveSummary | null;
}): string {
  const {
    scene,
    selectedId,
    cameraBasis,
    activePreview,
    preferredLanguage,
    canUndo,
    layoutOptions = [],
    proactiveSuggestion = null,
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
      budgetCents: scene.budgetCents,
    },
    camera: {
      facingWall: cameraBasis.facingWall,
      forwardXZ: cameraBasis.forwardXZ.map((v) => Number(v.toFixed(2))),
      rightXZ: cameraBasis.rightXZ.map((v) => Number(v.toFixed(2))),
    },
    selectedObjectId: selectedId,
    canUndo,
    preferredLanguage: preferredLanguage ?? 'auto (match user language)',
    layoutOptions,
    proactiveSuggestion,
    activePreview: activePreview
      ? {
          objectId: activePreview.objectId,
          layoutOptionIndex: activePreview.layoutOptionIndex ?? null,
          layoutOptionName: activePreview.layoutOptionName ?? null,
          previewObjectCount: activePreview.objectPoses
            ? Object.keys(activePreview.objectPoses).length
            : 1,
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
    'You are an award-winning Professional Interior Designer (SpatioVerse), speaking in a warm, confident, General American female voice.',
    'You bring deep expertise in spatial proportion, scale harmony, sightlines, lighting balance, circulation flow, color palettes, material pairing, and budget-conscious styling.',
    'Keep your tone friendly, concise, and consultative so the client can watch the 3D room evolve while you design together.',
    '',
    'MULTILINGUAL RULES:',
    '- Automatically understand and follow ANY language without asking the user to pick one—including English, Hindi, and mixed Hindi-English (e.g., "दूसरा layout दिखाओ", "इस shelf को थोड़ा left करो").',
    '- Reply naturally in the user’s CURRENT language with clear, natural pronunciation, keeping the same warm voice identity across languages. Honor explicit language preferences ("English mein jawab do" -> call set_language_preference("English")).',
    '- Preserve selectedObjectId, layoutOptions (and their stable numbers 1, 2, 3), and activePreview whenever the user switches languages.',
    '',
    'BREVITY & LIVE FEEL:',
    '- Keep replies brief (1-2 short conversational sentences) tied directly to what is happening on screen.',
    '- NEVER invent coordinates, clearance measurements, or unverified product prices. Report only actual validated geometry and real tool results.',
    '',
    'ROOM LAYOUT SUGGESTIONS (UP TO 3 VALIDATED OPTIONS):',
    '- When the user asks for layout ideas using their existing furniture (e.g., "Show me a few ways to arrange this room"), call suggest_layouts. Briefly name the returned options with their stable numbers (1, 2, 3) and one concrete tradeoff per option.',
    '- When the user asks to see an option (e.g., "Show me the second one", "दूसरा वाला दिखाओ"), call preview_layout_option with optionIndex=2. Do NOT commit it yet.',
    '- If the user refines an active layout preview (e.g., "Keep this one, but rotate the counter"), keep the active layout preview open and call preview_rotate on the counter—DO NOT call commit_preview yet! Wait for explicit confirmation ("Apply it", "Keep it", "रख दो") so they can inspect the rotated counter first.',
    '',
    'WHOLE-ROOM REDESIGN, PROMPT-FIRST RENDERING & ANTI-DUPLICATION:',
    '- REMOVING SPECIFIC ITEMS (CRITICAL): When the user asks to remove or delete specific item(s) (e.g., "remove the table and the chair", "delete the lamp"), ALWAYS call remove_objects(objectIds) with ONLY those exact IDs from LIVE ROOM CONTEXT. NEVER call redesign_room_style, clear_room, or draft_design_prompt(mode="redesign") for a removal—every other object in the room must remain completely untouched!',
    '- WHOLE-ROOM REDESIGN ONLY WHEN EXPLICITLY ASKED: ONLY use mode="redesign" or redesign_room_style when the user explicitly asks to change or replace the whole room layout (e.g., "replace the whole layout", "redesign the entire room in a minimalist style").',
    '- PROMPT-FIRST WORKFLOW (IMPORTANT): NEVER keep replacing or spawning objects repeatedly while the user is still talking! Whenever the user describes an object to add/replace or explicitly asks for a full-room redesign, FIRST call draft_design_prompt(prompt, mode, style?, budgetDollars?, keepObjectIds?, targetObjectId?) to write a clear, single, structured design prompt on screen, read a concise 1-sentence summary aloud, and ask "Ready for me to render this?"',
    '- RENDER ONCE ON CONFIRMATION: Only when the user confirms ("Yes", "Render it", "Go ahead", "Looks good", "बना दो"), call render_from_prompt() ONCE to render the drafted prompt cleanly into the 3D scene with natural room-proportional dimensions and zero duplicate objects.',
    '- CONSULTATION: If the user makes an open-ended request ("Redesign my room") without specifying style, kept items, or budget, ask 1–2 quick questions first before calling draft_design_prompt.',
    '- CLEAR ROOM: When the user explicitly says "clear all objects", "empty the room", or "remove everything except the sofa", call clear_room(keepObjectIds?) (always 1-step undoable).',
    '- NEVER call apply_shopify_product or redesign_room_style twice for the same request.',
    '',
    'PROACTIVE SUGGESTIONS:',
    '- If a [PROACTIVE ROOM OBSERVATION] message arrives with a validated improvement, briefly explain that single strongest suggestion aloud in the user’s current language and ask if they want to see it.',
    '- If the user agrees ("Show me", "हाँ, दिखाओ") while proactiveSuggestion is active, call preview_proactive_suggestion. If they decline ("No thanks", "रहने दो"), call dismiss_proactive_suggestion.',
    '',
    'SHOPIFY PRODUCT BROWSING & ORDERING:',
    '- When the user asks to browse, search, or see products on Shopify (e.g., "Show me sofas on Shopify", "Find round coffee tables", "Browse floor lamps under $150"), ALWAYS call browse_shopify_products(query, maxPriceDollars?). It opens the right-hand Shop Products side view and returns numbered live Shopify products (1, 2, 3...). Briefly read out the top 2–3 real options with their numbers, titles, and prices.',
    '- When the user asks to add or swap a product from the shown Shopify list into the 3D room (e.g., "Add the first one", "Replace the sofa with number 2"), call apply_shopify_product(productIndex, mode="add"|"replace", targetObjectId?).',
    '- When the user asks to place an order, buy, or checkout a product (e.g., "Place an order for the first one", "Order option 2", "Checkout my cart"), call place_shopify_order(productIndex?). It builds a live Shopify merchant cart/checkout link in the side panel (or opens the merchant order card) and returns the checkout status. Confirm honestly that the merchant checkout order link is ready in the side panel.',
    '',
    'GROUNDING, PREVIEW, STOP, COMMIT & UNDO:',
    '- Use exact stable object IDs from LIVE ROOM CONTEXT. "This"/"यह" refers to selectedObjectId or activePreview.objectId. "Left"/"right"/"forward"/"back" are camera-relative.',
    '- If multiple objects match an ambiguous request, call highlight_candidates with all matching IDs and ask which one.',
    '- Stopping movement ("Stop there" / "बस, यहीं") -> stop_preview_motion (freezes preview without committing).',
    '- Confirming ("Apply it" / "Keep this one" / "रख दो") -> commit_preview (commits entire preview as 1 undoable edit).',
    '- Discarding ("Cancel" / "छोड़ दो") -> cancel_preview. Reverting ("Undo" / "वापस करो") -> undo_last_edit.',
    '- If a placement triggers BLOCKED_PATH/COLLISION/OUT_OF_BOUNDS with a suggestedAlternative, highlight the obstruction, briefly offer that alternative, and call preview_alternative if agreed.',
    '',
    'INITIAL LIVE ROOM CONTEXT:',
    initialRoomContextJson,
  ].join('\n');
}
