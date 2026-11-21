'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  AlertTriangle,
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
  RotateCw,
  ShieldCheck,
  Trash2,
  Unlock,
  Video,
  X,
} from 'lucide-react';
import type { WalkerPose } from '@/components/FirstPersonRig';
import { MediaIntakeModal } from '@/components/MediaIntakeModal';
import { SceneToolbar } from '@/components/SceneToolbar';
import {
  FT_TO_METERS,
  type ConstraintIssue,
  type SceneObject,
  type ShopScene,
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
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-zinc-400">
          <span className="capitalize">{obj.kind}</span>
          <span>·</span>
          <span>
            {metersToFeet(obj.size[0])}×{metersToFeet(obj.size[2])} ft
          </span>
          {obj.source === 'owned' ? (
            <span className="text-emerald-300/90">· $0</span>
          ) : obj.product ? (
            <span className="text-amber-200">
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
  const lastMediaSource = useSceneStore((state) => state.lastMediaSource);

  const hydrateFromStorage = useSceneStore((state) => state.hydrateFromStorage);
  const selectObject = useSceneStore((state) => state.selectObject);
  const setCameraMode = useSceneStore((state) => state.setCameraMode);
  const rotateObject = useSceneStore((state) => state.rotateObject);
  const toggleLock = useSceneStore((state) => state.toggleLock);
  const removeObject = useSceneStore((state) => state.removeObject);
  const setIntakeOpen = useSceneStore((state) => state.setIntakeOpen);

  // Null = default responsive (open on desktop >=768px, closed on mobile)
  const [inventoryPref, setInventoryPref] = useState<boolean | null>(null);
  const [dismissedInspectorId, setDismissedInspectorId] = useState<
    string | null
  >(null);
  const [walkerPose, setWalkerPose] = useState<WalkerPose>(() => ({
    x: scene.room.entrance.offset,
    z: Math.max(0, scene.room.depth * 0.5 - 0.56),
    yawDeg: 0,
    locked: false,
  }));

  // Hydrate persisted scene state once on client mount
  useEffect(() => {
    hydrateFromStorage();
  }, [hydrateFromStorage]);

  // Escape in Orbit mode clears active fixture selection cleanly
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !intakeOpen &&
        cameraMode === 'orbit' &&
        selectedId
      ) {
        selectObject(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [intakeOpen, cameraMode, selectedId, selectObject]);

  const handleWalkerPose = useCallback((pose: WalkerPose) => {
    setWalkerPose(pose);
  }, []);

  const isWalkthrough = cameraMode === 'walkthrough';

  const selectedObject = useMemo(
    () => scene.objects.find((obj) => obj.id === selectedId) ?? null,
    [scene.objects, selectedId]
  );

  // Right Inspector automatically opens when an object is selected in Orbit mode,
  // and hides automatically when nothing is selected or in Walkthrough mode.
  const inspectorOpen =
    !isWalkthrough &&
    selectedObject !== null &&
    dismissedInspectorId !== selectedObject.id;

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
      if (!selectedId && scene.objects.length > 0) {
        selectObject(scene.objects[0].id);
        setDismissedInspectorId(null);
      } else {
        setDismissedInspectorId(null);
      }
      return;
    }

    if (!selectedId) {
      if (scene.objects.length > 0) {
        selectObject(scene.objects[0].id);
        setDismissedInspectorId(null);
      }
      return;
    }

    setDismissedInspectorId((prev) =>
      prev === selectedId ? null : selectedId
    );
  }, [isWalkthrough, selectedId, scene.objects, selectObject, setCameraMode]);

  const handleSelectFixture = useCallback(
    (id: string) => {
      selectObject(id);
      setDismissedInspectorId(null);
    },
    [selectObject]
  );

  const {
    ownedObjects,
    proposedObjects,
    errorIssues,
    errorIds,
    warningIds,
    spentCents,
  } = useMemo(() => {
    const owned: SceneObject[] = [];
    const proposed: SceneObject[] = [];
    let spent = 0;

    for (const obj of scene.objects) {
      if (obj.source === 'owned') {
        owned.push(obj);
      } else {
        proposed.push(obj);
        if (obj.product) {
          spent += obj.product.priceCents;
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
      errorIssues: errors,
      errorIds: errSet,
      warningIds: warnSet,
      spentCents: spent,
    };
  }, [scene.objects, issues]);

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
        <SpaceCanvas onWalkerPose={handleWalkerPose} />
      </div>

      {/* Floating Glass Top HUD Toolbar */}
      <SceneToolbar
        inventoryOpen={toolbarInventoryActive}
        onToggleInventory={handleToggleInventory}
        inspectorOpen={inspectorOpen}
        onToggleInspector={handleToggleInspector}
      />

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

      {/* Collapsible Floating Right Fixture Inspector Drawer */}
      {inspectorOpen && selectedObject && (
        <aside
          aria-label="Selected Fixture Inspector"
          className="pointer-events-auto fixed bottom-16 right-3 top-[68px] z-20 flex w-[280px] flex-col overflow-hidden rounded-2xl border border-white/12 bg-zinc-950/80 shadow-[0_18px_50px_rgba(0,0,0,0.52)] backdrop-blur-xl"
        >
          {/* Inspector Header */}
          <div className="flex items-start justify-between gap-2 border-b border-white/10 px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="rounded-md bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200">
                  {selectedObject.kind}
                </span>
                <span className="rounded-md bg-white/6 px-1.5 py-0.5 text-[10px] font-medium capitalize text-zinc-300">
                  {selectedObject.source}
                </span>
              </div>
              <h2 className="mt-1.5 text-sm font-semibold leading-snug text-white">
                {selectedObject.label}
              </h2>
            </div>
            <button
              type="button"
              onClick={() => setDismissedInspectorId(selectedObject.id)}
              aria-label="Close Fixture Inspector"
              className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3.5">
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
            <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                Sourcing &amp; Budget
              </div>

              {selectedObject.source === 'owned' ? (
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-emerald-200">
                      Owned Existing Fixture
                    </span>
                    <span className="font-semibold text-emerald-300">$0</span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-zinc-400">
                    Already owned on-site — contributes $0.00 toward your new-fixture purchase budget.
                  </p>
                </div>
              ) : selectedObject.product ? (
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-white">
                        {selectedObject.product.title}
                      </div>
                      <div className="text-[11px] text-zinc-400">
                        {selectedObject.product.seller}
                      </div>
                    </div>
                    <span className="shrink-0 text-xs font-semibold text-amber-200">
                      {formatCents(
                        selectedObject.product.priceCents,
                        selectedObject.product.currency
                      )}
                    </span>
                  </div>

                  <a
                    href={selectedObject.product.productUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-white/8 px-3 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-white/15"
                  >
                    <span>View Live Shopify Product</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-amber-100">
                      Spatial Layout Proposal
                    </span>
                    <span className="text-[11px] text-zinc-400">Unpriced</span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-zinc-400">
                    Placeholder geometry staged for proportion check. Match a live Shopify SKU to verify exact dimensions &amp; price.
                  </p>
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
        </aside>
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
        /* Bottom-Center Orbit Mode HUD: Violation Alert Pill OR Orbit Hint + Budget + Media Source */
        <div className="pointer-events-none fixed bottom-3 left-1/2 z-20 flex max-w-[95vw] -translate-x-1/2 flex-col items-center gap-2">
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

          <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-white/12 bg-zinc-950/74 px-3.5 py-1.5 text-[11px] text-zinc-300 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl">
            <span className="hidden text-zinc-400 lg:inline">
              Drag to orbit · Click fixture to inspect &amp; move on floor
            </span>
            <span className="hidden text-zinc-700 lg:inline">·</span>

            <span
              className={`inline-flex items-center gap-1 font-medium ${
                isOverBudget ? 'text-red-300' : 'text-zinc-200'
              }`}
            >
              <DollarSign className="h-3.5 w-3.5 text-amber-300" />
              <span>
                New Budget: {formatBudgetCents(spentCents)} /{' '}
                {formatCents(scene.budgetCents)}
              </span>
            </span>

            {lastMediaSource && (
              <>
                <span className="text-zinc-700">·</span>
                <button
                  type="button"
                  onClick={() => setIntakeOpen(true)}
                  title={lastMediaSource.notes ?? lastMediaSource.label}
                  className="inline-flex max-w-[240px] cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 bg-white/6 px-2 py-0.5 text-[11px] text-zinc-200 transition-colors hover:bg-white/12"
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

      {/* Multimodal Media Intake Modal */}
      <MediaIntakeModal />
    </main>
  );
}
