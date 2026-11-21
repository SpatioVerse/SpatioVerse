import {
  GoogleGenAI,
  ThinkingLevel,
  createPartFromUri,
} from '@google/genai';
import { z } from 'zod';
import {
  FT_TO_METERS,
  ProductRefSchema,
  ShopSceneSchema,
  type ConstraintIssue,
  type ProductRef,
  type SceneObject,
  type ShopScene,
  type Vec3,
} from '@/lib/schema';
import {
  deduplicateSceneObjects,
  normalizeObjectSizeForRoom,
} from '@/lib/roomProportions';
import {
  DEFAULT_MIN_WALKWAY_METERS,
  evaluateScene,
} from '@/lib/constraints';

export const HYDROGEN_MODEL_ID = 'gemini-4-hydrogen' as const;
export const NEON_MODEL_ID = 'gemini-4-neon' as const;

/**
 * Benchmarked optimal model assignment satisfying the mandatory 2-model Gemini 4 rule:
 * - `/api/analyze`: `gemini-4-neon` (~10.5s, 3/3 fixture recall, 0 false positives)
 * - `/api/plan`: `gemini-4-hydrogen` (~10.8s layout, ~6.3s repair, 100% pass rate)
 * Supports optional server env overrides (`ANALYZE_MODEL_ID` / `PLAN_MODEL_ID`).
 */
export const ANALYZE_MODEL_ID: string =
  process.env.ANALYZE_MODEL_ID?.trim() || NEON_MODEL_ID;
export const PLAN_MODEL_ID: string =
  process.env.PLAN_MODEL_ID?.trim() || HYDROGEN_MODEL_ID;

/**
 * Files larger than 14 MB use the Gemini Files API instead of inline base64
 * (base64 adds ~33% overhead and Gemini's inline request cap is 20 MB).
 */
export const INLINE_MEDIA_MAX_BYTES = 14 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export const ALLOWED_MEDIA_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);

export type GeminiErrorCode =
  | 'MISSING_API_KEY'
  | 'INVALID_INPUT'
  | 'INVALID_MIME'
  | 'PAYLOAD_TOO_LARGE'
  | 'FILE_UPLOAD_FAILED'
  | 'MODEL_TIMEOUT'
  | 'MODEL_ERROR'
  | 'INVALID_MODEL_JSON';

export class GeminiServiceError extends Error {
  public readonly code: GeminiErrorCode;
  public readonly status: number;
  public readonly requestId: string;
  public readonly modelAttempted?: string;

  constructor(params: {
    code: GeminiErrorCode;
    message: string;
    status: number;
    requestId: string;
    modelAttempted?: string;
  }) {
    super(params.message);
    this.name = 'GeminiServiceError';
    this.code = params.code;
    this.status = params.status;
    this.requestId = params.requestId;
    this.modelAttempted = params.modelAttempted;
  }
}

/**
 * Structured server-side trace logger.
 * Logs request ID, model ID, timing, and safe counts — NEVER API keys or user footage.
 */
export function logGeminiEvent(event: {
  requestId: string;
  route: '/api/analyze' | '/api/plan' | '/api/replace' | '/api/match-model';
  modelId: string;
  stage: string;
  durationMs?: number;
  meta?: Record<string, string | number | boolean | undefined>;
}): void {
  const payload = {
    ts: new Date().toISOString(),
    service: 'spacestage-gemini',
    ...event,
  };
  console.info(JSON.stringify(payload));
}

export function getGeminiClient(
  requestId: string,
  modelAttempted?: string
): GoogleGenAI {
  const apiKey =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim();

  if (!apiKey) {
    throw new GeminiServiceError({
      code: 'MISSING_API_KEY',
      message:
        'Server GEMINI_API_KEY is not configured. Add GEMINI_API_KEY to .env.local on the server.',
      status: 503,
      requestId,
      modelAttempted,
    });
  }

  return new GoogleGenAI({ apiKey });
}

export function normalizeMediaMimeType(
  rawMime: string,
  fileName?: string
): string {
  const cleaned = rawMime.trim().toLowerCase().split(';')[0];
  if (cleaned === 'image/jpg') return 'image/jpeg';
  if (cleaned === 'video/x-m4v') return 'video/mp4';
  if (cleaned && cleaned !== 'application/octet-stream') return cleaned;

  const lowerName = (fileName ?? '').toLowerCase();
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.webp')) return 'image/webp';
  if (lowerName.endsWith('.mp4') || lowerName.endsWith('.m4v')) {
    return 'video/mp4';
  }
  if (lowerName.endsWith('.webm')) return 'video/webm';
  if (lowerName.endsWith('.mov')) return 'video/quicktime';
  return cleaned;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  requestId: string,
  modelAttempted: string,
  operationLabel: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new GeminiServiceError({
              code: 'MODEL_TIMEOUT',
              message: `${operationLabel} timed out after ${Math.round(timeoutMs / 1000)}s.`,
              status: 504,
              requestId,
              modelAttempted,
            })
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ============================================================================
// 1. MULTIMODAL SCENE OBSERVATION (/api/analyze)
// ============================================================================

export const SceneKindSchema = z.enum([
  'shelf',
  'counter',
  'table',
  'rack',
  'lamp',
  'plant',
  'art',
]);

export const FixtureObservationSchema = z.object({
  id: z.string().min(1),
  kind: SceneKindSchema,
  label: z.string().min(1),
  visualCues: z.array(z.string()),
  possibleLocation: z.string(),
  wallAlignment: z.enum(['north', 'south', 'east', 'west', 'center']).optional(),
  position: z.tuple([z.number(), z.number(), z.number()]).optional(),
  rotationY: z.number().optional(),
  relativePosition: z
    .object({
      xNorm: z.number().min(-1).max(1),
      zNorm: z.number().min(-1).max(1),
    })
    .optional(),
  approxSizeMeters: z
    .tuple([z.number().positive(), z.number().positive(), z.number().positive()])
    .optional(),
  evidence: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  uncertainty: z.string(),
  likelyWallMounted: z.boolean().optional(),
});

export type FixtureObservation = z.infer<typeof FixtureObservationSchema>;

const RawAnalyzeResponseSchema = z.object({
  observations: z.array(FixtureObservationSchema),
  roomCues: z.array(z.string()),
  warnings: z.array(z.string()),
});

export interface AnalyzeRoomHint {
  width: number;
  depth: number;
  height: number;
  entranceWall?: 'north' | 'south' | 'east' | 'west';
}

export interface AnalyzeMediaInput {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  notes?: string;
  roomHint?: AnalyzeRoomHint;
  requestId: string;
  timeoutMs?: number;
  forceFilesApi?: boolean;
  clientOverride?: Pick<GoogleGenAI, 'models' | 'files'>;
}

export interface AnalyzeUrlInput {
  mediaUrl: string;
  youtubeId?: string | null;
  notes?: string;
  roomHint?: AnalyzeRoomHint;
  requestId: string;
  timeoutMs?: number;
  clientOverride?: Pick<GoogleGenAI, 'models' | 'files'>;
}

export interface AnalyzeMediaResult {
  observations: FixtureObservation[];
  roomCues: string[];
  warnings: string[];
  modelUsed: string;
  requestId: string;
  uploadMethod: 'inline' | 'files_api' | 'youtube_uri';
}

const OBSERVATION_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    observations: {
      type: 'array',
      description:
        'Visible existing/owned retail fixtures or furniture spotted in the uploaded image or video.',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description:
              'Temporary observation identifier such as obs-1, obs-2.',
          },
          kind: {
            type: 'string',
            enum: ['shelf', 'counter', 'table', 'rack', 'lamp', 'plant', 'art'],
          },
          label: {
            type: 'string',
            description:
              'Concise grounded description of the visible fixture (e.g., "Light wood 4-tier freestanding shelf").',
          },
          visualCues: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Observable visual attributes such as material, color, freestanding vs mounted cues.',
          },
          possibleLocation: {
            type: 'string',
            description:
              'Relative placement visible in frame (e.g., "against west wall near rear corner").',
          },
          wallAlignment: {
            type: 'string',
            enum: ['north', 'south', 'east', 'west', 'center'],
            description:
              'Which wall the fixture sits against (north=back wall opposite camera/entry, south=entry wall, west=left wall, east=right wall, center=freestanding interior).',
          },
          position: {
            type: 'array',
            items: { type: 'number' },
            minItems: 3,
            maxItems: 3,
            description:
              'Direct vision-estimated 3D floor coordinates [x, 0, z] in meters inside the provided room bounds (X in [-width/2, +width/2], Z in [-depth/2, +depth/2], Y=0 on floor) matching where the object sits in the video.',
          },
          rotationY: {
            type: 'number',
            description:
              'Counter-clockwise orientation around +Y in radians (0 facing south, 1.5708 facing east from west wall, -1.5708 facing west from east wall, 3.1416 facing north).',
          },
          relativePosition: {
            type: 'object',
            description:
              'Approximate normalized floor coordinates in [-1, 1] for faithful layout reconstruction (xNorm: -1 west to +1 east; zNorm: -1 north/back to +1 south/front). Explicitly uncalibrated.',
            properties: {
              xNorm: { type: 'number' },
              zNorm: { type: 'number' },
            },
            required: ['xNorm', 'zNorm'],
          },
          approxSizeMeters: {
            type: 'array',
            items: { type: 'number' },
            minItems: 3,
            maxItems: 3,
            description:
              'Rough uncalibrated visual proportion estimate [width, height, depth] in meters for 3D staging (never treated as verified).',
          },
          evidence: {
            type: 'string',
            description:
              'For video: timestamp range like "00:02-00:07" and visual cue; for photo: region in frame.',
          },
          confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
          },
          uncertainty: {
            type: 'string',
            description:
              'Explicit statement of scale/dimension uncertainty, occlusion, or mounting ambiguity.',
          },
          likelyWallMounted: {
            type: 'boolean',
            description:
              'True if visual cues suggest the item is mounted to a wall or ceiling rather than freestanding.',
          },
        },
        required: [
          'id',
          'kind',
          'label',
          'visualCues',
          'possibleLocation',
          'evidence',
          'confidence',
          'uncertainty',
        ],
      },
    },
    roomCues: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Observable architectural, doorway, wall, floor, and lighting cues without claiming exact uncalibrated dimensions.',
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Explicit warnings about uncalibrated camera perspective, unseen walls, or uncertain measurements.',
    },
  },
  required: ['observations', 'roomCues', 'warnings'],
};

const UNCALIBRATED_WARNING =
  'Exact room and fixture measurements cannot be determined from uncalibrated camera media; user confirmation of physical dimensions is required.';

function buildObservationPrompts(
  isVideo: boolean,
  notes?: string,
  roomHint?: AnalyzeRoomHint
) {
  const halfW = roomHint ? (roomHint.width / 2).toFixed(3) : '2.400';
  const halfD = roomHint ? (roomHint.depth / 2).toFixed(3) : '2.100';
  const roomLine = roomHint
    ? `User-confirmed room envelope in METERS: width(X)=${roomHint.width.toFixed(3)}m ([-${halfW}, +${halfW}]), depth(Z)=${roomHint.depth.toFixed(3)}m ([-${halfD}, +${halfD}]), height(Y)=${roomHint.height.toFixed(3)}m, entrance wall=${(roomHint.entranceWall ?? 'south').toUpperCase()}.`
    : 'Room floor is centered at [0, 0] in meters (use approximate centered coordinates X in [-2.4, +2.4], Z in [-2.1, +2.1]).';

  const systemPrompt = [
    `You are SpaceStage Vision-to-3D Scene Observer powered by ${ANALYZE_MODEL_ID}.`,
    'Watch the entire space video/photo and DIRECTLY reconstruct the 3D floorplan coordinates (`position`, `rotationY`, `approxSizeMeters`) of every visible floor-standing furniture/fixture item so the 3D scene mirrors the exact layout seen in the media.',
    roomLine,
    'STRICT RULES:',
    '1. Track camera pan/rotation across the clip to build ONE coherent top-down 3D floorplan: north = back wall (-Z), south = entrance/front wall (+Z), west = left wall (-X), east = right wall (+X), Y = 0 on floor.',
    '2. Output exact non-overlapping `[x, 0, z]` `position` and `rotationY` (radians: 0 along north wall, 1.5708 along west wall, -1.5708 along east wall, 3.1416 along south wall) directly from what you SEE — keep every item inside the room walls and leave the entrance doorway clear.',
    '3. Skip ceiling-mounted pendant lights, chandeliers, and small wall sconces; focus on floor-standing furniture, counters, shelves, sofas, chairs, tables, racks, plants, floor lamps, mirrors, and major wall art.',
    '4. Map `kind` to one of: shelf, counter, table, rack, lamp, plant, art. Use clear descriptive labels matching the real object (e.g., "Lounge Sofa", "Accent Chair", "Wooden Display Shelf", "Modern Wooden Cabinet", "Coffee Table", "Round Side Table", "Bar Stool", "Wall Mirror", "Steel Frame Rack", "Floor Lamp", "Potted Plant", "Checkout Counter").',
    '5. NEVER claim exact calibrated measurements — mark scale uncertainty honestly in `uncertainty` and `warnings`.',
    isVideo
      ? '6. Cite concrete video timestamp ranges (e.g. "00:01-00:05") in `evidence`.'
      : '6. Cite concrete image regions (e.g. "back-left corner", "center foreground") in `evidence`.',
  ].join('\n');

  const userPrompt = notes?.trim()
    ? `Directly reconstruct the 3D floorplan layout (` +
      '`position`, `rotationY`, `approxSizeMeters`, `observations`' +
      `) from this ${isVideo ? 'video' : 'photo'}. Merchant context: ${notes.trim()}`
    : `Directly reconstruct the 3D floorplan layout (` +
      '`position`, `rotationY`, `approxSizeMeters`, `observations`' +
      `) from this ${isVideo ? 'video' : 'photo'}, matching the exact visible arrangement.`;

  return { systemPrompt, userPrompt };
}

function finalizeObservationOutput(
  rawText: string | undefined,
  isVideo: boolean,
  requestId: string,
  uploadMethod: AnalyzeMediaResult['uploadMethod']
): AnalyzeMediaResult {
  const trimmed = rawText?.trim();
  if (!trimmed) {
    throw new GeminiServiceError({
      code: 'INVALID_MODEL_JSON',
      message: `${ANALYZE_MODEL_ID} returned an empty response.`,
      status: 502,
      requestId,
      modelAttempted: ANALYZE_MODEL_ID,
    });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(trimmed);
  } catch {
    throw new GeminiServiceError({
      code: 'INVALID_MODEL_JSON',
      message: `${ANALYZE_MODEL_ID} returned malformed JSON.`,
      status: 502,
      requestId,
      modelAttempted: ANALYZE_MODEL_ID,
    });
  }

  const validated = RawAnalyzeResponseSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new GeminiServiceError({
      code: 'INVALID_MODEL_JSON',
      message: `${ANALYZE_MODEL_ID} output failed schema validation: ${validated.error.issues[0]?.message ?? 'invalid structure'}`,
      status: 502,
      requestId,
      modelAttempted: ANALYZE_MODEL_ID,
    });
  }

  const warnings = [...validated.data.warnings];
  const hasCalibrationWarning = warnings.some((w) =>
    /uncalibrated|exact.*(measurement|dimension)|confirm.*(measurement|dimension)/i.test(
      w
    )
  );
  if (!hasCalibrationWarning) {
    warnings.unshift(UNCALIBRATED_WARNING);
  }
  if (!isVideo) {
    const hasSinglePhotoNote = warnings.some((w) =>
      /single photo|still image|single view/i.test(w)
    );
    if (!hasSinglePhotoNote) {
      warnings.push(
        'Single-photo fallback used instead of multi-angle video; blind spots outside the camera frame cannot be inspected.'
      );
    }
  }

  const normalizedObservations = validated.data.observations.map(
    (obs, index) => ({
      ...obs,
      id: obs.id.trim() || `obs-${index + 1}`,
    })
  );

  return {
    observations: normalizedObservations,
    roomCues: validated.data.roomCues,
    warnings,
    modelUsed: ANALYZE_MODEL_ID,
    requestId,
    uploadMethod,
  };
}

export async function analyzeSpaceMedia(
  input: AnalyzeMediaInput
): Promise<AnalyzeMediaResult> {
  const {
    buffer,
    fileName,
    notes,
    requestId,
    timeoutMs = 60_000,
    forceFilesApi = false,
  } = input;

  if (!buffer || buffer.byteLength === 0) {
    throw new GeminiServiceError({
      code: 'INVALID_INPUT',
      message: 'Uploaded media file is empty.',
      status: 400,
      requestId,
      modelAttempted: ANALYZE_MODEL_ID,
    });
  }

  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new GeminiServiceError({
      code: 'PAYLOAD_TOO_LARGE',
      message: `Uploaded file (${(buffer.byteLength / (1024 * 1024)).toFixed(1)} MB) exceeds maximum 100 MB limit.`,
      status: 413,
      requestId,
      modelAttempted: ANALYZE_MODEL_ID,
    });
  }

  const mimeType = normalizeMediaMimeType(input.mimeType, fileName);
  if (!ALLOWED_MEDIA_MIMES.has(mimeType)) {
    throw new GeminiServiceError({
      code: 'INVALID_MIME',
      message: `Unsupported media MIME type "${input.mimeType || 'unknown'}". Upload JPG, PNG, WebP, MP4, MOV, or WebM.`,
      status: 415,
      requestId,
      modelAttempted: ANALYZE_MODEL_ID,
    });
  }

  const ai =
    input.clientOverride ?? getGeminiClient(requestId, ANALYZE_MODEL_ID);
  const useFilesApi =
    forceFilesApi || buffer.byteLength > INLINE_MEDIA_MAX_BYTES;
  const uploadMethod: 'inline' | 'files_api' = useFilesApi
    ? 'files_api'
    : 'inline';

  const startMs = Date.now();
  logGeminiEvent({
    requestId,
    route: '/api/analyze',
    modelId: ANALYZE_MODEL_ID,
    stage: 'start',
    meta: {
      mimeType,
      sizeBytes: buffer.byteLength,
      uploadMethod,
    },
  });

  let uploadedFileName: string | undefined;

  try {
    let mediaPart:
      | ReturnType<typeof createPartFromUri>
      | { inlineData: { data: string; mimeType: string } };

    if (useFilesApi) {
      const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
      let uploaded = await withTimeout(
        ai.files.upload({
          file: blob,
          config: {
            mimeType,
            displayName: `spacestage-${requestId}`,
          },
        }),
        timeoutMs,
        requestId,
        ANALYZE_MODEL_ID,
        'Gemini Files API upload'
      );

      uploadedFileName = uploaded.name;

      const pollDeadline = Date.now() + timeoutMs;
      while (
        uploaded.state &&
        String(uploaded.state).toUpperCase() === 'PROCESSING'
      ) {
        if (Date.now() > pollDeadline) {
          throw new GeminiServiceError({
            code: 'MODEL_TIMEOUT',
            message: 'Gemini Files API media processing timed out.',
            status: 504,
            requestId,
            modelAttempted: ANALYZE_MODEL_ID,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (!uploaded.name) break;
        uploaded = await ai.files.get({ name: uploaded.name });
      }

      if (
        !uploaded.uri ||
        (uploaded.state && String(uploaded.state).toUpperCase() === 'FAILED')
      ) {
        throw new GeminiServiceError({
          code: 'FILE_UPLOAD_FAILED',
          message: 'Gemini Files API failed to process uploaded media.',
          status: 502,
          requestId,
          modelAttempted: ANALYZE_MODEL_ID,
        });
      }

      mediaPart = createPartFromUri(
        uploaded.uri,
        uploaded.mimeType || mimeType
      );
    } else {
      mediaPart = {
        inlineData: {
          data: buffer.toString('base64'),
          mimeType,
        },
      };
    }

    const isVideo = mimeType.startsWith('video/');
    const { systemPrompt, userPrompt } = buildObservationPrompts(
      isVideo,
      notes,
      input.roomHint
    );

    const response = await withTimeout(
      ai.models.generateContent({
        model: ANALYZE_MODEL_ID,
        contents: [
          {
            role: 'user',
            parts: [mediaPart, { text: userPrompt }],
          },
        ],
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: 'application/json',
          responseSchema: OBSERVATION_RESPONSE_SCHEMA,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.LOW,
          },
          temperature: 0.1,
        },
      }),
      timeoutMs,
      requestId,
      ANALYZE_MODEL_ID,
      `${ANALYZE_MODEL_ID} observation`
    );

    const finalized = finalizeObservationOutput(
      response.text,
      isVideo,
      requestId,
      uploadMethod
    );

    logGeminiEvent({
      requestId,
      route: '/api/analyze',
      modelId: ANALYZE_MODEL_ID,
      stage: 'complete',
      durationMs: Date.now() - startMs,
      meta: {
        uploadMethod,
        observationCount: finalized.observations.length,
        warningCount: finalized.warnings.length,
      },
    });

    return finalized;
  } catch (err) {
    logGeminiEvent({
      requestId,
      route: '/api/analyze',
      modelId: ANALYZE_MODEL_ID,
      stage: 'error',
      durationMs: Date.now() - startMs,
      meta: {
        errorName: err instanceof Error ? err.name : 'UnknownError',
      },
    });
    if (err instanceof GeminiServiceError) throw err;
    throw new GeminiServiceError({
      code: 'MODEL_ERROR',
      message:
        err instanceof Error
          ? `${ANALYZE_MODEL_ID} request failed: ${err.message}`
          : `${ANALYZE_MODEL_ID} request failed.`,
      status: 502,
      requestId,
      modelAttempted: ANALYZE_MODEL_ID,
    });
  } finally {
    if (uploadedFileName) {
      await ai.files.delete({ name: uploadedFileName }).catch(() => undefined);
    }
  }
}

function extractYouTubeWatchUrl(
  rawUrl: string,
  explicitYoutubeId?: string | null
): string | null {
  if (explicitYoutubeId && /^[a-zA-Z0-9_-]{11}$/.test(explicitYoutubeId)) {
    return `https://www.youtube.com/watch?v=${explicitYoutubeId}`;
  }
  try {
    const parsed = new URL(
      rawUrl.startsWith('http://') || rawUrl.startsWith('https://')
        ? rawUrl
        : `https://${rawUrl}`
    );
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') {
      const id = parsed.pathname.split('/').filter(Boolean)[0];
      return id && /^[a-zA-Z0-9_-]{11}$/.test(id)
        ? `https://www.youtube.com/watch?v=${id}`
        : null;
    }
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const v = parsed.searchParams.get('v');
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) {
        return `https://www.youtube.com/watch?v=${v}`;
      }
      const segments = parsed.pathname.split('/').filter(Boolean);
      if (
        (segments[0] === 'shorts' ||
          segments[0] === 'embed' ||
          segments[0] === 'live') &&
        segments[1] &&
        /^[a-zA-Z0-9_-]{11}$/.test(segments[1])
      ) {
        return `https://www.youtube.com/watch?v=${segments[1]}`;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function isSafePublicHttpsUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return null;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host.endsWith('.local') ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Supports `MediaIntakeModal`'s JSON YouTube / direct HTTPS video URL intake mode.
 */
export async function analyzeSpaceUrl(
  input: AnalyzeUrlInput
): Promise<AnalyzeMediaResult> {
  const { mediaUrl, youtubeId, notes, requestId, timeoutMs = 65_000 } = input;
  const trimmedUrl = mediaUrl.trim();
  if (!trimmedUrl && !youtubeId) {
    throw new GeminiServiceError({
      code: 'INVALID_INPUT',
      message: 'Provide a valid YouTube or HTTPS video URL to analyze.',
      status: 400,
      requestId,
      modelAttempted: ANALYZE_MODEL_ID,
    });
  }

  const youtubeWatchUrl = extractYouTubeWatchUrl(trimmedUrl, youtubeId);
  if (youtubeWatchUrl) {
    const ai =
      input.clientOverride ?? getGeminiClient(requestId, ANALYZE_MODEL_ID);
    const startMs = Date.now();
    logGeminiEvent({
      requestId,
      route: '/api/analyze',
      modelId: ANALYZE_MODEL_ID,
      stage: 'start_youtube_uri',
      meta: { uploadMethod: 'youtube_uri' },
    });

    try {
      const { systemPrompt, userPrompt } = buildObservationPrompts(
        true,
        notes,
        input.roomHint
      );
      const response = await withTimeout(
        ai.models.generateContent({
          model: ANALYZE_MODEL_ID,
          contents: [
            {
              role: 'user',
              parts: [
                createPartFromUri(youtubeWatchUrl, 'video/mp4'),
                { text: userPrompt },
              ],
            },
          ],
          config: {
            systemInstruction: systemPrompt,
            responseMimeType: 'application/json',
            responseSchema: OBSERVATION_RESPONSE_SCHEMA,
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            temperature: 0.1,
          },
        }),
        timeoutMs,
        requestId,
        ANALYZE_MODEL_ID,
        `${ANALYZE_MODEL_ID} YouTube observation`
      );

      const finalized = finalizeObservationOutput(
        response.text,
        true,
        requestId,
        'youtube_uri'
      );

      logGeminiEvent({
        requestId,
        route: '/api/analyze',
        modelId: ANALYZE_MODEL_ID,
        stage: 'complete',
        durationMs: Date.now() - startMs,
        meta: {
          uploadMethod: 'youtube_uri',
          observationCount: finalized.observations.length,
        },
      });
      return finalized;
    } catch (err) {
      if (err instanceof GeminiServiceError) throw err;
      throw new GeminiServiceError({
        code: 'MODEL_ERROR',
        message:
          err instanceof Error
            ? `Failed to analyze YouTube video: ${err.message}`
            : 'Failed to analyze YouTube video.',
        status: 502,
        requestId,
        modelAttempted: ANALYZE_MODEL_ID,
      });
    }
  }

  const safeUrl = isSafePublicHttpsUrl(trimmedUrl);
  if (!safeUrl) {
    throw new GeminiServiceError({
      code: 'INVALID_INPUT',
      message:
        'Only public YouTube links or public HTTPS media URLs are supported.',
      status: 400,
      requestId,
      modelAttempted: ANALYZE_MODEL_ID,
    });
  }

  let fetchedRes: Response;
  try {
    fetchedRes = await withTimeout(
      fetch(safeUrl.toString()),
      20_000,
      requestId,
      ANALYZE_MODEL_ID,
      'Remote media URL download'
    );
  } catch (err) {
    if (err instanceof GeminiServiceError) throw err;
    throw new GeminiServiceError({
      code: 'FILE_UPLOAD_FAILED',
      message: 'Could not download remote media URL.',
      status: 400,
      requestId,
      modelAttempted: ANALYZE_MODEL_ID,
    });
  }

  if (!fetchedRes.ok) {
    throw new GeminiServiceError({
      code: 'FILE_UPLOAD_FAILED',
      message: `Remote media URL returned HTTP ${fetchedRes.status}.`,
      status: 400,
      requestId,
      modelAttempted: ANALYZE_MODEL_ID,
    });
  }

  const arrayBuf = await fetchedRes.arrayBuffer();
  const contentType = fetchedRes.headers.get('content-type') ?? '';
  return analyzeSpaceMedia({
    buffer: Buffer.from(arrayBuf),
    mimeType: contentType,
    fileName: safeUrl.pathname,
    notes,
    requestId,
    timeoutMs,
    clientOverride: input.clientOverride,
  });
}

// ============================================================================
// 2. SPATIAL LAYOUT PLANNER + SINGLE DETERMINISTIC REPAIR (/api/plan)
// ============================================================================

export const OwnedFixtureInputSchema = z
  .object({
    id: z.string().min(1),
    kind: SceneKindSchema,
    label: z.string().min(1),
    size: z
      .tuple([
        z.number().positive(),
        z.number().positive(),
        z.number().positive(),
      ])
      .optional(),
    widthMeters: z.number().positive().optional(),
    heightMeters: z.number().positive().optional(),
    depthMeters: z.number().positive().optional(),
    position: z.tuple([z.number(), z.number(), z.number()]).optional(),
    rotationY: z.number().optional(),
    dimensionsVerified: z.boolean().optional(),
    locked: z.boolean().optional(),
    owned: z.boolean().optional(),
    exclude: z.boolean().optional(),
    keep: z.boolean().optional(),
  })
  .passthrough();

export type OwnedFixtureInput = z.infer<typeof OwnedFixtureInputSchema>;

export const ProductCandidateInputSchema = ProductRefSchema.extend({
  kind: SceneKindSchema.optional(),
  size: z
    .tuple([z.number().positive(), z.number().positive(), z.number().positive()])
    .optional(),
  dimensionsVerified: z.boolean().optional(),
});

export type ProductCandidateInput = z.infer<typeof ProductCandidateInputSchema>;

const AnalysisContextSchema = z
  .object({
    observations: z.array(FixtureObservationSchema).optional(),
    roomCues: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
  })
  .passthrough();

export const PlanRequestSchema = z.object({
  room: z.object({
    width: z.number().positive(),
    depth: z.number().positive(),
    height: z.number().positive(),
    entrance: z.object({
      wall: z.enum(['north', 'south', 'east', 'west']),
      offset: z.number().default(0),
      width: z.number().positive().default(DEFAULT_MIN_WALKWAY_METERS),
    }),
  }),
  purpose: z.string().min(1).optional(),
  style: z.string().min(1).optional(),
  brief: z.string().min(1).optional(),
  budgetCents: z.number().int().nonnegative(),
  minWalkwayWidth: z.number().positive().default(DEFAULT_MIN_WALKWAY_METERS),
  noDrilling: z.boolean().default(true),
  analysis: AnalysisContextSchema.nullable().optional(),
  currentScene: ShopSceneSchema.optional(),
  existingObjects: z.array(OwnedFixtureInputSchema).optional(),
  items: z.array(OwnedFixtureInputSchema).optional(),
  ownedObjects: z.array(OwnedFixtureInputSchema).optional(),
  products: z.array(ProductCandidateInputSchema).optional(),
  productCandidates: z.array(ProductCandidateInputSchema).optional(),
});

export type PlanRequestInput = z.infer<typeof PlanRequestSchema>;

const PlannedObjectSchema = z.object({
  id: z.string().min(1),
  kind: SceneKindSchema,
  label: z.string().min(1),
  source: z.enum(['owned', 'shopify', 'proposal']),
  position: z.tuple([z.number(), z.number(), z.number()]),
  size: z.tuple([
    z.number().positive(),
    z.number().positive(),
    z.number().positive(),
  ]),
  rotationY: z.number(),
  dimensionsVerified: z.boolean(),
  locked: z.boolean().optional(),
  selectedVariantId: z.string().nullable().optional(),
});

const RawPlanSchema = z.object({
  objects: z.array(PlannedObjectSchema),
  warnings: z.array(z.string()),
});

const PLANNER_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    objects: {
      type: 'array',
      description:
        'Complete list of 3D objects in the boutique floorplan (all coordinates and sizes in meters; floor is X/Z centered at [0,0], Y=0 on floor).',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: {
            type: 'string',
            enum: ['shelf', 'counter', 'table', 'rack', 'lamp', 'plant', 'art'],
          },
          label: { type: 'string' },
          source: {
            type: 'string',
            enum: ['owned', 'shopify', 'proposal'],
          },
          position: {
            type: 'array',
            items: { type: 'number' },
            minItems: 3,
            maxItems: 3,
            description:
              '[x, y, z] in meters. Room floor spans x in [-width/2, +width/2] and z in [-depth/2, +depth/2]. Use y = 0 for floor-standing fixtures.',
          },
          size: {
            type: 'array',
            items: { type: 'number' },
            minItems: 3,
            maxItems: 3,
            description: '[widthX, heightY, depthZ] in meters at rotationY = 0.',
          },
          rotationY: {
            type: 'number',
            description:
              'Counter-clockwise rotation around vertical Y axis in radians (e.g. 0, 1.5708, 3.1416, -1.5708).',
          },
          dimensionsVerified: {
            type: 'boolean',
            description:
              'True ONLY when exact dimensions were verified in the input; false for approximate/estimated sizes.',
          },
          locked: {
            type: 'boolean',
          },
          selectedVariantId: {
            type: 'string',
            nullable: true,
            description:
              'If source is "shopify", MUST match an exact variantId from provided Shopify candidates; null for owned or generic proposal items.',
          },
        },
        required: [
          'id',
          'kind',
          'label',
          'source',
          'position',
          'size',
          'rotationY',
          'dimensionsVerified',
        ],
      },
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Design notes, assumptions about approximate fixture dimensions, or trade-offs made to fit constraints.',
    },
  },
  required: ['objects', 'warnings'],
};

const DEFAULT_APPROX_SIZES: Record<SceneObject['kind'], Vec3> = {
  counter: [1.2, 0.95, 0.55],
  shelf: [0.9, 1.8, 0.35],
  table: [1.0, 0.8, 0.6],
  rack: [1.1, 1.55, 0.5],
  lamp: [0.35, 1.55, 0.35],
  plant: [0.4, 0.9, 0.4],
  art: [0.8, 1.35, 0.12],
};

function toCleanProductRef(candidate: ProductCandidateInput): ProductRef {
  return ProductRefSchema.parse({
    title: candidate.title,
    seller: candidate.seller,
    sellerDomain: candidate.sellerDomain,
    productId: candidate.productId,
    variantId: candidate.variantId,
    priceCents: Math.round(candidate.priceCents),
    currency: candidate.currency,
    productUrl: candidate.productUrl,
    ...(candidate.imageUrl ? { imageUrl: candidate.imageUrl } : {}),
    ...(typeof candidate.available === 'boolean'
      ? { available: candidate.available }
      : {}),
  });
}

function sanitizePlannedScene(params: {
  rawPlan: z.infer<typeof RawPlanSchema>;
  room: ShopScene['room'];
  purpose: string;
  style: string;
  budgetCents: number;
  minWalkwayWidth: number;
  noDrilling: boolean;
  ownedFixtures: OwnedFixtureInput[];
  productCandidates: ProductCandidateInput[];
}): ShopScene {
  const {
    rawPlan,
    room,
    purpose,
    style,
    budgetCents,
    minWalkwayWidth,
    noDrilling,
    ownedFixtures,
    productCandidates,
  } = params;

  const ownedById = new Map(ownedFixtures.map((o) => [o.id, o]));
  const candidateByVariant = new Map(
    productCandidates.map((p) => [p.variantId, p])
  );

  const sanitizedObjects: SceneObject[] = [];
  const seenIds = new Set<string>();

  for (const item of rawPlan.objects) {
    let uniqueId = item.id.trim() || `obj-${sanitizedObjects.length + 1}`;
    while (seenIds.has(uniqueId)) {
      uniqueId = `${uniqueId}-${sanitizedObjects.length + 1}`;
    }

    const matchingOwned = ownedById.get(item.id);
    if (matchingOwned || item.source === 'owned') {
      if (matchingOwned) {
        seenIds.add(matchingOwned.id);
        const finalSize: Vec3 = matchingOwned.size ?? item.size;
        const finalPos: Vec3 =
          matchingOwned.locked && matchingOwned.position
            ? matchingOwned.position
            : item.position;
        const finalRot =
          matchingOwned.locked && typeof matchingOwned.rotationY === 'number'
            ? matchingOwned.rotationY
            : item.rotationY;

        sanitizedObjects.push({
          id: matchingOwned.id,
          kind: matchingOwned.kind,
          label: matchingOwned.label,
          source: 'owned',
          position: finalPos,
          size: finalSize,
          rotationY: finalRot,
          dimensionsVerified:
            matchingOwned.size !== undefined &&
            matchingOwned.dimensionsVerified === true,
          ...(matchingOwned.locked ? { locked: true } : {}),
        });
        continue;
      }

      // Unconfirmed item marked owned by model becomes a generic proposal so owned inventory stays truthful
      seenIds.add(uniqueId);
      sanitizedObjects.push({
        id: uniqueId,
        kind: item.kind,
        label: item.label,
        source: 'proposal',
        position: item.position,
        size: item.size,
        rotationY: item.rotationY,
        dimensionsVerified: false,
      });
      continue;
    }

    const matchedCandidate = item.selectedVariantId
      ? candidateByVariant.get(item.selectedVariantId)
      : undefined;

    seenIds.add(uniqueId);

    if (matchedCandidate) {
      const hasVerifiedCandidateSize =
        matchedCandidate.size !== undefined &&
        matchedCandidate.dimensionsVerified === true;
      sanitizedObjects.push({
        id: uniqueId,
        kind: matchedCandidate.kind ?? item.kind,
        label: matchedCandidate.title || item.label,
        source: 'shopify',
        position: item.position,
        size: matchedCandidate.size ?? item.size,
        rotationY: item.rotationY,
        dimensionsVerified: hasVerifiedCandidateSize,
        product: toCleanProductRef(matchedCandidate),
      });
    } else {
      sanitizedObjects.push({
        id: uniqueId,
        kind: item.kind,
        label: item.label,
        source: 'proposal',
        position: item.position,
        size: item.size,
        rotationY: item.rotationY,
        dimensionsVerified: false,
      });
    }
  }

  const extraWarnings = [...rawPlan.warnings];
  for (const owned of ownedFixtures) {
    if (seenIds.has(owned.id)) continue;
    const fallbackSize = owned.size ?? DEFAULT_APPROX_SIZES[owned.kind];
    const fallbackPos: Vec3 = owned.position ?? [
      -room.width / 2 + fallbackSize[0] / 2 + 0.05,
      0,
      -room.depth / 2 + fallbackSize[2] / 2 + 0.05,
    ];
    sanitizedObjects.unshift({
      id: owned.id,
      kind: owned.kind,
      label: owned.label,
      source: 'owned',
      position: fallbackPos,
      size: fallbackSize,
      rotationY: owned.rotationY ?? 0,
      dimensionsVerified:
        owned.size !== undefined && owned.dimensionsVerified === true,
      ...(owned.locked ? { locked: true } : {}),
    });
    extraWarnings.push(
      `Restored confirmed owned fixture "${owned.label}" (${owned.id}) so existing inventory is preserved.`
    );
  }

  if (sanitizedObjects.some((o) => !o.dimensionsVerified)) {
    const hasDimNote = extraWarnings.some((w) =>
      /unverified|approximate.*dimension|estimated.*dimension/i.test(w)
    );
    if (!hasDimNote) {
      extraWarnings.push(
        'One or more fixtures use approximate placeholder dimensions; confirm exact measurements before purchasing.'
      );
    }
  }

  return ShopSceneSchema.parse({
    room,
    purpose,
    style,
    budgetCents,
    minWalkwayWidth,
    noDrilling,
    objects: sanitizedObjects,
    warnings: extraWarnings,
  });
}

function buildPlannerSystemInstruction(params: {
  room: ShopScene['room'];
  minWalkwayWidth: number;
  noDrilling: boolean;
  budgetCents: number;
}): string {
  const { room, minWalkwayWidth, noDrilling, budgetCents } = params;
  const halfW = (room.width / 2).toFixed(3);
  const halfD = (room.depth / 2).toFixed(3);

  return [
    `You are a Professional Interior Designer and SpaceStage Spatial Planner powered by ${PLAN_MODEL_ID}.`,
    'Design a cohesive, realistically proportioned, visually balanced 3D room and retail floorplan in strict JSON—prioritizing natural furniture-to-room scale ratios, focal points, sightlines, material harmony, and comfortable circulation.',
    '',
    'COORDINATE & GEOMETRY RULES (MANDATORY):',
    `- All lengths and coordinates are in METERS (1 ft = ${FT_TO_METERS} m). Room width (X) = ${room.width.toFixed(4)}m, depth (Z) = ${room.depth.toFixed(4)}m, ceiling height (Y) = ${room.height.toFixed(4)}m.`,
    `- Floor is centered at [0, 0]: X spans [-${halfW}, +${halfW}] (west = -${halfW}, east = +${halfW}); Z spans [-${halfD}, +${halfD}] (north = -${halfD}, south = +${halfD}).`,
    '- Place floor-standing fixtures with `position[1] = 0` (bottom resting on the floor).',
    '- Every rotated object footprint (`position` +/- rotated `size[0]/2`, `size[2]/2`) MUST stay strictly inside the room walls (`[-width/2, +width/2]` and `[-depth/2, +depth/2]`) with zero overlap between fixtures.',
    `- Entrance is on the ${room.entrance.wall.toUpperCase()} wall (offset ${room.entrance.offset.toFixed(3)}m from wall center, doorway width ${room.entrance.width.toFixed(3)}m). NEVER place wall art, mirrors, counters, or tall shelves flush against the glass ${room.entrance.wall.toUpperCase()} entrance wall.`,
    `- Keep at least ${minWalkwayWidth.toFixed(4)}m (3 ft) unobstructed vestibule inside the entrance AND maintain a continuous ${minWalkwayWidth.toFixed(4)}m wide walkway from the entrance reaching every counter, shelf, table, and rack.`,
    noDrilling
      ? '- `noDrilling` is TRUE: ONLY place freestanding floor fixtures (`position[1] = 0`, floor-leaning if art). DO NOT use wall-mounted shelves, hanging racks, ceiling pendants, sconces, or elevated wall art.'
      : '- `noDrilling` is false: wall-mounted items are permitted if within room bounds.',
    '',
    'INVENTORY & SHOPIFY COMMERCE RULES (MANDATORY):',
    '- Preserve all confirmed `owned` fixtures (`source: "owned"`, exact `id`, $0 cost toward new-purchase budget). Do not move `locked: true` owned fixtures.',
    `- Total price of new \`shopify\` fixtures MUST NOT exceed $${(budgetCents / 100).toFixed(2)} (${budgetCents} cents).`,
    '- NEVER invent Shopify product IDs, variant IDs, or prices. When selecting a provided Shopify candidate, set `source: "shopify"` and `selectedVariantId` to its exact `variantId`. If no provided candidate fits, set `source: "proposal"` and `selectedVariantId: null`.',
    '- Set `dimensionsVerified: true` ONLY if the input explicitly marked that item’s dimensions as verified; otherwise set `dimensionsVerified: false`.',
  ].join('\n');
}

export interface PlanGenerationOptions {
  requestId: string;
  timeoutMs?: number;
  clientOverride?: Pick<GoogleGenAI, 'models'>;
}

export interface PlanGenerationResult {
  scene: ShopScene;
  issues: ConstraintIssue[];
  valid: boolean;
  modelUsed: string;
  repairCount: number;
  requestId: string;
}

async function callPlannerOnce(params: {
  ai: Pick<GoogleGenAI, 'models'>;
  systemInstruction: string;
  userPrompt: string;
  requestId: string;
  timeoutMs: number;
  stageLabel: string;
}): Promise<z.infer<typeof RawPlanSchema>> {
  const { ai, systemInstruction, userPrompt, requestId, timeoutMs, stageLabel } =
    params;

  const response = await withTimeout(
    ai.models.generateContent({
      model: PLAN_MODEL_ID,
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: PLANNER_RESPONSE_SCHEMA,
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.LOW,
        },
        temperature: 0.2,
      },
    }),
    timeoutMs,
    requestId,
    PLAN_MODEL_ID,
    stageLabel
  );

  const rawText = response.text?.trim();
  if (!rawText) {
    throw new GeminiServiceError({
      code: 'INVALID_MODEL_JSON',
      message: `${stageLabel} returned an empty response.`,
      status: 502,
      requestId,
      modelAttempted: PLAN_MODEL_ID,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new GeminiServiceError({
      code: 'INVALID_MODEL_JSON',
      message: `${stageLabel} returned malformed JSON.`,
      status: 502,
      requestId,
      modelAttempted: PLAN_MODEL_ID,
    });
  }

  const checked = RawPlanSchema.safeParse(parsed);
  if (!checked.success) {
    throw new GeminiServiceError({
      code: 'INVALID_MODEL_JSON',
      message: `${stageLabel} output failed schema check: ${checked.error.issues[0]?.message ?? 'invalid layout JSON'}`,
      status: 502,
      requestId,
      modelAttempted: PLAN_MODEL_ID,
    });
  }

  return checked.data;
}

function normalizeOwnedItemSize(item: OwnedFixtureInput): Vec3 | undefined {
  if (item.size) return item.size;
  if (
    item.widthMeters !== undefined ||
    item.heightMeters !== undefined ||
    item.depthMeters !== undefined
  ) {
    const defaults = DEFAULT_APPROX_SIZES[item.kind];
    return [
      item.widthMeters ?? defaults[0],
      item.heightMeters ?? defaults[1],
      item.depthMeters ?? defaults[2],
    ];
  }
  return undefined;
}

function resolveOwnedAndCandidates(rawInput: PlanRequestInput): {
  ownedFixtures: OwnedFixtureInput[];
  productCandidates: ProductCandidateInput[];
  recreatingFromMedia: boolean;
} {
  const explicitOwned =
    rawInput.existingObjects ?? rawInput.ownedObjects ?? rawInput.items;
  const mediaObservations = rawInput.analysis?.observations ?? [];

  let ownedFixtures: OwnedFixtureInput[] = [];
  let recreatingFromMedia = false;

  if (explicitOwned) {
    ownedFixtures = explicitOwned
      .filter(
        (item) =>
          item.keep !== false &&
          item.exclude !== true &&
          item.owned !== false
      )
      .map((item) => {
        const resolvedSize = normalizeOwnedItemSize(item);
        return resolvedSize ? { ...item, size: resolvedSize } : item;
      });
  } else if (mediaObservations.length > 0) {
    // Faithfully recreate the room observed in the uploaded video/photo
    // instead of keeping unrelated demo-preset furniture from currentScene.
    recreatingFromMedia = true;
    const halfW = rawInput.room.width / 2;
    const halfD = rawInput.room.depth / 2;

    ownedFixtures = mediaObservations
      .filter((obs) => {
        // Exclude overhead ceiling pendants / wall sconces from floor-standing furniture footprint
        if (obs.kind === 'lamp' && obs.likelyWallMounted) return false;
        if (/pendant|chandelier|sconce|ceiling/i.test(obs.label)) return false;
        // When noDrilling is true, exclude wall-mounted art/mirrors that hang above counters/sofas
        // so the planner doesn't shove them onto the front glass entrance wall
        if (rawInput.noDrilling && obs.kind === 'art' && obs.likelyWallMounted) {
          return false;
        }
        return true;
      })
      .map((obs) => {
        const approxSize = obs.approxSizeMeters ?? DEFAULT_APPROX_SIZES[obs.kind];
        let suggestedPos: Vec3 | undefined = obs.position
          ? [
              Number(obs.position[0].toFixed(3)),
              0,
              Number(obs.position[2].toFixed(3)),
            ]
          : undefined;

        if (!suggestedPos && obs.relativePosition) {
          const clampedX = Math.max(-0.92, Math.min(0.92, obs.relativePosition.xNorm));
          const clampedZ = Math.max(-0.92, Math.min(0.92, obs.relativePosition.zNorm));
          suggestedPos = [
            Number((clampedX * halfW).toFixed(3)),
            0,
            Number((clampedZ * halfD).toFixed(3)),
          ];
        }

        let suggestedRot = typeof obs.rotationY === 'number' ? obs.rotationY : 0;
        if (typeof obs.rotationY !== 'number') {
          if (obs.wallAlignment === 'west') suggestedRot = Math.PI / 2;
          else if (obs.wallAlignment === 'east') suggestedRot = -Math.PI / 2;
          else if (obs.wallAlignment === 'south') suggestedRot = Math.PI;
        }

        return {
          id: obs.id,
          kind: obs.kind,
          label: obs.label,
          size: approxSize,
          position: suggestedPos,
          rotationY: suggestedRot,
          dimensionsVerified: false,
        };
      });
  } else if (rawInput.currentScene) {
    ownedFixtures = rawInput.currentScene.objects
      .filter((obj) => obj.source === 'owned')
      .map((obj) => ({
        id: obj.id,
        kind: obj.kind,
        label: obj.label,
        size: obj.size,
        position: obj.position,
        rotationY: obj.rotationY,
        dimensionsVerified: obj.dimensionsVerified,
        locked: obj.locked,
      }));
  }

  const candidateMap = new Map<string, ProductCandidateInput>();
  for (const p of rawInput.products ?? rawInput.productCandidates ?? []) {
    if (p.available !== false) {
      candidateMap.set(p.variantId, p);
    }
  }
  if (rawInput.currentScene && !recreatingFromMedia) {
    for (const obj of rawInput.currentScene.objects) {
      if (
        obj.source === 'shopify' &&
        obj.product &&
        obj.product.available !== false &&
        !candidateMap.has(obj.product.variantId)
      ) {
        candidateMap.set(obj.product.variantId, {
          ...obj.product,
          kind: obj.kind,
          size: obj.size,
          dimensionsVerified: obj.dimensionsVerified,
        });
      }
    }
  }

  return {
    ownedFixtures,
    productCandidates: Array.from(candidateMap.values()),
    recreatingFromMedia,
  };
}

export async function generateShopPlan(
  rawInput: PlanRequestInput,
  options: PlanGenerationOptions
): Promise<PlanGenerationResult> {
  const { requestId, timeoutMs = 75_000 } = options;
  const ai =
    options.clientOverride ?? getGeminiClient(requestId, PLAN_MODEL_ID);

  const purpose =
    rawInput.purpose?.trim() ||
    rawInput.brief?.trim() ||
    rawInput.currentScene?.purpose?.trim() ||
    'Boutique retail display';
  const style =
    rawInput.style?.trim() ||
    rawInput.brief?.trim() ||
    rawInput.currentScene?.style?.trim() ||
    'Modern, minimal, warm retail aesthetic';

  const { ownedFixtures, productCandidates, recreatingFromMedia } =
    resolveOwnedAndCandidates(rawInput);

  const systemInstruction = buildPlannerSystemInstruction({
    room: rawInput.room,
    minWalkwayWidth: rawInput.minWalkwayWidth,
    noDrilling: rawInput.noDrilling,
    budgetCents: rawInput.budgetCents,
  });

  const initialPrompt = JSON.stringify(
    {
      task: recreatingFromMedia
        ? 'FAITHFUL_VISION_RECREATION: The vision model ALREADY reconstructed direct 3D coordinates (`currentPosition`, `currentRotationY`, `size`) for each observed fixture in `confirmedOwnedFixtures` while watching the video. PRESERVE those exact positions and orientations as closely as possible — ONLY apply minimal nudges if needed to stay inside room walls, resolve overlaps, or keep the 3ft entrance clear. Do NOT discard or rearrange the room.'
        : 'Design an optimal, constraint-valid 3D retail store layout.',
      room: rawInput.room,
      purpose,
      style,
      budgetCents: rawInput.budgetCents,
      minWalkwayWidth: rawInput.minWalkwayWidth,
      noDrilling: rawInput.noDrilling,
      ...(rawInput.analysis
        ? {
            mediaAnalysisContext: {
              observations: rawInput.analysis.observations ?? [],
              roomCues: rawInput.analysis.roomCues ?? [],
            },
          }
        : {}),
      confirmedOwnedFixtures: ownedFixtures.map((o) => ({
        id: o.id,
        kind: o.kind,
        label: o.label,
        size: o.size ?? DEFAULT_APPROX_SIZES[o.kind],
        sizeWasProvidedByUser: o.size !== undefined,
        dimensionsVerified: Boolean(o.size && o.dimensionsVerified),
        locked: Boolean(o.locked),
        currentPosition: o.position ?? null,
        currentRotationY: o.rotationY ?? null,
      })),
      availableShopifyCandidates: productCandidates.map((p) => ({
        variantId: p.variantId,
        productId: p.productId,
        title: p.title,
        seller: p.seller,
        priceCents: p.priceCents,
        currency: p.currency,
        suggestedKind: p.kind ?? null,
        size: p.size ?? null,
        dimensionsVerified: Boolean(p.size && p.dimensionsVerified),
      })),
    },
    null,
    2
  );

  const startMs = Date.now();
  logGeminiEvent({
    requestId,
    route: '/api/plan',
    modelId: PLAN_MODEL_ID,
    stage: 'initial_plan_start',
    meta: {
      ownedCount: ownedFixtures.length,
      candidateCount: productCandidates.length,
      budgetCents: rawInput.budgetCents,
      noDrilling: rawInput.noDrilling,
    },
  });

  try {
    const firstRawPlan = await callPlannerOnce({
      ai,
      systemInstruction,
      userPrompt: initialPrompt,
      requestId,
      timeoutMs,
      stageLabel: `${PLAN_MODEL_ID} initial layout`,
    });

    let currentScene = sanitizePlannedScene({
      rawPlan: firstRawPlan,
      room: rawInput.room,
      purpose,
      style,
      budgetCents: rawInput.budgetCents,
      minWalkwayWidth: rawInput.minWalkwayWidth,
      noDrilling: rawInput.noDrilling,
      ownedFixtures,
      productCandidates,
    });

    let validation = evaluateScene(currentScene);
    let repairCount = 0;

    logGeminiEvent({
      requestId,
      route: '/api/plan',
      modelId: PLAN_MODEL_ID,
      stage: 'initial_plan_validated',
      durationMs: Date.now() - startMs,
      meta: {
        valid: validation.valid,
        errorCount: validation.summary.errorCount,
        warningCount: validation.summary.warningCount,
      },
    });

    if (!validation.valid) {
      repairCount = 1;
      const errorIssues = validation.issues.filter(
        (i) => i.severity === 'error'
      );

      const repairPrompt = JSON.stringify(
        {
          task: 'REPAIR_INVALID_LAYOUT: Fix EVERY error in `validationErrors` while keeping owned fixtures and obeying room bounds, 3ft entrance/walkway clearance, budget, and noDrilling.',
          validationErrors: errorIssues,
          previousScene: {
            room: currentScene.room,
            budgetCents: currentScene.budgetCents,
            minWalkwayWidth: currentScene.minWalkwayWidth,
            noDrilling: currentScene.noDrilling,
            objects: currentScene.objects.map((o) => ({
              id: o.id,
              kind: o.kind,
              label: o.label,
              source: o.source,
              position: o.position,
              size: o.size,
              rotationY: o.rotationY,
              dimensionsVerified: o.dimensionsVerified,
              locked: o.locked ?? false,
              selectedVariantId: o.product?.variantId ?? null,
            })),
          },
          availableShopifyCandidates: productCandidates.map((p) => ({
            variantId: p.variantId,
            title: p.title,
            priceCents: p.priceCents,
            suggestedKind: p.kind ?? null,
            size: p.size ?? null,
          })),
        },
        null,
        2
      );

      const repairStartMs = Date.now();
      const repairedRawPlan = await callPlannerOnce({
        ai,
        systemInstruction,
        userPrompt: repairPrompt,
        requestId,
        timeoutMs,
        stageLabel: `${PLAN_MODEL_ID} layout repair`,
      });

      currentScene = sanitizePlannedScene({
        rawPlan: repairedRawPlan,
        room: rawInput.room,
        purpose,
        style,
        budgetCents: rawInput.budgetCents,
        minWalkwayWidth: rawInput.minWalkwayWidth,
        noDrilling: rawInput.noDrilling,
        ownedFixtures,
        productCandidates,
      });

      validation = evaluateScene(currentScene);

      logGeminiEvent({
        requestId,
        route: '/api/plan',
        modelId: PLAN_MODEL_ID,
        stage: 'repair_plan_validated',
        durationMs: Date.now() - repairStartMs,
        meta: {
          valid: validation.valid,
          errorCount: validation.summary.errorCount,
          warningCount: validation.summary.warningCount,
        },
      });
    }

    return {
      scene: currentScene,
      issues: validation.issues,
      valid: validation.valid,
      modelUsed: PLAN_MODEL_ID,
      repairCount,
      requestId,
    };
  } catch (err) {
    logGeminiEvent({
      requestId,
      route: '/api/plan',
      modelId: PLAN_MODEL_ID,
      stage: 'error',
      durationMs: Date.now() - startMs,
      meta: {
        errorName: err instanceof Error ? err.name : 'UnknownError',
      },
    });
    if (err instanceof GeminiServiceError) throw err;
    throw new GeminiServiceError({
      code: 'MODEL_ERROR',
      message:
        err instanceof Error
          ? `${PLAN_MODEL_ID} planning failed: ${err.message}`
          : `${PLAN_MODEL_ID} planning failed.`,
      status: 502,
      requestId,
      modelAttempted: PLAN_MODEL_ID,
    });
  }
}

export const generateShopPlanWithNeon = generateShopPlan;

// ============================================================================
// 3. VOICE / TEXT OBJECT REPLACEMENT & 3D MOCKUP GENERATOR (/api/replace)
// ============================================================================

export const ReplaceRequestSchema = z.object({
  command: z.string().min(1),
  scene: ShopSceneSchema,
  selectedObjectId: z.string().nullable().optional(),
  replacementProduct: z
    .object({
      title: z.string().min(1),
      description: z.string().optional(),
      product: ProductRefSchema.optional(),
    })
    .optional(),
});

export type ReplaceRequestInput = z.infer<typeof ReplaceRequestSchema>;

const RawReplaceOutputSchema = z.object({
  action: z.enum(['replace', 'add', 'remove']),
  targetObjectId: z.string().nullable().optional(),
  replacement: z
    .object({
      kind: SceneKindSchema,
      label: z.string().min(1),
      size: z.tuple([
        z.number().positive(),
        z.number().positive(),
        z.number().positive(),
      ]),
      position: z.tuple([z.number(), z.number(), z.number()]).optional(),
      rotationY: z.number().optional(),
    })
    .nullable()
    .optional(),
  explanation: z.string().min(1),
});

const REPLACE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['replace', 'add', 'remove'],
    },
    targetObjectId: {
      type: 'string',
      nullable: true,
      description:
        'Exact `id` from `scene.objects` to replace or remove. Null when adding a new item.',
    },
    replacement: {
      type: 'object',
      nullable: true,
      description:
        '3D mockup specification for the replacement or newly added object.',
      properties: {
        kind: {
          type: 'string',
          enum: ['shelf', 'counter', 'table', 'rack', 'lamp', 'plant', 'art'],
        },
        label: {
          type: 'string',
          description:
            'Descriptive mockup label including color & furniture type so our 3D GLB catalog renders the matching asset and finish (e.g., "Cream Linen Lounge Sofa", "Walnut Wooden Cabinet Wardrobe", "Round Marble Coffee Table", "Olive Velvet Accent Chair", "Brass Floor Lamp", "Wooden Display Shelf", "Wall Mirror", "Wooden Bar Stool").',
        },
        size: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3,
          description: '[widthX, heightY, depthZ] in meters.',
        },
        position: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3,
          description:
            'Optional [x, 0, z] in meters. For replacements, keep the target object position unless nudging slightly to stay inside room bounds.',
        },
        rotationY: {
          type: 'number',
          description:
            'Optional rotation around +Y in radians; defaults to target object rotationY.',
        },
      },
      required: ['kind', 'label', 'size'],
    },
    explanation: {
      type: 'string',
      description: 'Short 1-sentence confirmation of the replacement performed.',
    },
  },
  required: ['action', 'explanation'],
};

export interface ReplaceObjectResult {
  scene: ShopScene;
  action: 'replace' | 'add' | 'remove';
  targetObjectId: string | null;
  replacedObject: SceneObject | null;
  issues: ConstraintIssue[];
  valid: boolean;
  explanation: string;
  modelUsed: string;
  requestId: string;
}

function clampObjectInsideRoom(
  obj: SceneObject,
  room: ShopScene['room']
): SceneObject {
  const halfW = room.width / 2;
  const halfD = room.depth / 2;
  const cos = Math.abs(Math.cos(obj.rotationY));
  const sin = Math.abs(Math.sin(obj.rotationY));
  const extX = (obj.size[0] / 2) * cos + (obj.size[2] / 2) * sin;
  const extZ = (obj.size[0] / 2) * sin + (obj.size[2] / 2) * cos;
  const pad = 0.03;

  const minX = -halfW + extX + pad;
  const maxX = halfW - extX - pad;
  const minZ = -halfD + extZ + pad;
  const maxZ = halfD - extZ - pad;

  const clampedX =
    minX <= maxX ? Math.max(minX, Math.min(maxX, obj.position[0])) : 0;
  const clampedZ =
    minZ <= maxZ ? Math.max(minZ, Math.min(maxZ, obj.position[2])) : 0;
  const clampedY = Math.max(
    0,
    Math.min(Math.max(0, room.height - obj.size[1]), obj.position[1])
  );

  return {
    ...obj,
    position: [
      Number(clampedX.toFixed(3)),
      Number(clampedY.toFixed(3)),
      Number(clampedZ.toFixed(3)),
    ],
  };
}

/**
 * Replaces, adds, or removes a 3D fixture in `ShopScene` from a typed/spoken
 * natural-language command or a clicked product card, generating a matching
 * 3D PBR GLB mockup specification and validating spatial constraints.
 */
export async function replaceObjectInScene(
  input: ReplaceRequestInput,
  options: PlanGenerationOptions
): Promise<ReplaceObjectResult> {
  const { requestId, timeoutMs = 45_000 } = options;
  const ai =
    options.clientOverride ?? getGeminiClient(requestId, PLAN_MODEL_ID);

  const { command, scene, selectedObjectId, replacementProduct } = input;
  const startMs = Date.now();

  logGeminiEvent({
    requestId,
    route: '/api/replace',
    modelId: PLAN_MODEL_ID,
    stage: 'start',
    meta: {
      objectCount: scene.objects.length,
      hasSelection: Boolean(selectedObjectId),
      hasProductCard: Boolean(replacementProduct),
    },
  });

  const systemInstruction = [
    `You are a Professional Interior Designer and SpaceStage 3D Add & Replacement Engine powered by ${PLAN_MODEL_ID}.`,
    'Interpret the user’s typed or spoken command (or drafted design prompt / clicked product specification) to ADD a new 3D furniture piece, REPLACE an existing one, or REMOVE one—always maintaining natural room-proportional dimensions, cohesive materials, and clean circulation.',
    'RULES:',
    '1. ADD INTENT: If the user says "add", "place", "put", "insert", "bring in", or "new" (e.g., "add a round walnut table", "add a floor lamp in the corner", "put a cream sofa"), ALWAYS set `action: "add"`, set `targetObjectId: null`, leave all existing objects untouched, and pick an open, collision-free floor `position: [x, 0, z]` inside `room` bounds that does not overlap any item in `sceneObjects` and keeps clear of the room entrance.',
    '2. REPLACE INTENT: If the user says "replace", "swap", "change", or "turn into", set `action: "replace"`. If `selectedObjectId` is set and the command refers to "this", "it", or matches the selected object type, set `targetObjectId` to `selectedObjectId`. Otherwise match the best existing `id` from `sceneObjects`.',
    '3. For `replacement.label`, ALWAYS include the requested color/material AND a specific style+furniture noun from our 46-model GLB catalog: Modern Sofa, Minimalist Boucle Sofa, Tufted Classic Sofa, Wooden Sofa, Daybed, Modern Armchair, Mid-Century Lounge Chair, Classic Wingback Armchair, Dining Chair, Office Chair, Accent Chair, Ottoman, Wooden Bench, Bar Stool, Wardrobe, Dresser, Nightstand, Wooden Cabinet, Bookshelf, Wooden Display Shelf, Steel Rack, Round Coffee Table, Round End Table, Round Side Table, Coffee Table, Dining Table, Console Table, Side Table, Desk, Bed, Desk Lamp, Floor Lamp, Potted Plant, Wall Mirror, Checkout Counter.',
    '4. Choose realistic physical dimensions `size: [width, height, depth]` in meters (e.g., 3-seat sofa ~ [2.1, 0.82, 0.92], accent chair ~ [0.82, 0.85, 0.82], coffee table ~ [1.1, 0.45, 0.6], round end table ~ [0.6, 0.62, 0.6], wardrobe/cabinet ~ [1.1, 1.9, 0.55], display shelf ~ [1.0, 1.8, 0.4], floor lamp ~ [0.42, 1.65, 0.42], plant ~ [0.55, 1.25, 0.55]).',
    '5. Keep `position[1] = 0` for floor-standing items. For `action: "replace"`, preserve the target object’s position and rotationY unless nudging slightly inside room bounds.',
  ].join('\n');

  const userPrompt = JSON.stringify(
    {
      command,
      selectedObjectId: selectedObjectId ?? null,
      replacementProduct: replacementProduct ?? null,
      room: scene.room,
      sceneObjects: scene.objects.map((o) => ({
        id: o.id,
        kind: o.kind,
        label: o.label,
        source: o.source,
        position: o.position,
        size: o.size,
        rotationY: o.rotationY,
      })),
    },
    null,
    2
  );

  try {
    const response = await withTimeout(
      ai.models.generateContent({
        model: PLAN_MODEL_ID,
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: REPLACE_RESPONSE_SCHEMA,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          temperature: 0.15,
        },
      }),
      timeoutMs,
      requestId,
      PLAN_MODEL_ID,
      `${PLAN_MODEL_ID} object replacement`
    );

    const rawText = response.text?.trim();
    if (!rawText) {
      throw new GeminiServiceError({
        code: 'INVALID_MODEL_JSON',
        message: 'Replacement model returned an empty response.',
        status: 502,
        requestId,
        modelAttempted: PLAN_MODEL_ID,
      });
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText);
    } catch {
      throw new GeminiServiceError({
        code: 'INVALID_MODEL_JSON',
        message: 'Replacement model returned malformed JSON.',
        status: 502,
        requestId,
        modelAttempted: PLAN_MODEL_ID,
      });
    }

    const checked = RawReplaceOutputSchema.safeParse(parsedJson);
    if (!checked.success) {
      throw new GeminiServiceError({
        code: 'INVALID_MODEL_JSON',
        message: `Replacement output failed schema validation: ${checked.error.issues[0]?.message ?? 'invalid structure'}`,
        status: 502,
        requestId,
        modelAttempted: PLAN_MODEL_ID,
      });
    }

    const { action, replacement, explanation } = checked.data;
    const resolvedTargetId =
      checked.data.targetObjectId ??
      (action !== 'add' ? selectedObjectId ?? null : null);

    let nextObjects = [...scene.objects];
    let updatedObject: SceneObject | null = null;

    if (action === 'remove' && resolvedTargetId) {
      nextObjects = nextObjects.filter((o) => o.id !== resolvedTargetId);
    } else if (action === 'replace' && replacement) {
      const targetIdx = resolvedTargetId
        ? nextObjects.findIndex((o) => o.id === resolvedTargetId)
        : -1;

      if (targetIdx >= 0) {
        const existing = nextObjects[targetIdx];
        const nextPos: Vec3 = replacement.position
          ? [replacement.position[0], 0, replacement.position[2]]
          : existing.position;
        const nextRot =
          typeof replacement.rotationY === 'number'
            ? replacement.rotationY
            : existing.rotationY;

        const candidateObj = clampObjectInsideRoom(
          {
            ...existing,
            kind: replacement.kind,
            label: replacementProduct?.title || replacement.label,
            source: replacementProduct?.product ? 'shopify' : 'proposal',
            size: replacement.size,
            position: nextPos,
            rotationY: nextRot,
            dimensionsVerified: false,
            locked: false,
            ...(replacementProduct?.product
              ? { product: replacementProduct.product }
              : { product: undefined }),
          },
          scene.room
        );
        nextObjects[targetIdx] = candidateObj;
        updatedObject = candidateObj;
      } else {
        // Fallback to adding if no target object matched
        const newId = `mockup-${Date.now()}`;
        const candidateObj = clampObjectInsideRoom(
          {
            id: newId,
            kind: replacement.kind,
            label: replacementProduct?.title || replacement.label,
            source: replacementProduct?.product ? 'shopify' : 'proposal',
            position: replacement.position ?? [0, 0, 0],
            size: replacement.size,
            rotationY: replacement.rotationY ?? 0,
            dimensionsVerified: false,
            ...(replacementProduct?.product
              ? { product: replacementProduct.product }
              : {}),
          },
          scene.room
        );
        nextObjects.push(candidateObj);
        updatedObject = candidateObj;
      }
    } else if (action === 'add' && replacement) {
      const newId = `mockup-${Date.now()}`;
      const candidateObj = clampObjectInsideRoom(
        {
          id: newId,
          kind: replacement.kind,
          label: replacementProduct?.title || replacement.label,
          source: replacementProduct?.product ? 'shopify' : 'proposal',
          position: replacement.position ?? [0, 0, 0],
          size: replacement.size,
          rotationY: replacement.rotationY ?? 0,
          dimensionsVerified: false,
          ...(replacementProduct?.product
            ? { product: replacementProduct.product }
            : {}),
        },
        scene.room
      );
      nextObjects.push(candidateObj);
      updatedObject = candidateObj;
    }

    const normalizedObjects = deduplicateSceneObjects(
      nextObjects.map((o) => ({
        ...o,
        size: normalizeObjectSizeForRoom(o.size, o.kind, scene.room, o.label),
      }))
    );

    const nextScene = ShopSceneSchema.parse({
      ...scene,
      objects: normalizedObjects,
    });

    const validation = evaluateScene(nextScene);

    logGeminiEvent({
      requestId,
      route: '/api/replace',
      modelId: PLAN_MODEL_ID,
      stage: 'complete',
      durationMs: Date.now() - startMs,
      meta: {
        action,
        valid: validation.valid,
        errorCount: validation.summary.errorCount,
      },
    });

    return {
      scene: nextScene,
      action,
      targetObjectId: updatedObject?.id ?? resolvedTargetId,
      replacedObject: updatedObject,
      issues: validation.issues,
      valid: validation.valid,
      explanation,
      modelUsed: PLAN_MODEL_ID,
      requestId,
    };
  } catch (err) {
    logGeminiEvent({
      requestId,
      route: '/api/replace',
      modelId: PLAN_MODEL_ID,
      stage: 'error',
      durationMs: Date.now() - startMs,
      meta: {
        errorName: err instanceof Error ? err.name : 'UnknownError',
      },
    });
    if (err instanceof GeminiServiceError) throw err;
    throw new GeminiServiceError({
      code: 'MODEL_ERROR',
      message:
        err instanceof Error
          ? `3D mockup replacement failed: ${err.message}`
          : '3D mockup replacement failed.',
      status: 502,
      requestId,
      modelAttempted: PLAN_MODEL_ID,
    });
  }
}

// ============================================================================
// 4. IMAGE-BASED PRODUCT -> 3D GLB CATALOG MATCHER (/api/match-model)
// ============================================================================

export const GLB_CATALOG_KEYS = [
  'sofaModern',
  'sofaMinimal',
  'sofaWood',
  'sofa',
  'daybed',
  'chairModern',
  'chairMidcentury',
  'armchairClassic',
  'chairGreen',
  'chairWood',
  'chair',
  'ottoman',
  'bench',
  'stool',
  'stoolBarRound',
  'stoolMetal',
  'table',
  'tableRound',
  'tableRoundWood',
  'tableRoundAccent',
  'tableSide',
  'tableSideTall',
  'tableSmallWood',
  'tableCoffeeModern2',
  'tableIndustrial',
  'tableWoodClassic',
  'tableDining',
  'tableConsole',
  'deskMetal',
  'cartCoffee',
  'cartIndustrial',
  'wardrobe',
  'cabinet',
  'cabinetPainted',
  'dresser',
  'nightstand',
  'bookshelf',
  'shelf',
  'shelfWallUnit',
  'rack',
  'rackSteelTall',
  'bed',
  'lamp',
  'lampTable',
  'mirror',
  'plant',
] as const;

export type GlbCatalogKey = (typeof GLB_CATALOG_KEYS)[number];

export const MatchProductModelRequestSchema = z.object({
  title: z.string().min(1),
  imageUrl: z.string().url().optional(),
});

export type MatchProductModelRequest = z.infer<
  typeof MatchProductModelRequestSchema
>;

const RawMatchModelOutputSchema = z.object({
  glbKey: z.enum(GLB_CATALOG_KEYS),
  inferredKind: SceneKindSchema,
  dominantColorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  overrideAlbedo: z.boolean(),
  estimatedSize: z.tuple([
    z.number().positive(),
    z.number().positive(),
    z.number().positive(),
  ]),
  confidence: z.enum(['high', 'medium', 'low']),
  reason: z.string(),
});

export interface MatchProductModelResult {
  glbKey: GlbCatalogKey;
  inferredKind: SceneObject['kind'];
  dominantColorHex: string;
  overrideAlbedo: boolean;
  estimatedSize: Vec3;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  usedImage: boolean;
  decisionCategory?: string;
  decisionConfidence?: number;
  decisionModelUsed?: string;
  modelUsed: string;
  requestId: string;
}

const MATCH_MODEL_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    glbKey: {
      type: 'string',
      enum: [...GLB_CATALOG_KEYS],
      description:
        'Closest matching 3D furniture silhouette from our 28-model PBR GLB catalog based on the product photo.',
    },
    inferredKind: {
      type: 'string',
      enum: ['shelf', 'counter', 'table', 'rack', 'lamp', 'plant', 'art'],
    },
    dominantColorHex: {
      type: 'string',
      description:
        '6-digit hex color (e.g. "#f2efe9", "#5c3b22", "#6b7750") matching the primary upholstery/wood/metal finish visible in the product photo.',
    },
    overrideAlbedo: {
      type: 'boolean',
      description:
        'True if the product is white, cream, ivory, pastel, or light solid fabric/finish so dark textures do not bleed through; false for natural wood grain or dark leather.',
    },
    estimatedSize: {
      type: 'array',
      items: { type: 'number' },
      minItems: 3,
      maxItems: 3,
      description:
        'Realistic [widthX, heightY, depthZ] in meters visually estimated from the product photo.',
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
    },
    reason: {
      type: 'string',
      description: 'Short explanation of why this 3D shape and color were chosen.',
    },
  },
  required: [
    'glbKey',
    'inferredKind',
    'dominantColorHex',
    'overrideAlbedo',
    'estimatedSize',
    'confidence',
    'reason',
  ],
};

async function runDecisionApiCategoryPick(params: {
  title: string;
  imagePart: { inlineData: { data: string; mimeType: string } } | null;
}): Promise<{ category: string; confidence: number } | null> {
  const apiKey =
    process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  if (!apiKey) return null;

  try {
    const inputPayload = params.imagePart
      ? [
          {
            type: 'image',
            data: params.imagePart.inlineData.data,
            mime_type: params.imagePart.inlineData.mimeType,
          },
          { type: 'text', text: `Product title: ${params.title}` },
        ]
      : `Product title: ${params.title}`;

    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/decisions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          model: 'gemini-decision-1',
          input: inputPayload,
          questions: {
            furniture_group: {
              type: 'choice',
              instructions:
                'Which furniture silhouette group best matches this product photo?',
              criteria: {
                round_table: 'Round or circular end table, coffee table, or pedestal table',
                rect_table: 'Rectangular coffee table, dining table, console table, desk, or rolling cart',
                sofa_lounge: 'Sofa, couch, loveseat, sectional, or daybed',
                chair_stool: 'Armchair, lounge chair, dining chair, bar stool, ottoman, or bench',
                storage_shelf: 'Wardrobe, cabinet, dresser, nightstand, bookshelf, display shelf, or rack',
                bedroom: 'Bed frame or mattress',
                lighting_decor: 'Floor lamp, table/desk lamp, mirror, or potted plant',
              },
            },
          },
        }),
        signal: AbortSignal.timeout(6000),
      }
    );

    if (!res.ok) return null;
    const data = (await res.json()) as {
      answers?: {
        furniture_group?: { choice?: string; confidence?: number };
      };
    };
    const ans = data.answers?.furniture_group;
    if (ans?.choice) {
      return {
        category: ans.choice,
        confidence: typeof ans.confidence === 'number' ? ans.confidence : 0.8,
      };
    }
  } catch {
    // Graceful fallback to direct vision selection
  }
  return null;
}

/**
 * Inspects a Shopify product's actual photo using `gemini-decision-1` (calibrated
 * zero-token category choice) + Gemini Vision (`gemini-4-hydrogen`) to pick the
 * closest 3D PBR GLB model from our 46-model catalog and sample its exact color.
 */
export async function matchProductImageToGlb(
  input: MatchProductModelRequest,
  options: PlanGenerationOptions
): Promise<MatchProductModelResult> {
  const { requestId, timeoutMs = 25_000 } = options;
  const ai =
    options.clientOverride ?? getGeminiClient(requestId, PLAN_MODEL_ID);
  const startMs = Date.now();

  let imagePart: { inlineData: { data: string; mimeType: string } } | null = null;
  if (input.imageUrl) {
    const safeUrl = isSafePublicHttpsUrl(input.imageUrl);
    if (safeUrl) {
      try {
        const res = await withTimeout(
          fetch(safeUrl.toString()),
          5_000,
          requestId,
          PLAN_MODEL_ID,
          'Product image fetch'
        );
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          const mime = normalizeMediaMimeType(
            res.headers.get('content-type') ?? 'image/jpeg',
            safeUrl.pathname
          );
          if (buf.byteLength > 0 && buf.byteLength <= 6 * 1024 * 1024 && mime.startsWith('image/')) {
            imagePart = {
              inlineData: {
                data: buf.toString('base64'),
                mimeType: mime,
              },
            };
          }
        }
      } catch {
        // Non-fatal: fall back to title-only classification if CDN image is unreachable
      }
    }
  }

  // Stage 1: Fast zero-output-token calibrated choice via gemini-decision-1
  const decision = options.clientOverride
    ? null
    : await runDecisionApiCategoryPick({
        title: input.title,
        imagePart,
      });

  logGeminiEvent({
    requestId,
    route: '/api/match-model',
    modelId: PLAN_MODEL_ID,
    stage: 'start',
    meta: {
      usedImage: Boolean(imagePart),
      decisionCategory: decision?.category,
      decisionConfidence: decision?.confidence,
    },
  });

  const systemInstruction = [
    'You are SpaceStage Visual 3D Asset Matcher.',
    'Look closely at the product PHOTO (primary ground truth) and title, and pick the single closest 3D GLB silhouette key from our 46-model catalog:',
    '- Round Tables: tableRoundWood (round wood end/side table with legs/shelf), tableRoundAccent (compact round accent/pedestal table), tableRound (low round coffee table)',
    '- Rectangular Tables/Desks/Carts: tableSide (square/compact side table), tableSideTall (tall narrow side table), tableSmallWood (small wood table), table (modern coffee table), tableCoffeeModern2 (contemporary coffee table 2), tableIndustrial (industrial metal+wood coffee table), tableWoodClassic (classic rectangular wood table), tableDining (large dining table), tableConsole (narrow hallway/display console), deskMetal (office/display desk), cartCoffee (rolling coffee/display cart), cartIndustrial (industrial storage cart)',
    '- Sofas: sofaMinimal (plush/low/boucle/white/minimal), sofaModern (clean modern), sofaWood (wood-framed sofa), sofa (tufted/classic leather), daybed',
    '- Chairs/Stools: chairModern (sculptural modern armchair), chairMidcentury (wood-frame lounge), armchairClassic (wingback/tufted), chairGreen (upholstered green chair), chairWood (wooden dining/cafe chair), chair (general), ottoman, bench, stool (wood stool), stoolBarRound (round bar stool), stoolMetal (metal stool)',
    '- Storage/Shelving: wardrobe (tall enclosed wardrobe/armoire), cabinet (modern wood cabinet/credenza), cabinetPainted (painted cabinet), dresser (chest of drawers), nightstand, bookshelf (tall bookcase), shelf (open wood display shelf), shelfWallUnit (modular shelf unit), rack (steel frame shelf), rackSteelTall (tall steel rack)',
    '- Bedroom/Lighting/Decor: bed, lamp (standing floor lamp), lampTable (desk/table lamp), mirror, plant',
    decision
      ? `Calibrated Decisions API (gemini-decision-1) group prior: "${decision.category}" (confidence ${(decision.confidence * 100).toFixed(0)}%).`
      : '',
    'Sample the exact primary visible hex color (`dominantColorHex`) from the photo, and set `overrideAlbedo: true` for white/cream/ivory/light-fabric finishes.',
  ]
    .filter(Boolean)
    .join('\n');

  const parts: Array<
    { inlineData: { data: string; mimeType: string } } | { text: string }
  > = [];
  if (imagePart) parts.push(imagePart);
  parts.push({
    text: `Match this product to the closest 3D GLB catalog asset and sample its visible color & proportions. Product title: "${input.title}"`,
  });

  const response = await withTimeout(
    ai.models.generateContent({
      model: PLAN_MODEL_ID,
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: MATCH_MODEL_RESPONSE_SCHEMA,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        temperature: 0.1,
      },
    }),
    timeoutMs,
    requestId,
    PLAN_MODEL_ID,
    'Product image to 3D GLB match'
  );

  const rawText = response.text?.trim();
  if (!rawText) {
    throw new GeminiServiceError({
      code: 'INVALID_MODEL_JSON',
      message: 'Vision matcher returned empty response.',
      status: 502,
      requestId,
      modelAttempted: PLAN_MODEL_ID,
    });
  }

  const parsed = RawMatchModelOutputSchema.parse(JSON.parse(rawText));

  logGeminiEvent({
    requestId,
    route: '/api/match-model',
    modelId: PLAN_MODEL_ID,
    stage: 'complete',
    durationMs: Date.now() - startMs,
    meta: {
      glbKey: parsed.glbKey,
      usedImage: Boolean(imagePart),
      decisionCategory: decision?.category,
      confidence: parsed.confidence,
    },
  });

  return {
    ...parsed,
    usedImage: Boolean(imagePart),
    ...(decision
      ? {
          decisionCategory: decision.category,
          decisionConfidence: decision.confidence,
          decisionModelUsed: 'gemini-decision-1',
        }
      : {}),
    modelUsed: PLAN_MODEL_ID,
    requestId,
  };
}
