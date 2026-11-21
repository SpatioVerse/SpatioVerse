import { beforeEach, describe, expect, it } from 'vitest';
import { compactDemoScene } from '@/fixtures/demoScene';
import { updateCameraBasis } from '@/lib/cameraBridge';
import { validateScene } from '@/lib/constraints';
import {
  computeMovedPosition,
  findValidatedAlternative,
  resolveDirectionVectorXZ,
} from '@/lib/voiceActions';
import { executeVoiceAction } from '@/lib/voiceExecutor';
import { useSceneStore } from '@/store/useSceneStore';

describe('Voice-editing spatial math & camera-relative grounding', () => {
  it('resolves "left" and "forward" relative to live camera orientation', () => {
    const northCam = {
      position: [0, 3, 4] as [number, number, number],
      forwardXZ: [0, -1] as [number, number],
      rightXZ: [1, 0] as [number, number],
      facingWall: 'north' as const,
    };
    expect(resolveDirectionVectorXZ('left', northCam)).toEqual([-1, 0]);
    expect(resolveDirectionVectorXZ('forward', northCam)).toEqual([0, -1]);

    const eastCam = {
      position: [-4, 3, 0] as [number, number, number],
      forwardXZ: [1, 0] as [number, number],
      rightXZ: [0, 1] as [number, number],
      facingWall: 'east' as const,
    };
    // Facing east, "on my left" is north (-Z)
    expect(resolveDirectionVectorXZ('left', eastCam)).toEqual([0, -1]);
    const moved = computeMovedPosition([0, 0, 0], 'left', 0.4, eastCam);
    expect(moved).toEqual([0, 0, -0.4]);
  });

  it('finds a validator-verified alternative when a placement blocks the entrance', () => {
    const scene = structuredClone(compactDemoScene);
    const shelfId = 'compact-owned-shelf';
    // Put shelf squarely in the south entrance zone
    const alt = findValidatedAlternative(
      scene,
      shelfId,
      [0, 0, 1.2],
      validateScene
    );
    expect(alt).not.toBeNull();
    expect(alt?.wall).not.toBe('south');

    const withAlt = structuredClone(scene);
    const target = withAlt.objects.find((o) => o.id === shelfId)!;
    target.position = alt!.position;
    target.rotationY = alt!.rotationY;
    const errors = validateScene(withAlt).filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
  });
});

describe('Voice-editing multi-turn preview, stop vs commit, alternatives, stale guard & undo', () => {
  beforeEach(() => {
    useSceneStore.getState().setScene(structuredClone(compactDemoScene), 'compact');
    useSceneStore.setState({
      undoStack: [],
      voicePreview: null,
      voiceHighlightIds: [],
      selectedId: null,
    });
    updateCameraBasis([0, 3, 4], [0, -1], [1, 0]);
  });

  it('accumulates move + refine + sideways rotate on preview, commits as one undoable step, and undoes cleanly', () => {
    const shelfId = 'compact-owned-shelf';
    const initialShelf = useSceneStore
      .getState()
      .scene.objects.find((o) => o.id === shelfId)!;
    const startPos = [...initialShelf.position];
    const startYaw = initialShelf.rotationY;

    useSceneStore.getState().selectObject(shelfId);

    // 1. "इस shelf को थोड़ा right करो" (move right into open room)
    const r1 = executeVoiceAction({
      type: 'preview_move',
      direction: 'right',
      distanceMeters: 0.4,
    });
    expect(r1.ok).toBe(true);
    expect(useSceneStore.getState().voicePreview?.objectId).toBe(shelfId);
    // Original scene must remain untouched until commit
    expect(
      useSceneStore.getState().scene.objects.find((o) => o.id === shelfId)
        ?.position
    ).toEqual(startPos);

    // 2. "थोड़ा और" (accumulates on active preview)
    const r2 = executeVoiceAction({
      type: 'preview_move',
      direction: 'right',
      distanceMeters: 0.2,
    });
    expect(r2.ok).toBe(true);
    const afterNudgeX = useSceneStore.getState().voicePreview!.previewPosition[0];
    expect(afterNudgeX).toBeCloseTo(startPos[0] + 0.6, 2);

    // 3. "बस, यहीं" (stop_preview_motion freezes preview WITHOUT committing)
    const rStop = executeVoiceAction({ type: 'stop_preview_motion' });
    expect(rStop.ok).toBe(true);
    expect(useSceneStore.getState().voicePreview?.frozen).toBe(true);
    expect(useSceneStore.getState().undoStack).toHaveLength(0);

    // 4. "Actually, turn it sideways" (rotates same preview by 90 deg)
    const rRot = executeVoiceAction({
      type: 'preview_rotate',
      mode: 'sideways',
    });
    expect(rRot.ok).toBe(true);
    expect(
      useSceneStore.getState().voicePreview!.previewRotationY
    ).not.toBeCloseTo(startYaw, 2);

    // 5. "रख दो" / "Keep it" (commits full accumulated edit as ONE undo step)
    const rCommit = executeVoiceAction({ type: 'commit_preview' });
    expect(rCommit.ok).toBe(true);
    expect(useSceneStore.getState().voicePreview).toBeNull();
    expect(useSceneStore.getState().undoStack).toHaveLength(1);
    expect(
      useSceneStore.getState().scene.objects.find((o) => o.id === shelfId)
        ?.position[0]
    ).toBeCloseTo(startPos[0] + 0.6, 2);

    // 6. "Undo that" restores EXACT starting position and rotation
    const rUndo = executeVoiceAction({ type: 'undo_last_edit' });
    expect(rUndo.ok).toBe(true);
    const restored = useSceneStore
      .getState()
      .scene.objects.find((o) => o.id === shelfId)!;
    expect(restored.position).toEqual(startPos);
    expect(restored.rotationY).toBe(startYaw);
    expect(useSceneStore.getState().undoStack).toHaveLength(0);
  });

  it('flags blocked entrance, offers a validated alternative, and previews it on agreement', () => {
    const tableId = 'compact-proposal-table';
    useSceneStore.getState().selectObject(tableId);

    // Move table south into the 3 ft south entrance clearance zone
    const blocked = executeVoiceAction({
      type: 'preview_move',
      objectId: tableId,
      direction: 'south',
      distanceMeters: 1.1,
    });

    expect(blocked.ok).toBe(true);
    expect(blocked.valid).toBe(false);
    expect(blocked.errors?.some((e) => e.code === 'BLOCKED_PATH')).toBe(true);
    expect(blocked.suggestedAlternative).not.toBeNull();

    // User says "हाँ, दिखाओ" -> preview_alternative
    const altRes = executeVoiceAction({ type: 'preview_alternative' });
    expect(altRes.ok).toBe(true);
    expect(altRes.valid).toBe(true);
    expect(altRes.errors).toEqual([]);
  });

  it('highlights multiple matching candidates on ambiguous reference', () => {
    const res = executeVoiceAction({
      type: 'highlight_candidates',
      objectIds: ['compact-owned-shelf', 'compact-owned-counter'],
    });
    expect(res.ok).toBe(true);
    expect(useSceneStore.getState().voiceHighlightIds).toEqual([
      'compact-owned-shelf',
      'compact-owned-counter',
    ]);
  });

  it('discards stale responses after user interruption, selection switch, or manual drag', () => {
    const shelfId = 'compact-owned-shelf';
    useSceneStore.getState().selectObject(shelfId);
    const capturedEpoch = useSceneStore.getState().editEpoch;

    // User switches object manually while an async voice turn is in flight
    useSceneStore.getState().selectObject('compact-owned-counter');

    const staleAttempt = executeVoiceAction(
      {
        type: 'preview_move',
        objectId: shelfId,
        direction: 'right',
        distanceMeters: 0.5,
      },
      capturedEpoch
    );

    expect(staleAttempt.ok).toBe(false);
    expect(staleAttempt.stale).toBe(true);
    expect(useSceneStore.getState().voicePreview).toBeNull();
  });

  it('generates validated distinct layout options respecting locked items, refines Option 2 counter, commits as 1 edit, and undoes cleanly', () => {
    // Lock one fixture to verify layout generator never moves locked items
    const store = useSceneStore.getState();
    const lockedId = 'compact-proposal-plant';
    store.toggleLock(lockedId);
    const lockedStart = [
      ...useSceneStore
        .getState()
        .scene.objects.find((o) => o.id === lockedId)!.position,
    ];
    const originalSnapshot = structuredClone(useSceneStore.getState().scene.objects);

    // 1. "Show me a few layouts"
    const sRes = executeVoiceAction({ type: 'suggest_layouts' });
    expect(sRes.ok).toBe(true);
    const options = useSceneStore.getState().layoutOptions;
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options.length).toBeLessThanOrEqual(3);
    for (const opt of options) {
      expect(opt.movedObjectIds).not.toContain(lockedId);
      expect(opt.poses[lockedId].position).toEqual(lockedStart);
      expect(opt.tradeoff.length).toBeGreaterThan(10);
    }

    // 2. "दूसरा वाला दिखाओ" (Option 2 preview)
    const pRes = executeVoiceAction({
      type: 'preview_layout_option',
      optionIndex: 2,
    });
    expect(pRes.ok).toBe(true);
    expect(pRes.valid).toBe(true);
    expect(useSceneStore.getState().voicePreview?.layoutOptionIndex).toBe(2);
    // Committed scene is still untouched
    expect(useSceneStore.getState().scene.objects).toEqual(originalSnapshot);

    // 3. "Keep this one, but rotate the counter" (refines counter inside same preview, waits for confirmation)
    const counterId = 'compact-owned-counter';
    const rRes = executeVoiceAction({
      type: 'preview_rotate',
      objectId: counterId,
      mode: 'relative',
      deltaDegrees: 90,
    });
    expect(rRes.ok).toBe(true);
    const activePreview = useSceneStore.getState().voicePreview!;
    expect(activePreview.layoutOptionIndex).toBe(2);
    expect(activePreview.objectPoses?.[counterId]).toBeDefined();
    expect(useSceneStore.getState().undoStack).toHaveLength(0);

    // 4. "Apply it" commits the entire refined Option 2 as ONE undoable step
    const cRes = executeVoiceAction({ type: 'commit_preview' });
    expect(cRes.ok).toBe(true);
    expect(useSceneStore.getState().voicePreview).toBeNull();
    expect(useSceneStore.getState().undoStack).toHaveLength(1);

    // 5. "Undo" restores the exact original room layout
    const uRes = executeVoiceAction({ type: 'undo_last_edit' });
    expect(uRes.ok).toBe(true);
    expect(useSceneStore.getState().scene.objects).toEqual(originalSnapshot);
  });

  it('proactively suggests a validated improvement after dragging a shelf near the entrance, previews on "Show me", and respects dismissal', () => {
    const shelfId = 'compact-owned-shelf';
    useSceneStore.getState().selectObject(shelfId);

    // Simulate user dragging shelf into the south entrance zone, then releasing drag
    useSceneStore.getState().setDragging(true);
    useSceneStore.getState().moveObject(shelfId, [0, 0, 1.1]);
    useSceneStore.getState().setDragging(false);

    const suggestion = useSceneStore.getState().proactiveSuggestion;
    expect(suggestion).not.toBeNull();
    expect(suggestion?.objectId).toBe(shelfId);
    expect(suggestion?.spokenPrompt.toLowerCase()).toContain('want to see it');

    // User says "Show me" -> previews the exact validated improvement
    const pRes = executeVoiceAction({ type: 'preview_proactive_suggestion' });
    expect(pRes.ok).toBe(true);
    expect(pRes.valid).toBe(true);
    expect(useSceneStore.getState().voicePreview?.objectId).toBe(shelfId);

    // Cancel preview, re-trigger suggestion, then dismiss -> stays quiet on unchanged room
    executeVoiceAction({ type: 'cancel_preview' });
    useSceneStore.getState().evaluateProactiveSuggestion(shelfId);
    expect(useSceneStore.getState().proactiveSuggestion).not.toBeNull();

    executeVoiceAction({ type: 'dismiss_proactive_suggestion' });
    expect(useSceneStore.getState().proactiveSuggestion).toBeNull();

    // Re-evaluating the exact same unchanged room must NOT repeat dismissed suggestion
    useSceneStore.getState().evaluateProactiveSuggestion(shelfId);
    expect(useSceneStore.getState().proactiveSuggestion).toBeNull();
  });
});
