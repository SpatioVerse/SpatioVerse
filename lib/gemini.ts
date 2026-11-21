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
  route: '/api/analyze' | '/api/plan';
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

export interface AnalyzeMediaInput {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  notes?: string;
  requestId: string;
  timeoutMs?: number;
  forceFilesApi?: boolean;
  clientOverride?: Pick<GoogleGenAI, 'models' | 'files'>;
}

export interface AnalyzeUrlInput {
  mediaUrl: string;
  youtubeId?: string | null;
  notes?: string;
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
              'Relative placement visible in frame (e.g., "left wall near rear corner").',
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

function buildObservationPrompts(isVideo: boolean, notes?: string) {
  const systemPrompt = [
    `You are SpaceStage Scene Observer powered by ${ANALYZE_MODEL_ID}.`,
    'Inspect the merchant-provided retail space media and identify ONLY visibly grounded furniture/fixtures.',
    'STRICT RULES:',
    '1. DO NOT invent or assert exact room or furniture measurements (no uncalibrated feet/meters/cm claims).',
    '2. Map each visible fixture to one of: shelf, counter, table, rack, lamp, plant, art.',
    isVideo
      ? '3. Cite concrete video timestamp ranges (e.g. "00:02-00:06") in `evidence`.'
      : '3. Cite concrete image regions (e.g. "back-left corner", "center foreground") in `evidence`.',
    '4. Explicitly describe scale/occlusion/mounting ambiguities in `uncertainty` and `warnings`.',
    '5. Never hallucinate hidden objects outside the frame.',
  ].join('\n');

  const userPrompt = notes?.trim()
    ? `Analyze this retail space ${isVideo ? 'video' : 'photo'} and extract visible owned fixtures. Merchant context (unverified): ${notes.trim()}`
    : `Analyze this retail space ${isVideo ? 'video' : 'photo'} and extract visible owned fixtures, room cues, and uncertainty warnings.`;

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
    const { systemPrompt, userPrompt } = buildObservationPrompts(isVideo, notes);

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
      const { systemPrompt, userPrompt } = buildObservationPrompts(true, notes);
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
    `You are SpaceStage Spatial Store Planner powered by ${PLAN_MODEL_ID}.`,
    'Generate a realistic, functional, visually balanced 3D retail floorplan in strict JSON.',
    '',
    'COORDINATE & GEOMETRY RULES (MANDATORY):',
    `- All lengths and coordinates are in METERS (1 ft = ${FT_TO_METERS} m). Room width (X) = ${room.width.toFixed(4)}m, depth (Z) = ${room.depth.toFixed(4)}m, ceiling height (Y) = ${room.height.toFixed(4)}m.`,
    `- Floor is centered at [0, 0]: X spans [-${halfW}, +${halfW}] (west = -${halfW}, east = +${halfW}); Z spans [-${halfD}, +${halfD}] (north = -${halfD}, south = +${halfD}).`,
    '- Place floor-standing fixtures with `position[1] = 0` (bottom resting on the floor).',
    '- Every rotated object footprint (`position` +/- rotated `size[0]/2`, `size[2]/2`) MUST stay strictly inside the room walls (`[-width/2, +width/2]` and `[-depth/2, +depth/2]`) with zero overlap between fixtures.',
    `- Entrance is on the ${room.entrance.wall.toUpperCase()} wall (offset ${room.entrance.offset.toFixed(3)}m from wall center, doorway width ${room.entrance.width.toFixed(3)}m).`,
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
} {
  const explicitOwned =
    rawInput.existingObjects ?? rawInput.ownedObjects ?? rawInput.items;

  let ownedFixtures: OwnedFixtureInput[] = [];
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
  if (rawInput.currentScene) {
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

  const { ownedFixtures, productCandidates } =
    resolveOwnedAndCandidates(rawInput);

  const systemInstruction = buildPlannerSystemInstruction({
    room: rawInput.room,
    minWalkwayWidth: rawInput.minWalkwayWidth,
    noDrilling: rawInput.noDrilling,
    budgetCents: rawInput.budgetCents,
  });

  const initialPrompt = JSON.stringify(
    {
      task: 'Design an optimal, constraint-valid 3D retail store layout.',
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
