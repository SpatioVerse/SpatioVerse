'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Keyboard,
  LayoutGrid,
  Loader2,
  Mic,
  MicOff,
  Pause,
  Send,
  Sparkles,
  Square,
  Undo2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  captureCanvasFrameBase64,
  getCameraBasis,
} from '@/lib/cameraBridge';
import type { LayoutOption } from '@/lib/layoutSuggestions';
import type { ShopScene } from '@/lib/schema';
import type { VoiceCommandResponse } from '@/lib/voiceActions';
import {
  executeVoiceActionAsync,
  type ActionExecutionResult,
} from '@/lib/voiceExecutor';
import {
  VoiceLiveClient,
  type VoiceSessionPhase,
} from '@/lib/voiceLiveClient';
import { useSceneStore } from '@/store/useSceneStore';

interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

function LayoutThumbnail({
  scene,
  option,
}: {
  scene: ShopScene;
  option: LayoutOption;
}) {
  const w = 52;
  const h = 42;
  const pad = 4;
  const rw = Math.max(0.1, scene.room.width);
  const rd = Math.max(0.1, scene.room.depth);
  const scale = Math.min((w - pad * 2) / rw, (h - pad * 2) / rd);
  const boxW = rw * scale;
  const boxH = rd * scale;
  const ox = (w - boxW) / 2;
  const oy = (h - boxH) / 2;

  const toX = (x: number) => ox + (x + rw / 2) * scale;
  const toY = (z: number) => oy + (z + rd / 2) * scale;
  const movedSet = new Set(option.movedObjectIds);

  const { entrance } = scene.room;
  const halfDoor = (entrance.width / 2) * scale;
  let door = { x1: ox, y1: oy + boxH, x2: ox + boxW, y2: oy + boxH };
  if (entrance.wall === 'south') {
    const cx = toX(entrance.offset);
    door = { x1: cx - halfDoor, y1: oy + boxH, x2: cx + halfDoor, y2: oy + boxH };
  } else if (entrance.wall === 'north') {
    const cx = toX(entrance.offset);
    door = { x1: cx - halfDoor, y1: oy, x2: cx + halfDoor, y2: oy };
  } else if (entrance.wall === 'east') {
    const cy = toY(entrance.offset);
    door = { x1: ox + boxW, y1: cy - halfDoor, x2: ox + boxW, y2: cy + halfDoor };
  } else {
    const cy = toY(entrance.offset);
    door = { x1: ox, y1: cy - halfDoor, x2: ox, y2: cy + halfDoor };
  }

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="shrink-0 rounded-lg border border-white/10 bg-black/50"
      aria-hidden="true"
    >
      <rect
        x={ox}
        y={oy}
        width={boxW}
        height={boxH}
        fill="rgba(255,255,255,0.04)"
        stroke="rgba(255,255,255,0.25)"
        strokeWidth={0.8}
        rx={1.5}
      />
      <line
        x1={door.x1}
        y1={door.y1}
        x2={door.x2}
        y2={door.y2}
        stroke="#34d399"
        strokeWidth={2}
        strokeLinecap="round"
      />
      {scene.objects.map((obj) => {
        const pose = option.poses[obj.id] ?? {
          position: obj.position,
          rotationY: obj.rotationY,
        };
        const cx = toX(pose.position[0]);
        const cy = toY(pose.position[2]);
        const fw = Math.max(3, obj.size[0] * scale);
        const fd = Math.max(3, obj.size[2] * scale);
        const deg = (-pose.rotationY * 180) / Math.PI;
        const isMoved = movedSet.has(obj.id);
        return (
          <rect
            key={obj.id}
            x={cx - fw / 2}
            y={cy - fd / 2}
            width={fw}
            height={fd}
            transform={`rotate(${deg} ${cx} ${cy})`}
            fill={isMoved ? 'rgba(56,189,248,0.85)' : 'rgba(255,255,255,0.38)'}
            rx={0.8}
          />
        );
      })}
    </svg>
  );
}

export interface VoiceRoomControlProps {
  /** Horizontal offset in px when the right-hand Shop/Inspect drawer is open so they never overlap */
  rightOffsetPx?: number;
}

export function VoiceRoomControl({ rightOffsetPx = 0 }: VoiceRoomControlProps = {}) {
  const scene = useSceneStore((state) => state.scene);
  const selectedId = useSceneStore((state) => state.selectedId);
  const isDragging = useSceneStore((state) => state.isDragging);
  const voicePreview = useSceneStore((state) => state.voicePreview);
  const voiceHighlightIds = useSceneStore((state) => state.voiceHighlightIds);
  const layoutOptions = useSceneStore((state) => state.layoutOptions);
  const proactiveSuggestion = useSceneStore((state) => state.proactiveSuggestion);
  const proactiveTick = useSceneStore((state) => state.proactiveTick);
  const undoCount = useSceneStore((state) => state.undoStack.length);
  const draftedDesignPrompt = useSceneStore((state) => state.draftedDesignPrompt);
  const isRenderingPrompt = useSceneStore((state) => state.isRenderingPrompt);
  const setDraftedDesignPrompt = useSceneStore(
    (state) => state.setDraftedDesignPrompt
  );

  const freezeVoicePreview = useSceneStore((state) => state.freezeVoicePreview);
  const previewSuggestedAlternative = useSceneStore(
    (state) => state.previewSuggestedAlternative
  );
  const commitVoicePreview = useSceneStore((state) => state.commitVoicePreview);
  const cancelVoicePreview = useSceneStore((state) => state.cancelVoicePreview);
  const generateLayoutOptions = useSceneStore(
    (state) => state.generateLayoutOptions
  );
  const previewLayoutOption = useSceneStore((state) => state.previewLayoutOption);
  const clearLayoutOptions = useSceneStore((state) => state.clearLayoutOptions);
  const previewProactiveSuggestion = useSceneStore(
    (state) => state.previewProactiveSuggestion
  );
  const dismissProactiveSuggestion = useSceneStore(
    (state) => state.dismissProactiveSuggestion
  );
  const undo = useSceneStore((state) => state.undo);

  const clientRef = useRef<VoiceLiveClient | null>(null);
  const lastAnnouncedTickRef = useRef<number>(0);
  const [phase, setPhase] = useState<VoiceSessionPhase>('idle');
  const [micLevel, setMicLevel] = useState(0);
  const [connectedModel, setConnectedModel] = useState<string | null>(null);
  const [activeVoiceName, setActiveVoiceName] = useState<string>('Sulafat');
  const [preferredLanguage, setPreferredLanguage] = useState<string | null>(null);
  const [userHeard, setUserHeard] = useState<string>('');
  const [roomReply, setRoomReply] = useState<string>('');
  const [lastActionNote, setLastActionNote] = useState<string>('');
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [showTypedBox, setShowTypedBox] = useState(false);
  const [typedInput, setTypedInput] = useState('');
  const [typedPending, setTypedPending] = useState(false);
  const [history, setHistory] = useState<ChatTurn[]>([]);

  const isSessionActive =
    phase === 'connecting' ||
    phase === 'listening' ||
    phase === 'thinking' ||
    phase === 'speaking';

  // Sync manual selection/drag/preview/layout changes to active live session
  useEffect(() => {
    if (!isSessionActive || !clientRef.current) return;
    if (isDragging) {
      clientRef.current.interruptSpeech();
    }
    clientRef.current.syncRoomContext();
  }, [
    isSessionActive,
    selectedId,
    isDragging,
    voicePreview,
    layoutOptions,
    proactiveSuggestion,
  ]);

  // Speak proactive suggestion aloud ONLY after user finishes dragging & speaking
  useEffect(() => {
    if (
      !proactiveSuggestion ||
      proactiveTick === 0 ||
      proactiveTick === lastAnnouncedTickRef.current ||
      isDragging
    ) {
      return;
    }

    if (isSessionActive && clientRef.current && phase === 'listening') {
      const prompt = proactiveSuggestion.spokenPrompt;
      const tickSnapshot = proactiveTick;
      const timer = window.setTimeout(() => {
        if (
          !useSceneStore.getState().isDragging &&
          clientRef.current?.announceProactiveSuggestion(prompt)
        ) {
          lastAnnouncedTickRef.current = tickSnapshot;
        }
      }, 350);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [proactiveSuggestion, proactiveTick, isDragging, isSessionActive, phase]);

  // Global Cmd+Z / Ctrl+Z undo shortcut when not typing inside an input
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'z' && !ev.shiftKey) {
        if (useSceneStore.getState().undoStack.length > 0) {
          ev.preventDefault();
          useSceneStore.getState().undo();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Clean teardown on unmount
  useEffect(() => {
    return () => {
      clientRef.current?.stop();
      clientRef.current = null;
    };
  }, []);

  const handleActionFeedback = useCallback((result: ActionExecutionResult) => {
    if (result.stale) return;
    setLastActionNote(result.summary);
  }, []);

  const startLiveSession = useCallback(async () => {
    setErrorBanner(null);
    setLastActionNote('');

    const client = new VoiceLiveClient(
      {
        onPhaseChange: (nextPhase) => setPhase(nextPhase),
        onUserTranscript: (text, isFinal) => {
          setUserHeard(text);
          if (isFinal && text) {
            setHistory((prev) => [...prev.slice(-10), { role: 'user', text }]);
          }
        },
        onAssistantTranscript: (text, isFinal) => {
          setRoomReply(text);
          if (isFinal && text) {
            setHistory((prev) => [
              ...prev.slice(-10),
              { role: 'assistant', text },
            ]);
          }
        },
        onActionResult: handleActionFeedback,
        onMicLevel: (lvl) => setMicLevel(lvl),
        onModelConnected: (model, voiceName) => {
          setConnectedModel(model);
          setActiveVoiceName(voiceName);
        },
        onPreferredLanguageChange: (lang) => setPreferredLanguage(lang),
        onError: (message, fallbackToText) => {
          setErrorBanner(message);
          if (fallbackToText) {
            setShowTypedBox(true);
          }
        },
        onClose: () => {
          setConnectedModel(null);
          setMicLevel(0);
        },
      },
      preferredLanguage
    );

    clientRef.current = client;
    await client.start();
  }, [handleActionFeedback, preferredLanguage]);

  const stopLiveSession = useCallback(() => {
    clientRef.current?.stop();
    clientRef.current = null;
    setPhase('idle');
    setMicLevel(0);
  }, []);

  const interruptSpeech = useCallback(() => {
    clientRef.current?.interruptSpeech();
  }, []);

  const submitTypedCommand = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      const text = typedInput.trim();
      if (!text || typedPending) return;

      setTypedInput('');
      setUserHeard(text);
      setErrorBanner(null);

      // If a live audio session is active, send directly through the live session
      if (isSessionActive && clientRef.current) {
        setHistory((prev) => [...prev.slice(-10), { role: 'user', text }]);
        clientRef.current.sendTextTurn(text);
        return;
      }

      // Otherwise use our server-side multilingual typed command route
      const store = useSceneStore.getState();
      const capturedEpoch = store.editEpoch;
      setTypedPending(true);
      setPhase('thinking');

      try {
        const frame = captureCanvasFrameBase64();
        const res = await fetch('/api/voice/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            scene: store.scene,
            selectedId: store.selectedId,
            cameraBasis: getCameraBasis(),
            activePreview: store.voicePreview,
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
            canUndo: store.undoStack.length > 0,
            preferredLanguage,
            history: history.slice(-8),
            canvasFrameBase64: frame ?? undefined,
          }),
        });

        const data = (await res.json()) as VoiceCommandResponse & {
          error?: { message?: string };
        };

        if (!res.ok) {
          throw new Error(
            data.error?.message || `Command request failed (HTTP ${res.status}).`
          );
        }

        // Discard stale response if user dragged/interrupted while waiting
        if (useSceneStore.getState().editEpoch !== capturedEpoch) {
          setLastActionNote('Ignored stale response after manual edit.');
          setPhase('idle');
          return;
        }

        if (data.updatedPreferredLanguage) {
          setPreferredLanguage(data.updatedPreferredLanguage);
        }

        let lastResult: ActionExecutionResult | null = null;
        for (const action of data.actions ?? []) {
          const result = await executeVoiceActionAsync(action, capturedEpoch);
          if (result.updatedPreferredLanguage) {
            setPreferredLanguage(result.updatedPreferredLanguage);
          }
          lastResult = result;
          handleActionFeedback(result);
        }

        let finalReply = data.replyText;
        if (
          lastResult &&
          lastResult.valid === false &&
          lastResult.suggestedAlternative &&
          !finalReply.toLowerCase().includes('wall') &&
          !finalReply.includes('दीवार')
        ) {
          finalReply = `${finalReply} (${lastResult.suggestedAlternative.label}?)`;
        }

        setRoomReply(finalReply || lastResult?.summary || '');
        setHistory((prev) => [
          ...prev.slice(-10),
          { role: 'user', text },
          ...(finalReply ? [{ role: 'assistant' as const, text: finalReply }] : []),
        ]);
        setPhase('idle');
      } catch (err) {
        setErrorBanner(
          err instanceof Error ? err.message : 'Failed to process command.'
        );
        setPhase('idle');
      } finally {
        setTypedPending(false);
      }
    },
    [
      typedInput,
      typedPending,
      isSessionActive,
      preferredLanguage,
      history,
      handleActionFeedback,
    ]
  );

  const previewErrors =
    voicePreview?.issues.filter((i) => i.severity === 'error') ?? [];
  const previewTargetLabel = voicePreview
    ? scene.objects.find((o) => o.id === voicePreview.objectId)?.label ??
      voicePreview.objectId
    : null;

  const panelExpanded =
    isSessionActive ||
    Boolean(voicePreview) ||
    Boolean(draftedDesignPrompt) ||
    layoutOptions.length > 0 ||
    Boolean(proactiveSuggestion) ||
    voiceHighlightIds.length > 0 ||
    showTypedBox ||
    Boolean(errorBanner) ||
    Boolean(roomReply);

  return (
    <div
      style={rightOffsetPx > 0 ? { right: `${rightOffsetPx}px` } : undefined}
      className="pointer-events-none fixed bottom-14 right-3 z-30 flex flex-col items-end gap-2 transition-[right] duration-200 sm:bottom-4 sm:right-4"
    >
      {/* Live Understanding, Preview Controls & Multilingual Typed Bar */}
      {panelExpanded && (
        <div className="pointer-events-auto w-[320px] max-w-[92vw] overflow-hidden rounded-2xl border border-white/14 bg-zinc-950/88 text-zinc-100 shadow-[0_20px_60px_rgba(0,0,0,0.62)] backdrop-blur-xl">
          {/* Status Header */}
          <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`flex h-2.5 w-2.5 shrink-0 rounded-full ${
                  phase === 'listening'
                    ? 'animate-pulse bg-emerald-400 shadow-[0_0_10px_#34d399]'
                    : phase === 'speaking'
                      ? 'animate-pulse bg-sky-400 shadow-[0_0_10px_#38bdf8]'
                      : phase === 'thinking' || phase === 'connecting'
                        ? 'animate-pulse bg-amber-300'
                        : phase === 'error'
                          ? 'bg-red-400'
                          : 'bg-zinc-500'
                }`}
              />
              <span className="truncate text-[11px] font-semibold tracking-tight text-white">
                {phase === 'connecting'
                  ? 'Connecting live room…'
                  : phase === 'listening'
                    ? 'Listening (any language)'
                    : phase === 'thinking'
                      ? 'Updating 3D preview…'
                      : phase === 'speaking'
                        ? 'Room speaking…'
                        : 'Room Voice & Commands'}
              </span>
              {preferredLanguage && (
                <span className="shrink-0 rounded-md bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-200">
                  {preferredLanguage}
                </span>
              )}
            </div>

            <div className="flex items-center gap-1">
              {phase === 'speaking' && (
                <button
                  type="button"
                  onClick={interruptSpeech}
                  title="Interrupt speech"
                  className="flex cursor-pointer items-center gap-1 rounded-lg border border-sky-400/35 bg-sky-500/20 px-2 py-0.5 text-[10px] font-semibold text-sky-200 hover:bg-sky-500/30"
                >
                  <VolumeX className="h-3 w-3" />
                  <span>Interrupt</span>
                </button>
              )}
              {isSessionActive && (
                <button
                  type="button"
                  onClick={stopLiveSession}
                  title="Stop voice session"
                  className="flex cursor-pointer items-center gap-1 rounded-lg border border-red-400/35 bg-red-500/20 px-2 py-0.5 text-[10px] font-semibold text-red-200 hover:bg-red-500/30"
                >
                  <Square className="h-2.5 w-2.5 fill-current" />
                  <span>Stop</span>
                </button>
              )}
              {!isSessionActive && (
                <button
                  type="button"
                  onClick={() => {
                    setShowTypedBox(false);
                    setErrorBanner(null);
                    setRoomReply('');
                    setUserHeard('');
                    clearLayoutOptions();
                  }}
                  aria-label="Close voice panel"
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-lg text-zinc-400 hover:bg-white/10 hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          <div className="space-y-2.5 p-3">
            {/* Live Mic Level Bars when Listening */}
            {phase === 'listening' && (
              <div className="flex items-center gap-2 rounded-xl bg-white/[0.04] px-2.5 py-1.5">
                <div className="flex h-4 items-end gap-0.5">
                  {[0.25, 0.55, 0.85, 0.6, 0.3].map((weight, idx) => (
                    <span
                      key={idx}
                      className="w-1 rounded-full bg-emerald-400 transition-all duration-75"
                      style={{
                        height: `${Math.max(20, Math.min(100, Math.round(micLevel * weight * 130)))}%`,
                      }}
                    />
                  ))}
                </div>
                <span className="text-[11px] text-zinc-300">
                  Speak naturally in English, Hindi, or mixed…
                </span>
              </div>
            )}

            {/* Error / Fallback Notice */}
            {errorBanner && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-500/12 px-2.5 py-2 text-[11px] text-amber-100">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
                <span>{errorBanner}</span>
              </div>
            )}

            {/* What the Room Understood + Brief Reply */}
            {(userHeard || roomReply || lastActionNote) && (
              <div className="space-y-1.5 rounded-xl border border-white/8 bg-black/35 p-2.5 text-[11px]">
                {userHeard && (
                  <div className="text-zinc-300">
                    <span className="font-semibold text-zinc-400">Heard: </span>
                    <span className="text-white">&ldquo;{userHeard}&rdquo;</span>
                  </div>
                )}
                {roomReply && (
                  <div className="text-sky-200">
                    <span className="font-semibold text-sky-400">Room: </span>
                    <span>{roomReply}</span>
                  </div>
                )}
                {lastActionNote && (
                  <div className="text-[10px] text-zinc-400">
                    {lastActionNote}
                  </div>
                )}
              </div>
            )}

            {/* Ambiguous Reference Indicator */}
            {voiceHighlightIds.length > 1 && (
              <div className="rounded-xl border border-purple-400/35 bg-purple-500/15 px-2.5 py-2 text-[11px] text-purple-100">
                Highlighted {voiceHighlightIds.length} matching fixtures in
                violet — click one or specify which one.
              </div>
            )}

            {/* Drafted Design Prompt Card (Prompt-First Agent Step) */}
            {draftedDesignPrompt && (
              <div className="space-y-2 rounded-xl border border-amber-300/40 bg-amber-950/35 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-200">
                      <Sparkles className="h-3.5 w-3.5 shrink-0 text-amber-300" />
                      <span>
                        Drafted Prompt ({draftedDesignPrompt.mode})
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-snug text-zinc-100">
                      &ldquo;{draftedDesignPrompt.prompt}&rdquo;
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={isRenderingPrompt}
                    onClick={() => setDraftedDesignPrompt(null)}
                    aria-label="Dismiss drafted prompt"
                    className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-zinc-400 hover:bg-white/10 hover:text-white disabled:opacity-40"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={isRenderingPrompt}
                    onClick={() => {
                      void executeVoiceActionAsync({
                        type: 'render_from_prompt',
                      }).then((res) => {
                        setLastActionNote(res.summary);
                      });
                    }}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-amber-300 px-2.5 py-1 text-[11px] font-semibold text-zinc-950 hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isRenderingPrompt ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Check className="h-3 w-3" />
                    )}
                    <span>
                      {isRenderingPrompt ? 'Rendering…' : 'Render 3D'}
                    </span>
                  </button>
                  <button
                    type="button"
                    disabled={isRenderingPrompt}
                    onClick={() => setDraftedDesignPrompt(null)}
                    className="cursor-pointer rounded-lg border border-white/12 px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/10 disabled:opacity-40"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Proactive Room Improvement Suggestion Card */}
            {proactiveSuggestion && !voicePreview && (
              <div className="space-y-2 rounded-xl border border-emerald-400/35 bg-emerald-950/40 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-200">
                      <Sparkles className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
                      <span className="truncate">{proactiveSuggestion.title}</span>
                    </div>
                    <p className="mt-0.5 text-[10px] leading-snug text-zinc-200">
                      {proactiveSuggestion.spokenPrompt}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={dismissProactiveSuggestion}
                    aria-label="Dismiss suggestion"
                    className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-zinc-400 hover:bg-white/10 hover:text-white"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      const res = previewProactiveSuggestion();
                      if (res.applied) {
                        setLastActionNote(
                          res.preview?.lastActionSummary ?? 'Previewing suggestion'
                        );
                      }
                    }}
                    className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-emerald-400 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-950 transition-colors hover:bg-emerald-300"
                  >
                    <Sparkles className="h-3 w-3" />
                    <span>Preview suggestion</span>
                  </button>
                  <button
                    type="button"
                    onClick={dismissProactiveSuggestion}
                    className="cursor-pointer rounded-lg border border-white/15 bg-white/8 px-2.5 py-1.5 text-[11px] font-medium text-zinc-200 transition-colors hover:bg-white/15"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {/* Numbered Validated Layout Options with 2D Thumbnails */}
            {layoutOptions.length > 0 && (
              <div className="space-y-1.5 rounded-xl border border-white/10 bg-black/35 p-2">
                <div className="flex items-center justify-between px-0.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    Validated Layout Options ({layoutOptions.length})
                  </span>
                  <button
                    type="button"
                    onClick={clearLayoutOptions}
                    className="cursor-pointer text-[10px] text-zinc-400 hover:text-white"
                  >
                    Hide
                  </button>
                </div>
                <div className="space-y-1.5">
                  {layoutOptions.map((opt) => {
                    const isActive = voicePreview?.layoutOptionIndex === opt.index;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => {
                          const res = previewLayoutOption(opt.index);
                          if (res.applied) {
                            setLastActionNote(
                              res.preview?.lastActionSummary ??
                                `Previewing Option ${opt.index}`
                            );
                          }
                        }}
                        className={`flex w-full cursor-pointer items-start gap-2 rounded-xl border p-1.5 text-left transition-all ${
                          isActive
                            ? 'border-sky-400/60 bg-sky-500/18'
                            : 'border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.07]'
                        }`}
                      >
                        <LayoutThumbnail scene={scene} option={opt} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                                isActive
                                  ? 'bg-sky-400 text-zinc-950'
                                  : 'bg-white/15 text-white'
                              }`}
                            >
                              {opt.index}
                            </span>
                            <span className="truncate text-[11px] font-semibold text-white">
                              {opt.name}
                            </span>
                          </div>
                          <div className="mt-0.5 text-[9.5px] font-medium text-emerald-300/90">
                            {opt.metricsSummary}
                          </div>
                          <p className="mt-0.5 line-clamp-2 text-[9.5px] leading-snug text-zinc-400">
                            {opt.tradeoff}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Active Translucent Preview Controls (Stop / Alternative / Keep / Cancel) */}
            {voicePreview && (
              <div className="space-y-2 rounded-xl border border-sky-400/30 bg-sky-950/35 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-[11px] font-semibold text-white">
                      Preview: {previewTargetLabel}
                    </div>
                    <div className="text-[10px] text-zinc-300">
                      {voicePreview.frozen
                        ? 'Paused for inspection — not committed yet'
                        : voicePreview.lastActionSummary}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase ${
                      previewErrors.length > 0
                        ? 'bg-red-500/25 text-red-200'
                        : voicePreview.frozen
                          ? 'bg-amber-500/25 text-amber-200'
                          : 'bg-sky-500/25 text-sky-200'
                    }`}
                  >
                    {previewErrors.length > 0
                      ? 'Blocked'
                      : voicePreview.frozen
                        ? 'Paused'
                        : 'Preview'}
                  </span>
                </div>

                {previewErrors.length > 0 && (
                  <div className="flex items-start gap-1.5 rounded-lg border border-red-400/35 bg-red-500/15 px-2 py-1.5 text-[10px] text-red-100">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-red-300" />
                    <span>{previewErrors[0].message}</span>
                  </div>
                )}

                {voicePreview.suggestedAlternative && (
                  <button
                    type="button"
                    onClick={() => {
                      const res = previewSuggestedAlternative();
                      if (res.applied) {
                        setLastActionNote(
                          res.preview?.lastActionSummary ?? 'Previewed alternative'
                        );
                      }
                    }}
                    className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-emerald-400/40 bg-emerald-500/20 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-100 transition-colors hover:bg-emerald-500/30"
                  >
                    <Sparkles className="h-3.5 w-3.5 text-emerald-300" />
                    <span>
                      Preview Alternative: {voicePreview.suggestedAlternative.label}
                    </span>
                  </button>
                )}

                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    onClick={freezeVoicePreview}
                    disabled={voicePreview.frozen}
                    className="flex cursor-pointer items-center justify-center gap-1 rounded-lg border border-amber-400/30 bg-amber-500/15 px-2 py-1.5 text-[11px] font-medium text-amber-100 transition-colors hover:bg-amber-500/25 disabled:cursor-default disabled:opacity-50"
                  >
                    <Pause className="h-3 w-3" />
                    <span>{voicePreview.frozen ? 'Paused' : 'Stop'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={commitVoicePreview}
                    className="flex cursor-pointer items-center justify-center gap-1 rounded-lg bg-emerald-400 px-2 py-1.5 text-[11px] font-semibold text-zinc-950 transition-colors hover:bg-emerald-300"
                  >
                    <Check className="h-3.5 w-3.5 stroke-[2.5]" />
                    <span>Keep it</span>
                  </button>

                  <button
                    type="button"
                    onClick={cancelVoicePreview}
                    className="flex cursor-pointer items-center justify-center gap-1 rounded-lg border border-white/15 bg-white/8 px-2 py-1.5 text-[11px] font-medium text-zinc-200 transition-colors hover:bg-white/15"
                  >
                    <X className="h-3 w-3" />
                    <span>Cancel</span>
                  </button>
                </div>
              </div>
            )}

            {/* Multilingual Typed Command Box (always accessible + auto-shown when mic unavailable) */}
            {(showTypedBox || !isSessionActive) && (
              <form onSubmit={submitTypedCommand} className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={typedInput}
                  onChange={(e) => setTypedInput(e.target.value)}
                  placeholder="Type in any language… (e.g. थोड़ा left करो)"
                  disabled={typedPending}
                  className="min-w-0 flex-1 rounded-xl border border-white/12 bg-black/45 px-2.5 py-1.5 text-[11px] text-white placeholder-zinc-500 outline-none focus:border-sky-400/50"
                />
                <button
                  type="submit"
                  disabled={typedPending || !typedInput.trim()}
                  aria-label="Send room command"
                  className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-white text-zinc-950 transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {typedPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                </button>
              </form>
            )}

            {connectedModel && (
              <div className="flex items-center justify-between text-[9px] text-zinc-500">
                <span>
                  {connectedModel} · Voice: {activeVoiceName}
                </span>
                <span>Original stays visible until kept</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Primary On-Canvas Floating Controls: Undo + Typed Toggle + One-Tap "Talk to room" */}
      <div className="pointer-events-auto flex items-center gap-2">
        {undoCount > 0 && (
          <button
            type="button"
            onClick={() => undo()}
            title="Undo last committed edit (Ctrl/Cmd+Z)"
            className="flex cursor-pointer items-center gap-1.5 rounded-2xl border border-white/15 bg-zinc-950/82 px-3 py-2 text-xs font-medium text-zinc-100 shadow-[0_12px_36px_rgba(0,0,0,0.45)] backdrop-blur-xl transition-colors hover:bg-zinc-900"
          >
            <Undo2 className="h-3.5 w-3.5 text-amber-300" />
            <span>Undo</span>
            <span className="rounded-full bg-white/12 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-300">
              {undoCount}
            </span>
          </button>
        )}

        <button
          type="button"
          onClick={() => {
            const opts = generateLayoutOptions();
            if (opts.length > 0) {
              setLastActionNote(
                `Generated ${opts.length} validated layout option${opts.length === 1 ? '' : 's'}`
              );
            } else {
              setLastActionNote('No additional feasible layouts found.');
            }
          }}
          title="Suggest validated room layouts"
          aria-label="Suggest validated room layouts"
          className={`flex h-10 w-10 cursor-pointer items-center justify-center rounded-2xl border shadow-[0_12px_36px_rgba(0,0,0,0.45)] backdrop-blur-xl transition-colors ${
            layoutOptions.length > 0
              ? 'border-emerald-400/45 bg-emerald-500/20 text-emerald-200'
              : 'border-white/14 bg-zinc-950/82 text-zinc-300 hover:bg-zinc-900 hover:text-white'
          }`}
        >
          <LayoutGrid className="h-4 w-4" />
        </button>

        <button
          type="button"
          onClick={() => setShowTypedBox((v) => !v)}
          title="Type multilingual room commands"
          aria-label="Toggle typed room commands"
          className={`flex h-10 w-10 cursor-pointer items-center justify-center rounded-2xl border shadow-[0_12px_36px_rgba(0,0,0,0.45)] backdrop-blur-xl transition-colors ${
            showTypedBox
              ? 'border-sky-400/45 bg-sky-500/20 text-sky-200'
              : 'border-white/14 bg-zinc-950/82 text-zinc-300 hover:bg-zinc-900 hover:text-white'
          }`}
        >
          <Keyboard className="h-4 w-4" />
        </button>

        <button
          type="button"
          onClick={isSessionActive ? stopLiveSession : startLiveSession}
          className={`flex cursor-pointer items-center gap-2 rounded-2xl px-4 py-2.5 text-xs font-semibold shadow-[0_16px_45px_rgba(0,0,0,0.55)] transition-all active:scale-[0.98] ${
            isSessionActive
              ? 'border border-emerald-400/50 bg-emerald-500/25 text-emerald-100 backdrop-blur-xl hover:bg-emerald-500/35'
              : 'bg-gradient-to-r from-sky-400 via-emerald-300 to-amber-200 text-zinc-950 hover:brightness-105'
          }`}
        >
          {phase === 'connecting' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : isSessionActive ? (
            <MicOff className="h-4 w-4 text-emerald-200" />
          ) : (
            <Mic className="h-4 w-4 stroke-[2.25]" />
          )}
          <span>{isSessionActive ? 'Stop Listening' : 'Talk to room'}</span>
        </button>
      </div>
    </div>
  );
}
