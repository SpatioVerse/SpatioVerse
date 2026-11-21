"use client";

/**
 * SpaceStage — SetupWizard (Client Component)
 *
 * Matches `TEAM_INTEGRATION.md` Section 3 (`SetupWizardProps`):
 *   - Accepts `initialScene`, `onScenePlanned(scene)`, and optional `onClose`.
 *   - Uses `@/lib/schema` (`FT_TO_METERS`, `RoomWall`, `SceneObjectKind`, `ShopScene`, `ShopSceneSchema`).
 *   - Sends `POST /api/analyze` with exact `FormData` fields from `TEAM_INTEGRATION.md`,
 *     then calls `POST /api/plan` and validates the returned scene via `ShopSceneSchema`.
 *
 * Example integration in `app/page.tsx`:
 * ```tsx
 * <SetupWizard
 *   initialScene={scene}
 *   onScenePlanned={(nextScene) => setScene(nextScene)}
 *   onClose={() => setWizardOpen(false)}
 * />
 * ```
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FT_TO_METERS,
  ShopSceneSchema,
  type RoomWall,
  type SceneObject,
  type SceneObjectKind,
  type ShopScene,
} from "@/lib/schema";

const MAX_RECORDING_SECONDS = 20;
const RECOMMENDED_MIN_SECONDS = 10;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB client-side guard
const ACCEPTED_MEDIA_TYPES = "image/jpeg,image/png,video/mp4,video/webm";

const VALID_KINDS: SceneObjectKind[] = [
  "shelf",
  "counter",
  "table",
  "rack",
  "lamp",
  "plant",
  "art",
];

const SHOP_TYPE_OPTIONS = [
  "Boutique Apparel",
  "Pop-Up / Market Stall",
  "Home Goods & Decor",
  "Beauty & Skincare",
  "Bookshop / Stationery",
  "Coffee & Concept Shop",
] as const;

const STYLE_OPTIONS = [
  "Warm Minimalist",
  "Modern Industrial",
  "Scandinavian Wood",
  "Editorial Gallery",
  "Botanical & Natural",
] as const;

const ENTRANCE_WALLS: RoomWall[] = ["north", "south", "east", "west"];

export interface DetectedObservation {
  id: string;
  label: string;
  kind: SceneObjectKind;
  owned: boolean;
  exclude: boolean;
  dimensionsVerified: boolean;
  widthMeters?: number;
  depthMeters?: number;
  heightMeters?: number;
}

export interface ConfirmedSetup {
  shopType: string;
  purpose: string;
  style: string;
  budgetCents: number;
  currency: string;
  noDrilling: boolean;
  room: ShopScene["room"] & { measurementsConfirmed: true };
  media: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    source: "camera" | "upload";
  } | null;
  observations: DetectedObservation[];
}

export interface SetupWizardProps {
  /** Baseline scene used to initialize defaults and preserve untouched properties. */
  initialScene: ShopScene;
  /** Called with a validated `ShopScene` once `/api/plan` (or manual fallback) completes. */
  onScenePlanned: (scene: ShopScene) => void;
  /** Optional close handler when mounted inside a modal/drawer. */
  onClose?: () => void;
  /** Optional callback receiving the structured setup payload before/alongside planning. */
  onComplete?: (confirmedSetup: ConfirmedSetup) => void;
  /** Optional controlled step index (1-4). */
  step?: 1 | 2 | 3 | 4;
  /** Optional callback when step changes. */
  onStepChange?: (step: 1 | 2 | 3 | 4) => void;
  /** Endpoint for Step 4 multipart analysis (defaults to "/api/analyze"). */
  analyzeEndpoint?: string;
  /** Endpoint for Step 4 scene planning (defaults to "/api/plan"). */
  planEndpoint?: string;
}

function feetToMeters(feet: number): number {
  return Number((feet * FT_TO_METERS).toFixed(4));
}

function metersToFeetInput(meters: number, fallback: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return String(fallback);
  return String(Number((meters / FT_TO_METERS).toFixed(1)));
}

function normalizeKind(raw: unknown): SceneObjectKind {
  if (typeof raw === "string") {
    const lower = raw.toLowerCase().trim();
    if ((VALID_KINDS as string[]).includes(lower)) {
      return lower as SceneObjectKind;
    }
    if (lower.includes("shelf") || lower.includes("bookcase")) return "shelf";
    if (lower.includes("counter") || lower.includes("desk")) return "counter";
    if (lower.includes("table")) return "table";
    if (lower.includes("rack") || lower.includes("garment")) return "rack";
    if (lower.includes("lamp") || lower.includes("light")) return "lamp";
    if (lower.includes("plant") || lower.includes("planter")) return "plant";
    if (lower.includes("art") || lower.includes("mirror") || lower.includes("frame")) return "art";
  }
  return "table";
}

function parseAnalyzeObservations(payload: unknown): DetectedObservation[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const rawList =
    (Array.isArray(record.observations) && record.observations) ||
    (Array.isArray(record.items) && record.items) ||
    (Array.isArray(record.objects) && record.objects) ||
    [];

  return rawList.map((item, idx) => {
    const obj = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const id =
      typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : `obs-${idx + 1}`;
    const label =
      typeof obj.label === "string" && obj.label.trim()
        ? obj.label.trim()
        : typeof obj.name === "string" && obj.name.trim()
          ? obj.name.trim()
          : `Detected item ${idx + 1}`;

    return {
      id,
      label,
      kind: normalizeKind(obj.kind ?? obj.category),
      owned: typeof obj.owned === "boolean" ? obj.owned : true,
      exclude: false,
      dimensionsVerified:
        typeof obj.dimensionsVerified === "boolean" ? obj.dimensionsVerified : false,
      widthMeters: typeof obj.widthMeters === "number" ? obj.widthMeters : undefined,
      depthMeters: typeof obj.depthMeters === "number" ? obj.depthMeters : undefined,
      heightMeters: typeof obj.heightMeters === "number" ? obj.heightMeters : undefined,
    };
  });
}

function buildFallbackScene(
  initialScene: ShopScene,
  setup: ConfirmedSetup,
  warningMsg: string
): ShopScene {
  const activeObs = setup.observations.filter((o) => !o.exclude);
  const ownedObjects: SceneObject[] = activeObs.map((obs, idx) => {
    const col = idx % 3;
    const row = Math.floor(idx / 3);
    const x = Number(((col - 1) * 0.9).toFixed(2));
    const z = Number((-setup.room.depth / 2 + 0.7 + row * 1.0).toFixed(2));
    return {
      id: obs.id,
      kind: obs.kind,
      label: obs.label,
      source: obs.owned ? "owned" : "proposal",
      position: [x, 0, z],
      size: [obs.widthMeters ?? 0.9, obs.heightMeters ?? 1.0, obs.depthMeters ?? 0.5],
      rotationY: 0,
      dimensionsVerified: obs.dimensionsVerified,
    };
  });

  return {
    ...initialScene,
    room: {
      width: setup.room.width,
      depth: setup.room.depth,
      height: setup.room.height,
      entrance: { ...setup.room.entrance },
    },
    purpose: setup.purpose,
    style: setup.style,
    budgetCents: setup.budgetCents,
    noDrilling: setup.noDrilling,
    objects: ownedObjects.length > 0 ? ownedObjects : initialScene.objects,
    warnings: Array.from(new Set([...initialScene.warnings, warningMsg])),
  };
}

export function SetupWizard({
  initialScene,
  onScenePlanned,
  onClose,
  onComplete,
  step: controlledStep,
  onStepChange,
  analyzeEndpoint = "/api/analyze",
  planEndpoint = "/api/plan",
}: SetupWizardProps) {
  const [internalStep, setInternalStep] = useState<1 | 2 | 3 | 4>(controlledStep ?? 1);
  const currentStep = controlledStep ?? internalStep;

  const goToStep = useCallback(
    (next: 1 | 2 | 3 | 4) => {
      if (controlledStep === undefined) {
        setInternalStep(next);
      }
      onStepChange?.(next);
    },
    [controlledStep, onStepChange]
  );

  // Step 1: Shop brief (default $400 = 40000 cents if initialScene has none)
  const [shopType, setShopType] = useState<string>(SHOP_TYPE_OPTIONS[0]);
  const [purpose, setPurpose] = useState<string>(
    initialScene.purpose || "Stage a welcoming retail layout with clear browsing flow"
  );
  const [style, setStyle] = useState<string>(initialScene.style || STYLE_OPTIONS[0]);
  const [budgetDollars, setBudgetDollars] = useState<string>(
    String(Math.round((initialScene.budgetCents || 40000) / 100))
  );
  const [noDrilling, setNoDrilling] = useState<boolean>(initialScene.noDrilling ?? true);

  const budgetCents = useMemo(() => {
    const parsed = Number(budgetDollars);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return Math.round(parsed * 100);
  }, [budgetDollars]);

  // Step 2: Room dimensions in feet (default 12 x 10 x 9) + centered entrance offset
  const [widthFeet, setWidthFeet] = useState<string>(
    metersToFeetInput(initialScene.room.width, 12)
  );
  const [depthFeet, setDepthFeet] = useState<string>(
    metersToFeetInput(initialScene.room.depth, 10)
  );
  const [heightFeet, setHeightFeet] = useState<string>(
    metersToFeetInput(initialScene.room.height, 9)
  );
  const [measurementsConfirmed, setMeasurementsConfirmed] = useState<boolean>(false);
  const [entranceWall, setEntranceWall] = useState<RoomWall>(
    initialScene.room.entrance.wall ?? "south"
  );
  const [entranceOffsetFeet, setEntranceOffsetFeet] = useState<string>(
    String(Number(((initialScene.room.entrance.offset ?? 0) / FT_TO_METERS).toFixed(1)))
  );
  const [entranceWidthFeet, setEntranceWidthFeet] = useState<string>(
    metersToFeetInput(initialScene.room.entrance.width, 3)
  );

  const roomMeters = useMemo(() => {
    const w = Math.max(1, Number(widthFeet) || 0);
    const d = Math.max(1, Number(depthFeet) || 0);
    const h = Math.max(1, Number(heightFeet) || 0);
    return {
      width: feetToMeters(w),
      depth: feetToMeters(d),
      height: feetToMeters(h),
    };
  }, [widthFeet, depthFeet, heightFeet]);

  const entranceMeters = useMemo(() => {
    const offset = Number(entranceOffsetFeet) || 0;
    const width = Math.max(1, Number(entranceWidthFeet) || 0);
    return {
      offset: feetToMeters(offset),
      width: feetToMeters(width),
    };
  }, [entranceOffsetFeet, entranceWidthFeet]);

  const entranceWallLengthFeet = useMemo(() => {
    const wallFeet =
      entranceWall === "north" || entranceWall === "south"
        ? Number(widthFeet) || 0
        : Number(depthFeet) || 0;
    return Math.max(0, wallFeet);
  }, [entranceWall, widthFeet, depthFeet]);

  // Per lib/schema.ts: entrance.offset is signed meters from center of wall (0 = centered)
  const entranceOutOfBounds = useMemo(() => {
    const offset = Number(entranceOffsetFeet);
    const doorway = Number(entranceWidthFeet);
    if (!Number.isFinite(offset) || !Number.isFinite(doorway) || doorway <= 0) return true;
    return Math.abs(offset) + doorway / 2 > entranceWallLengthFeet / 2;
  }, [entranceOffsetFeet, entranceWidthFeet, entranceWallLengthFeet]);

  // Step 3: MediaRecorder or file upload
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaSource, setMediaSource] = useState<"camera" | "upload" | null>(null);
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState<string | null>(null);
  const [cameraActive, setCameraActive] = useState<boolean>(false);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordingSeconds, setRecordingSeconds] = useState<number>(0);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const liveVideoRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopCameraStream = useCallback(() => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // Ignore stop errors during teardown
      }
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    if (liveVideoRef.current) {
      liveVideoRef.current.srcObject = null;
    }
    setCameraActive(false);
    setIsRecording(false);
  }, []);

  useEffect(() => {
    return () => {
      stopCameraStream();
    };
  }, [stopCameraStream]);

  useEffect(() => {
    return () => {
      if (mediaPreviewUrl) {
        URL.revokeObjectURL(mediaPreviewUrl);
      }
    };
  }, [mediaPreviewUrl]);

  const setCapturedFile = useCallback((file: File, source: "camera" | "upload") => {
    setMediaPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    setMediaFile(file);
    setMediaSource(source);
  }, []);

  const handleStartCamera = async () => {
    setCameraError(null);
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setCameraError(
        "Camera recording is not supported in this browser. Upload a JPG, PNG, MP4, or WebM file below."
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      mediaStreamRef.current = stream;
      setCameraActive(true);
      requestAnimationFrame(() => {
        if (liveVideoRef.current) {
          liveVideoRef.current.srcObject = stream;
          liveVideoRef.current.play().catch(() => {});
        }
      });
    } catch (err) {
      const denied =
        err instanceof DOMException &&
        (err.name === "NotAllowedError" || err.name === "PermissionDeniedError");
      setCameraError(
        denied
          ? "Camera permission was denied. Use the file upload option below to continue."
          : "Could not access camera. Use the file upload option below to continue."
      );
      stopCameraStream();
    }
  };

  const handleStartRecording = () => {
    const stream = mediaStreamRef.current;
    if (!stream) return;

    setCameraError(null);
    recordedChunksRef.current = [];
    setRecordingSeconds(0);

    const preferredMime =
      typeof MediaRecorder.isTypeSupported === "function"
        ? MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
          ? "video/webm;codecs=vp9"
          : MediaRecorder.isTypeSupported("video/webm")
            ? "video/webm"
            : MediaRecorder.isTypeSupported("video/mp4")
              ? "video/mp4"
              : undefined
        : undefined;

    try {
      const recorder = preferredMime
        ? new MediaRecorder(stream, { mimeType: preferredMime })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const resolvedMime = recorder.mimeType || preferredMime || "video/webm";
        const blob = new Blob(recordedChunksRef.current, { type: resolvedMime });
        const ext = resolvedMime.includes("mp4") ? "mp4" : "webm";
        const file = new File([blob], `room-walkthrough.${ext}`, { type: blob.type });
        setCapturedFile(file, "camera");
        stopCameraStream();
      };

      recorder.start(250);
      setIsRecording(true);

      let elapsed = 0;
      timerIntervalRef.current = setInterval(() => {
        elapsed += 1;
        setRecordingSeconds(elapsed);
        if (elapsed >= MAX_RECORDING_SECONDS) {
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.stop();
          }
        }
      }, 1000);
    } catch {
      setCameraError("Unable to start video recording. Please upload a photo or video file instead.");
      stopCameraStream();
    }
  };

  const handleStopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const allowed = ["image/jpeg", "image/png", "video/mp4", "video/webm"];
    if (!allowed.includes(file.type)) {
      setCameraError("Unsupported file type. Please choose a JPG, PNG, MP4, or WebM file.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setCameraError(
        `File is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB). Please upload a file under 25 MB.`
      );
      return;
    }
    setCameraError(null);
    stopCameraStream();
    setCapturedFile(file, "upload");
  };

  // Step 4: Analyze + editable observations + plan
  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [hasAnalyzed, setHasAnalyzed] = useState<boolean>(false);
  const [analysisPayload, setAnalysisPayload] = useState<unknown>(null);
  const [observations, setObservations] = useState<DetectedObservation[]>([]);
  const [planning, setPlanning] = useState<boolean>(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const runAnalyze = useCallback(async () => {
    if (!mediaFile) {
      setAnalyzeError("Please record a video or upload a room photo/video before analyzing.");
      return;
    }

    setAnalyzing(true);
    setAnalyzeError(null);

    try {
      const formData = new FormData();
      const sourceType =
        mediaSource === "camera"
          ? "camera"
          : mediaFile.type.startsWith("video/")
            ? "video"
            : "image";

      // Exact multipart contract documented in TEAM_INTEGRATION.md
      formData.append("file", mediaFile);
      formData.append("sourceType", sourceType);
      formData.append("widthFt", String(Number(widthFeet) || 12));
      formData.append("depthFt", String(Number(depthFeet) || 10));
      formData.append("heightFt", String(Number(heightFeet) || 9));
      formData.append("entranceWall", entranceWall);
      formData.append("style", style);
      formData.append("budgetCents", String(budgetCents));
      formData.append("notes", `${shopType}: ${purpose}`.trim());

      const response = await fetch(analyzeEndpoint, {
        method: "POST",
        body: formData,
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const msg =
          (data &&
            typeof data === "object" &&
            ("error" in data
              ? typeof (data as { error?: unknown }).error === "string"
                ? (data as { error: string }).error
                : (data as { error?: { message?: string } }).error?.message
              : undefined)) ||
          `Analysis failed with HTTP ${response.status}.`;
        throw new Error(msg);
      }

      setAnalysisPayload(data);
      setObservations(parseAnalyzeObservations(data));
      setHasAnalyzed(true);
    } catch (err) {
      setAnalyzeError(
        err instanceof Error ? err.message : "Failed to analyze media. Please retry."
      );
    } finally {
      setAnalyzing(false);
    }
  }, [
    analyzeEndpoint,
    budgetCents,
    depthFeet,
    entranceWall,
    heightFeet,
    mediaFile,
    mediaSource,
    purpose,
    shopType,
    style,
    widthFeet,
  ]);

  const handleProceedToAnalyze = () => {
    goToStep(4);
    void runAnalyze();
  };

  const updateObservation = (id: string, patch: Partial<DetectedObservation>) => {
    setObservations((prev) => prev.map((obs) => (obs.id === id ? { ...obs, ...patch } : obs)));
  };

  const addManualObservation = () => {
    setObservations((prev) => [
      ...prev,
      {
        id: `manual-${Date.now()}`,
        label: "Existing fixture",
        kind: "table",
        owned: true,
        exclude: false,
        dimensionsVerified: false,
      },
    ]);
  };

  const buildConfirmedSetup = (): ConfirmedSetup => ({
    shopType,
    purpose: purpose.trim(),
    style,
    budgetCents,
    currency: "USD",
    noDrilling,
    room: {
      width: roomMeters.width,
      depth: roomMeters.depth,
      height: roomMeters.height,
      entrance: {
        wall: entranceWall,
        offset: entranceMeters.offset,
        width: entranceMeters.width,
      },
      measurementsConfirmed: true,
    },
    media: mediaFile
      ? {
          fileName: mediaFile.name,
          mimeType: mediaFile.type,
          sizeBytes: mediaFile.size,
          source: mediaSource ?? "upload",
        }
      : null,
    observations,
  });

  const handlePlanScene = async () => {
    if (!measurementsConfirmed) return;
    const confirmedSetup = buildConfirmedSetup();
    onComplete?.(confirmedSetup);

    setPlanning(true);
    setPlanError(null);

    try {
      const response = await fetch(planEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          room: {
            width: confirmedSetup.room.width,
            depth: confirmedSetup.room.depth,
            height: confirmedSetup.room.height,
            entrance: confirmedSetup.room.entrance,
          },
          purpose: confirmedSetup.purpose,
          style: confirmedSetup.style,
          brief: `${confirmedSetup.shopType}: ${confirmedSetup.purpose}`,
          budgetCents: confirmedSetup.budgetCents,
          minWalkwayWidth: initialScene.minWalkwayWidth || 0.9,
          noDrilling: confirmedSetup.noDrilling,
          analysis: analysisPayload ?? undefined,
          currentScene: initialScene,
          items: confirmedSetup.observations.filter((o) => !o.exclude),
        }),
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const msg =
          (data &&
            typeof data === "object" &&
            ("error" in data
              ? typeof (data as { error?: unknown }).error === "string"
                ? (data as { error: string }).error
                : (data as { error?: { message?: string } }).error?.message
              : undefined)) ||
          `Planning failed with HTTP ${response.status}.`;
        throw new Error(msg);
      }

      const candidateScene =
        data && typeof data === "object" && "scene" in data
          ? (data as { scene: unknown }).scene
          : data;
      const parsed = ShopSceneSchema.safeParse(candidateScene);
      if (!parsed.success) {
        throw new Error("Planner returned a scene that failed ShopSceneSchema validation.");
      }

      onScenePlanned(parsed.data);
      onClose?.();
    } catch (err) {
      setPlanError(
        err instanceof Error ? err.message : "Failed to generate layout plan. Please retry."
      );
    } finally {
      setPlanning(false);
    }
  };

  const handleApplyWithoutAiPlan = () => {
    if (!measurementsConfirmed) return;
    const confirmedSetup = buildConfirmedSetup();
    const fallback = buildFallbackScene(
      initialScene,
      confirmedSetup,
      "Applied confirmed room dimensions and owned items directly without AI layout generation."
    );
    onScenePlanned(fallback);
    onClose?.();
  };

  const step1Valid = shopType.trim().length > 0 && purpose.trim().length > 0 && budgetCents >= 0;
  const step2Valid =
    Number(widthFeet) > 0 &&
    Number(depthFeet) > 0 &&
    Number(heightFeet) > 0 &&
    !entranceOutOfBounds &&
    measurementsConfirmed;
  const step3Valid = Boolean(mediaFile);

  const steps = [
    { num: 1 as const, label: "Shop Brief" },
    { num: 2 as const, label: "Dimensions" },
    { num: 3 as const, label: "Capture Space" },
    { num: 4 as const, label: "Confirm Items" },
  ];

  return (
    <section
      aria-label="SpaceStage Setup Wizard"
      className="mx-auto w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-950 p-6 text-zinc-100 shadow-2xl"
    >
      <header className="mb-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Set up your space</h2>
            <p className="mt-1 text-xs text-zinc-400">
              Confirm room measurements, capture existing fixtures, and set your staging budget.
            </p>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close setup wizard"
              className="rounded-lg border border-zinc-800 px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
            >
              Close
            </button>
          )}
        </div>

        <nav aria-label="Setup steps" className="mt-4 grid grid-cols-4 gap-2">
          {steps.map((s) => {
            const active = currentStep === s.num;
            const completed = currentStep > s.num;
            return (
              <button
                key={s.num}
                type="button"
                onClick={() => {
                  if (s.num < currentStep) goToStep(s.num);
                }}
                disabled={s.num > currentStep}
                aria-current={active ? "step" : undefined}
                className={`rounded-lg border px-2 py-2 text-left text-xs font-medium transition ${
                  active
                    ? "border-amber-300/60 bg-amber-300/15 text-amber-200"
                    : completed
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                      : "cursor-not-allowed border-zinc-800 bg-zinc-900/50 text-zinc-500"
                }`}
              >
                <span className="block text-[10px] opacity-75">Step {s.num}</span>
                <span className="truncate">{s.label}</span>
              </button>
            );
          })}
        </nav>
      </header>

      {/* STEP 1: SHOP BRIEF */}
      {currentStep === 1 && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="wizard-shop-type" className="block text-xs font-medium text-zinc-300">
                Shop type
              </label>
              <select
                id="wizard-shop-type"
                value={shopType}
                onChange={(e) => setShopType(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-amber-300 focus:outline-none"
              >
                {SHOP_TYPE_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="wizard-style" className="block text-xs font-medium text-zinc-300">
                Visual style
              </label>
              <select
                id="wizard-style"
                value={style}
                onChange={(e) => setStyle(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-amber-300 focus:outline-none"
              >
                {STYLE_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="wizard-purpose" className="block text-xs font-medium text-zinc-300">
              Primary goal / purpose
            </label>
            <textarea
              id="wizard-purpose"
              rows={2}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-amber-300 focus:outline-none"
              placeholder="e.g. Maximize product visibility for a weekend pop-up"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="wizard-budget" className="block text-xs font-medium text-zinc-300">
                New-purchase budget (USD)
              </label>
              <div className="relative mt-1">
                <span className="pointer-events-none absolute left-3 top-2 text-sm text-zinc-400">
                  $
                </span>
                <input
                  id="wizard-budget"
                  type="number"
                  min={0}
                  step={10}
                  value={budgetDollars}
                  onChange={(e) => setBudgetDollars(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 py-2 pl-7 pr-3 text-sm text-zinc-100 focus:border-amber-300 focus:outline-none"
                />
              </div>
              <p className="mt-1 text-[11px] text-zinc-400">
                Stored as {budgetCents.toLocaleString()} cents (owned items count as $0).
              </p>
            </div>

            <div className="flex items-center pt-4">
              <label className="flex cursor-pointer items-center gap-3 text-xs text-zinc-200">
                <input
                  type="checkbox"
                  checked={noDrilling}
                  onChange={(e) => setNoDrilling(e.target.checked)}
                  className="h-4 w-4 rounded border-zinc-600 accent-amber-300"
                />
                <span>
                  <span className="font-medium">No-drilling / renter-friendly</span>
                  <span className="block text-[11px] text-zinc-400">
                    Prefer freestanding fixtures over wall-mounted shelves.
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="button"
              disabled={!step1Valid}
              onClick={() => goToStep(2)}
              className="rounded-lg bg-amber-300 px-4 py-2 text-xs font-semibold text-zinc-950 hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next: Room dimensions
            </button>
          </div>
        </div>
      )}

      {/* STEP 2: MEASUREMENTS & ENTRANCE */}
      {currentStep === 2 && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="room-width" className="block text-xs font-medium text-zinc-300">
                Width (ft)
              </label>
              <input
                id="room-width"
                type="number"
                min={1}
                step={0.5}
                value={widthFeet}
                onChange={(e) => setWidthFeet(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
              />
              <p className="mt-1 text-[11px] text-zinc-400">{roomMeters.width} m</p>
            </div>

            <div>
              <label htmlFor="room-depth" className="block text-xs font-medium text-zinc-300">
                Depth (ft)
              </label>
              <input
                id="room-depth"
                type="number"
                min={1}
                step={0.5}
                value={depthFeet}
                onChange={(e) => setDepthFeet(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
              />
              <p className="mt-1 text-[11px] text-zinc-400">{roomMeters.depth} m</p>
            </div>

            <div>
              <label htmlFor="room-height" className="block text-xs font-medium text-zinc-300">
                Ceiling height (ft)
              </label>
              <input
                id="room-height"
                type="number"
                min={1}
                step={0.5}
                value={heightFeet}
                onChange={(e) => setHeightFeet(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
              />
              <p className="mt-1 text-[11px] text-zinc-400">{roomMeters.height} m</p>
            </div>
          </div>

          <fieldset className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <legend className="px-1 text-xs font-medium text-zinc-300">
              Entrance (offset 0 = centered on wall)
            </legend>
            <div className="mt-2 grid gap-4 sm:grid-cols-3">
              <div>
                <label htmlFor="entrance-wall" className="block text-[11px] font-medium text-zinc-400">
                  Wall
                </label>
                <select
                  id="entrance-wall"
                  value={entranceWall}
                  onChange={(e) => setEntranceWall(e.target.value as RoomWall)}
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm capitalize text-zinc-100"
                >
                  {ENTRANCE_WALLS.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="entrance-offset"
                  className="block text-[11px] font-medium text-zinc-400"
                >
                  Center offset (ft)
                </label>
                <input
                  id="entrance-offset"
                  type="number"
                  step={0.5}
                  value={entranceOffsetFeet}
                  onChange={(e) => setEntranceOffsetFeet(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
                />
                <p className="mt-1 text-[11px] text-zinc-400">{entranceMeters.offset} m</p>
              </div>

              <div>
                <label
                  htmlFor="entrance-width"
                  className="block text-[11px] font-medium text-zinc-400"
                >
                  Doorway width (ft)
                </label>
                <input
                  id="entrance-width"
                  type="number"
                  min={1}
                  step={0.5}
                  value={entranceWidthFeet}
                  onChange={(e) => setEntranceWidthFeet(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
                />
                <p className="mt-1 text-[11px] text-zinc-400">{entranceMeters.width} m</p>
              </div>
            </div>

            {entranceOutOfBounds && (
              <p role="alert" className="mt-2 text-xs font-medium text-red-400">
                Doorway must fit within the {entranceWall} wall ({entranceWallLengthFeet} ft wide,
                centered at 0).
              </p>
            )}
          </fieldset>

          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-xs text-amber-100">
            <input
              id="confirm-measurements"
              type="checkbox"
              checked={measurementsConfirmed}
              onChange={(e) => setMeasurementsConfirmed(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-amber-300 accent-amber-300"
            />
            <span>
              <strong>I confirm these measurements</strong> ({roomMeters.width} m &times;{" "}
              {roomMeters.depth} m &times; {roomMeters.height} m) match my actual space.
            </span>
          </label>

          <div className="flex justify-between pt-2">
            <button
              type="button"
              onClick={() => goToStep(1)}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-900"
            >
              Back
            </button>
            <button
              type="button"
              disabled={!step2Valid}
              onClick={() => goToStep(3)}
              className="rounded-lg bg-amber-300 px-4 py-2 text-xs font-semibold text-zinc-950 hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next: Capture space
            </button>
          </div>
        </div>
      )}

      {/* STEP 3: CAMERA RECORDING OR UPLOAD */}
      {currentStep === 3 && (
        <div className="space-y-4">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium text-zinc-100">
                  Record a {RECOMMENDED_MIN_SECONDS}&ndash;{MAX_RECORDING_SECONDS}s walkthrough
                </h3>
                <p className="text-xs text-zinc-400">
                  Pan slowly across walls and existing fixtures, or upload a photo/video below.
                </p>
              </div>

              {!cameraActive ? (
                <button
                  type="button"
                  onClick={handleStartCamera}
                  className="rounded-lg border border-amber-300/50 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-300/15"
                >
                  Open camera
                </button>
              ) : (
                <button
                  type="button"
                  onClick={stopCameraStream}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
                >
                  Close camera
                </button>
              )}
            </div>

            {cameraError && (
              <p
                role="alert"
                className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200"
              >
                {cameraError}
              </p>
            )}

            {cameraActive && (
              <div className="mt-3 space-y-2">
                <video
                  ref={liveVideoRef}
                  muted
                  playsInline
                  aria-label="Live camera preview"
                  className="aspect-video w-full rounded-lg bg-black object-cover"
                />
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-zinc-300">
                    {isRecording
                      ? `Recording: ${recordingSeconds}s / ${MAX_RECORDING_SECONDS}s`
                      : "Camera ready"}
                  </span>
                  {!isRecording ? (
                    <button
                      type="button"
                      onClick={handleStartRecording}
                      className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500"
                    >
                      Start recording
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleStopRecording}
                      className="rounded-lg bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-white"
                    >
                      Stop recording
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-900/30 p-4">
            <label htmlFor="space-media-upload" className="block text-xs font-medium text-zinc-300">
              Or upload a photo / video (JPG, PNG, MP4, WebM &mdash; max 25 MB)
            </label>
            <input
              id="space-media-upload"
              type="file"
              accept={ACCEPTED_MEDIA_TYPES}
              onChange={handleFileUpload}
              className="mt-2 block w-full text-xs text-zinc-300 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-zinc-100 hover:file:bg-zinc-700"
            />
          </div>

          {mediaFile && mediaPreviewUrl && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
              <div className="mb-2 flex items-center justify-between text-xs text-zinc-300">
                <span className="font-medium">{mediaFile.name}</span>
                <span>{(mediaFile.size / (1024 * 1024)).toFixed(2)} MB</span>
              </div>
              {mediaFile.type.startsWith("video/") ? (
                <video
                  src={mediaPreviewUrl}
                  controls
                  playsInline
                  aria-label="Captured walkthrough playback"
                  className="max-h-60 w-full rounded-lg bg-black"
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={mediaPreviewUrl}
                  alt="Uploaded room preview"
                  className="max-h-60 w-full rounded-lg object-contain"
                />
              )}
            </div>
          )}

          <div className="flex justify-between pt-2">
            <button
              type="button"
              onClick={() => {
                stopCameraStream();
                goToStep(2);
              }}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-900"
            >
              Back
            </button>
            <button
              type="button"
              disabled={!step3Valid}
              onClick={handleProceedToAnalyze}
              className="rounded-lg bg-amber-300 px-4 py-2 text-xs font-semibold text-zinc-950 hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Analyze space
            </button>
          </div>
        </div>
      )}

      {/* STEP 4: ANALYZE, CONFIRM OBSERVATIONS, & PLAN */}
      {currentStep === 4 && (
        <div className="space-y-4">
          {analyzing && (
            <div
              role="status"
              aria-live="polite"
              className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-xs text-zinc-300"
            >
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-amber-300 border-t-transparent" />
              <span>Analyzing your space via {analyzeEndpoint}...</span>
            </div>
          )}

          {analyzeError && (
            <div
              role="alert"
              className="space-y-2 rounded-xl border border-red-500/40 bg-red-950/50 p-4 text-xs text-red-200"
            >
              <p>{analyzeError}</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void runAnalyze()}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500"
                >
                  Retry analysis
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAnalyzeError(null);
                    setHasAnalyzed(true);
                  }}
                  className="rounded-lg border border-red-400/40 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-red-100 hover:bg-zinc-800"
                >
                  Continue without AI scan (add items manually)
                </button>
              </div>
            </div>
          )}

          {planError && (
            <div
              role="alert"
              className="space-y-2 rounded-xl border border-amber-400/40 bg-amber-950/40 p-4 text-xs text-amber-100"
            >
              <p>{planError}</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void handlePlanScene()}
                  className="rounded-lg bg-amber-300 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-amber-200"
                >
                  Retry AI plan
                </button>
                <button
                  type="button"
                  onClick={handleApplyWithoutAiPlan}
                  className="rounded-lg border border-amber-300/40 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-zinc-800"
                >
                  Apply room &amp; owned items without AI layout
                </button>
              </div>
            </div>
          )}

          {!analyzing && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium text-zinc-100">
                    Detected furniture &amp; fixtures ({observations.length})
                  </h3>
                  <p className="text-xs text-zinc-400">
                    Edit labels, mark owned items ($0), exclude false detections, or confirm dimensions.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={addManualObservation}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800"
                >
                  + Add item
                </button>
              </div>

              {observations.length === 0 ? (
                <p className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-xs text-zinc-400">
                  {hasAnalyzed
                    ? "No existing items were detected. Add owned items manually or build your layout from an empty room."
                    : "Run analysis or add existing items manually."}
                </p>
              ) : (
                <ul className="space-y-2">
                  {observations.map((obs) => (
                    <li
                      key={obs.id}
                      className={`rounded-xl border p-3 ${
                        obs.exclude
                          ? "border-zinc-800 bg-zinc-900/30 opacity-50"
                          : "border-zinc-800 bg-zinc-900/70"
                      }`}
                    >
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div>
                          <label
                            htmlFor={`obs-label-${obs.id}`}
                            className="block text-[11px] font-medium text-zinc-400"
                          >
                            Label
                          </label>
                          <input
                            id={`obs-label-${obs.id}`}
                            type="text"
                            value={obs.label}
                            onChange={(e) => updateObservation(obs.id, { label: e.target.value })}
                            className="mt-0.5 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100"
                          />
                        </div>
                        <div>
                          <label
                            htmlFor={`obs-kind-${obs.id}`}
                            className="block text-[11px] font-medium text-zinc-400"
                          >
                            Kind
                          </label>
                          <select
                            id={`obs-kind-${obs.id}`}
                            value={obs.kind}
                            onChange={(e) =>
                              updateObservation(obs.id, {
                                kind: e.target.value as SceneObjectKind,
                              })
                            }
                            className="mt-0.5 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs capitalize text-zinc-100"
                          >
                            {VALID_KINDS.map((k) => (
                              <option key={k} value={k}>
                                {k}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-zinc-300">
                        <label className="flex cursor-pointer items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={obs.owned}
                            onChange={(e) => updateObservation(obs.id, { owned: e.target.checked })}
                            className="h-3.5 w-3.5 accent-amber-300"
                          />
                          <span>Owned ($0)</span>
                        </label>

                        <label className="flex cursor-pointer items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={obs.exclude}
                            onChange={(e) => updateObservation(obs.id, { exclude: e.target.checked })}
                            className="h-3.5 w-3.5 accent-amber-300"
                          />
                          <span>Exclude</span>
                        </label>

                        <label className="flex cursor-pointer items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={obs.dimensionsVerified}
                            onChange={(e) =>
                              updateObservation(obs.id, { dimensionsVerified: e.target.checked })
                            }
                            className="h-3.5 w-3.5 accent-amber-300"
                          />
                          <span>Dimensions verified</span>
                        </label>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex justify-between pt-2">
            <button
              type="button"
              onClick={() => goToStep(3)}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-900"
            >
              Back
            </button>
            <button
              type="button"
              disabled={analyzing || planning || !measurementsConfirmed}
              onClick={() => void handlePlanScene()}
              className="rounded-lg bg-amber-300 px-4 py-2 text-xs font-semibold text-zinc-950 hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {planning ? "Planning layout..." : "Confirm & build plan"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export default SetupWizard;
