'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  AlertTriangle,
  ArrowRight,
  Box,
  Camera,
  CheckCircle2,
  ChevronLeft,
  DollarSign,
  ExternalLink,
  Film,
  Footprints,
  Link2,
  Lock,
  Navigation,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  ShoppingBag,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Unlink,
  Unlock,
  Video,
  X,
} from 'lucide-react';
import type { WalkerPose } from '@/components/FirstPersonRig';
import { MediaIntakeModal } from '@/components/MediaIntakeModal';
import { ProductPanel } from '@/components/ProductPanel';
import { ReplaceObjectBar } from '@/components/ReplaceObjectBar';
import { SceneToolbar } from '@/components/SceneToolbar';
import { SetupWizard } from '@/components/SetupWizard';
import { VoiceRoomControl } from '@/components/VoiceRoomControl';
import { validateScene } from '@/lib/constraints';
import { computeReplacementPatch } from '@/lib/productVisuals';
import {
  deduplicateSceneObjects,
  normalizeObjectSizeForRoom,
} from '@/lib/roomProportions';
import {
  FT_TO_METERS,
  type ConstraintIssue,
  type ProductRef,
  type SceneObject,
  type ShopScene,
  type Vec3,
} from '@/lib/schema';
import { useSceneStore } from '@/store/useSceneStore';

const SpaceCanvas = dynamic(
  () => import('@/components/SpaceCanvas').then((mod) => mod.SpaceCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center bg-[#121110] text-zinc-400">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-300/30 border-t-amber-300" />
          <span className="text-xs font-medium tracking-wide text-zinc-400">
            Initializing 3D Boutique Studio…
          </span>
        </div>
      </div>
    ),
  }
);

function metersToFeet(meters: number): string {
  return (meters / FT_TO_METERS).toFixed(1);
}

function formatCents(cents: number, currency = 'USD'): string {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

function formatBudgetCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function compassLabel(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return dirs[idx];
}

function normalizeDeg(radians: number): number {
  const deg = Math.round((radians * 180) / Math.PI);
  return ((deg % 360) + 360) % 360;
}

function MiniFloorplan({
  scene,
  pose,
}: {
  scene: ShopScene;
  pose: WalkerPose;
}) {
  const pad = 6;
  const maxBox = 64;
  const aspect = scene.room.width / Math.max(0.1, scene.room.depth);
  const mapW = aspect >= 1 ? maxBox : Math.max(32, maxBox * aspect);
  const mapH = aspect >= 1 ? Math.max(32, maxBox / aspect) : maxBox;
  const svgW = mapW + pad * 2;
  const svgH = mapH + pad * 2;

  const toSvgX = (x: number) =>
    pad + ((x + scene.room.width * 0.5) / Math.max(0.1, scene.room.width)) * mapW;
  const toSvgY = (z: number) =>
    pad + ((z + scene.room.depth * 0.5) / Math.max(0.1, scene.room.depth)) * mapH;

  const px = toSvgX(pose.x);
  const py = toSvgY(pose.z);

  const { entrance } = scene.room;
  let doorLine: { x1: number; y1: number; x2: number; y2: number };
  const halfDoor = entrance.width * 0.5;
  if (entrance.wall === 'south') {
    doorLine = {
      x1: toSvgX(entrance.offset - halfDoor),
      y1: pad + mapH,
      x2: toSvgX(entrance.offset + halfDoor),
      y2: pad + mapH,
    };
  } else if (entrance.wall === 'north') {
    doorLine = {
      x1: toSvgX(entrance.offset - halfDoor),
      y1: pad,
      x2: toSvgX(entrance.offset + halfDoor),
      y2: pad,
    };
  } else if (entrance.wall === 'east') {
    doorLine = {
      x1: pad + mapW,
      y1: toSvgY(entrance.offset - halfDoor),
      x2: pad + mapW,
      y2: toSvgY(entrance.offset + halfDoor),
    };
  } else {
    doorLine = {
      x1: pad,
      y1: toSvgY(entrance.offset - halfDoor),
      x2: pad,
      y2: toSvgY(entrance.offset + halfDoor),
    };
  }

  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-xl border border-white/12 bg-zinc-900/85 p-1"
      title="Live 2D boutique floorplan position"
    >
      <svg
        width={svgW}
        height={svgH}
        viewBox={`0 0 ${svgW} ${svgH}`}
        className="overflow-visible"
      >
        {/* Room floor */}
        <rect
          x={pad}
          y={pad}
          width={mapW}
          height={mapH}
          rx={2.5}
          fill="rgba(255,255,255,0.06)"
          stroke="rgba(255,255,255,0.28)"
          strokeWidth={1.2}
        />

        {/* Fixtures */}
        {scene.objects.map((obj) => {
          const cx = toSvgX(obj.position[0]);
          const cy = toSvgY(obj.position[2]);
          const w = (obj.size[0] / Math.max(0.1, scene.room.width)) * mapW;
          const h = (obj.size[2] / Math.max(0.1, scene.room.depth)) * mapH;
          const rotDeg = (-obj.rotationY * 180) / Math.PI;
          return (
            <rect
              key={obj.id}
              x={cx - w * 0.5}
              y={cy - h * 0.5}
              width={Math.max(2, w)}
              height={Math.max(2, h)}
              rx={1}
              transform={`rotate(${rotDeg} ${cx} ${cy})`}
              fill={
                obj.source === 'owned'
                  ? 'rgba(251,191,36,0.45)'
                  : 'rgba(255,255,255,0.28)'
              }
            />
          );
        })}

        {/* Entrance opening */}
        <line
          x1={doorLine.x1}
          y1={doorLine.y1}
          x2={doorLine.x2}
          y2={doorLine.y2}
          stroke="#34d399"
          strokeWidth={2.6}
          strokeLinecap="round"
        />

        {/* Live Walker FOV cone + dot */}
        <g transform={`translate(${px} ${py}) rotate(${pose.yawDeg})`}>
          <path
            d="M 0 0 L -7 -13 A 14 14 0 0 1 7 -13 Z"
            fill="rgba(52,211,153,0.34)"
          />
          <circle
            cx={0}
            cy={0}
            r={3.2}
            fill="#34d399"
            stroke="#09090b"
            strokeWidth={1.2}
          />
        </g>
      </svg>
    </div>
  );
}

function FixtureListItem({
  obj,
  isSelected,
  hasError,
  hasWarning,
  onSelect,
}: {
  obj: SceneObject;
  isSelected: boolean;
  hasError: boolean;
  hasWarning: boolean;
  onSelect: () => void;
}) {
  const isShopifyLinked = obj.source === 'shopify' && Boolean(obj.product);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`group flex w-full cursor-pointer items-start justify-between gap-2 rounded-xl border px-2.5 py-2 text-left transition-all ${
        isSelected
          ? 'border-amber-300/60 bg-amber-300/16 text-white shadow-sm'
          : 'border-transparent bg-white/[0.03] text-zinc-200 hover:border-white/12 hover:bg-white/[0.07]'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium leading-snug">
            {obj.label}
          </span>
          {isShopifyLinked && (
            <span className="shrink-0 rounded-md border border-emerald-400/35 bg-emerald-500/18 px-1.5 py-0.5 text-[9px] font-semibold leading-none tracking-tight text-emerald-200">
              Shopify
            </span>
          )}
        </div>
        {isShopifyLinked && obj.product && (
          <div className="mt-0.5 truncate text-[10px] leading-snug text-emerald-200/80">
            {obj.product.title}
          </div>
        )}
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-zinc-400">
          <span className="capitalize">{obj.kind}</span>
          <span>·</span>
          <span>
            {metersToFeet(obj.size[0])}×{metersToFeet(obj.size[2])} ft
          </span>
          {obj.source === 'owned' ? (
            <span className="text-emerald-300/90">· $0</span>
          ) : obj.product ? (
            <span className="font-semibold text-emerald-300">
              · {formatCents(obj.product.priceCents, obj.product.currency)}
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-0.5 flex shrink-0 items-center gap-1">
        {obj.locked && <Lock className="h-3 w-3 text-zinc-400" />}
        {hasError ? (
          <span
            className="h-2 w-2 rounded-full bg-red-400 ring-2 ring-red-400/25"
            title="Spatial or budget violation"
          />
        ) : hasWarning ? (
          <span
            className="h-2 w-2 rounded-full bg-amber-300/80 ring-2 ring-amber-300/20"
            title="Approximate dimensions"
          />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/70" />
        )}
      </div>
    </button>
  );
}

export default function HomePage() {
  const scene = useSceneStore((state) => state.scene);
  const selectedId = useSceneStore((state) => state.selectedId);
  const cameraMode = useSceneStore((state) => state.cameraMode);
  const issues = useSceneStore((state) => state.issues);
  const intakeOpen = useSceneStore((state) => state.intakeOpen);
  const wizardOpen = useSceneStore((state) => state.wizardOpen);
  const rightPanelTab = useSceneStore((state) => state.rightPanelTab);
  const cartObjectIds = useSceneStore((state) => state.cartObjectIds);
  const shopDrawerRequestedEpoch = useSceneStore(
    (state) => state.shopDrawerRequestedEpoch
  );
  const aiTrace = useSceneStore((state) => state.aiTrace);
  const lastMediaSource = useSceneStore((state) => state.lastMediaSource);

  const hydrateFromStorage = useSceneStore((state) => state.hydrateFromStorage);
  const setValidator = useSceneStore((state) => state.setValidator);
  const setScene = useSceneStore((state) => state.setScene);
  const selectObject = useSceneStore((state) => state.selectObject);
  const setCameraMode = useSceneStore((state) => state.setCameraMode);
  const rotateObject = useSceneStore((state) => state.rotateObject);
  const toggleLock = useSceneStore((state) => state.toggleLock);
  const updateObject = useSceneStore((state) => state.updateObject);
  const clearObjectProduct = useSceneStore((state) => state.clearObjectProduct);
  const removeObject = useSceneStore((state) => state.removeObject);
  const setIntakeOpen = useSceneStore((state) => state.setIntakeOpen);
  const setWizardOpen = useSceneStore((state) => state.setWizardOpen);
  const setRightPanelTab = useSceneStore((state) => state.setRightPanelTab);
  const setAiTrace = useSceneStore((state) => state.setAiTrace);

  // Null = default responsive (open on desktop >=768px, closed on mobile)
  const [inventoryPref, setInventoryPref] = useState<boolean | null>(null);
  const [drawerPinnedOpen, setDrawerPinnedOpen] = useState(false);
  const [dismissedShopEpoch, setDismissedShopEpoch] = useState(0);
  const [dismissedInspectorId, setDismissedInspectorId] = useState<
    string | null
  >(null);
  const [brokenThumbUrl, setBrokenThumbUrl] = useState<string | null>(null);
  const [walkerPose, setWalkerPose] = useState<WalkerPose>(() => ({
    x: scene.room.entrance.offset,
    z: Math.max(0, scene.room.depth * 0.5 - 0.56),
    yawDeg: 0,
    locked: false,
  }));

  // Wire Akash's deterministic constraint engine & hydrate persisted scene on client mount
  useEffect(() => {
    setValidator(validateScene);
    hydrateFromStorage();
  }, [setValidator, hydrateFromStorage]);

  // Escape closes SetupWizard or clears active fixture selection in Orbit mode
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (wizardOpen) {
        setWizardOpen(false);
        return;
      }
      if (!intakeOpen && cameraMode === 'orbit' && selectedId) {
        selectObject(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    wizardOpen,
    setWizardOpen,
    intakeOpen,
    cameraMode,
    selectedId,
    selectObject,
  ]);

  const handleWalkerPose = useCallback((pose: WalkerPose) => {
    setWalkerPose(pose);
  }, []);

  const isWalkthrough = cameraMode === 'walkthrough';

  const selectedObject = useMemo(
    () => scene.objects.find((obj) => obj.id === selectedId) ?? null,
    [scene.objects, selectedId]
  );

  // Right Studio Drawer opens when pinned (e.g. Shop / Review Purchases / Toolbar toggle),
  // when voice requests browsing/ordering Shopify products,
  // or whenever an object is selected in Orbit mode unless explicitly dismissed.
  const voiceShopDrawerOpen = shopDrawerRequestedEpoch > dismissedShopEpoch;
  const rightDrawerOpen =
    voiceShopDrawerOpen ||
    (!isWalkthrough &&
      (drawerPinnedOpen ||
        (selectedObject !== null && dismissedInspectorId !== selectedObject.id)));

  const handleCloseRightDrawer = useCallback(() => {
    setDrawerPinnedOpen(false);
    setDismissedShopEpoch(shopDrawerRequestedEpoch);
    setDismissedInspectorId(selectedId);
    setRightPanelTab('inspect');
  }, [selectedId, setRightPanelTab, shopDrawerRequestedEpoch]);

  const handleToggleInventory = useCallback(() => {
    if (isWalkthrough) {
      setCameraMode('orbit');
      setInventoryPref(true);
      return;
    }
    setInventoryPref((prev) => {
      const currentlyOpen =
        prev ?? (typeof window !== 'undefined' ? window.innerWidth >= 768 : true);
      return !currentlyOpen;
    });
  }, [isWalkthrough, setCameraMode]);

  const handleToggleInspector = useCallback(() => {
    if (isWalkthrough) {
      setCameraMode('orbit');
      setDrawerPinnedOpen(true);
      setDismissedInspectorId(null);
      if (!selectedId && scene.objects.length > 0) {
        selectObject(scene.objects[0].id);
      }
      return;
    }

    if (rightDrawerOpen) {
      setDrawerPinnedOpen(false);
      setDismissedInspectorId(selectedId);
      return;
    }

    setDrawerPinnedOpen(true);
    setDismissedInspectorId(null);
    if (
      rightPanelTab === 'inspect' &&
      !selectedId &&
      scene.objects.length > 0
    ) {
      selectObject(scene.objects[0].id);
    }
  }, [
    isWalkthrough,
    rightDrawerOpen,
    rightPanelTab,
    selectedId,
    scene.objects,
    selectObject,
    setCameraMode,
  ]);

  const handleOpenShop = useCallback(() => {
    if (!isWalkthrough && rightDrawerOpen && rightPanelTab === 'shop') {
      setDrawerPinnedOpen(false);
      setDismissedInspectorId(selectedId ?? '__closed__');
      return;
    }
    if (isWalkthrough) {
      setCameraMode('orbit');
    }
    if (!selectedId) {
      const firstProposed =
        scene.objects.find((obj) => obj.source === 'proposal') ??
        scene.objects.find((obj) => obj.source !== 'owned');
      if (firstProposed) {
        selectObject(firstProposed.id);
      }
    }
    setRightPanelTab('shop');
    setDrawerPinnedOpen(true);
    setDismissedInspectorId(null);
  }, [
    isWalkthrough,
    rightDrawerOpen,
    rightPanelTab,
    setCameraMode,
    selectedId,
    scene.objects,
    selectObject,
    setRightPanelTab,
  ]);

  const handleSwitchToShopTab = useCallback(() => {
    setRightPanelTab('shop');
    setDrawerPinnedOpen(true);
    setDismissedInspectorId(null);
  }, [setRightPanelTab]);

  const handleSwitchToInspectTab = useCallback(() => {
    setRightPanelTab('inspect');
    setDismissedInspectorId(null);
  }, [setRightPanelTab]);

  const handleSelectFixture = useCallback(
    (id: string) => {
      selectObject(id);
      setDismissedInspectorId(null);
    },
    [selectObject]
  );

  const [swapToast, setSwapToast] = useState<{
    objectId: string;
    title: string;
    seller: string;
    price: string;
  } | null>(null);
  const swapToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (swapToastTimerRef.current) {
        clearTimeout(swapToastTimerRef.current);
      }
    };
  }, []);

  const handleReplaceObjectProduct = useCallback(
    (objectId: string, product: ProductRef, verifiedSize?: Vec3) => {
      const currentObj = scene.objects.find((obj) => obj.id === objectId);
      if (!currentObj) return;
      const patch = computeReplacementPatch(currentObj, product, verifiedSize);
      const nextKind = patch.kind ?? currentObj.kind;
      const nextSize = verifiedSize
        ? verifiedSize
        : normalizeObjectSizeForRoom(
            (patch.size as Vec3 | undefined) ?? currentObj.size,
            nextKind,
            scene.room,
            product.title
          );
      updateObject(objectId, { ...patch, size: nextSize });
      selectObject(objectId);

      // Vision-based product photo -> closest 3D GLB + sampled color match
      const { setVisionModelOverride } = useSceneStore.getState();
      setVisionModelOverride(objectId, null);
      void fetch('/api/match-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: product.title,
          imageUrl: product.imageUrl,
        }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((match) => {
          if (!match || typeof match.glbKey !== 'string') return;
          setVisionModelOverride(objectId, {
            glbKey: match.glbKey,
            dominantColorHex: match.dominantColorHex,
            overrideAlbedo: Boolean(match.overrideAlbedo),
          });
          if (!verifiedSize && Array.isArray(match.estimatedSize) && match.estimatedSize.length === 3) {
            updateObject(objectId, {
              kind: match.inferredKind ?? patch.kind,
              size: match.estimatedSize as Vec3,
            });
          }
        })
        .catch(() => {
          // Graceful fallback: keep deterministic catalog match
        });

      setSwapToast({
        objectId,
        title: product.title,
        seller: product.seller,
        price: formatCents(product.priceCents, product.currency),
      });
      if (swapToastTimerRef.current) {
        clearTimeout(swapToastTimerRef.current);
      }
      swapToastTimerRef.current = setTimeout(() => {
        setSwapToast(null);
      }, 4200);
    },
    [scene.objects, scene.room, updateObject, selectObject]
  );

  const handleAddObjectProduct = useCallback(
    (product: ProductRef, verifiedSize?: Vec3) => {
      // Deduplicate: if this exact Shopify product is already in the room, select it cleanly
      const existingSame = scene.objects.find(
        (obj) => obj.product?.productId === product.productId
      );
      if (existingSame) {
        selectObject(existingSame.id);
        setSwapToast({
          objectId: existingSame.id,
          title: `Already in room: ${product.title}`,
          seller: product.seller,
          price: formatCents(product.priceCents, product.currency),
        });
        return;
      }

      const templateObj: SceneObject = {
        id: `shopify-${Date.now()}`,
        kind: 'table',
        label: product.title,
        source: 'shopify',
        position: [0, 0, 0],
        size: [1.0, 0.85, 0.7],
        rotationY: 0,
        dimensionsVerified: Boolean(verifiedSize),
      };
      const patch = computeReplacementPatch(templateObj, product, verifiedSize);
      const nextKind = patch.kind ?? templateObj.kind;
      const rawSize: Vec3 = (patch.size as Vec3 | undefined) ?? templateObj.size;
      const nextSize: Vec3 = verifiedSize
        ? rawSize
        : normalizeObjectSizeForRoom(rawSize, nextKind, scene.room, product.title);

      // Pick an open collision-free floor position inside room bounds
      const halfW = Math.max(0.4, scene.room.width / 2 - nextSize[0] / 2 - 0.2);
      const halfD = Math.max(0.4, scene.room.depth / 2 - nextSize[2] / 2 - 0.2);
      const candidates: Array<[number, number]> = [[0, 0]];
      const step = 0.45;
      for (let r = step; r <= Math.max(halfW, halfD); r += step) {
        candidates.push(
          [r, 0],
          [-r, 0],
          [0, r],
          [0, -r],
          [r, r],
          [-r, r],
          [r, -r],
          [-r, -r]
        );
      }

      const isFree = (cx: number, cz: number) => {
        if (Math.abs(cx) > halfW || Math.abs(cz) > halfD) return false;
        const pad = 0.12;
        for (const obj of scene.objects) {
          const dx = Math.abs(cx - obj.position[0]);
          const dz = Math.abs(cz - obj.position[2]);
          const minX = (nextSize[0] + obj.size[0]) / 2 + pad;
          const minZ = (nextSize[2] + obj.size[2]) / 2 + pad;
          if (dx < minX && dz < minZ) return false;
        }
        return true;
      };

      let bestPos: Vec3 = [0, 0, 0];
      for (const [cx, cz] of candidates) {
        if (isFree(cx, cz)) {
          bestPos = [Number(cx.toFixed(2)), 0, Number(cz.toFixed(2))];
          break;
        }
      }

      const newObj: SceneObject = {
        ...templateObj,
        ...patch,
        id: templateObj.id,
        kind: nextKind,
        label: product.title,
        source: 'shopify',
        product,
        position: bestPos,
        size: nextSize,
        rotationY: 0,
        dimensionsVerified: Boolean(verifiedSize),
      };

      setScene({
        ...scene,
        objects: deduplicateSceneObjects([...scene.objects, newObj]),
      });
      selectObject(newObj.id);

      // Vision + Decisions API (gemini-decision-1 + gemini-4-hydrogen) photo -> closest 3D GLB match
      const { setVisionModelOverride } = useSceneStore.getState();
      setVisionModelOverride(newObj.id, null);
      void fetch('/api/match-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: product.title,
          imageUrl: product.imageUrl,
        }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((match) => {
          if (!match || typeof match.glbKey !== 'string') return;
          setVisionModelOverride(newObj.id, {
            glbKey: match.glbKey,
            dominantColorHex: match.dominantColorHex,
            overrideAlbedo: Boolean(match.overrideAlbedo),
          });
          if (
            !verifiedSize &&
            Array.isArray(match.estimatedSize) &&
            match.estimatedSize.length === 3
          ) {
            updateObject(newObj.id, {
              kind: match.inferredKind ?? nextKind,
              size: match.estimatedSize as Vec3,
            });
          }
        })
        .catch(() => {
          // Graceful fallback: keep deterministic catalog match
        });

      setSwapToast({
        objectId: newObj.id,
        title: `Added: ${product.title}`,
        seller: product.seller,
        price: formatCents(product.priceCents, product.currency),
      });
      if (swapToastTimerRef.current) {
        clearTimeout(swapToastTimerRef.current);
      }
      swapToastTimerRef.current = setTimeout(() => {
        setSwapToast(null);
      }, 4200);
    },
    [scene, setScene, selectObject, updateObject]
  );

  const handleWizardScenePlanned = useCallback(
    (nextScene: ShopScene) => {
      setScene(nextScene);
      const isFallback = nextScene.warnings.some((warning) =>
        /without ai|offline|fallback|local/i.test(warning)
      );
      setAiTrace({
        analyzeModel: isFallback ? undefined : 'gemini-4-neon',
        planModel: isFallback ? undefined : 'gemini-4-hydrogen',
        warnings: nextScene.warnings,
        mode: isFallback ? 'local-fallback' : 'live-gemini',
        updatedAt: new Date().toISOString(),
      });
      setWizardOpen(false);
    },
    [setScene, setAiTrace, setWizardOpen]
  );

  const {
    ownedObjects,
    proposedObjects,
    shopifyObjects,
    errorIssues,
    errorIds,
    warningIds,
    spentCents,
  } = useMemo(() => {
    const owned: SceneObject[] = [];
    const proposed: SceneObject[] = [];
    const shopify: SceneObject[] = [];
    let spent = 0;

    for (const obj of scene.objects) {
      if (obj.source === 'owned') {
        owned.push(obj);
      } else {
        proposed.push(obj);
        if (obj.product && obj.source === 'shopify' && cartObjectIds.includes(obj.id)) {
          spent += Math.round(obj.product.priceCents);
          shopify.push(obj);
        }
      }
    }

    const errors: ConstraintIssue[] = [];
    const errSet = new Set<string>();
    const warnSet = new Set<string>();

    for (const issue of issues) {
      if (issue.severity === 'error') {
        errors.push(issue);
        for (const id of issue.objectIds) errSet.add(id);
      } else {
        for (const id of issue.objectIds) warnSet.add(id);
      }
    }

    return {
      ownedObjects: owned,
      proposedObjects: proposed,
      shopifyObjects: shopify,
      errorIssues: errors,
      errorIds: errSet,
      warningIds: warnSet,
      spentCents: spent,
    };
  }, [scene.objects, issues, cartObjectIds]);

  const selectedIssues = useMemo(() => {
    if (!selectedObject) return [];
    return issues.filter((issue) =>
      issue.objectIds.includes(selectedObject.id)
    );
  }, [issues, selectedObject]);

  const showInventoryDesktopDefault = !isWalkthrough && inventoryPref === null;
  const showInventoryForcedOpen = !isWalkthrough && inventoryPref === true;
  const toolbarInventoryActive = !isWalkthrough && inventoryPref !== false;
  const isOverBudget = spentCents > scene.budgetCents;

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-zinc-950 font-sans text-zinc-100">
      {/* Full-Bleed 3D Boutique Viewport (100% of h-screen w-screen) */}
      <div className="absolute inset-0">
        <SpaceCanvas validator={validateScene} onWalkerPose={handleWalkerPose} />
      </div>

      {/* Floating Glass Top HUD Toolbar */}
      <SceneToolbar
        inventoryOpen={toolbarInventoryActive}
        onToggleInventory={handleToggleInventory}
        inspectorOpen={rightDrawerOpen}
        onToggleInspector={handleToggleInspector}
        onOpenShop={handleOpenShop}
      />

      {/* Instant 3D Replacement Confirmation Toast */}
      {swapToast && !isWalkthrough && (
        <div
          role="status"
          data-testid="swap-confirmation-toast"
          className="pointer-events-auto fixed left-1/2 top-[70px] z-30 flex max-w-[min(520px,90vw)] -translate-x-1/2 items-center gap-2.5 rounded-2xl border border-emerald-400/45 bg-emerald-950/92 px-3.5 py-2 text-xs text-emerald-50 shadow-[0_14px_40px_rgba(6,78,59,0.55)] backdrop-blur-xl"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-300" />
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            <span className="shrink-0 font-semibold text-emerald-200">Replaced in 3D:</span>
            <span className="truncate font-medium text-white">{swapToast.title}</span>
            <span className="shrink-0 font-semibold text-amber-200">({swapToast.price})</span>
          </div>
          <button
            type="button"
            onClick={() => {
              selectObject(swapToast.objectId);
              setRightPanelTab('inspect');
              setSwapToast(null);
            }}
            className="shrink-0 cursor-pointer rounded-lg border border-emerald-300/35 bg-emerald-400/20 px-2.5 py-1 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-400/30"
          >
            Inspect
          </button>
          <button
            type="button"
            aria-label="Dismiss replacement confirmation"
            onClick={() => setSwapToast(null)}
            className="shrink-0 cursor-pointer text-emerald-200/70 hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Collapsible Floating Left Inventory & Space Drawer */}
      {(showInventoryDesktopDefault || showInventoryForcedOpen) && (
        <aside
          aria-label="Boutique Inventory and Room Specs"
          className={`${
            showInventoryDesktopDefault ? 'hidden md:flex' : 'flex'
          } pointer-events-auto fixed bottom-16 left-3 top-[68px] z-20 w-[260px] flex-col overflow-hidden rounded-2xl border border-white/12 bg-zinc-950/76 shadow-[0_18px_50px_rgba(0,0,0,0.48)] backdrop-blur-xl`}
        >
          {/* Drawer Header & Room Specs */}
          <div className="border-b border-white/10 px-3.5 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <Box className="h-3.5 w-3.5 text-amber-300" />
                <h2 className="text-xs font-semibold tracking-tight text-white">
                  Space &amp; Inventory
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setInventoryPref(false)}
                title="Collapse Inventory Drawer"
                aria-label="Collapse Inventory Drawer"
                className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-2.5 grid grid-cols-2 gap-1.5 text-[11px]">
              <div className="rounded-xl border border-white/8 bg-white/[0.04] px-2.5 py-1.5">
                <div className="text-[10px] text-zinc-400">Envelope</div>
                <div className="font-semibold text-zinc-100">
                  {metersToFeet(scene.room.width)}×{metersToFeet(scene.room.depth)} ft
                </div>
              </div>
              <div className="rounded-xl border border-white/8 bg-white/[0.04] px-2.5 py-1.5">
                <div className="text-[10px] text-zinc-400">Ceiling / Entry</div>
                <div className="font-semibold capitalize text-zinc-100">
                  {metersToFeet(scene.room.height)} ft · {scene.room.entrance.wall}
                </div>
              </div>
            </div>

            <p className="mt-2 line-clamp-2 text-[11px] leading-snug text-zinc-400">
              {scene.style}
            </p>
          </div>

          {/* Scrollable Fixtures List */}
          <div className="flex-1 space-y-3 overflow-y-auto px-2.5 py-3">
            {/* Owned Section */}
            <div>
              <div className="mb-1.5 flex items-center justify-between px-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-300/90">
                <span>Owned Fixtures ({ownedObjects.length})</span>
                <span>$0</span>
              </div>
              <div className="space-y-1">
                {ownedObjects.map((obj) => (
                  <FixtureListItem
                    key={obj.id}
                    obj={obj}
                    isSelected={selectedId === obj.id}
                    hasError={errorIds.has(obj.id)}
                    hasWarning={warningIds.has(obj.id)}
                    onSelect={() => handleSelectFixture(obj.id)}
                  />
                ))}
                {ownedObjects.length === 0 && (
                  <p className="px-2 py-1 text-[11px] text-zinc-500">
                    No owned fixtures listed.
                  </p>
                )}
              </div>
            </div>

            {/* Proposed / Sourced Section */}
            <div>
              <div className="mb-1.5 flex items-center justify-between px-1 text-[10px] font-semibold uppercase tracking-wider text-amber-200/90">
                <span>Proposed &amp; Sourced ({proposedObjects.length})</span>
              </div>
              <div className="space-y-1">
                {proposedObjects.map((obj) => (
                  <FixtureListItem
                    key={obj.id}
                    obj={obj}
                    isSelected={selectedId === obj.id}
                    hasError={errorIds.has(obj.id)}
                    hasWarning={warningIds.has(obj.id)}
                    onSelect={() => handleSelectFixture(obj.id)}
                  />
                ))}
                {proposedObjects.length === 0 && (
                  <p className="px-2 py-1 text-[11px] text-zinc-500">
                    No proposed fixtures placed.
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Drawer Footer Badges */}
          <div className="flex items-center justify-between border-t border-white/10 px-3.5 py-2 text-[10px] text-zinc-400">
            <span>
              Min walkway: {metersToFeet(scene.minWalkwayWidth)} ft
            </span>
            {scene.noDrilling && (
              <span className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 font-medium text-zinc-300">
                No-Drilling
              </span>
            )}
          </div>
        </aside>
      )}

      {/* Collapsible Floating Right Studio Drawer (Inspect + Live Shopify Shop & Cart) */}
      {rightDrawerOpen && (
        <section
          aria-label="Studio Inspector and Shopify Commerce Drawer"
          className={`pointer-events-auto fixed bottom-16 right-3 top-[68px] z-20 flex flex-col overflow-hidden rounded-2xl border border-white/12 bg-zinc-950/84 shadow-[0_18px_50px_rgba(0,0,0,0.55)] backdrop-blur-xl transition-[width] duration-200 ${
            rightPanelTab === 'shop'
              ? 'w-[380px] max-w-[calc(100vw-24px)]'
              : 'w-[292px] max-w-[calc(100vw-24px)]'
          }`}
        >
          {/* 2-Tab Segmented Drawer Header */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-3 py-2.5">
            <div
              role="tablist"
              aria-label="Studio Right Panel Tabs"
              className="grid flex-1 grid-cols-2 gap-1 rounded-xl bg-white/6 p-0.5"
            >
              <button
                type="button"
                role="tab"
                data-testid="right-tab-inspect"
                aria-selected={rightPanelTab === 'inspect'}
                onClick={handleSwitchToInspectTab}
                className={`flex cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-all ${
                  rightPanelTab === 'inspect'
                    ? 'bg-white text-zinc-950 shadow-sm'
                    : 'text-zinc-300 hover:bg-white/8 hover:text-white'
                }`}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                <span>Inspect</span>
              </button>

              <button
                type="button"
                role="tab"
                data-testid="right-tab-shop"
                aria-selected={rightPanelTab === 'shop'}
                onClick={handleSwitchToShopTab}
                className={`flex cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-all ${
                  rightPanelTab === 'shop'
                    ? 'bg-gradient-to-r from-emerald-300 to-amber-200 text-zinc-950 shadow-sm'
                    : 'text-zinc-300 hover:bg-white/8 hover:text-white'
                }`}
              >
                <ShoppingBag className="h-3.5 w-3.5" />
                <span>Shop &amp; Cart</span>
                {shopifyObjects.length > 0 && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold leading-none ${
                      rightPanelTab === 'shop'
                        ? 'bg-zinc-950/20 text-zinc-950'
                        : 'bg-emerald-500/25 text-emerald-200'
                    }`}
                  >
                    {shopifyObjects.length}
                  </span>
                )}
              </button>
            </div>

            <button
              type="button"
              onClick={handleCloseRightDrawer}
              aria-label="Close Fixture Inspector"
              className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {rightPanelTab === 'inspect' ? (
            selectedObject ? (
              <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3.5">
                {/* Selected Fixture Identity */}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="rounded-md bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200">
                      {selectedObject.kind}
                    </span>
                    <span
                      className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium capitalize ${
                        selectedObject.source === 'shopify'
                          ? 'border border-emerald-400/35 bg-emerald-500/18 text-emerald-200'
                          : selectedObject.source === 'owned'
                            ? 'bg-white/8 text-emerald-200/90'
                            : 'bg-amber-400/12 text-amber-200'
                      }`}
                    >
                      {selectedObject.source}
                    </span>
                  </div>
                  <h2 className="mt-1.5 text-sm font-semibold leading-snug text-white">
                    {selectedObject.label}
                  </h2>
                  {selectedObject.source === 'shopify' &&
                    selectedObject.product && (
                      <p className="mt-0.5 truncate text-[11px] text-emerald-200/85">
                        Linked: {selectedObject.product.title}
                      </p>
                    )}
                </div>

                {/* Quick Fixture Actions */}
                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    disabled={Boolean(selectedObject.locked)}
                    onClick={() => rotateObject(selectedObject.id, Math.PI / 2)}
                    className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-white/10 bg-white/[0.05] px-2 py-2 text-[11px] font-medium text-zinc-100 transition-colors hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <RotateCw className="h-3.5 w-3.5 text-amber-300" />
                    <span>Rotate 90°</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => toggleLock(selectedObject.id)}
                    className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border px-2 py-2 text-[11px] font-medium transition-colors ${
                      selectedObject.locked
                        ? 'border-amber-300/40 bg-amber-300/15 text-amber-100'
                        : 'border-white/10 bg-white/[0.05] text-zinc-100 hover:bg-white/12'
                    }`}
                  >
                    {selectedObject.locked ? (
                      <Lock className="h-3.5 w-3.5 text-amber-300" />
                    ) : (
                      <Unlock className="h-3.5 w-3.5 text-zinc-300" />
                    )}
                    <span>{selectedObject.locked ? 'Locked' : 'Lock'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => removeObject(selectedObject.id)}
                    className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-red-400/20 bg-red-500/10 px-2 py-2 text-[11px] font-medium text-red-200 transition-colors hover:bg-red-500/20"
                  >
                    <Trash2 className="h-3.5 w-3.5 text-red-300" />
                    <span>Remove</span>
                  </button>
                </div>

                {/* Dimensions & Verification Badge */}
                <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                      Dimensions
                    </span>
                    {selectedObject.dimensionsVerified ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/35 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-200">
                        <ShieldCheck className="h-3 w-3" />
                        Verified
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/35 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-200">
                        <AlertTriangle className="h-3 w-3" />
                        Approximate
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-3 gap-1.5 text-center">
                    <div className="rounded-lg bg-black/30 px-1.5 py-1.5">
                      <div className="text-[10px] text-zinc-400">Width</div>
                      <div className="text-xs font-semibold text-white">
                        {metersToFeet(selectedObject.size[0])} ft
                      </div>
                      <div className="text-[10px] text-zinc-500">
                        {selectedObject.size[0].toFixed(2)} m
                      </div>
                    </div>
                    <div className="rounded-lg bg-black/30 px-1.5 py-1.5">
                      <div className="text-[10px] text-zinc-400">Depth</div>
                      <div className="text-xs font-semibold text-white">
                        {metersToFeet(selectedObject.size[2])} ft
                      </div>
                      <div className="text-[10px] text-zinc-500">
                        {selectedObject.size[2].toFixed(2)} m
                      </div>
                    </div>
                    <div className="rounded-lg bg-black/30 px-1.5 py-1.5">
                      <div className="text-[10px] text-zinc-400">Height</div>
                      <div className="text-xs font-semibold text-white">
                        {metersToFeet(selectedObject.size[1])} ft
                      </div>
                      <div className="text-[10px] text-zinc-500">
                        {selectedObject.size[1].toFixed(2)} m
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-1 text-[11px] text-zinc-400">
                    <span>
                      Pos: ({metersToFeet(selectedObject.position[0])},{' '}
                      {metersToFeet(selectedObject.position[2])}) ft
                    </span>
                    <span>Yaw: {normalizeDeg(selectedObject.rotationY)}°</span>
                  </div>
                </div>

                {/* Sourcing & Budget Section (Strictly Truthful) */}
                <div className="space-y-2.5 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    Sourcing &amp; Budget
                  </div>

                  {selectedObject.source === 'owned' ? (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-emerald-200">
                          Owned Existing Fixture
                        </span>
                        <span className="font-semibold text-emerald-300">
                          $0
                        </span>
                      </div>
                      <p className="text-[11px] leading-relaxed text-zinc-400">
                        Already owned on-site — contributes $0.00 toward your
                        new-fixture purchase budget.
                      </p>
                    </div>
                  ) : selectedObject.product ? (
                    <div className="space-y-2.5">
                      <div className="flex items-start gap-2.5">
                        {selectedObject.product.imageUrl &&
                          brokenThumbUrl !==
                            selectedObject.product.imageUrl && (
                            <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-white/12 bg-black/40">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={selectedObject.product.imageUrl}
                                alt={selectedObject.product.title}
                                onError={() =>
                                  setBrokenThumbUrl(
                                    selectedObject.product?.imageUrl ?? null
                                  )
                                }
                                className="h-full w-full object-cover"
                              />
                            </div>
                          )}

                        <div className="min-w-0 flex-1">
                          <div className="line-clamp-2 text-xs font-semibold leading-snug text-white">
                            {selectedObject.product.title}
                          </div>
                          <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px]">
                            <span className="truncate text-zinc-400">
                              {selectedObject.product.seller}
                            </span>
                            <span className="shrink-0 font-semibold text-emerald-300">
                              {formatCents(
                                selectedObject.product.priceCents,
                                selectedObject.product.currency
                              )}
                            </span>
                          </div>
                        </div>
                      </div>

                      <a
                        href={selectedObject.product.productUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-white/8 px-3 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-white/15"
                      >
                        <span>View Live Shopify Product</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>

                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          type="button"
                          data-testid="inspector-swap-product-btn"
                          onClick={handleSwitchToShopTab}
                          className="flex cursor-pointer items-center justify-center gap-1 rounded-lg border border-emerald-400/35 bg-emerald-500/15 px-2 py-1.5 text-[11px] font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/25"
                        >
                          <RefreshCw className="h-3 w-3" />
                          <span>Swap Product</span>
                        </button>
                        <button
                          type="button"
                          data-testid="inspector-unlink-sku-btn"
                          onClick={() => clearObjectProduct(selectedObject.id)}
                          className="flex cursor-pointer items-center justify-center gap-1 rounded-lg border border-white/12 bg-white/[0.05] px-2 py-1.5 text-[11px] font-medium text-zinc-300 transition-colors hover:border-red-400/35 hover:bg-red-500/12 hover:text-red-200"
                        >
                          <Unlink className="h-3 w-3" />
                          <span>Unlink SKU</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-amber-100">
                          Spatial Layout Proposal
                        </span>
                        <span className="text-[11px] text-zinc-400">
                          Unpriced
                        </span>
                      </div>
                      <p className="text-[11px] leading-relaxed text-zinc-400">
                        Placeholder geometry staged for proportion check. Match
                        a live Shopify SKU to verify exact dimensions &amp;
                        price.
                      </p>
                      <button
                        type="button"
                        data-testid="browse-shopify-matches-btn"
                        onClick={handleSwitchToShopTab}
                        className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-300 via-amber-200 to-emerald-300 px-3 py-2 text-[11px] font-semibold text-zinc-950 shadow-sm transition-transform hover:brightness-105 active:scale-[0.99]"
                      >
                        <span>Browse Real Shopify Matches</span>
                        <ArrowRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>

                {/* Per-Object Validation Issues */}
                <div className="space-y-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    Constraint Checks
                  </div>

                  {selectedIssues.length === 0 ? (
                    <div className="flex items-center gap-2 rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
                      <span>Clear of walls, fixtures &amp; entrance path.</span>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {selectedIssues.map((issue, idx) => (
                        <div
                          key={`${issue.code}-${idx}`}
                          className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-[11px] leading-snug ${
                            issue.severity === 'error'
                              ? 'border-red-400/35 bg-red-500/14 text-red-100'
                              : 'border-amber-400/30 bg-amber-500/12 text-amber-100'
                          }`}
                        >
                          <AlertTriangle
                            className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                              issue.severity === 'error'
                                ? 'text-red-300'
                                : 'text-amber-300'
                            }`}
                          />
                          <span>{issue.message}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-5 text-center">
                <span className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-amber-300">
                  <Box className="h-5 w-5" />
                </span>
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-white">
                    No Fixture Selected
                  </p>
                  <p className="text-[11px] leading-relaxed text-zinc-400">
                    Click any fixture in the 3D boutique or inventory list to
                    inspect dimensions, constraints, and live Shopify sourcing.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleOpenShop}
                  className="mt-1 flex cursor-pointer items-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-300 to-emerald-300 px-3.5 py-2 text-xs font-semibold text-zinc-950 transition-transform hover:brightness-105"
                >
                  <ShoppingBag className="h-3.5 w-3.5" />
                  <span>Browse Shopify Catalog</span>
                </button>
              </div>
            )
          ) : (
            <div className="min-h-0 flex-1 overflow-hidden [&>aside]:rounded-none [&>aside]:border-0 [&>aside]:bg-transparent [&>aside]:shadow-none">
              <ProductPanel
                selectedObject={selectedObject}
                scene={scene}
                onReplaceObjectProduct={handleReplaceObjectProduct}
                onAddObjectProduct={handleAddObjectProduct}
              />
            </div>
          )}
        </section>
      )}

      {/* Bottom-Center Walkthrough Controls HUD */}
      {isWalkthrough ? (
        <div className="pointer-events-auto fixed bottom-4 left-1/2 z-30 flex max-w-[96vw] -translate-x-1/2 items-center gap-3 rounded-2xl border border-white/15 bg-zinc-950/82 px-3.5 py-2.5 text-zinc-100 shadow-[0_18px_55px_rgba(0,0,0,0.58)] backdrop-blur-xl">
          <MiniFloorplan scene={scene} pose={walkerPose} />

          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-400/18 px-2 py-0.5 text-[11px] font-semibold text-emerald-200">
                <Footprints className="h-3 w-3" />
                Walkthrough
              </span>

              <span className="font-mono text-[11px] text-zinc-200">
                X {walkerPose.x >= 0 ? '+' : ''}
                {metersToFeet(walkerPose.x)} ft · Z {walkerPose.z >= 0 ? '+' : ''}
                {metersToFeet(walkerPose.z)} ft · {walkerPose.yawDeg}°{' '}
                {compassLabel(walkerPose.yawDeg)}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-300">
              <span>
                <kbd className="rounded bg-white/12 px-1.5 py-0.5 font-mono text-[10px] text-white">
                  WASD
                </kbd>{' '}
                /{' '}
                <kbd className="rounded bg-white/12 px-1.5 py-0.5 font-mono text-[10px] text-white">
                  ↑↓
                </kbd>{' '}
                walk
              </span>
              <span className="text-zinc-600">·</span>
              <span>
                {walkerPose.locked ? (
                  <span className="text-emerald-300">
                    360° Look Locked (ESC to unlock)
                  </span>
                ) : (
                  <span>Click viewport or Drag to look 360°</span>
                )}
              </span>
              <span className="hidden text-zinc-600 sm:inline">·</span>
              <span className="hidden sm:inline">
                <kbd className="rounded bg-white/12 px-1.5 py-0.5 font-mono text-[10px] text-white">
                  Shift
                </kbd>{' '}
                faster
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setCameraMode('orbit')}
            className="ml-1 flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-zinc-950 shadow-sm transition-colors hover:bg-zinc-200"
          >
            <Navigation className="h-3.5 w-3.5" />
            <span>Exit Walkthrough</span>
          </button>
        </div>
      ) : (
        /* Bottom-Center Orbit Mode HUD: Voice/Text Replace Bar + Violation Alert + Budget + Review Purchases + AI Provenance */
        <div className="pointer-events-none fixed bottom-3 left-1/2 z-20 flex w-full max-w-[95vw] -translate-x-1/2 flex-col items-center gap-2">
          <ReplaceObjectBar selectedObject={selectedObject} />
          {errorIssues.length > 0 && (
            <button
              type="button"
              onClick={() => {
                const firstId = errorIssues[0]?.objectIds[0];
                if (firstId) {
                  handleSelectFixture(firstId);
                }
              }}
              className="pointer-events-auto flex cursor-pointer items-center gap-2 rounded-2xl border border-red-400/45 bg-red-950/85 px-4 py-2 text-xs font-medium text-red-100 shadow-[0_12px_36px_rgba(127,29,29,0.5)] backdrop-blur-xl transition-transform hover:scale-[1.01]"
            >
              <AlertTriangle className="h-4 w-4 shrink-0 text-red-300" />
              <span className="max-w-md truncate">
                {errorIssues[0].message}
              </span>
              {errorIssues.length > 1 && (
                <span className="rounded-full bg-red-500/35 px-2 py-0.5 text-[10px] font-semibold text-red-100">
                  +{errorIssues.length - 1} more
                </span>
              )}
            </button>
          )}

          <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-white/12 bg-zinc-950/76 px-3.5 py-1.5 text-[11px] text-zinc-300 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl">
            <span className="hidden text-zinc-400 xl:inline">
              Drag to orbit · Click fixture to inspect &amp; move on floor
            </span>
            <span className="hidden text-zinc-700 xl:inline">·</span>

            <span
              className={`inline-flex items-center gap-1 font-medium ${
                isOverBudget ? 'text-red-300' : 'text-zinc-200'
              }`}
            >
              <DollarSign
                className={`h-3.5 w-3.5 ${
                  isOverBudget ? 'text-red-300' : 'text-amber-300'
                }`}
              />
              <span>
                New Budget: {formatBudgetCents(spentCents)} /{' '}
                {formatCents(scene.budgetCents)}
              </span>
            </span>

            <span className="text-zinc-700">·</span>

            <button
              type="button"
              data-testid="bottom-review-purchases-btn"
              onClick={handleOpenShop}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-0.5 text-[11px] font-semibold transition-all ${
                shopifyObjects.length > 0
                  ? 'border-emerald-400/45 bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30'
                  : 'border-white/12 bg-white/[0.06] text-zinc-200 hover:border-amber-300/35 hover:bg-white/12 hover:text-white'
              }`}
            >
              <ShoppingBag
                className={`h-3 w-3 ${
                  shopifyObjects.length > 0
                    ? 'text-emerald-300'
                    : 'text-amber-200'
                }`}
              />
              <span>
                {shopifyObjects.length > 0
                  ? `Review Purchases (${shopifyObjects.length})`
                  : 'Shop Fixtures'}
              </span>
            </button>

            {aiTrace && (
              <>
                <span className="text-zinc-700">·</span>
                <span
                  data-testid="ai-provenance-badge"
                  title={[
                    aiTrace.mode === 'live-gemini'
                      ? 'Live Gemini 4 Pipeline'
                      : 'Local Fallback Preview',
                    aiTrace.analyzeModel
                      ? `Analyze: ${aiTrace.analyzeModel}${
                          aiTrace.analyzeRequestId
                            ? ` (${aiTrace.analyzeRequestId})`
                            : ''
                        }`
                      : null,
                    aiTrace.planModel
                      ? `Plan: ${aiTrace.planModel}${
                          aiTrace.planRequestId
                            ? ` (${aiTrace.planRequestId})`
                            : ''
                        }`
                      : null,
                    typeof aiTrace.observationCount === 'number'
                      ? `Observations: ${aiTrace.observationCount}`
                      : null,
                    typeof aiTrace.repairCount === 'number'
                      ? `Constraint repairs: ${aiTrace.repairCount}`
                      : null,
                    aiTrace.warnings.length > 0
                      ? `Notes: ${aiTrace.warnings.join(' | ')}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join('\n')}
                  className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[10px] font-semibold ${
                    aiTrace.mode === 'live-gemini'
                      ? 'border-emerald-400/35 bg-emerald-500/16 text-emerald-200'
                      : 'border-amber-400/35 bg-amber-500/16 text-amber-200'
                  }`}
                >
                  <Sparkles className="h-3 w-3 shrink-0" />
                  {aiTrace.mode === 'live-gemini' ? (
                    <span>
                      {[aiTrace.analyzeModel, aiTrace.planModel]
                        .filter(Boolean)
                        .join(' + ') || 'gemini-4'}
                      {typeof aiTrace.repairCount === 'number'
                        ? ` · repairs: ${aiTrace.repairCount}`
                        : ''}
                    </span>
                  ) : (
                    <span>Local Preview</span>
                  )}
                </span>
              </>
            )}

            {lastMediaSource && (
              <>
                <span className="text-zinc-700">·</span>
                <button
                  type="button"
                  onClick={() => setIntakeOpen(true)}
                  title={lastMediaSource.notes ?? lastMediaSource.label}
                  className="inline-flex max-w-[190px] cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 bg-white/6 px-2 py-0.5 text-[11px] text-zinc-200 transition-colors hover:bg-white/12"
                >
                  {lastMediaSource.kind === 'camera' ? (
                    <Camera className="h-3 w-3 shrink-0 text-emerald-300" />
                  ) : lastMediaSource.kind === 'youtube' ? (
                    <Link2 className="h-3 w-3 shrink-0 text-amber-300" />
                  ) : lastMediaSource.kind === 'video' ? (
                    <Video className="h-3 w-3 shrink-0 text-amber-300" />
                  ) : (
                    <Film className="h-3 w-3 shrink-0 text-amber-300" />
                  )}
                  <span className="truncate">{lastMediaSource.label}</span>
                  <span
                    className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase ${
                      lastMediaSource.backendConnected
                        ? 'bg-emerald-500/25 text-emerald-200'
                        : 'bg-amber-500/20 text-amber-200'
                    }`}
                  >
                    {lastMediaSource.backendConnected ? 'Gemini' : 'Local'}
                  </span>
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Live Multilingual Voice-Editing Control */}
      <VoiceRoomControl
        rightOffsetPx={
          rightDrawerOpen ? (rightPanelTab === 'shop' ? 404 : 316) : 0
        }
      />

      {/* Multimodal Media Intake Modal */}
      <MediaIntakeModal />

      {/* 4-Step SpatioVerse Setup Wizard Modal */}
      {wizardOpen && (
        <div
          data-testid="setup-wizard-modal"
          role="dialog"
          aria-modal="true"
          aria-label="SpatioVerse Setup Wizard"
          onClick={() => setWizardOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl shadow-[0_28px_90px_rgba(0,0,0,0.75)]"
          >
            <SetupWizard
              initialScene={scene}
              onScenePlanned={handleWizardScenePlanned}
              onClose={() => setWizardOpen(false)}
            />
          </div>
        </div>
      )}
    </main>
  );
}
