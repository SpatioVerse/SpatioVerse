'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  CheckCircle2,
  Loader2,
  Mic,
  MicOff,
  Send,
  Sparkles,
  AlertTriangle,
} from 'lucide-react';
import { ShopSceneSchema, type ProductRef, type SceneObject } from '@/lib/schema';
import { useSceneStore } from '@/store/useSceneStore';

interface BrowserSpeechRecognitionEvent {
  results: {
    [index: number]: {
      [index: number]: { transcript: string };
      isFinal?: boolean;
    };
    length: number;
  };
}

interface BrowserSpeechRecognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionCtor = new () => BrowserSpeechRecognition;

const QUICK_MOCKUP_SWAPS = [
  { label: 'Cream Linen Sofa', command: 'Replace with a cream linen lounge sofa' },
  { label: 'Olive Accent Chair', command: 'Replace with an olive velvet accent chair' },
  { label: 'Walnut Wardrobe', command: 'Replace with a walnut wooden wardrobe cabinet' },
  { label: 'Oak Display Shelf', command: 'Replace with a tall oak wooden display shelf' },
  { label: 'Marble Coffee Table', command: 'Replace with a modern coffee table' },
  { label: 'Floor Mirror', command: 'Replace with a standing boutique mirror' },
] as const;

export interface ReplaceObjectBarProps {
  selectedObject: SceneObject | null;
}

/**
 * Reusable helper ready for the upcoming Shop Products panel:
 * pass any clicked Shopify ProductRef to generate & swap in a matching 3D GLB mockup.
 */
export async function applyProductMockupReplacement(params: {
  product: ProductRef;
  targetObjectId?: string | null;
}): Promise<{ ok: boolean; explanation?: string; error?: string }> {
  const { scene, setScene, selectObject } = useSceneStore.getState();
  const res = await fetch('/api/replace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: `Replace with ${params.product.title}`,
      scene,
      selectedObjectId: params.targetObjectId ?? null,
      replacementProduct: {
        title: params.product.title,
        product: params.product,
      },
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    return {
      ok: false,
      error: data?.error?.message || `Replacement failed (HTTP ${res.status}).`,
    };
  }

  const parsed = ShopSceneSchema.safeParse(data?.scene);
  if (!parsed.success) {
    return { ok: false, error: 'Returned 3D scene failed schema validation.' };
  }

  setScene(parsed.data);
  if (typeof data?.targetObjectId === 'string') {
    selectObject(data.targetObjectId);
  }
  return { ok: true, explanation: data?.explanation };
}

export function ReplaceObjectBar({ selectedObject }: ReplaceObjectBarProps) {
  const scene = useSceneStore((state) => state.scene);
  const setScene = useSceneStore((state) => state.setScene);
  const selectObject = useSceneStore((state) => state.selectObject);

  const [command, setCommand] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: 'emerald' | 'red';
    message: string;
  } | null>(null);

  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);

  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.stop();
      } catch {
        // Ignore stop errors on unmount
      }
    };
  }, []);

  const submitCommand = useCallback(
    async (rawText: string) => {
      const trimmed = rawText.trim();
      if (!trimmed || isSubmitting) return;

      setIsSubmitting(true);
      setFeedback(null);

      try {
        const res = await fetch('/api/replace', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            command: trimmed,
            scene,
            selectedObjectId: selectedObject?.id ?? null,
          }),
        });

        const data = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(
            data?.error?.message || `Replace request failed (HTTP ${res.status}).`
          );
        }

        const parsed = ShopSceneSchema.safeParse(data?.scene);
        if (!parsed.success) {
          throw new Error('Updated scene did not match ShopSceneSchema.');
        }

        setScene(parsed.data);
        if (typeof data?.targetObjectId === 'string') {
          selectObject(data.targetObjectId);
        }
        setCommand('');
        setFeedback({
          tone: 'emerald',
          message:
            typeof data?.explanation === 'string'
              ? data.explanation
              : '3D mockup updated.',
        });
      } catch (err) {
        setFeedback({
          tone: 'red',
          message:
            err instanceof Error
              ? err.message
              : 'Could not replace object. Please try again.',
        });
      } finally {
        setIsSubmitting(false);
      }
    },
    [isSubmitting, scene, selectedObject, selectObject, setScene]
  );

  const handleFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submitCommand(command);
  };

  const toggleVoiceInput = () => {
    if (isListening) {
      try {
        recognitionRef.current?.stop();
      } catch {
        // Ignore
      }
      setIsListening(false);
      return;
    }

    const win = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const Ctor = win.SpeechRecognition || win.webkitSpeechRecognition;

    if (!Ctor) {
      setFeedback({
        tone: 'red',
        message:
          'Voice recognition is not supported in this browser — type your replacement command instead.',
      });
      return;
    }

    try {
      const recognition = new Ctor();
      recognition.lang = 'en-US';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      recognition.onresult = (event) => {
        const transcript = event.results[0]?.[0]?.transcript?.trim();
        if (transcript) {
          setCommand(transcript);
          void submitCommand(transcript);
        }
      };

      recognition.onerror = (event) => {
        setIsListening(false);
        setFeedback({
          tone: 'red',
          message:
            event.error === 'not-allowed'
              ? 'Microphone permission denied. Allow mic access or type your command.'
              : `Voice capture error (${event.error}). Try typing instead.`,
        });
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
      setFeedback(null);
      setIsListening(true);
      recognition.start();
    } catch {
      setIsListening(false);
      setFeedback({
        tone: 'red',
        message: 'Could not start voice capture. Type your command instead.',
      });
    }
  };

  return (
    <div className="pointer-events-auto flex w-full max-w-xl flex-col gap-1.5 rounded-2xl border border-white/14 bg-zinc-950/86 px-3 py-2 text-zinc-100 shadow-[0_14px_45px_rgba(0,0,0,0.58)] backdrop-blur-xl">
      <form onSubmit={handleFormSubmit} className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 shrink-0 text-amber-300" />
        <input
          type="text"
          value={command}
          disabled={isSubmitting}
          onChange={(e) => setCommand(e.target.value)}
          placeholder={
            selectedObject
              ? `Replace "${selectedObject.label}" (type or speak)…`
              : 'Type or speak: "Replace the sofa with a cream linen sofa"…'
          }
          className="min-w-0 flex-1 bg-transparent text-xs text-white placeholder:text-zinc-400 focus:outline-none"
        />

        <button
          type="button"
          onClick={toggleVoiceInput}
          disabled={isSubmitting}
          title={isListening ? 'Stop voice input' : 'Speak replacement command'}
          aria-label={isListening ? 'Stop voice input' : 'Speak replacement command'}
          className={`flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-xl transition-colors ${
            isListening
              ? 'animate-pulse bg-red-500 text-white'
              : 'bg-white/8 text-zinc-200 hover:bg-white/15 hover:text-white'
          }`}
        >
          {isListening ? (
            <MicOff className="h-3.5 w-3.5" />
          ) : (
            <Mic className="h-3.5 w-3.5" />
          )}
        </button>

        <button
          type="submit"
          disabled={isSubmitting || !command.trim()}
          className="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-xl bg-gradient-to-r from-amber-300 to-emerald-300 px-2.5 text-[11px] font-semibold text-zinc-950 transition-all hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {isSubmitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3 w-3" />
          )}
          <span>{isSubmitting ? 'Swapping…' : 'Swap'}</span>
        </button>
      </form>

      {/* Quick 3D Mockup Swap Presets (also previews Shop Products click-to-swap flow) */}
      {selectedObject && (
        <div className="flex flex-wrap items-center gap-1 border-t border-white/8 pt-1.5">
          <span className="mr-1 text-[10px] font-medium text-zinc-400">
            Quick mockup:
          </span>
          {QUICK_MOCKUP_SWAPS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              disabled={isSubmitting}
              onClick={() => void submitCommand(preset.command)}
              className="cursor-pointer rounded-lg border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[10px] font-medium text-zinc-200 transition-colors hover:border-amber-300/40 hover:bg-amber-300/15 hover:text-white disabled:opacity-45"
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}

      {feedback && (
        <div
          className={`flex items-center gap-1.5 text-[11px] ${
            feedback.tone === 'emerald' ? 'text-emerald-300' : 'text-red-300'
          }`}
        >
          {feedback.tone === 'emerald' ? (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="truncate">{feedback.message}</span>
        </div>
      )}
    </div>
  );
}
