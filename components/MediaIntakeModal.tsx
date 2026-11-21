'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Circle,
  Film,
  Link2,
  Loader2,
  Play,
  Radio,
  Sparkles,
  Square,
  Upload,
  Video,
  X,
} from 'lucide-react';
import {
  FT_TO_METERS,
  ShopSceneSchema,
  type RoomWall,
  type SceneObject,
  type ShopScene,
} from '@/lib/schema';
import {
  useSceneStore,
  type MediaSourceSummary,
} from '@/store/useSceneStore';

type IntakeTab = 'upload' | 'camera' | 'youtube';

function extractYouTubeId(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(
      trimmed.startsWith('http://') || trimmed.startsWith('https://')
        ? trimmed
        : `https://${trimmed}`
    );
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();

    if (host === 'youtu.be') {
      const id = parsed.pathname.split('/').filter(Boolean)[0];
      return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }

    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const vParam = parsed.searchParams.get('v');
      if (vParam && /^[a-zA-Z0-9_-]{11}$/.test(vParam)) {
        return vParam;
      }
      const segments = parsed.pathname.split('/').filter(Boolean);
      if (
        (segments[0] === 'shorts' ||
          segments[0] === 'embed' ||
          segments[0] === 'live') &&
        segments[1] &&
        /^[a-zA-Z0-9_-]{11}$/.test(segments[1])
      ) {
        return segments[1];
      }
    }
  } catch {
    return null;
  }

  return null;
}

function isDirectVideoUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return /\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function clampValue(value: number, min: number, max: number): number {
  if (min > max) return (min + max) * 0.5;
  return Math.max(min, Math.min(max, value));
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSeconds(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Re-scales and clamps existing fixtures safely inside confirmed room dimensions
 * without fabricating new Shopify products or prices.
 */
function applyConfirmedParametersLocally(
  currentScene: ShopScene,
  params: {
    widthFt: number;
    depthFt: number;
    heightFt: number;
    entranceWall: RoomWall;
    style: string;
    budgetDollars: number;
  }
): ShopScene {
  const newWidth = Number((params.widthFt * FT_TO_METERS).toFixed(4));
  const newDepth = Number((params.depthFt * FT_TO_METERS).toFixed(4));
  const newHeight = Number((params.heightFt * FT_TO_METERS).toFixed(4));

  const scaleX = currentScene.room.width > 0 ? newWidth / currentScene.room.width : 1;
  const scaleZ = currentScene.room.depth > 0 ? newDepth / currentScene.room.depth : 1;

  const halfW = newWidth * 0.5;
  const halfD = newDepth * 0.5;
  const wallInset = 0.04;

  const entranceWidth = Math.min(
    currentScene.room.entrance.width,
    Math.max(0.9144, (params.entranceWall === 'north' || params.entranceWall === 'south' ? newWidth : newDepth) * 0.45)
  );
  const wallSpan =
    params.entranceWall === 'north' || params.entranceWall === 'south'
      ? newWidth
      : newDepth;
  const maxEntranceOffset = Math.max(0, wallSpan * 0.5 - entranceWidth * 0.5 - 0.15);
  const clampedOffset = clampValue(
    currentScene.room.entrance.offset,
    -maxEntranceOffset,
    maxEntranceOffset
  );

  const clampedObjects: SceneObject[] = currentScene.objects.map((obj) => {
    const cos = Math.abs(Math.cos(obj.rotationY));
    const sin = Math.abs(Math.sin(obj.rotationY));
    const extentX = (obj.size[0] * 0.5) * cos + (obj.size[2] * 0.5) * sin;
    const extentZ = (obj.size[0] * 0.5) * sin + (obj.size[2] * 0.5) * cos;

    const scaledX = obj.position[0] * scaleX;
    const scaledZ = obj.position[2] * scaleZ;

    const nextX = Number(
      clampValue(scaledX, -halfW + extentX + wallInset, halfW - extentX - wallInset).toFixed(3)
    );
    const nextZ = Number(
      clampValue(scaledZ, -halfD + extentZ + wallInset, halfD - extentZ - wallInset).toFixed(3)
    );
    const nextY = Number(
      clampValue(obj.position[1], 0, Math.max(0, newHeight - obj.size[1])).toFixed(3)
    );

    return {
      ...obj,
      position: [nextX, nextY, nextZ],
    };
  });

  return {
    ...currentScene,
    room: {
      width: newWidth,
      depth: newDepth,
      height: newHeight,
      entrance: {
        wall: params.entranceWall,
        offset: Number(clampedOffset.toFixed(3)),
        width: Number(entranceWidth.toFixed(4)),
      },
    },
    style: params.style.trim() || currentScene.style,
    budgetCents: Math.max(0, Math.round(params.budgetDollars * 100)),
    objects: clampedObjects,
  };
}

function MediaIntakeDialogContent({
  scene,
  onClose,
}: {
  scene: ShopScene;
  onClose: () => void;
}) {
  const setScene = useSceneStore((state) => state.setScene);
  const setLastMediaSource = useSceneStore((state) => state.setLastMediaSource);

  const [activeTab, setActiveTab] = useState<IntakeTab>('upload');

  // Upload Video / Photo state
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [uploadPreviewUrl, setUploadPreviewUrl] = useState<string | null>(null);
  const [uploadMediaKind, setUploadMediaKind] = useState<'video' | 'image' | null>(
    null
  );
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Live Camera state
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const liveVideoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // YouTube / Direct Video URL state
  const [videoUrlInput, setVideoUrlInput] = useState('');
  const [showEmbedPlayer, setShowEmbedPlayer] = useState(false);
  const [failedThumbId, setFailedThumbId] = useState<string | null>(null);

  // Confirmed Space Parameters (exact ground truth)
  const [widthFt, setWidthFt] = useState(() =>
    String(Number((scene.room.width / FT_TO_METERS).toFixed(1)))
  );
  const [depthFt, setDepthFt] = useState(() =>
    String(Number((scene.room.depth / FT_TO_METERS).toFixed(1)))
  );
  const [heightFt, setHeightFt] = useState(() =>
    String(Number((scene.room.height / FT_TO_METERS).toFixed(1)))
  );
  const [entranceWall, setEntranceWall] = useState<RoomWall>(
    scene.room.entrance.wall
  );
  const [styleInput, setStyleInput] = useState(scene.style);
  const [budgetDollars, setBudgetDollars] = useState(() =>
    String(Math.round(scene.budgetCents / 100))
  );

  // Submission status
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusNotice, setStatusNotice] = useState<{
    tone: 'amber' | 'emerald' | 'red';
    message: string;
  } | null>(null);

  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploadUrlRef = useRef<string | null>(null);
  const recordedUrlRef = useRef<string | null>(null);

  const stopCameraTracks = useCallback(() => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try {
        recorderRef.current.stop();
      } catch {
        // Ignore recorder stop race during teardown
      }
    }
    recorderRef.current = null;

    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (liveVideoRef.current) {
      liveVideoRef.current.srcObject = null;
    }
    setIsRecording(false);
    setCameraActive(false);
  }, []);

  // Attach MediaStream to <video> whenever camera becomes active
  useEffect(() => {
    if (cameraActive && liveVideoRef.current && streamRef.current) {
      liveVideoRef.current.srcObject = streamRef.current;
      void liveVideoRef.current.play().catch(() => {
        // Autoplay might wait briefly until metadata is ready
      });
    }
  }, [cameraActive]);

  // Escape key close + guaranteed cleanup of streams, timers, and blob URLs
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
      }
      stopCameraTracks();
      if (uploadUrlRef.current) {
        URL.revokeObjectURL(uploadUrlRef.current);
      }
      if (recordedUrlRef.current) {
        URL.revokeObjectURL(recordedUrlRef.current);
      }
    };
  }, [onClose, stopCameraTracks]);

  const handleSelectFile = useCallback((file: File) => {
    const isVideo = file.type.startsWith('video/');
    const isImage = file.type.startsWith('image/');
    if (!isVideo && !isImage) {
      setStatusNotice({
        tone: 'red',
        message: 'Please choose a video (MP4, MOV, WebM) or photo (JPG, PNG, WebP).',
      });
      return;
    }

    if (uploadUrlRef.current) {
      URL.revokeObjectURL(uploadUrlRef.current);
    }

    const nextUrl = URL.createObjectURL(file);
    uploadUrlRef.current = nextUrl;
    setUploadedFile(file);
    setUploadPreviewUrl(nextUrl);
    setUploadMediaKind(isVideo ? 'video' : 'image');
    setStatusNotice(null);
  }, []);

  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      handleSelectFile(file);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragOver(false);
    const file = event.dataTransfer.files?.[0];
    if (file) {
      handleSelectFile(file);
    }
  };

  const clearUploadedFile = () => {
    if (uploadUrlRef.current) {
      URL.revokeObjectURL(uploadUrlRef.current);
      uploadUrlRef.current = null;
    }
    setUploadedFile(null);
    setUploadPreviewUrl(null);
    setUploadMediaKind(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const startLiveCamera = async () => {
    setCameraError(null);
    setStatusNotice(null);

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function'
    ) {
      setCameraError(
        'Live camera capture is not available in this browser context. Try Upload Video/Photo or a YouTube link instead.'
      );
      return;
    }

    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
      }

      streamRef.current = stream;
      setCameraActive(true);
    } catch (err) {
      const msg =
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Camera permission was denied. Allow camera access in your browser settings or upload a clip instead.'
          : 'Could not start a live camera feed on this device. You can still upload a room video/photo or paste a link.';
      setCameraError(msg);
    }
  };

  const startRecording = () => {
    const stream = streamRef.current;
    if (!stream) return;

    if (typeof MediaRecorder === 'undefined') {
      setCameraError(
        'MediaRecorder is unsupported in this browser. Live preview still works, or upload a recorded clip.'
      );
      return;
    }

    setCameraError(null);
    if (recordedUrlRef.current) {
      URL.revokeObjectURL(recordedUrlRef.current);
      recordedUrlRef.current = null;
    }
    setRecordedBlob(null);
    setRecordedUrl(null);
    recordedChunksRef.current = [];

    const preferredTypes = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4',
    ];
    const mimeType = preferredTypes.find((type) =>
      MediaRecorder.isTypeSupported(type)
    );

    try {
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        if (recordTimerRef.current) {
          clearInterval(recordTimerRef.current);
          recordTimerRef.current = null;
        }
        const blob = new Blob(recordedChunksRef.current, {
          type: recorder.mimeType || 'video/webm',
        });
        if (blob.size > 0) {
          const url = URL.createObjectURL(blob);
          recordedUrlRef.current = url;
          setRecordedBlob(blob);
          setRecordedUrl(url);
        }
        setIsRecording(false);
      };

      recorderRef.current = recorder;
      recorder.start(250);
      setIsRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = setInterval(() => {
        setRecordSeconds((prev) => prev + 1);
      }, 1000);
    } catch {
      setCameraError('Unable to start clip recording with this camera stream.');
    }
  };

  const stopRecording = () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
  };

  const youtubeId = useMemo(
    () => extractYouTubeId(videoUrlInput),
    [videoUrlInput]
  );
  const directVideo = useMemo(
    () => isDirectVideoUrl(videoUrlInput),
    [videoUrlInput]
  );

  const handleTabSwitch = (nextTab: IntakeTab) => {
    if (activeTab === 'camera' && nextTab !== 'camera') {
      stopCameraTracks();
    }
    setActiveTab(nextTab);
    setStatusNotice(null);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;

    const parsedWidth = Number.parseFloat(widthFt);
    const parsedDepth = Number.parseFloat(depthFt);
    const parsedHeight = Number.parseFloat(heightFt);
    const parsedBudget = Number.parseFloat(budgetDollars);

    if (
      !Number.isFinite(parsedWidth) ||
      parsedWidth < 6 ||
      parsedWidth > 120 ||
      !Number.isFinite(parsedDepth) ||
      parsedDepth < 6 ||
      parsedDepth > 120 ||
      !Number.isFinite(parsedHeight) ||
      parsedHeight < 7 ||
      parsedHeight > 30
    ) {
      setStatusNotice({
        tone: 'red',
        message:
          'Enter realistic room dimensions (Width & Depth 6–120 ft, Height 7–30 ft).',
      });
      return;
    }

    if (!Number.isFinite(parsedBudget) || parsedBudget < 0) {
      setStatusNotice({
        tone: 'red',
        message: 'Enter a valid new-fixture budget ($0 or greater).',
      });
      return;
    }

    setIsSubmitting(true);
    setStatusNotice(null);

    const safeWidthM = Number((parsedWidth * FT_TO_METERS).toFixed(4));
    const safeDepthM = Number((parsedDepth * FT_TO_METERS).toFixed(4));
    const safeHeightM = Number((parsedHeight * FT_TO_METERS).toFixed(4));
    const safeBudgetCents = Math.round(parsedBudget * 100);
    const safeStyle = styleInput.trim() || scene.style;

    // Determine active media summary metadata
    let mediaKind: MediaSourceSummary['kind'] = 'video';
    let mediaLabel = `${parsedWidth}×${parsedDepth} ft confirmed space brief`;
    let summaryPreviewUrl: string | undefined;

    if (activeTab === 'upload' && uploadedFile && uploadMediaKind) {
      mediaKind = uploadMediaKind;
      mediaLabel = uploadedFile.name;
    } else if (activeTab === 'camera') {
      mediaKind = 'camera';
      mediaLabel = recordedBlob
        ? `Live camera walkthrough clip (${formatSeconds(recordSeconds)})`
        : cameraActive
          ? 'Live camera feed'
          : 'Camera intake brief';
    } else if (activeTab === 'youtube' && videoUrlInput.trim()) {
      mediaKind = 'youtube';
      mediaLabel = youtubeId
        ? `YouTube walkthrough (${youtubeId})`
        : videoUrlInput.trim();
      if (youtubeId) {
        summaryPreviewUrl = `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;
      }
    }

    let backendConnected = false;
    let analysisResult: unknown = null;
    let plannedScene: ShopScene | null = null;

    try {
      // 1. Call POST /api/analyze if media file, recorded clip, or video link is present
      const hasFileToAnalyze =
        (activeTab === 'upload' && Boolean(uploadedFile)) ||
        (activeTab === 'camera' && Boolean(recordedBlob));
      const hasUrlToAnalyze =
        activeTab === 'youtube' && Boolean(videoUrlInput.trim());

      if (hasFileToAnalyze) {
        const formData = new FormData();
        if (activeTab === 'upload' && uploadedFile) {
          formData.append('file', uploadedFile);
          formData.append('sourceType', uploadMediaKind ?? 'video');
        } else if (activeTab === 'camera' && recordedBlob) {
          formData.append('file', recordedBlob, 'live-walkthrough.webm');
          formData.append('sourceType', 'camera');
        }
        formData.append('widthFt', String(parsedWidth));
        formData.append('depthFt', String(parsedDepth));
        formData.append('heightFt', String(parsedHeight));
        formData.append('entranceWall', entranceWall);
        formData.append('style', safeStyle);
        formData.append('budgetCents', String(safeBudgetCents));

        const analyzeRes = await fetch('/api/analyze', {
          method: 'POST',
          body: formData,
        });
        if (analyzeRes.ok) {
          analysisResult = await analyzeRes.json();
          backendConnected = true;
        }
      } else if (hasUrlToAnalyze) {
        const analyzeRes = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mediaUrl: videoUrlInput.trim(),
            youtubeId,
            sourceType: 'youtube',
            room: {
              width: safeWidthM,
              depth: safeDepthM,
              height: safeHeightM,
              entranceWall,
            },
            style: safeStyle,
            budgetCents: safeBudgetCents,
          }),
        });
        if (analyzeRes.ok) {
          analysisResult = await analyzeRes.json();
          backendConnected = true;
        }
      }

      // 2. Call POST /api/plan using the shared SpaceStage contract
      const planRes = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room: {
            width: safeWidthM,
            depth: safeDepthM,
            height: safeHeightM,
            entrance: {
              wall: entranceWall,
              offset: scene.room.entrance.offset,
              width: scene.room.entrance.width,
            },
          },
          purpose: scene.purpose,
          style: safeStyle,
          budgetCents: safeBudgetCents,
          minWalkwayWidth: scene.minWalkwayWidth,
          noDrilling: scene.noDrilling,
          analysis: analysisResult,
          currentScene: scene,
        }),
      });

      if (planRes.ok) {
        const planJson: unknown = await planRes.json();
        const candidateScene =
          typeof planJson === 'object' &&
          planJson !== null &&
          'scene' in planJson
            ? (planJson as { scene: unknown }).scene
            : planJson;
        const parsed = ShopSceneSchema.safeParse(candidateScene);
        if (parsed.success) {
          plannedScene = parsed.data;
          backendConnected = true;
        }
      }
    } catch {
      // Network or offline backend — fall back honestly below
    }

    if (plannedScene) {
      setScene(plannedScene);
      setLastMediaSource({
        kind: mediaKind,
        label: mediaLabel,
        previewUrl: summaryPreviewUrl,
        notes: 'Analyzed via SpaceStage Gemini backend',
        backendConnected: true,
        updatedAt: new Date().toISOString(),
      });
      setStatusNotice({
        tone: 'emerald',
        message: 'Space analyzed and staged in 3D from backend plan.',
      });
      setIsSubmitting(false);
      stopCameraTracks();
      onClose();
      return;
    }

    // Honest non-blocking offline fallback: apply confirmed dimensions/style/entrance/budget locally
    const updatedScene = applyConfirmedParametersLocally(scene, {
      widthFt: parsedWidth,
      depthFt: parsedDepth,
      heightFt: parsedHeight,
      entranceWall,
      style: safeStyle,
      budgetDollars: parsedBudget,
    });

    setScene(updatedScene);
    setLastMediaSource({
      kind: mediaKind,
      label: mediaLabel,
      previewUrl: summaryPreviewUrl,
      notes: 'Local confirmed dimensions applied (backend offline)',
      backendConnected,
      updatedAt: new Date().toISOString(),
    });
    setStatusNotice({
      tone: 'amber',
      message:
        'Gemini backend routes not yet deployed — updating local 3D boutique with your confirmed dimensions & style.',
    });
    setIsSubmitting(false);
    stopCameraTracks();

    closeTimeoutRef.current = setTimeout(() => {
      onClose();
    }, 1150);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="media-intake-title"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-white/15 bg-zinc-950/92 text-zinc-100 shadow-[0_28px_90px_rgba(0,0,0,0.7)] backdrop-blur-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-300 to-emerald-400 text-zinc-950 shadow-inner">
              <Sparkles className="h-4.5 w-4.5" />
            </span>
            <div>
              <h2
                id="media-intake-title"
                className="text-base font-semibold tracking-tight text-white"
              >
                Scan or Upload Retail Space
              </h2>
              <p className="text-xs text-zinc-400">
                Upload a walkthrough video/photo, record live, or link YouTube — then confirm exact room dimensions.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close media intake modal"
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-xl text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-4.5 w-4.5" />
          </button>
        </div>

        {/* Scrollable Form Body */}
        <form
          onSubmit={handleSubmit}
          className="flex flex-1 flex-col gap-5 overflow-y-auto px-6 py-5"
        >
          {/* Three Interactive Source Tabs */}
          <div
            className="grid grid-cols-3 gap-1.5 rounded-2xl border border-white/10 bg-white/5 p-1"
            role="tablist"
            aria-label="Media Intake Source"
          >
            <button
              type="button"
              role="tab"
              data-testid="tab-upload"
              aria-selected={activeTab === 'upload'}
              onClick={() => handleTabSwitch('upload')}
              className={`flex cursor-pointer items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold transition-all ${
                activeTab === 'upload'
                  ? 'bg-white text-zinc-950 shadow-sm'
                  : 'text-zinc-300 hover:bg-white/8 hover:text-white'
              }`}
            >
              <Upload className="h-3.5 w-3.5" />
              <span>Upload Video / Photo</span>
            </button>

            <button
              type="button"
              role="tab"
              data-testid="tab-camera"
              aria-selected={activeTab === 'camera'}
              onClick={() => handleTabSwitch('camera')}
              className={`flex cursor-pointer items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold transition-all ${
                activeTab === 'camera'
                  ? 'bg-white text-zinc-950 shadow-sm'
                  : 'text-zinc-300 hover:bg-white/8 hover:text-white'
              }`}
            >
              <Camera className="h-3.5 w-3.5" />
              <span>Live Camera Feed</span>
            </button>

            <button
              type="button"
              role="tab"
              data-testid="tab-youtube"
              aria-selected={activeTab === 'youtube'}
              onClick={() => handleTabSwitch('youtube')}
              className={`flex cursor-pointer items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold transition-all ${
                activeTab === 'youtube'
                  ? 'bg-white text-zinc-950 shadow-sm'
                  : 'text-zinc-300 hover:bg-white/8 hover:text-white'
              }`}
            >
              <Link2 className="h-3.5 w-3.5" />
              <span>YouTube / Video Link</span>
            </button>
          </div>

          {/* Tab 1: Upload Video / Photo */}
          {activeTab === 'upload' && (
            <div className="space-y-3">
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*,image/*"
                onChange={handleFileInputChange}
                className="hidden"
              />

              {!uploadPreviewUrl ? (
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDragOver(true);
                  }}
                  onDragLeave={() => setIsDragOver(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`flex cursor-pointer flex-col items-center justify-center gap-2.5 rounded-2xl border-2 border-dashed px-6 py-9 text-center transition-all ${
                    isDragOver
                      ? 'border-amber-300 bg-amber-300/10'
                      : 'border-white/15 bg-white/[0.03] hover:border-white/30 hover:bg-white/[0.06]'
                  }`}
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10 text-amber-300">
                    <Film className="h-6 w-6" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">
                      Drop a store walkthrough video or room photo
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-400">
                      MP4, MOV, WebM, JPG, PNG, or WebP · Click to browse
                    </p>
                  </div>
                </div>
              ) : (
                <div className="overflow-hidden rounded-2xl border border-white/12 bg-black/60">
                  <div className="relative flex max-h-60 items-center justify-center bg-black">
                    {uploadMediaKind === 'video' ? (
                      <video
                        src={uploadPreviewUrl}
                        controls
                        playsInline
                        className="max-h-60 w-full object-contain"
                      />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={uploadPreviewUrl}
                        alt={uploadedFile?.name ?? 'Uploaded retail space'}
                        className="max-h-60 w-full object-contain"
                      />
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2 border-t border-white/10 px-3.5 py-2 text-xs">
                    <div className="flex min-w-0 items-center gap-2">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                      <span className="truncate font-medium text-zinc-200">
                        {uploadedFile?.name}
                      </span>
                      {uploadedFile && (
                        <span className="shrink-0 text-zinc-500">
                          ({formatFileSize(uploadedFile.size)})
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={clearUploadedFile}
                      className="cursor-pointer rounded-lg px-2 py-1 text-[11px] font-medium text-zinc-300 hover:bg-white/10 hover:text-white"
                    >
                      Replace
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Tab 2: Live Camera Feed */}
          {activeTab === 'camera' && (
            <div className="space-y-3">
              <div className="overflow-hidden rounded-2xl border border-white/12 bg-black/70">
                {cameraActive ? (
                  <div className="relative">
                    <video
                      ref={liveVideoRef}
                      autoPlay
                      muted
                      playsInline
                      className="max-h-60 w-full bg-black object-cover"
                    />
                    <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full border border-white/15 bg-zinc-950/75 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur-md">
                      <Radio
                        className={`h-3 w-3 ${
                          isRecording
                            ? 'animate-pulse text-red-400'
                            : 'text-emerald-400'
                        }`}
                      />
                      <span>
                        {isRecording
                          ? `REC ${formatSeconds(recordSeconds)}`
                          : 'LIVE CAMERA'}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center gap-3 px-6 py-9 text-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10 text-emerald-300">
                      <Camera className="h-6 w-6" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-white">
                        Walk your storefront with live camera capture
                      </p>
                      <p className="mt-0.5 text-xs text-zinc-400">
                        Uses rear camera when available. Record a quick 5–15s pan of walls &amp; existing fixtures.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={startLiveCamera}
                      className="flex cursor-pointer items-center gap-2 rounded-xl bg-emerald-400 px-4 py-2 text-xs font-semibold text-zinc-950 shadow-sm transition-colors hover:bg-emerald-300"
                    >
                      <Video className="h-3.5 w-3.5" />
                      <span>Start Live Camera</span>
                    </button>
                  </div>
                )}

                {cameraActive && (
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 px-3.5 py-2.5">
                    <div className="flex items-center gap-2">
                      {!isRecording ? (
                        <button
                          type="button"
                          onClick={startRecording}
                          className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-red-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-400"
                        >
                          <Circle className="h-3 w-3 fill-current" />
                          <span>Record Clip</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={stopRecording}
                          className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-950 transition-colors hover:bg-white"
                        >
                          <Square className="h-3 w-3 fill-current" />
                          <span>Stop ({formatSeconds(recordSeconds)})</span>
                        </button>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={stopCameraTracks}
                      className="cursor-pointer rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-white/10 hover:text-white"
                    >
                      Turn Off Camera
                    </button>
                  </div>
                )}
              </div>

              {cameraError && (
                <div className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-500/12 px-3.5 py-2.5 text-xs text-amber-200">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                  <span>{cameraError}</span>
                </div>
              )}

              {recordedUrl && (
                <div className="overflow-hidden rounded-2xl border border-emerald-400/30 bg-black/70">
                  <div className="flex items-center justify-between border-b border-white/10 px-3.5 py-2 text-xs">
                    <span className="flex items-center gap-1.5 font-medium text-emerald-300">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Recorded clip ready ({formatSeconds(recordSeconds)})
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        if (recordedUrlRef.current) {
                          URL.revokeObjectURL(recordedUrlRef.current);
                          recordedUrlRef.current = null;
                        }
                        setRecordedBlob(null);
                        setRecordedUrl(null);
                      }}
                      className="cursor-pointer text-zinc-400 hover:text-white"
                    >
                      Discard
                    </button>
                  </div>
                  <video
                    src={recordedUrl}
                    controls
                    playsInline
                    className="max-h-44 w-full bg-black object-contain"
                  />
                </div>
              )}
            </div>
          )}

          {/* Tab 3: YouTube / Direct Video Link */}
          {activeTab === 'youtube' && (
            <div className="space-y-3">
              <div>
                <label
                  htmlFor="video-url-input"
                  className="mb-1.5 block text-xs font-medium text-zinc-300"
                >
                  YouTube Walkthrough URL or Direct MP4 / WebM Link
                </label>
                <div className="relative">
                  <Link2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                  <input
                    id="video-url-input"
                    data-testid="youtube-url-input"
                    type="text"
                    inputMode="url"
                    value={videoUrlInput}
                    onChange={(e) => {
                      setVideoUrlInput(e.target.value);
                      setShowEmbedPlayer(false);
                    }}
                    placeholder="https://www.youtube.com/watch?v=... or https://.../tour.mp4"
                    className="w-full rounded-xl border border-white/12 bg-white/5 py-2.5 pl-10 pr-3.5 text-sm text-white placeholder:text-zinc-500 focus:border-amber-300/60 focus:outline-none"
                  />
                </div>
              </div>

              {youtubeId && (
                <div
                  data-testid="youtube-preview-card"
                  className="overflow-hidden rounded-2xl border border-emerald-400/25 bg-black/70"
                >
                  {showEmbedPlayer ? (
                    <iframe
                      src={`https://www.youtube.com/embed/${youtubeId}?autoplay=1`}
                      title="YouTube space walkthrough preview"
                      className="aspect-video w-full border-0"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                    />
                  ) : (
                    <div className="relative aspect-video w-full overflow-hidden bg-gradient-to-br from-zinc-900 via-zinc-950 to-emerald-950/60">
                      {failedThumbId !== youtubeId ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`}
                          alt={`YouTube walkthrough thumbnail (${youtubeId})`}
                          onError={() => setFailedThumbId(youtubeId)}
                          className="h-full w-full object-cover opacity-85"
                        />
                      ) : (
                        <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center">
                          <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/15 bg-white/10 text-amber-300">
                            <Film className="h-6 w-6" />
                          </div>
                          <p className="text-xs font-medium text-zinc-200">
                            YouTube Walkthrough Linked
                          </p>
                          <p className="font-mono text-[11px] text-zinc-400">
                            youtube.com/watch?v={youtubeId}
                          </p>
                        </div>
                      )}

                      <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-full border border-white/15 bg-zinc-950/80 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-md">
                        <Video className="h-3 w-3 text-amber-300" />
                        <span className="font-mono">ID: {youtubeId}</span>
                      </div>

                      <button
                        type="button"
                        onClick={() => setShowEmbedPlayer(true)}
                        className="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/25 transition-colors hover:bg-black/15"
                      >
                        <span className="flex items-center gap-2 rounded-full bg-white/95 px-4 py-2 text-xs font-semibold text-zinc-950 shadow-xl">
                          <Play className="h-3.5 w-3.5 fill-current" />
                          <span>Preview Embedded Video</span>
                        </span>
                      </button>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2 border-t border-white/10 px-3.5 py-2 text-xs">
                    <span className="flex items-center gap-1.5 font-medium text-emerald-300">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                      <span>YouTube video verified</span>
                      <span className="rounded-md border border-emerald-400/30 bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-200">
                        {youtubeId}
                      </span>
                    </span>
                    <span className="text-[11px] text-zinc-400">
                      Ready for analysis
                    </span>
                  </div>
                </div>
              )}

              {!youtubeId && directVideo && (
                <div className="overflow-hidden rounded-2xl border border-white/12 bg-black/70">
                  <video
                    src={videoUrlInput.trim()}
                    controls
                    playsInline
                    className="max-h-52 w-full bg-black object-contain"
                  />
                  <div className="flex items-center gap-1.5 border-t border-white/10 px-3.5 py-2 text-xs text-emerald-300">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Direct video stream detected
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Confirmed Space Parameters (Truthful Ground-Truth Measurement Form) */}
          <div className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-200">
                Confirmed Space Parameters
              </h3>
              <span className="text-[11px] text-zinc-400">
                Exact user-verified room ground truth
              </span>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label
                  htmlFor="room-width-ft"
                  className="mb-1 block text-[11px] font-medium text-zinc-300"
                >
                  Width (ft)
                </label>
                <input
                  id="room-width-ft"
                  type="number"
                  step="0.5"
                  min="6"
                  max="120"
                  required
                  value={widthFt}
                  onChange={(e) => setWidthFt(e.target.value)}
                  className="w-full rounded-xl border border-white/12 bg-zinc-900/80 px-3 py-2 text-sm font-medium text-white focus:border-amber-300/60 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="room-depth-ft"
                  className="mb-1 block text-[11px] font-medium text-zinc-300"
                >
                  Depth (ft)
                </label>
                <input
                  id="room-depth-ft"
                  type="number"
                  step="0.5"
                  min="6"
                  max="120"
                  required
                  value={depthFt}
                  onChange={(e) => setDepthFt(e.target.value)}
                  className="w-full rounded-xl border border-white/12 bg-zinc-900/80 px-3 py-2 text-sm font-medium text-white focus:border-amber-300/60 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="room-height-ft"
                  className="mb-1 block text-[11px] font-medium text-zinc-300"
                >
                  Height (ft)
                </label>
                <input
                  id="room-height-ft"
                  type="number"
                  step="0.5"
                  min="7"
                  max="30"
                  required
                  value={heightFt}
                  onChange={(e) => setHeightFt(e.target.value)}
                  className="w-full rounded-xl border border-white/12 bg-zinc-900/80 px-3 py-2 text-sm font-medium text-white focus:border-amber-300/60 focus:outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="entrance-wall"
                  className="mb-1 block text-[11px] font-medium text-zinc-300"
                >
                  Entrance Wall
                </label>
                <select
                  id="entrance-wall"
                  value={entranceWall}
                  onChange={(e) => setEntranceWall(e.target.value as RoomWall)}
                  className="w-full rounded-xl border border-white/12 bg-zinc-900/80 px-3 py-2 text-sm text-white focus:border-amber-300/60 focus:outline-none"
                >
                  <option value="south">South (Storefront Front)</option>
                  <option value="north">North (Rear Entry)</option>
                  <option value="east">East Wall</option>
                  <option value="west">West Wall</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="budget-dollars"
                  className="mb-1 block text-[11px] font-medium text-zinc-300"
                >
                  New-Fixture Budget ($)
                </label>
                <input
                  id="budget-dollars"
                  type="number"
                  step="50"
                  min="0"
                  required
                  value={budgetDollars}
                  onChange={(e) => setBudgetDollars(e.target.value)}
                  className="w-full rounded-xl border border-white/12 bg-zinc-900/80 px-3 py-2 text-sm font-medium text-white focus:border-amber-300/60 focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="aesthetic-style"
                className="mb-1 block text-[11px] font-medium text-zinc-300"
              >
                Aesthetic Style &amp; Material Direction
              </label>
              <input
                id="aesthetic-style"
                type="text"
                value={styleInput}
                onChange={(e) => setStyleInput(e.target.value)}
                placeholder="Warm minimalist travertine, fluted white oak & brushed brass"
                className="w-full rounded-xl border border-white/12 bg-zinc-900/80 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:border-amber-300/60 focus:outline-none"
              />
            </div>

            <p className="text-[11px] leading-relaxed text-zinc-400">
              Uncalibrated videos guide fixture placement and materials, while your confirmed feet dimensions above establish the exact 3D spatial envelope.
            </p>
          </div>

          {statusNotice && (
            <div
              className={`flex items-start gap-2.5 rounded-2xl border px-4 py-3 text-xs leading-relaxed ${
                statusNotice.tone === 'amber'
                  ? 'border-amber-400/35 bg-amber-500/14 text-amber-100'
                  : statusNotice.tone === 'emerald'
                    ? 'border-emerald-400/35 bg-emerald-500/14 text-emerald-100'
                    : 'border-red-400/35 bg-red-500/14 text-red-100'
              }`}
            >
              {statusNotice.tone === 'emerald' ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
              ) : (
                <AlertTriangle
                  className={`mt-0.5 h-4 w-4 shrink-0 ${
                    statusNotice.tone === 'amber'
                      ? 'text-amber-300'
                      : 'text-red-300'
                  }`}
                />
              )}
              <span>{statusNotice.message}</span>
            </div>
          )}

          {/* Footer Action Row */}
          <div className="flex items-center justify-end gap-2.5 border-t border-white/10 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-xl px-4 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="stage-space-btn"
              disabled={isSubmitting}
              className="flex cursor-pointer items-center gap-2 rounded-xl bg-gradient-to-r from-amber-300 via-amber-200 to-emerald-300 px-5 py-2.5 text-xs font-semibold text-zinc-950 shadow-lg transition-all hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Analyzing &amp; Staging…</span>
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  <span>Analyze &amp; Stage 3D Space</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function MediaIntakeModal() {
  const intakeOpen = useSceneStore((state) => state.intakeOpen);
  const scene = useSceneStore((state) => state.scene);
  const setIntakeOpen = useSceneStore((state) => state.setIntakeOpen);

  if (!intakeOpen) {
    return null;
  }

  return (
    <MediaIntakeDialogContent
      scene={scene}
      onClose={() => setIntakeOpen(false)}
    />
  );
}
