'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Compass,
  Footprints,
  Grid3x3,
  Orbit,
  PanelLeft,
  PanelRight,
  RotateCcw,
  ShoppingBag,
  Video,
  Wand2,
} from 'lucide-react';
import { SCENE_PRESETS, type ScenePresetKey } from '@/fixtures/demoScene';
import {
  useSceneStore,
  type CameraPreset,
} from '@/store/useSceneStore';

interface SceneToolbarProps {
  inventoryOpen: boolean;
  onToggleInventory: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onOpenShop?: () => void;
}

const PRESET_LABELS: Record<ScenePresetKey, string> = {
  flagship: 'Flagship 24×18',
  compact: 'Compact 12×10',
};

const CAMERA_PRESETS: Array<{ id: CameraPreset; label: string }> = [
  { id: 'perspective', label: '3D' },
  { id: 'top', label: 'Plan' },
  { id: 'entrance', label: 'Entry' },
];

export function SceneToolbar({
  inventoryOpen,
  onToggleInventory,
  inspectorOpen,
  onToggleInspector,
  onOpenShop,
}: SceneToolbarProps) {
  const scene = useSceneStore((state) => state.scene);
  const activePreset = useSceneStore((state) => state.activePreset);
  const cameraMode = useSceneStore((state) => state.cameraMode);
  const cameraPreset = useSceneStore((state) => state.cameraPreset);
  const showGrid = useSceneStore((state) => state.showGrid);
  const issues = useSceneStore((state) => state.issues);
  const lastMediaSource = useSceneStore((state) => state.lastMediaSource);
  const wizardOpen = useSceneStore((state) => state.wizardOpen);
  const rightPanelTab = useSceneStore((state) => state.rightPanelTab);

  const switchPreset = useSceneStore((state) => state.switchPreset);
  const setCameraMode = useSceneStore((state) => state.setCameraMode);
  const setCameraPreset = useSceneStore((state) => state.setCameraPreset);
  const toggleGrid = useSceneStore((state) => state.toggleGrid);
  const resetScene = useSceneStore((state) => state.resetScene);
  const setIntakeOpen = useSceneStore((state) => state.setIntakeOpen);
  const setWizardOpen = useSceneStore((state) => state.setWizardOpen);
  const setRightPanelTab = useSceneStore((state) => state.setRightPanelTab);

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter(
    (issue) => issue.severity === 'warning'
  ).length;
  const cartObjectIds = useSceneStore((state) => state.cartObjectIds);
  const shopifyCount = scene.objects.filter(
    (obj) =>
      obj.source === 'shopify' &&
      Boolean(obj.product) &&
      cartObjectIds.includes(obj.id)
  ).length;
  const isWalkthrough = cameraMode === 'walkthrough';
  const shopActive = inspectorOpen && rightPanelTab === 'shop';

  const handleOpenShopClick = () => {
    if (onOpenShop) {
      onOpenShop();
      return;
    }
    if (isWalkthrough) {
      setCameraMode('orbit');
    }
    setRightPanelTab('shop');
  };

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-30 flex flex-wrap items-center justify-between gap-2 p-2.5 lg:p-3">
      {/* Left Capsule: Brand, Preset Switcher & Live Validation Badge */}
      <div className="pointer-events-auto flex items-center gap-1.5 rounded-2xl border border-white/12 bg-zinc-950/75 px-2 py-1.5 text-zinc-100 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl">
        <div className="flex items-center gap-2 pr-0.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-gradient-to-br from-amber-300/90 via-amber-500/85 to-emerald-500/85 text-zinc-950 shadow-inner">
            <Compass className="h-4 w-4 stroke-[2.25]" />
          </span>
          <div className="leading-none">
            <div className="text-[13px] font-semibold tracking-tight text-white">
              SpatioVerse
            </div>
            <div className="hidden text-[10px] font-medium text-zinc-400 2xl:block">
              3D Retail Studio
            </div>
          </div>
        </div>

        <div className="h-5 w-px bg-white/10" />

        {/* Preset Pill Switcher */}
        <div
          className="flex items-center rounded-xl bg-white/6 p-0.5"
          role="group"
          aria-label="Room Preset"
        >
          {(Object.keys(SCENE_PRESETS) as ScenePresetKey[]).map((key) => {
            const active = activePreset === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => switchPreset(key)}
                title={SCENE_PRESETS[key].subtitle}
                className={`cursor-pointer rounded-lg px-2 py-1 text-[11px] font-medium transition-all ${
                  active
                    ? 'bg-white text-zinc-950 shadow-sm'
                    : 'text-zinc-300 hover:bg-white/8 hover:text-white'
                }`}
              >
                {PRESET_LABELS[key]}
              </button>
            );
          })}
        </div>

        {/* Validation Status Badge */}
        <div
          title={
            errorCount > 0
              ? `${errorCount} blocking spatial/budget issue${errorCount === 1 ? '' : 's'}`
              : warningCount > 0
                ? `Valid layout · ${warningCount} approximate dimension note${warningCount === 1 ? '' : 's'}`
                : 'All spatial and budget constraints pass'
          }
          className={`flex items-center gap-1.5 rounded-xl border px-2 py-1 text-[11px] font-semibold tracking-tight ${
            errorCount > 0
              ? 'border-red-400/40 bg-red-500/20 text-red-200'
              : 'border-emerald-400/35 bg-emerald-500/18 text-emerald-200'
          }`}
        >
          {errorCount > 0 ? (
            <>
              <AlertTriangle className="h-3.5 w-3.5 text-red-300" />
              <span>
                {errorCount} {errorCount === 1 ? 'Issue' : 'Issues'}
              </span>
            </>
          ) : (
            <>
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
              <span>Valid</span>
            </>
          )}
        </div>
      </div>

      {/* Center Capsule: Orbit Editor vs Walk Through + Camera Presets */}
      <div className="pointer-events-auto flex items-center gap-1.5 rounded-2xl border border-white/12 bg-zinc-950/78 px-1.5 py-1.5 text-zinc-100 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl">
        <div
          className="flex items-center rounded-xl bg-white/6 p-0.5"
          role="group"
          aria-label="Camera Mode"
        >
          <button
            type="button"
            onClick={() => setCameraMode('orbit')}
            className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-all ${
              !isWalkthrough
                ? 'bg-white text-zinc-950 shadow-sm'
                : 'text-zinc-300 hover:bg-white/10 hover:text-white'
            }`}
          >
            <Orbit className="h-3.5 w-3.5" />
            <span>Orbit Editor</span>
          </button>

          <button
            type="button"
            onClick={() => setCameraMode('walkthrough')}
            className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-all ${
              isWalkthrough
                ? 'bg-gradient-to-r from-emerald-400 to-amber-300 text-zinc-950 shadow-[0_0_20px_rgba(52,211,153,0.4)]'
                : 'text-emerald-200/90 hover:bg-emerald-500/15 hover:text-emerald-100'
            }`}
          >
            <Footprints className="h-3.5 w-3.5" />
            <span>Walk Through</span>
          </button>
        </div>

        {!isWalkthrough && (
          <>
            <div className="h-5 w-px bg-white/10" />
            <div
              className="flex items-center gap-0.5 rounded-xl bg-white/5 p-0.5"
              role="group"
              aria-label="Camera Viewpoint"
            >
              {CAMERA_PRESETS.map((preset) => {
                const active = cameraPreset === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setCameraPreset(preset.id)}
                    className={`cursor-pointer rounded-lg px-2 py-1 text-[11px] font-medium transition-all ${
                      active
                        ? 'bg-amber-300/90 text-zinc-950 shadow-sm'
                        : 'text-zinc-300 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Right Capsule: Scan / Upload Space, Setup Wizard, Shop & Studio Controls */}
      <div className="pointer-events-auto flex items-center gap-1 rounded-2xl border border-white/12 bg-zinc-950/75 px-1.5 py-1.5 text-zinc-100 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl">
        <button
          type="button"
          onClick={() => setIntakeOpen(true)}
          className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-300 via-amber-200 to-emerald-200 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-950 shadow-sm transition-transform hover:brightness-105 active:scale-[0.98]"
        >
          <Video className="h-3.5 w-3.5" />
          <span>Scan / Upload Space</span>
          {lastMediaSource && (
            <span
              className="h-2 w-2 rounded-full bg-emerald-600 ring-2 ring-zinc-950/30"
              title={`Active media: ${lastMediaSource.label}`}
            />
          )}
        </button>

        <button
          type="button"
          data-testid="toolbar-setup-wizard-btn"
          onClick={() => setWizardOpen(true)}
          title="Open 4-step SpatioVerse Setup Wizard"
          aria-pressed={wizardOpen}
          className={`flex cursor-pointer items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[11px] font-semibold transition-all ${
            wizardOpen
              ? 'border-amber-300/50 bg-amber-300/20 text-amber-100'
              : 'border-white/10 bg-white/[0.05] text-zinc-200 hover:border-white/20 hover:bg-white/10 hover:text-white'
          }`}
        >
          <Wand2 className="h-3.5 w-3.5 text-amber-300" />
          <span>Setup</span>
        </button>

        <button
          type="button"
          data-testid="toolbar-shop-btn"
          onClick={handleOpenShopClick}
          title={
            shopifyCount > 0
              ? `Review ${shopifyCount} staged Shopify purchase${shopifyCount === 1 ? '' : 's'} and merchant carts`
              : 'Browse live Shopify fixtures & cart handoff'
          }
          aria-pressed={shopActive}
          className={`flex cursor-pointer items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[11px] font-semibold transition-all ${
            shopifyCount > 0
              ? shopActive
                ? 'border-emerald-300/65 bg-emerald-500/30 text-emerald-50 shadow-[0_0_16px_rgba(16,185,129,0.3)]'
                : 'border-emerald-400/45 bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/28'
              : shopActive
                ? 'border-white/25 bg-white/16 text-white'
                : 'border-white/10 bg-white/[0.05] text-zinc-200 hover:border-white/20 hover:bg-white/10 hover:text-white'
          }`}
        >
          <ShoppingBag
            className={`h-3.5 w-3.5 ${
              shopifyCount > 0 ? 'text-emerald-300' : 'text-amber-200'
            }`}
          />
          {shopifyCount > 0 ? (
            <span>Review Purchases ({shopifyCount})</span>
          ) : (
            <span>Shop</span>
          )}
        </button>

        <div className="mx-0.5 h-5 w-px bg-white/10" />

        <button
          type="button"
          onClick={toggleGrid}
          title={showGrid ? 'Hide floor grid' : 'Show floor grid'}
          aria-label="Toggle floor grid"
          aria-pressed={showGrid}
          className={`flex h-7 w-7 cursor-pointer items-center justify-center rounded-xl transition-colors ${
            showGrid
              ? 'bg-amber-300/20 text-amber-200 ring-1 ring-amber-300/40'
              : 'text-zinc-300 hover:bg-white/10 hover:text-white'
          }`}
        >
          <Grid3x3 className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          onClick={resetScene}
          title="Reset scene to preset defaults"
          aria-label="Reset scene"
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-xl text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          onClick={onToggleInventory}
          title={inventoryOpen ? 'Hide Inventory Drawer' : 'Show Inventory Drawer'}
          aria-label="Toggle Inventory Drawer"
          aria-pressed={inventoryOpen}
          className={`flex h-7 w-7 cursor-pointer items-center justify-center rounded-xl transition-colors ${
            inventoryOpen
              ? 'bg-white/16 text-white ring-1 ring-white/25'
              : 'text-zinc-300 hover:bg-white/10 hover:text-white'
          }`}
        >
          <PanelLeft className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          onClick={onToggleInspector}
          title={
            inspectorOpen
              ? 'Hide Inspector & Shop Drawer'
              : 'Show Inspector & Shop Drawer'
          }
          aria-label="Toggle Inspector Drawer"
          aria-pressed={inspectorOpen}
          className={`flex h-7 w-7 cursor-pointer items-center justify-center rounded-xl transition-colors ${
            inspectorOpen
              ? 'bg-white/16 text-white ring-1 ring-white/25'
              : 'text-zinc-300 hover:bg-white/10 hover:text-white'
          }`}
        >
          <PanelRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  );
}
