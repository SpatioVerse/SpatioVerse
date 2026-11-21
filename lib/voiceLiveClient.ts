'use client';

import {
  GoogleGenAI,
  Modality,
  Type,
  type FunctionDeclaration,
  type LiveServerMessage,
  type Session,
} from '@google/genai';
import {
  captureCanvasFrameBase64,
  getCameraBasis,
} from '@/lib/cameraBridge';
import {
  VoiceActionSchema,
  buildVoiceSystemInstruction,
  formatGroundedRoomContext,
  type VoiceAction,
} from '@/lib/voiceActions';
import {
  executeVoiceActionAsync,
  type ActionExecutionResult,
} from '@/lib/voiceExecutor';
import { useSceneStore } from '@/store/useSceneStore';

export type VoiceSessionPhase =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

export interface VoiceLiveCallbacks {
  onPhaseChange: (phase: VoiceSessionPhase) => void;
  onUserTranscript: (text: string, isFinal: boolean) => void;
  onAssistantTranscript: (text: string, isFinal: boolean) => void;
  onActionResult: (result: ActionExecutionResult) => void;
  onMicLevel: (level: number) => void;
  onModelConnected: (model: string, voiceName: string) => void;
  onPreferredLanguageChange: (language: string) => void;
  onError: (message: string, fallbackToText?: boolean) => void;
  onClose: () => void;
}

const LIVE_FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'select_object',
    description: 'Select a specific fixture in the 3D room by its exact ID.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        objectId: { type: Type.STRING, description: 'Exact object ID from LIVE ROOM CONTEXT.' },
      },
      required: ['objectId'],
    },
  },
  {
    name: 'highlight_candidates',
    description:
      'Highlight two or more matching fixtures when the user reference is ambiguous (e.g. "move the shelf" when multiple shelves exist) and ask which one.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        objectIds: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'All matching object IDs to highlight simultaneously.',
        },
        reason: { type: Type.STRING },
      },
      required: ['objectIds'],
    },
  },
  {
    name: 'preview_move',
    description:
      'Slide the translucent 3D preview of an object in a camera-relative (left/right/forward/back) or world (north/south/east/west) direction. Accumulates on an active preview.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        objectId: {
          type: Type.STRING,
          description: 'Optional exact object ID; defaults to active preview or selected object.',
        },
        direction: {
          type: Type.STRING,
          enum: ['left', 'right', 'forward', 'back', 'north', 'south', 'east', 'west'],
        },
        distanceMeters: {
          type: Type.NUMBER,
          description: 'Distance in meters (0.35-0.45 for "a bit", 0.2-0.25 for "a little more").',
        },
      },
      required: ['direction'],
    },
  },
  {
    name: 'preview_move_to_wall',
    description:
      'Preview moving a fixture cleanly against a wall (north, south, east, west, opposite, or other).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        objectId: { type: Type.STRING },
        wall: {
          type: Type.STRING,
          enum: ['north', 'south', 'east', 'west', 'opposite', 'other'],
        },
        alignWithWall: { type: Type.BOOLEAN },
      },
      required: ['wall'],
    },
  },
  {
    name: 'preview_rotate',
    description:
      'Rotate the active preview (or selected fixture). Use mode="sideways" for 90-degree turn, "relative" with deltaDegrees, or "face_center".',
    parameters: {
      type: Type.OBJECT,
      properties: {
        objectId: { type: Type.STRING },
        mode: {
          type: Type.STRING,
          enum: ['relative', 'sideways', 'face_center'],
        },
        deltaDegrees: { type: Type.NUMBER },
      },
    },
  },
  {
    name: 'stop_preview_motion',
    description:
      'Freeze/pause the active preview right where it is for inspection WITHOUT committing or discarding it (e.g. "stop there", "बस, यहीं").',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'preview_alternative',
    description:
      'Preview the validator-verified suggested alternative placement after the user agrees (e.g. "हाँ, दिखाओ", "yes, show me").',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'commit_preview',
    description:
      'Commit/accept the active preview into the room layout as one undoable edit (e.g. "keep it", "रख दो").',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'cancel_preview',
    description:
      'Discard the active preview and keep the original placement (e.g. "cancel", "छोड़ दो").',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'undo_last_edit',
    description:
      'Undo the last committed layout edit, restoring exact previous position and rotation (e.g. "undo that", "वापस करो").',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'set_language_preference',
    description:
      'Honor an explicit user request to reply in a specific language (e.g. "English mein jawab do" -> language="English").',
    parameters: {
      type: Type.OBJECT,
      properties: {
        language: { type: Type.STRING },
      },
      required: ['language'],
    },
  },
  {
    name: 'suggest_layouts',
    description:
      'Generate up to 3 validated, genuinely different room layouts using current furniture, locked items, budget, and clearances. Returns stable numbered options (1, 2, 3) with goal names and one concrete tradeoff each.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'preview_layout_option',
    description:
      'Preview a specific numbered layout option (1, 2, or 3) directly in the 3D room (e.g. "Show me the second one", "दूसरा वाला दिखाओ"). Does NOT commit it yet.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        optionIndex: {
          type: Type.INTEGER,
          description: 'Stable 1-based option number (1, 2, or 3).',
        },
      },
      required: ['optionIndex'],
    },
  },
  {
    name: 'preview_proactive_suggestion',
    description:
      'Immediately preview the active proactive improvement suggestion in 3D when the user agrees (e.g. "Show me", "हाँ, दिखाओ").',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'dismiss_proactive_suggestion',
    description:
      'Dismiss the active proactive improvement suggestion when the user declines (e.g. "No thanks", "रहने दो").',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'browse_shopify_products',
    description:
      'Search live Shopify products and open the right-hand Shop Products side view showing the suggested products. Works with a specific query OR empty/omitted query to show featured Shopify furniture products. Returns numbered options (1, 2, 3...) with real titles, sellers, and prices.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Optional furniture or decor search query (e.g. "round walnut table", "cream sofa", "floor lamp"). Omit or leave empty to open the Shop Products panel with featured items.',
        },
        maxPriceDollars: {
          type: Type.NUMBER,
          description: 'Optional maximum price in USD dollars if the user specifies a budget.',
        },
      },
    },
  },
  {
    name: 'apply_shopify_product',
    description:
      'Add or replace a 3D item in the room using a numbered product from the currently shown Shopify side-panel list (1-based productIndex).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        productIndex: {
          type: Type.INTEGER,
          description: '1-based index of the product shown in the Shop Products side panel (e.g. 1 for the first option).',
        },
        mode: {
          type: Type.STRING,
          enum: ['add', 'replace'],
          description: '"add" inserts a new product into the room; "replace" swaps the selected/target object.',
        },
        targetObjectId: {
          type: Type.STRING,
          description: 'Optional exact object ID when mode="replace".',
        },
      },
      required: ['productIndex', 'mode'],
    },
  },
  {
    name: 'place_shopify_order',
    description:
      'Create a live Shopify merchant order / checkout cart for a numbered product from the Shop Products list or for all Shopify items currently placed in the 3D room, and open the side view with the checkout link.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        productIndex: {
          type: Type.INTEGER,
          description: 'Optional 1-based product index from the browsed Shopify list. Omit to order all Shopify products currently placed in the room.',
        },
      },
    },
  },
  {
    name: 'clear_room',
    description:
      'Clear all furniture objects from the 3D room (or remove everything except specific keepObjectIds). Always 1-step undoable.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        keepObjectIds: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Optional exact object IDs from LIVE ROOM CONTEXT to keep while clearing all other items.',
        },
      },
    },
  },
  {
    name: 'remove_objects',
    description:
      'Remove one or more specific furniture objects from the 3D room by exact ID WITHOUT changing, moving, or redesigning any other object in the room. Always 1-step undoable.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        objectIds: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Exact object IDs from LIVE ROOM CONTEXT to remove.',
        },
      },
      required: ['objectIds'],
    },
  },
  {
    name: 'redesign_room_style',
    description:
      'Replace the whole room layout with a fresh, constraint-validated 3D design tailored to the user’s style (e.g. minimalist, decorative, cozy, luxury) and budget, optionally keeping specific items and furnishing with live Shopify products.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        style: {
          type: Type.STRING,
          description: 'Requested room aesthetic or style (e.g. "minimalist", "decorative cozy", "warm modern", "boutique luxury").',
        },
        brief: {
          type: Type.STRING,
          description: 'Optional extra user preferences (colors, mood, specific furniture requests).',
        },
        budgetDollars: {
          type: Type.NUMBER,
          description: 'Optional budget in USD dollars for new items (e.g. 500, 1200).',
        },
        keepExistingObjects: {
          type: Type.BOOLEAN,
          description: 'True to keep all current owned items and redesign around them; false (default) to replace the whole layout freshly.',
        },
        keepObjectIds: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Optional exact object IDs to keep while replacing everything else.',
        },
      },
      required: ['style'],
    },
  },
  {
    name: 'draft_design_prompt',
    description:
      'Write a clean, structured design prompt FIRST (shown on screen) before rendering any new object or room redesign so objects are never repeatedly replaced while the user is still speaking.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: {
          type: Type.STRING,
          description: 'Clear, specific design prompt describing the exact object(s), style, colors, and placement to render.',
        },
        mode: {
          type: Type.STRING,
          enum: ['redesign', 'add', 'replace'],
          description: '"redesign" for whole-room layout, "add" to insert one new object, "replace" to swap one target object.',
        },
        style: { type: Type.STRING },
        budgetDollars: { type: Type.NUMBER },
        keepObjectIds: { type: Type.ARRAY, items: { type: Type.STRING } },
        targetObjectId: { type: Type.STRING },
      },
      required: ['prompt', 'mode'],
    },
  },
  {
    name: 'render_from_prompt',
    description:
      'Render the currently drafted design prompt into the 3D scene ONCE after the user confirms (e.g. "Yes", "Render it", "Go ahead"). Enforces natural room-proportional sizing and zero duplicate objects.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
];

function float32ToInt16Downsampled(
  input: Float32Array,
  inputRate: number,
  targetRate: number
): Int16Array {
  if (inputRate === targetRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  const ratio = inputRate / targetRate;
  const newLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Int16Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < newLength) {
    const nextOffsetBuffer = Math.min(
      input.length,
      Math.round((offsetResult + 1) * ratio)
    );
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer; i += 1) {
      accum += input[i];
      count += 1;
    }
    const sample = count > 0 ? accum / count : 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    out[offsetResult] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}

function mapToolCallToVoiceAction(
  name: string,
  args: Record<string, unknown> | undefined
): VoiceAction | null {
  const candidate: Record<string, unknown> = {
    ...(args ?? {}),
    type: name,
  };
  const parsed = VoiceActionSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export class VoiceLiveClient {
  private session: Session | null = null;
  private mediaStream: MediaStream | null = null;
  private micContext: AudioContext | null = null;
  private micProcessor: ScriptProcessorNode | null = null;
  private playbackContext: AudioContext | null = null;
  private activeSources = new Set<AudioBufferSourceNode>();
  private nextPlayTime = 0;
  private phase: VoiceSessionPhase = 'idle';
  private closed = false;
  private preferredLanguage: string | null = null;
  private voiceName: string = 'Sulafat';
  private userTranscriptBuffer = '';
  private assistantTranscriptBuffer = '';
  private lastFrameSentAt = 0;
  private callbacks: VoiceLiveCallbacks;

  constructor(callbacks: VoiceLiveCallbacks, preferredLanguage: string | null) {
    this.callbacks = callbacks;
    this.preferredLanguage = preferredLanguage;
  }

  private setPhase(next: VoiceSessionPhase): void {
    if (this.phase === next) return;
    this.phase = next;
    this.callbacks.onPhaseChange(next);
  }

  public setPreferredLanguage(lang: string | null): void {
    this.preferredLanguage = lang;
  }

  public async start(): Promise<void> {
    this.closed = false;
    this.setPhase('connecting');

    // 1. Request microphone first so permission errors are surfaced immediately
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function'
    ) {
      this.setPhase('error');
      this.callbacks.onError(
        'Microphone API is unavailable in this browser. Use the typed command box below in any language.',
        true
      );
      return;
    }

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Microphone permission denied.';
      this.setPhase('error');
      this.callbacks.onError(
        `Microphone unavailable (${msg}). You can still type commands in any language below.`,
        true
      );
      return;
    }

    // 2. Request short-lived ephemeral token from our server route (keeps GEMINI_API_KEY server-side)
    let tokenData: {
      token: string;
      model: string;
      fallbackModel?: string;
      voiceName?: string;
    };
    try {
      const res = await fetch('/api/voice/token', { method: 'POST' });
      const json = (await res.json()) as {
        token?: string;
        model?: string;
        fallbackModel?: string;
        voiceName?: string;
        error?: { message?: string };
      };
      if (!res.ok || !json.token || !json.model) {
        throw new Error(
          json.error?.message || `Voice token request failed (HTTP ${res.status}).`
        );
      }
      tokenData = {
        token: json.token,
        model: json.model,
        fallbackModel: json.fallbackModel,
        voiceName: json.voiceName,
      };
      if (json.voiceName) {
        this.voiceName = json.voiceName;
      }
    } catch (err) {
      this.cleanupAudio();
      const msg =
        err instanceof Error ? err.message : 'Could not initialize voice session.';
      this.setPhase('error');
      this.callbacks.onError(msg, true);
      return;
    }

    // 3. Connect to Gemini Live Audio API with automatic fallback model
    const modelsToTry = [
      tokenData.model,
      ...(tokenData.fallbackModel && tokenData.fallbackModel !== tokenData.model
        ? [tokenData.fallbackModel]
        : []),
    ];

    let connectedModel: string | null = null;
    let lastError = 'Could not connect to Gemini Live Audio.';

    for (const model of modelsToTry) {
      if (this.closed) return;
      try {
        await this.connectLiveModel(tokenData.token, model);
        connectedModel = model;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    if (!connectedModel || this.closed) {
      this.cleanupAudio();
      this.setPhase('error');
      this.callbacks.onError(
        `${lastError} — You can still use typed multilingual commands below.`,
        true
      );
      return;
    }

    this.callbacks.onModelConnected(connectedModel, this.voiceName);
    this.startMicStreaming();
    this.sendCanvasFrameIfReady(true);
    this.setPhase('listening');
  }

  private buildCurrentContextJson(): string {
    const store = useSceneStore.getState();
    return formatGroundedRoomContext({
      scene: store.scene,
      selectedId: store.selectedId,
      cameraBasis: getCameraBasis(),
      activePreview: store.voicePreview,
      preferredLanguage: this.preferredLanguage,
      canUndo: store.undoStack.length > 0,
      layoutOptions: store.layoutOptions.map((o) => ({
        index: o.index,
        name: o.name,
        tradeoff: o.tradeoff,
        metricsSummary: o.metricsSummary,
      })),
      proactiveSuggestion: store.proactiveSuggestion
        ? {
            title: store.proactiveSuggestion.title,
            spokenPrompt: store.proactiveSuggestion.spokenPrompt,
            objectId: store.proactiveSuggestion.objectId,
            targetLabel: store.proactiveSuggestion.targetLabel,
          }
        : null,
    });
  }

  private async connectLiveModel(
    ephemeralToken: string,
    model: string
  ): Promise<void> {
    const initialContext = this.buildCurrentContextJson();

    const ai = new GoogleGenAI({
      apiKey: ephemeralToken,
      httpOptions: { apiVersion: 'v1alpha' },
    });

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Timed out connecting to ${model}.`));
        }
      }, 10_000);

      ai.live
        .connect({
          model,
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: this.voiceName,
                },
              },
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            systemInstruction: buildVoiceSystemInstruction(initialContext),
            tools: [{ functionDeclarations: LIVE_FUNCTION_DECLARATIONS }],
          },
          callbacks: {
            onopen: () => {},
            onmessage: (msg) => {
              if (msg.setupComplete && !settled) {
                settled = true;
                window.clearTimeout(timeout);
                resolve();
              }
              this.handleServerMessage(msg);
            },
            onerror: (ev) => {
              const message =
                ev && typeof ev === 'object' && 'message' in ev
                  ? String((ev as { message?: unknown }).message)
                  : 'Live audio WebSocket error';
              if (!settled) {
                settled = true;
                window.clearTimeout(timeout);
                reject(new Error(message));
              } else if (!this.closed) {
                this.callbacks.onError(message, false);
              }
            },
            onclose: (ev) => {
              if (!settled) {
                settled = true;
                window.clearTimeout(timeout);
                reject(
                  new Error(
                    `Live session closed during setup (${ev?.code ?? 'unknown'} ${ev?.reason ?? ''}).`
                  )
                );
              } else if (!this.closed) {
                this.stop();
              }
            },
          },
        })
        .then((session) => {
          this.session = session;
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            window.clearTimeout(timeout);
            reject(err);
          }
        });
    });
  }

  private handleServerMessage(msg: LiveServerMessage): void {
    if (this.closed) return;

    // Interruption / barge-in signal from Gemini Live VAD
    if (msg.serverContent?.interrupted) {
      this.stopPlayback();
      useSceneStore.getState().bumpEditEpoch();
      this.assistantTranscriptBuffer = '';
      this.setPhase('listening');
    }

    // Input audio transcription (what the user said)
    if (msg.serverContent?.inputTranscription?.text) {
      const chunk = msg.serverContent.inputTranscription.text;
      this.userTranscriptBuffer += chunk;
      this.callbacks.onUserTranscript(this.userTranscriptBuffer.trim(), false);
      this.sendCanvasFrameIfReady(false);
    }

    // Output audio transcription (what the room is saying)
    if (msg.serverContent?.outputTranscription?.text) {
      const chunk = msg.serverContent.outputTranscription.text;
      this.assistantTranscriptBuffer += chunk;
      this.callbacks.onAssistantTranscript(
        this.assistantTranscriptBuffer.trim(),
        false
      );
    }

    // Streamed 24 kHz PCM audio parts
    if (msg.serverContent?.modelTurn?.parts) {
      for (const part of msg.serverContent.modelTurn.parts) {
        const mime = part.inlineData?.mimeType ?? '';
        const data = part.inlineData?.data;
        if (data && mime.startsWith('audio/')) {
          this.setPhase('speaking');
          this.enqueuePcm24k(data);
        }
      }
    }

    // Typed tool calls from Gemini Live (async to support live Shopify browsing & ordering)
    if (msg.toolCall?.functionCalls && msg.toolCall.functionCalls.length > 0) {
      this.setPhase('thinking');
      const capturedEpoch = useSceneStore.getState().editEpoch;
      const calls = msg.toolCall.functionCalls;
      void (async () => {
        const functionResponses = await Promise.all(
          calls.map(async (fc) => {
            const action = mapToolCallToVoiceAction(
              fc.name ?? '',
              (fc.args as Record<string, unknown> | undefined) ?? {}
            );

            let result: ActionExecutionResult;
            if (!action) {
              result = {
                ok: false,
                actionType: 'select_object',
                summary: `Unsupported or malformed tool arguments for ${fc.name}.`,
              };
            } else {
              result = await executeVoiceActionAsync(action, capturedEpoch);
              if (result.updatedPreferredLanguage) {
                this.preferredLanguage = result.updatedPreferredLanguage;
                this.callbacks.onPreferredLanguageChange(
                  result.updatedPreferredLanguage
                );
              }
              this.callbacks.onActionResult(result);
            }

            return {
              id: fc.id,
              name: fc.name,
              response: result as unknown as Record<string, unknown>,
            };
          })
        );

        if (this.closed) return;
        try {
          this.session?.sendToolResponse({ functionResponses });
        } catch {
          // Ignore if session closed mid-turn
        }
      })();
    }

    if (msg.serverContent?.turnComplete) {
      if (this.userTranscriptBuffer.trim()) {
        this.callbacks.onUserTranscript(this.userTranscriptBuffer.trim(), true);
        this.userTranscriptBuffer = '';
      }
      if (this.assistantTranscriptBuffer.trim()) {
        this.callbacks.onAssistantTranscript(
          this.assistantTranscriptBuffer.trim(),
          true
        );
        this.assistantTranscriptBuffer = '';
      }
      if (this.activeSources.size === 0) {
        this.setPhase('listening');
      }
    }
  }

  private startMicStreaming(): void {
    if (!this.mediaStream) return;

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    this.micContext = new AudioCtx();
    const source = this.micContext.createMediaStreamSource(this.mediaStream);
    const processor = this.micContext.createScriptProcessor(4096, 1, 1);
    this.micProcessor = processor;

    processor.onaudioprocess = (ev) => {
      if (this.closed || !this.session) return;
      const input = ev.inputBuffer.getChannelData(0);

      // Compute RMS level for live listening meter
      let sumSq = 0;
      for (let i = 0; i < input.length; i += 1) {
        sumSq += input[i] * input[i];
      }
      const rms = Math.sqrt(sumSq / input.length);
      this.callbacks.onMicLevel(Math.min(1, rms * 6));

      const pcm16 = float32ToInt16Downsampled(
        input,
        this.micContext?.sampleRate ?? 48000,
        16000
      );
      const base64 = bytesToBase64(
        new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength)
      );

      try {
        this.session.sendRealtimeInput({
          audio: {
            data: base64,
            mimeType: 'audio/pcm;rate=16000',
          },
        });
      } catch {
        // Ignore transient write errors on teardown
      }
    };

    source.connect(processor);
    // Route through zero-gain node to keep ScriptProcessor ticking without echo
    const silentGain = this.micContext.createGain();
    silentGain.gain.value = 0;
    processor.connect(silentGain);
    silentGain.connect(this.micContext.destination);
  }

  private enqueuePcm24k(base64: string): void {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!this.playbackContext) {
      this.playbackContext = new AudioCtx({ sampleRate: 24000 });
    }
    if (this.playbackContext.state === 'suspended') {
      void this.playbackContext.resume();
    }

    const int16 = base64ToInt16(base64);
    if (int16.length === 0) return;

    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i += 1) {
      float32[i] = int16[i] / 32768;
    }

    const buffer = this.playbackContext.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);

    const src = this.playbackContext.createBufferSource();
    src.buffer = buffer;
    src.connect(this.playbackContext.destination);

    const now = this.playbackContext.currentTime;
    const startAt = Math.max(now + 0.015, this.nextPlayTime);
    this.nextPlayTime = startAt + buffer.duration;

    this.activeSources.add(src);
    src.onended = () => {
      this.activeSources.delete(src);
      if (this.activeSources.size === 0 && !this.closed && this.phase === 'speaking') {
        this.setPhase('listening');
      }
    };

    src.start(startAt);
  }

  /**
   * Immediately halts any queued AI speech and bumps the editEpoch so stale
   * in-flight tool responses cannot move the wrong object.
   */
  public interruptSpeech(): void {
    this.stopPlayback();
    useSceneStore.getState().bumpEditEpoch();
    if (!this.closed && this.session) {
      this.setPhase('listening');
    }
  }

  private stopPlayback(): void {
    for (const src of this.activeSources) {
      try {
        src.stop();
      } catch {
        // Already stopped
      }
    }
    this.activeSources.clear();
    if (this.playbackContext) {
      this.nextPlayTime = this.playbackContext.currentTime;
    }
  }

  /**
   * Sends a silent room-state update whenever selection, manual drag, or
   * preview state changes while a live session is active.
   */
  public syncRoomContext(): void {
    if (this.closed || !this.session) return;
    const ctxJson = this.buildCurrentContextJson();

    try {
      this.session.sendClientContent({
        turns: `[LIVE ROOM CONTEXT UPDATE]\n${ctxJson}`,
        turnComplete: false,
      });
    } catch {
      // Ignore if closing
    }
  }

  /**
   * Speaks a validated proactive suggestion aloud ONLY when the user has
   * finished dragging/speaking (phase === 'listening' and no active speech).
   */
  public announceProactiveSuggestion(spokenPrompt: string): boolean {
    if (this.closed || !this.session) return false;
    if (this.phase !== 'listening' || this.activeSources.size > 0) {
      return false;
    }
    this.syncRoomContext();
    try {
      this.session.sendClientContent({
        turns: `[PROACTIVE ROOM OBSERVATION] Briefly share this validated suggestion aloud in the user's current language (1-2 short warm sentences, ending by asking if they want to see it): ${spokenPrompt}`,
        turnComplete: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sends a fresh JPEG frame of the 3D canvas (throttled to every 2.5s) to
   * ground visual references like "this one" or "on my left".
   */
  public sendCanvasFrameIfReady(force: boolean): void {
    if (this.closed || !this.session) return;
    const now = Date.now();
    if (!force && now - this.lastFrameSentAt < 2500) return;

    const jpeg = captureCanvasFrameBase64();
    if (!jpeg) return;
    this.lastFrameSentAt = now;

    try {
      this.session.sendRealtimeInput({
        video: {
          data: jpeg,
          mimeType: 'image/jpeg',
        },
      });
    } catch {
      // Ignore if closing
    }
  }

  /**
   * Allows sending a typed turn directly into the active live session too!
   */
  public sendTextTurn(text: string): void {
    if (this.closed || !this.session) return;
    this.stopPlayback();
    this.syncRoomContext();
    this.sendCanvasFrameIfReady(true);
    this.setPhase('thinking');
    try {
      this.session.sendClientContent({
        turns: text,
        turnComplete: true,
      });
    } catch {
      // Ignore
    }
  }

  private cleanupAudio(): void {
    this.stopPlayback();
    if (this.micProcessor) {
      try {
        this.micProcessor.disconnect();
      } catch {
        // Ignore
      }
      this.micProcessor = null;
    }
    if (this.micContext) {
      void this.micContext.close().catch(() => {});
      this.micContext = null;
    }
    if (this.playbackContext) {
      void this.playbackContext.close().catch(() => {});
      this.playbackContext = null;
    }
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }
    this.callbacks.onMicLevel(0);
  }

  public stop(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.session?.close();
    } catch {
      // Ignore
    }
    this.session = null;
    this.cleanupAudio();
    this.setPhase('idle');
    this.callbacks.onClose();
  }
}
