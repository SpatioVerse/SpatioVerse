import { create } from 'zustand';
import {
  SCENE_PRESETS,
  flagshipScene,
  type ScenePresetKey,
} from '@/fixtures/demoScene';
import { validateScene } from '@/lib/constraints';
import {
  ShopSceneSchema,
  type ConstraintIssue,
  type SceneObject,
  type SceneValidator,
  type ShopScene,
  type Vec3,
} from '@/lib/schema';
import {
  applyPoseToScene,
  findValidatedAlternative,
  type VoicePreviewState,
} from '@/lib/voiceActions';

export type CameraMode = 'orbit' | 'walkthrough';
export type CameraPreset = 'perspective' | 'top' | 'entrance';
export type RightPanelTab = 'inspect' | 'shop';

export type MediaSourceSummary = {
  kind: 'video' | 'image' | 'camera' | 'youtube';
  label: string;
  previewUrl?: string;
  notes?: string;
  backendConnected: boolean;
  updatedAt: string;
};

export type AiRunTrace = {
  analyzeModel?: string;
  analyzeRequestId?: string;
  observationCount?: number;
  planModel?: string;
  planRequestId?: string;
  repairCount?: number;
  warnings: string[];
  mode: 'live-gemini' | 'local-fallback';
  updatedAt: string;
};

const STORAGE_KEY = 'spacestage.scene.v2';

function cloneScene(scene: ShopScene): ShopScene {
  if (typeof structuredClone === 'function') {
    return structuredClone(scene);
  }
  return JSON.parse(JSON.stringify(scene)) as ShopScene;
}

function isPresetKey(value: unknown): value is ScenePresetKey {
  return value === 'flagship' || value === 'compact';
}

/**
 * Default spatial & commerce constraint validator for ShopScene.
 * Delegates to `@/lib/constraints`'s deterministic constraint engine
 * (room bounds, exact 2D SAT rotated OBB collisions, entrance clearance &
 * 3ft walkway BFS connectivity, no-drilling compliance, budget cap, and
 * unverified dimension warnings).
 */
export function defaultSceneValidator(scene: ShopScene): ConstraintIssue[] {
  return validateScene(scene);
}

type PersistedScenePayload = {
  activePreset: ScenePresetKey;
  scene: ShopScene;
};

function persistSceneState(activePreset: ScenePresetKey, scene: ShopScene): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const payload: PersistedScenePayload = { activePreset, scene };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore private-browsing or quota storage errors gracefully
  }
}

export interface ApplyVoicePreviewOutcome {
  applied: boolean;
  stale?: boolean;
  reason?: string;
  preview: VoicePreviewState | null;
}

export interface SceneStoreState {
  scene: ShopScene;
  activePreset: ScenePresetKey;
  selectedId: string | null;
  isDragging: boolean;
  cameraMode: CameraMode;
  cameraPreset: CameraPreset;
  cameraPresetTick: number;
  showGrid: boolean;
  issues: ConstraintIssue[];
  validator: SceneValidator;
  hydrated: boolean;
  intakeOpen: boolean;
  wizardOpen: boolean;
  rightPanelTab: RightPanelTab;
  aiTrace: AiRunTrace | null;
  lastMediaSource: MediaSourceSummary | null;

  /** Undo stack of committed ShopScene snapshots (most recent at end) */
  undoStack: ShopScene[];
  /** Active translucent 3D preview from live voice/typed editing */
  voicePreview: VoicePreviewState | null;
  /** Object IDs highlighted during ambiguous reference clarification */
  voiceHighlightIds: string[];
  /** Monotonic token incremented on manual drag, selection switch, interrupt, commit, cancel, or undo */
  editEpoch: number;
  /** Internal snapshot taken at start of manual drag so a drag commits as one undo step */
  dragStartSnapshot: ShopScene | null;

  hydrateFromStorage: () => void;
  selectObject: (id: string | null) => void;
  setDragging: (dragging: boolean) => void;
  setCameraMode: (mode: CameraMode) => void;
  setCameraPreset: (preset: CameraPreset) => void;
  toggleGrid: () => void;
  setValidator: (validator: SceneValidator) => void;
  setScene: (scene: ShopScene, preset?: ScenePresetKey) => void;
  switchPreset: (preset: ScenePresetKey) => void;
  moveObject: (id: string, position: Vec3) => void;
  rotateObject: (id: string, deltaRadians: number) => void;
  toggleLock: (id: string) => void;
  updateObject: (id: string, patch: Partial<Omit<SceneObject, 'id'>>) => void;
  clearObjectProduct: (id: string) => void;
  removeObject: (id: string) => void;
  resetScene: () => void;
  setIntakeOpen: (open: boolean) => void;
  setWizardOpen: (open: boolean) => void;
  setRightPanelTab: (tab: RightPanelTab) => void;
  setAiTrace: (trace: AiRunTrace | null) => void;
  setLastMediaSource: (source: MediaSourceSummary | null) => void;

  bumpEditEpoch: () => number;
  setVoiceHighlightIds: (ids: string[]) => void;
  applyVoicePreview: (
    objectId: string,
    nextPosition: Vec3,
    nextRotationY: number,
    summary: string,
    expectedEpoch?: number
  ) => ApplyVoicePreviewOutcome;
  freezeVoicePreview: () => boolean;
  previewSuggestedAlternative: () => ApplyVoicePreviewOutcome;
  commitVoicePreview: () => boolean;
  cancelVoicePreview: () => void;
  undo: () => boolean;
}

const MAX_UNDO_HISTORY = 30;
const initialScene = cloneScene(flagshipScene);

function pushUndoSnapshot(stack: ShopScene[], snapshot: ShopScene): ShopScene[] {
  const next = [...stack, cloneScene(snapshot)];
  return next.length > MAX_UNDO_HISTORY
    ? next.slice(next.length - MAX_UNDO_HISTORY)
    : next;
}

export const useSceneStore = create<SceneStoreState>((set, get) => ({
  scene: initialScene,
  activePreset: 'flagship',
  selectedId: null,
  isDragging: false,
  cameraMode: 'orbit',
  cameraPreset: 'perspective',
  cameraPresetTick: 0,
  showGrid: false,
  issues: validateScene(initialScene),
  validator: validateScene,
  hydrated: false,
  intakeOpen: false,
  wizardOpen: false,
  rightPanelTab: 'inspect',
  aiTrace: null,
  lastMediaSource: null,
  undoStack: [],
  voicePreview: null,
  voiceHighlightIds: [],
  editEpoch: 0,
  dragStartSnapshot: null,

  hydrateFromStorage: () => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        set({ hydrated: true });
        return;
      }

      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) {
        set({ hydrated: true });
        return;
      }

      const record = parsed as Record<string, unknown>;
      const sceneResult = ShopSceneSchema.safeParse(record.scene);
      if (!sceneResult.success) {
        set({ hydrated: true });
        return;
      }

      const validScene = sceneResult.data;
      const validPreset: ScenePresetKey = isPresetKey(record.activePreset)
        ? record.activePreset
        : get().activePreset;
      const validator = get().validator;

      set({
        scene: validScene,
        activePreset: validPreset,
        selectedId: null,
        isDragging: false,
        issues: validator(validScene),
        hydrated: true,
      });
    } catch {
      set({ hydrated: true });
    }
  },

  selectObject: (id) => {
    set((state) => {
      if (state.selectedId === id) {
        return state;
      }
      const previewStale =
        state.voicePreview && id !== state.voicePreview.objectId;
      return {
        selectedId: id,
        voiceHighlightIds: [],
        voicePreview: previewStale ? null : state.voicePreview,
        editEpoch: state.editEpoch + 1,
      };
    });
  },

  setDragging: (dragging) => {
    set((state) => {
      if (dragging) {
        return {
          isDragging: true,
          dragStartSnapshot: cloneScene(state.scene),
          voicePreview: null,
          voiceHighlightIds: [],
          editEpoch: state.editEpoch + 1,
        };
      }

      // Finishing manual drag: push dragStartSnapshot onto undoStack if moved
      let nextUndoStack = state.undoStack;
      if (state.dragStartSnapshot) {
        const beforeJson = JSON.stringify(state.dragStartSnapshot.objects);
        const afterJson = JSON.stringify(state.scene.objects);
        if (beforeJson !== afterJson) {
          nextUndoStack = pushUndoSnapshot(state.undoStack, state.dragStartSnapshot);
        }
      }
      return {
        isDragging: false,
        dragStartSnapshot: null,
        undoStack: nextUndoStack,
      };
    });
  },

  setCameraMode: (mode) => {
    set({
      cameraMode: mode,
      isDragging: false,
    });
  },

  setCameraPreset: (preset) => {
    set((state) => ({
      cameraMode: 'orbit',
      cameraPreset: preset,
      cameraPresetTick: state.cameraPresetTick + 1,
      isDragging: false,
    }));
  },

  toggleGrid: () => {
    set((state) => ({ showGrid: !state.showGrid }));
  },

  setValidator: (validator) => {
    set((state) => ({
      validator,
      issues: validator(state.scene),
    }));
  },

  setScene: (scene, preset) => {
    const nextScene = cloneScene(scene);
    set((state) => {
      const nextPreset = preset ?? state.activePreset;
      const stillSelected =
        state.selectedId &&
        nextScene.objects.some((obj) => obj.id === state.selectedId)
          ? state.selectedId
          : null;
      persistSceneState(nextPreset, nextScene);
      return {
        scene: nextScene,
        activePreset: nextPreset,
        selectedId: stillSelected,
        isDragging: false,
        issues: state.validator(nextScene),
      };
    });
  },

  switchPreset: (preset) => {
    const definition = SCENE_PRESETS[preset];
    if (!definition) {
      return;
    }
    const nextScene = cloneScene(definition.scene);
    set((state) => {
      persistSceneState(preset, nextScene);
      return {
        scene: nextScene,
        activePreset: preset,
        selectedId: null,
        isDragging: false,
        voicePreview: null,
        voiceHighlightIds: [],
        undoStack: [],
        editEpoch: state.editEpoch + 1,
        cameraPreset: 'perspective',
        cameraPresetTick: state.cameraPresetTick + 1,
        issues: state.validator(nextScene),
      };
    });
  },

  moveObject: (id, position) => {
    set((state) => {
      const target = state.scene.objects.find((obj) => obj.id === id);
      if (!target || target.locked) {
        return state;
      }

      const nextScene: ShopScene = {
        ...state.scene,
        objects: state.scene.objects.map((obj) =>
          obj.id === id
            ? { ...obj, position: [position[0], position[1], position[2]] }
            : obj
        ),
      };

      persistSceneState(state.activePreset, nextScene);
      return {
        scene: nextScene,
        issues: state.validator(nextScene),
      };
    });
  },

  rotateObject: (id, deltaRadians) => {
    set((state) => {
      const target = state.scene.objects.find((obj) => obj.id === id);
      if (!target || target.locked) {
        return state;
      }

      const nextUndoStack = pushUndoSnapshot(state.undoStack, state.scene);
      const nextScene: ShopScene = {
        ...state.scene,
        objects: state.scene.objects.map((obj) =>
          obj.id === id
            ? { ...obj, rotationY: obj.rotationY + deltaRadians }
            : obj
        ),
      };

      persistSceneState(state.activePreset, nextScene);
      return {
        scene: nextScene,
        undoStack: nextUndoStack,
        voicePreview:
          state.voicePreview?.objectId === id ? null : state.voicePreview,
        editEpoch: state.editEpoch + 1,
        issues: state.validator(nextScene),
      };
    });
  },

  toggleLock: (id) => {
    set((state) => {
      const nextScene: ShopScene = {
        ...state.scene,
        objects: state.scene.objects.map((obj) =>
          obj.id === id ? { ...obj, locked: !obj.locked } : obj
        ),
      };
      persistSceneState(state.activePreset, nextScene);
      return {
        scene: nextScene,
        isDragging: state.selectedId === id ? false : state.isDragging,
      };
    });
  },

  updateObject: (id, patch) => {
    set((state) => {
      const exists = state.scene.objects.some((obj) => obj.id === id);
      if (!exists) {
        return state;
      }

      const nextScene: ShopScene = {
        ...state.scene,
        objects: state.scene.objects.map((obj) =>
          obj.id === id ? { ...obj, ...patch } : obj
        ),
      };

      persistSceneState(state.activePreset, nextScene);
      return {
        scene: nextScene,
        issues: state.validator(nextScene),
      };
    });
  },

  clearObjectProduct: (id) => {
    set((state) => {
      const exists = state.scene.objects.some((obj) => obj.id === id);
      if (!exists) {
        return state;
      }

      const nextScene: ShopScene = {
        ...state.scene,
        objects: state.scene.objects.map((obj) =>
          obj.id === id
            ? {
                ...obj,
                source: 'proposal',
                product: undefined,
                dimensionsVerified: false,
              }
            : obj
        ),
      };

      persistSceneState(state.activePreset, nextScene);
      return {
        scene: nextScene,
        issues: state.validator(nextScene),
      };
    });
  },

  removeObject: (id) => {
    set((state) => {
      const nextObjects = state.scene.objects.filter((obj) => obj.id !== id);
      if (nextObjects.length === state.scene.objects.length) {
        return state;
      }

      const nextScene: ShopScene = {
        ...state.scene,
        objects: nextObjects,
      };

      persistSceneState(state.activePreset, nextScene);
      return {
        scene: nextScene,
        selectedId: state.selectedId === id ? null : state.selectedId,
        isDragging: false,
        issues: state.validator(nextScene),
      };
    });
  },

  resetScene: () => {
    set((state) => {
      const preset = state.activePreset;
      const freshScene = cloneScene(SCENE_PRESETS[preset].scene);
      persistSceneState(preset, freshScene);
      return {
        scene: freshScene,
        selectedId: null,
        isDragging: false,
        voicePreview: null,
        voiceHighlightIds: [],
        undoStack: pushUndoSnapshot(state.undoStack, state.scene),
        editEpoch: state.editEpoch + 1,
        issues: state.validator(freshScene),
      };
    });
  },

  setIntakeOpen: (open) => {
    set({ intakeOpen: open });
  },

  setWizardOpen: (open) => {
    set({ wizardOpen: open });
  },

  setRightPanelTab: (tab) => {
    set({ rightPanelTab: tab });
  },

  setAiTrace: (trace) => {
    set({ aiTrace: trace });
  },

  setLastMediaSource: (source) => {
    set({ lastMediaSource: source });
  },

  bumpEditEpoch: () => {
    let nextEpoch = 0;
    set((state) => {
      nextEpoch = state.editEpoch + 1;
      return { editEpoch: nextEpoch };
    });
    return nextEpoch;
  },

  setVoiceHighlightIds: (ids) => {
    set({ voiceHighlightIds: ids });
  },

  applyVoicePreview: (
    objectId,
    nextPosition,
    nextRotationY,
    summary,
    expectedEpoch
  ) => {
    const state = get();
    if (
      typeof expectedEpoch === 'number' &&
      expectedEpoch !== state.editEpoch
    ) {
      return {
        applied: false,
        stale: true,
        reason: 'Discarded stale response after user interruption or manual edit.',
        preview: state.voicePreview,
      };
    }

    const target = state.scene.objects.find((obj) => obj.id === objectId);
    if (!target) {
      return {
        applied: false,
        reason: `Object "${objectId}" not found in scene.`,
        preview: state.voicePreview,
      };
    }

    if (target.locked) {
      return {
        applied: false,
        reason: `"${target.label}" is locked. Unlock it before moving.`,
        preview: state.voicePreview,
      };
    }

    const originalPosition: Vec3 =
      state.voicePreview?.objectId === objectId
        ? [...state.voicePreview.originalPosition]
        : [...target.position];
    const originalRotationY =
      state.voicePreview?.objectId === objectId
        ? state.voicePreview.originalRotationY
        : target.rotationY;

    const previewPos: Vec3 = [
      nextPosition[0],
      nextPosition[1],
      nextPosition[2],
    ];
    const hypotheticalScene = applyPoseToScene(
      state.scene,
      objectId,
      previewPos,
      nextRotationY
    );
    const previewIssues = state.validator(hypotheticalScene);
    const hasBlockingError = previewIssues.some((i) => i.severity === 'error');
    const suggestedAlternative = hasBlockingError
      ? findValidatedAlternative(
          state.scene,
          objectId,
          previewPos,
          state.validator
        )
      : null;

    const nextPreview: VoicePreviewState = {
      objectId,
      originalPosition,
      originalRotationY,
      previewPosition: previewPos,
      previewRotationY: nextRotationY,
      issues: previewIssues,
      frozen: false,
      suggestedAlternative,
      lastActionSummary: summary,
      epoch: state.editEpoch,
    };

    set({
      selectedId: objectId,
      voicePreview: nextPreview,
      voiceHighlightIds: [],
    });

    return {
      applied: true,
      preview: nextPreview,
    };
  },

  freezeVoicePreview: () => {
    const state = get();
    if (!state.voicePreview) {
      return false;
    }
    set({
      voicePreview: {
        ...state.voicePreview,
        frozen: true,
        lastActionSummary: 'Paused preview for inspection',
      },
    });
    return true;
  },

  previewSuggestedAlternative: () => {
    const state = get();
    const preview = state.voicePreview;
    if (!preview || !preview.suggestedAlternative) {
      return {
        applied: false,
        reason: 'No suggested alternative is currently available.',
        preview: state.voicePreview,
      };
    }

    const alt = preview.suggestedAlternative;
    return get().applyVoicePreview(
      preview.objectId,
      alt.position,
      alt.rotationY,
      `Previewing alternative: ${alt.label}`
    );
  },

  commitVoicePreview: () => {
    const state = get();
    const preview = state.voicePreview;
    if (!preview) {
      return false;
    }

    const nextUndoStack = pushUndoSnapshot(state.undoStack, state.scene);
    const nextScene = applyPoseToScene(
      state.scene,
      preview.objectId,
      preview.previewPosition,
      preview.previewRotationY
    );
    persistSceneState(state.activePreset, nextScene);

    set({
      scene: nextScene,
      undoStack: nextUndoStack,
      voicePreview: null,
      voiceHighlightIds: [],
      editEpoch: state.editEpoch + 1,
      issues: state.validator(nextScene),
    });

    return true;
  },

  cancelVoicePreview: () => {
    set((state) => ({
      voicePreview: null,
      voiceHighlightIds: [],
      editEpoch: state.editEpoch + 1,
    }));
  },

  undo: () => {
    const state = get();
    if (state.undoStack.length === 0) {
      return false;
    }

    const previousScene = state.undoStack[state.undoStack.length - 1];
    const nextUndoStack = state.undoStack.slice(0, -1);
    const restored = cloneScene(previousScene);
    persistSceneState(state.activePreset, restored);

    set({
      scene: restored,
      undoStack: nextUndoStack,
      voicePreview: null,
      voiceHighlightIds: [],
      isDragging: false,
      dragStartSnapshot: null,
      editEpoch: state.editEpoch + 1,
      issues: state.validator(restored),
    });

    return true;
  },
}));
