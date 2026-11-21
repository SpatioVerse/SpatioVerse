import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { ShopSceneSchema } from '@/lib/schema';
import {
  VoiceActionSchema,
  buildVoiceSystemInstruction,
  formatGroundedRoomContext,
  type VoiceAction,
  type VoicePreviewState,
} from '@/lib/voiceActions';

export const maxDuration = 30;

const TYPED_COMMAND_MODEL =
  process.env.VOICE_TEXT_MODEL?.trim() || 'gemini-3.8-flash';

const HistoryItemSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
});

const CameraBasisSchema = z.object({
  position: z.tuple([z.number(), z.number(), z.number()]),
  forwardXZ: z.tuple([z.number(), z.number()]),
  rightXZ: z.tuple([z.number(), z.number()]),
  facingWall: z.enum(['north', 'south', 'east', 'west']),
});

const RequestBodySchema = z.object({
  text: z.string().trim().min(1, 'Command text is required').max(1000),
  scene: ShopSceneSchema,
  selectedId: z.string().nullable(),
  cameraBasis: CameraBasisSchema,
  activePreview: z.unknown().nullable().optional(),
  layoutOptions: z
    .array(
      z.object({
        index: z.number().int(),
        name: z.string(),
        tradeoff: z.string(),
        metricsSummary: z.string(),
      })
    )
    .optional(),
  proactiveSuggestion: z
    .object({
      title: z.string(),
      spokenPrompt: z.string(),
      objectId: z.string(),
      targetLabel: z.string(),
    })
    .nullable()
    .optional(),
  canUndo: z.boolean().default(false),
  preferredLanguage: z.string().nullable().optional(),
  history: z.array(HistoryItemSchema).max(12).default([]),
  canvasFrameBase64: z.string().optional(),
});

const RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    understood: {
      type: 'string',
      description: 'Concise summary of what the user asked for.',
    },
    replyText: {
      type: 'string',
      description:
        'Brief, natural 1-sentence reply in the user language (or preferredLanguage if set).',
    },
    detectedLanguage: {
      type: 'string',
      description:
        'Language detected from the user message (e.g. English, Hindi, Hinglish, Spanish).',
    },
    updatedPreferredLanguage: {
      type: ['string', 'null'],
      description:
        'Set only if the user explicitly asked to switch reply language (e.g. "English mein jawab do" -> "English").',
    },
    actions: {
      type: 'array',
      items: {
        anyOf: [
          {
            type: 'object',
            properties: {
              type: { const: 'select_object' },
              objectId: { type: 'string' },
            },
            required: ['type', 'objectId'],
          },
          {
            type: 'object',
            properties: {
              type: { const: 'highlight_candidates' },
              objectIds: { type: 'array', items: { type: 'string' } },
              reason: { type: 'string' },
            },
            required: ['type', 'objectIds'],
          },
          {
            type: 'object',
            properties: {
              type: { const: 'preview_move' },
              objectId: { type: 'string' },
              direction: {
                type: 'string',
                enum: [
                  'left',
                  'right',
                  'forward',
                  'back',
                  'north',
                  'south',
                  'east',
                  'west',
                ],
              },
              distanceMeters: { type: 'number' },
            },
            required: ['type', 'direction'],
          },
          {
            type: 'object',
            properties: {
              type: { const: 'preview_move_to_wall' },
              objectId: { type: 'string' },
              wall: {
                type: 'string',
                enum: ['north', 'south', 'east', 'west', 'opposite', 'other'],
              },
              alignWithWall: { type: 'boolean' },
            },
            required: ['type', 'wall'],
          },
          {
            type: 'object',
            properties: {
              type: { const: 'preview_rotate' },
              objectId: { type: 'string' },
              mode: {
                type: 'string',
                enum: ['relative', 'sideways', 'face_center'],
              },
              deltaDegrees: { type: 'number' },
            },
            required: ['type', 'mode'],
          },
          {
            type: 'object',
            properties: { type: { const: 'stop_preview_motion' } },
            required: ['type'],
          },
          {
            type: 'object',
            properties: { type: { const: 'preview_alternative' } },
            required: ['type'],
          },
          {
            type: 'object',
            properties: { type: { const: 'commit_preview' } },
            required: ['type'],
          },
          {
            type: 'object',
            properties: { type: { const: 'cancel_preview' } },
            required: ['type'],
          },
          {
            type: 'object',
            properties: { type: { const: 'undo_last_edit' } },
            required: ['type'],
          },
          {
            type: 'object',
            properties: {
              type: { const: 'set_language_preference' },
              language: { type: 'string' },
            },
            required: ['type', 'language'],
          },
          {
            type: 'object',
            properties: { type: { const: 'suggest_layouts' } },
            required: ['type'],
          },
          {
            type: 'object',
            properties: {
              type: { const: 'preview_layout_option' },
              optionIndex: { type: 'integer', minimum: 1, maximum: 3 },
            },
            required: ['type', 'optionIndex'],
          },
          {
            type: 'object',
            properties: { type: { const: 'preview_proactive_suggestion' } },
            required: ['type'],
          },
          {
            type: 'object',
            properties: { type: { const: 'dismiss_proactive_suggestion' } },
            required: ['type'],
          },
          {
            type: 'object',
            properties: {
              type: { const: 'browse_shopify_products' },
              query: { type: 'string' },
              maxPriceDollars: { type: 'number' },
            },
            required: ['type', 'query'],
          },
          {
            type: 'object',
            properties: {
              type: { const: 'apply_shopify_product' },
              productIndex: { type: 'integer', minimum: 1, maximum: 12 },
              mode: { type: 'string', enum: ['add', 'replace'] },
              targetObjectId: { type: 'string' },
            },
            required: ['type', 'productIndex', 'mode'],
          },
          {
            type: 'object',
            properties: {
              type: { const: 'place_shopify_order' },
              productIndex: { type: 'integer', minimum: 1, maximum: 12 },
            },
            required: ['type'],
          },
          {
            type: 'object',
            properties: {
              type: { const: 'clear_room' },
              keepObjectIds: { type: 'array', items: { type: 'string' } },
            },
            required: ['type'],
          },
          {
            type: 'object',
            properties: {
              type: { const: 'redesign_room_style' },
              style: { type: 'string' },
              brief: { type: 'string' },
              budgetDollars: { type: 'number' },
              keepExistingObjects: { type: 'boolean' },
              keepObjectIds: { type: 'array', items: { type: 'string' } },
            },
            required: ['type', 'style'],
          },
          {
            type: 'object',
            properties: {
              type: { const: 'draft_design_prompt' },
              prompt: { type: 'string' },
              mode: { type: 'string', enum: ['redesign', 'add', 'replace'] },
              style: { type: 'string' },
              budgetDollars: { type: 'number' },
              keepObjectIds: { type: 'array', items: { type: 'string' } },
              targetObjectId: { type: 'string' },
            },
            required: ['type', 'prompt', 'mode'],
          },
          {
            type: 'object',
            properties: { type: { const: 'render_from_prompt' } },
            required: ['type'],
          },
        ],
      },
    },
  },
  required: ['understood', 'replyText', 'detectedLanguage', 'actions'],
};

function sanitizeAction(raw: Record<string, unknown>): VoiceAction | null {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    if (k === 'distanceMeters') {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n) || n < 0.05) continue;
      cleaned[k] = Math.min(3.5, n);
      continue;
    }
    if (k === 'deltaDegrees') {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) continue;
      cleaned[k] = Math.max(-360, Math.min(360, n));
      continue;
    }
    if (k === 'objectIds' && Array.isArray(v)) {
      const nonEmpty = v.filter(
        (item): item is string => typeof item === 'string' && item.trim().length > 0
      );
      if (nonEmpty.length === 0) continue;
      cleaned[k] = nonEmpty;
      continue;
    }
    cleaned[k] = v;
  }
  const parsed = VoiceActionSchema.safeParse(cleaned);
  if (!parsed.success) {
    console.warn('[voice/command] dropped invalid action:', JSON.stringify(cleaned), parsed.error.issues);
    return null;
  }
  return parsed.data;
}

export async function POST(request: Request): Promise<NextResponse> {
  const requestId =
    request.headers.get('x-request-id')?.trim() || crypto.randomUUID();
  const apiKey = process.env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    return NextResponse.json(
      {
        error: {
          code: 'MISSING_API_KEY',
          message: 'GEMINI_API_KEY is not configured on the server.',
          requestId,
        },
      },
      { status: 503, headers: { 'x-request-id': requestId } }
    );
  }

  let bodyJson: unknown;
  try {
    bodyJson = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          code: 'INVALID_JSON',
          message: 'Request body must be valid JSON.',
          requestId,
        },
      },
      { status: 400, headers: { 'x-request-id': requestId } }
    );
  }

  const parsed = RequestBodySchema.safeParse(bodyJson);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'INVALID_INPUT',
          message: parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
          requestId,
        },
      },
      { status: 400, headers: { 'x-request-id': requestId } }
    );
  }

  const data = parsed.data;
  const contextJson = formatGroundedRoomContext({
    scene: data.scene,
    selectedId: data.selectedId,
    cameraBasis: data.cameraBasis,
    activePreview: (data.activePreview as VoicePreviewState | null) ?? null,
    preferredLanguage: data.preferredLanguage ?? null,
    canUndo: data.canUndo,
    layoutOptions: data.layoutOptions ?? [],
    proactiveSuggestion: data.proactiveSuggestion ?? null,
  });

  const systemInstruction = `${buildVoiceSystemInstruction(contextJson)}

TYPED COMMAND JSON OUTPUT RULES:
- Return ONLY JSON matching the response schema.
- Translate the user's intent into typed actions[] using exact object IDs from LIVE ROOM CONTEXT.
- NEVER return an empty actions[] when the user asks to move, rotate, stop, commit, cancel, undo, select, or clarify an object.
- For preview_move, ALWAYS set "direction" ("left"|"right"|"forward"|"back"|"north"|"south"|"east"|"west") and "distanceMeters" (0.35-0.45 for a little, 0.2 for a bit more).
- If the user asks to move/rotate an object and one is selected (or activePreview exists), use that objectId.
- If multiple objects match an ambiguous noun (like "shelf" when 2 shelves exist and neither is selected), emit highlight_candidates with all matching objectIds and ask briefly which one.
- Keep replyText brief (1 short sentence) in the user's current language, or updatedPreferredLanguage/preferredLanguage if set.`;

  const historyLines = data.history
    .slice(-8)
    .map((h) => `${h.role === 'user' ? 'User' : 'Room'}: ${h.text}`)
    .join('\n');

  const userParts: Array<
    { text: string } | { inlineData: { mimeType: string; data: string } }
  > = [];

  if (data.canvasFrameBase64 && data.canvasFrameBase64.length < 400_000) {
    userParts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: data.canvasFrameBase64,
      },
    });
  }

  userParts.push({
    text: [
      historyLines ? `Recent conversation:\n${historyLines}\n` : '',
      `User command: ${data.text}`,
    ]
      .filter(Boolean)
      .join('\n'),
  });

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: TYPED_COMMAND_MODEL,
      contents: [{ role: 'user', parts: userParts }],
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseJsonSchema: RESPONSE_JSON_SCHEMA,
        temperature: 0.2,
      },
    });

    const rawText = response.text?.trim() ?? '';
    const parsedModel = JSON.parse(rawText) as {
      understood?: string;
      replyText?: string;
      detectedLanguage?: string;
      updatedPreferredLanguage?: string | null;
      actions?: Array<Record<string, unknown>>;
    };

    const actions: VoiceAction[] = [];
    for (const rawAct of parsedModel.actions ?? []) {
      const sanitized = sanitizeAction(rawAct);
      if (sanitized) actions.push(sanitized);
    }

    return NextResponse.json(
      {
        understood: parsedModel.understood ?? data.text,
        replyText: parsedModel.replyText ?? '',
        detectedLanguage: parsedModel.detectedLanguage ?? 'auto',
        updatedPreferredLanguage: parsedModel.updatedPreferredLanguage ?? null,
        actions,
        modelUsed: TYPED_COMMAND_MODEL,
        requestId,
      },
      { status: 200, headers: { 'x-request-id': requestId } }
    );
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Failed to interpret room command with Gemini.';
    return NextResponse.json(
      {
        error: {
          code: 'COMMAND_ERROR',
          message,
          requestId,
        },
      },
      { status: 502, headers: { 'x-request-id': requestId } }
    );
  }
}
