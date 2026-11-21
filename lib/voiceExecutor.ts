import { getCameraBasis } from '@/lib/cameraBridge';
import type { RoomWall } from '@/lib/schema';
import {
  computeMovedPosition,
  computePoseAlongWall,
  computeRotatedYaw,
  getNearestWall,
  getOppositeWall,
  type VoiceAction,
} from '@/lib/voiceActions';
import { useSceneStore } from '@/store/useSceneStore';

export interface ActionExecutionResult {
  ok: boolean;
  stale?: boolean;
  valid?: boolean;
  actionType: VoiceAction['type'];
  objectId?: string;
  summary: string;
  errors?: Array<{ code: string; message: string }>;
  suggestedAlternative?: {
    label: string;
    wall: RoomWall;
    reason: string;
  } | null;
  highlightedIds?: string[];
  updatedPreferredLanguage?: string;
}

function resolveTargetObjectId(explicitId?: string): string | null {
  const state = useSceneStore.getState();
  if (explicitId) {
    const exact = state.scene.objects.find((o) => o.id === explicitId);
    if (exact) return exact.id;
  }
  if (state.voicePreview) {
    return state.voicePreview.objectId;
  }
  if (state.selectedId) {
    return state.selectedId;
  }
  return null;
}

/**
 * Deterministically executes a typed VoiceAction against useSceneStore.
 * Used identically by both Gemini Live Audio tool calls and the typed
 * multilingual command fallback so previews, validation, alternatives,
 * stale-epoch guards, and undo behavior are 100% consistent.
 */
export function executeVoiceAction(
  action: VoiceAction,
  expectedEpoch?: number
): ActionExecutionResult {
  const store = useSceneStore.getState();

  if (typeof expectedEpoch === 'number' && expectedEpoch !== store.editEpoch) {
    return {
      ok: false,
      stale: true,
      actionType: action.type,
      summary: 'Ignored stale action because the user interrupted or edited manually.',
    };
  }

  switch (action.type) {
    case 'select_object': {
      const obj = store.scene.objects.find((o) => o.id === action.objectId);
      if (!obj) {
        return {
          ok: false,
          actionType: action.type,
          summary: `No fixture found with id "${action.objectId}".`,
        };
      }
      store.selectObject(obj.id);
      return {
        ok: true,
        actionType: action.type,
        objectId: obj.id,
        summary: `Selected "${obj.label}".`,
      };
    }

    case 'highlight_candidates': {
      const validIds = action.objectIds.filter((id) =>
        store.scene.objects.some((o) => o.id === id)
      );
      if (validIds.length === 0) {
        return {
          ok: false,
          actionType: action.type,
          summary: 'None of the requested candidate IDs exist in the room.',
        };
      }
      store.setVoiceHighlightIds(validIds);
      const labels = validIds
        .map((id) => store.scene.objects.find((o) => o.id === id)?.label ?? id)
        .join(' vs ');
      return {
        ok: true,
        actionType: action.type,
        highlightedIds: validIds,
        summary: `Highlighted matching fixtures: ${labels}.`,
      };
    }

    case 'preview_move': {
      const targetId = resolveTargetObjectId(action.objectId);
      if (!targetId) {
        return {
          ok: false,
          actionType: action.type,
          summary: 'No fixture is selected. Ask the user which fixture to move.',
        };
      }

      const obj = store.scene.objects.find((o) => o.id === targetId);
      if (!obj) {
        return {
          ok: false,
          actionType: action.type,
          summary: `Fixture "${targetId}" not found.`,
        };
      }

      const multiDelta = store.voicePreview?.objectPoses?.[targetId];
      const currentPos = multiDelta
        ? multiDelta.previewPosition
        : store.voicePreview?.objectId === targetId
          ? store.voicePreview.previewPosition
          : obj.position;
      const currentYaw = multiDelta
        ? multiDelta.previewRotationY
        : store.voicePreview?.objectId === targetId
          ? store.voicePreview.previewRotationY
          : obj.rotationY;

      const distance = action.distanceMeters ?? 0.4;
      const nextPos = computeMovedPosition(
        currentPos,
        action.direction,
        distance,
        getCameraBasis()
      );

      const outcome = store.applyVoicePreview(
        targetId,
        nextPos,
        currentYaw,
        `Moved ${distance.toFixed(2)}m ${action.direction}`,
        expectedEpoch
      );

      if (!outcome.applied || !outcome.preview) {
        return {
          ok: false,
          stale: outcome.stale,
          actionType: action.type,
          objectId: targetId,
          summary: outcome.reason ?? 'Could not preview move.',
        };
      }

      const errors = outcome.preview.issues
        .filter((i) => i.severity === 'error')
        .map((i) => ({ code: i.code, message: i.message }));

      return {
        ok: true,
        valid: errors.length === 0,
        actionType: action.type,
        objectId: targetId,
        summary:
          errors.length === 0
            ? `Preview moved ${distance.toFixed(2)}m ${action.direction} (valid).`
            : `Preview moved ${action.direction}, but flagged: ${errors[0].message}`,
        errors,
        suggestedAlternative: outcome.preview.suggestedAlternative
          ? {
              label: outcome.preview.suggestedAlternative.label,
              wall: outcome.preview.suggestedAlternative.wall,
              reason: outcome.preview.suggestedAlternative.reason,
            }
          : null,
      };
    }

    case 'preview_move_to_wall': {
      const targetId = resolveTargetObjectId(action.objectId);
      if (!targetId) {
        return {
          ok: false,
          actionType: action.type,
          summary: 'No fixture is selected to move to a wall.',
        };
      }

      const obj = store.scene.objects.find((o) => o.id === targetId);
      if (!obj) {
        return {
          ok: false,
          actionType: action.type,
          summary: `Fixture "${targetId}" not found.`,
        };
      }

      const currentPos =
        store.voicePreview?.objectId === targetId
          ? store.voicePreview.previewPosition
          : obj.position;

      let targetWall: RoomWall;
      if (action.wall === 'opposite' || action.wall === 'other') {
        const nearest = getNearestWall(currentPos, store.scene.room);
        const opp = getOppositeWall(nearest);
        targetWall =
          opp === store.scene.room.entrance.wall
            ? (['north', 'west', 'east', 'south'] as RoomWall[]).find(
                (w) => w !== nearest && w !== store.scene.room.entrance.wall
              ) ?? opp
            : opp;
      } else {
        targetWall = action.wall;
      }

      const lateral =
        targetWall === 'north' || targetWall === 'south'
          ? currentPos[0]
          : currentPos[2];
      const pose = computePoseAlongWall(
        obj,
        store.scene.room,
        targetWall,
        lateral,
        action.alignWithWall !== false
      );

      const outcome = store.applyVoicePreview(
        targetId,
        pose.position,
        pose.rotationY,
        `Moved along ${targetWall} wall`,
        expectedEpoch
      );

      if (!outcome.applied || !outcome.preview) {
        return {
          ok: false,
          stale: outcome.stale,
          actionType: action.type,
          objectId: targetId,
          summary: outcome.reason ?? 'Could not preview wall placement.',
        };
      }

      const errors = outcome.preview.issues
        .filter((i) => i.severity === 'error')
        .map((i) => ({ code: i.code, message: i.message }));

      return {
        ok: true,
        valid: errors.length === 0,
        actionType: action.type,
        objectId: targetId,
        summary:
          errors.length === 0
            ? `Previewed along ${targetWall} wall (valid).`
            : `Previewed along ${targetWall} wall, but flagged: ${errors[0].message}`,
        errors,
        suggestedAlternative: outcome.preview.suggestedAlternative
          ? {
              label: outcome.preview.suggestedAlternative.label,
              wall: outcome.preview.suggestedAlternative.wall,
              reason: outcome.preview.suggestedAlternative.reason,
            }
          : null,
      };
    }

    case 'preview_rotate': {
      const targetId = resolveTargetObjectId(action.objectId);
      if (!targetId) {
        return {
          ok: false,
          actionType: action.type,
          summary: 'No fixture is selected to rotate.',
        };
      }

      const obj = store.scene.objects.find((o) => o.id === targetId);
      if (!obj) {
        return {
          ok: false,
          actionType: action.type,
          summary: `Fixture "${targetId}" not found.`,
        };
      }

      const multiDelta = store.voicePreview?.objectPoses?.[targetId];
      const currentPos = multiDelta
        ? multiDelta.previewPosition
        : store.voicePreview?.objectId === targetId
          ? store.voicePreview.previewPosition
          : obj.position;
      const currentYaw = multiDelta
        ? multiDelta.previewRotationY
        : store.voicePreview?.objectId === targetId
          ? store.voicePreview.previewRotationY
          : obj.rotationY;

      const nextYaw = computeRotatedYaw(
        currentYaw,
        currentPos,
        action.mode ?? 'relative',
        action.deltaDegrees
      );

      const degLabel =
        action.mode === 'sideways'
          ? 'sideways (90°)'
          : action.mode === 'face_center'
            ? 'to face center'
            : `${action.deltaDegrees ?? 90}°`;

      const outcome = store.applyVoicePreview(
        targetId,
        currentPos,
        nextYaw,
        `Rotated ${degLabel}`,
        expectedEpoch
      );

      if (!outcome.applied || !outcome.preview) {
        return {
          ok: false,
          stale: outcome.stale,
          actionType: action.type,
          objectId: targetId,
          summary: outcome.reason ?? 'Could not preview rotation.',
        };
      }

      const errors = outcome.preview.issues
        .filter((i) => i.severity === 'error')
        .map((i) => ({ code: i.code, message: i.message }));

      return {
        ok: true,
        valid: errors.length === 0,
        actionType: action.type,
        objectId: targetId,
        summary:
          errors.length === 0
            ? `Preview rotated ${degLabel} (valid).`
            : `Preview rotated ${degLabel}, but flagged: ${errors[0].message}`,
        errors,
        suggestedAlternative: outcome.preview.suggestedAlternative
          ? {
              label: outcome.preview.suggestedAlternative.label,
              wall: outcome.preview.suggestedAlternative.wall,
              reason: outcome.preview.suggestedAlternative.reason,
            }
          : null,
      };
    }

    case 'stop_preview_motion': {
      const froze = store.freezeVoicePreview();
      return {
        ok: froze,
        actionType: action.type,
        objectId: store.voicePreview?.objectId,
        summary: froze
          ? 'Stopped movement and held the preview in place for inspection (not yet committed).'
          : 'No active preview is moving right now.',
      };
    }

    case 'preview_alternative': {
      const outcome = store.previewSuggestedAlternative();
      if (!outcome.applied || !outcome.preview) {
        return {
          ok: false,
          actionType: action.type,
          summary: outcome.reason ?? 'No validated alternative is available.',
        };
      }
      const errors = outcome.preview.issues
        .filter((i) => i.severity === 'error')
        .map((i) => ({ code: i.code, message: i.message }));
      return {
        ok: true,
        valid: errors.length === 0,
        actionType: action.type,
        objectId: outcome.preview.objectId,
        summary: `${outcome.preview.lastActionSummary} (valid, ready to keep or adjust).`,
        errors,
      };
    }

    case 'commit_preview': {
      const objId = store.voicePreview?.objectId;
      const committed = store.commitVoicePreview();
      return {
        ok: committed,
        actionType: action.type,
        objectId: objId,
        summary: committed
          ? 'Committed preview to the room layout as one undoable edit.'
          : 'There is no active preview to commit.',
      };
    }

    case 'cancel_preview': {
      const hadPreview = Boolean(store.voicePreview);
      store.cancelVoicePreview();
      return {
        ok: true,
        actionType: action.type,
        summary: hadPreview
          ? 'Discarded preview and kept the original placement.'
          : 'No active preview to cancel.',
      };
    }

    case 'undo_last_edit': {
      const undone = store.undo();
      return {
        ok: undone,
        actionType: action.type,
        summary: undone
          ? 'Undid the last edit and restored exact previous position and rotation.'
          : 'Nothing to undo yet.',
      };
    }

    case 'set_language_preference': {
      return {
        ok: true,
        actionType: action.type,
        updatedPreferredLanguage: action.language,
        summary: `Switched reply language preference to ${action.language}.`,
      };
    }

    case 'suggest_layouts': {
      const options = store.generateLayoutOptions();
      if (options.length === 0) {
        return {
          ok: false,
          actionType: action.type,
          summary:
            'No additional valid layout alternatives are feasible with the current room size, locked items, and clearance constraints.',
        };
      }
      const listSummary = options
        .map(
          (o) =>
            `Option ${o.index}: "${o.name}" (${o.metricsSummary}) — Tradeoff: ${o.tradeoff}`
        )
        .join(' | ');
      return {
        ok: true,
        valid: true,
        actionType: action.type,
        summary: `Generated ${options.length} validated layout option${options.length === 1 ? '' : 's'}: ${listSummary}`,
      };
    }

    case 'preview_layout_option': {
      const outcome = store.previewLayoutOption(action.optionIndex);
      if (!outcome.applied || !outcome.preview) {
        return {
          ok: false,
          actionType: action.type,
          summary:
            outcome.reason ??
            `Layout option ${action.optionIndex} is not available.`,
        };
      }
      return {
        ok: true,
        valid: !outcome.preview.issues.some((i) => i.severity === 'error'),
        actionType: action.type,
        objectId: outcome.preview.objectId,
        summary: outcome.preview.lastActionSummary,
      };
    }

    case 'preview_proactive_suggestion': {
      const outcome = store.previewProactiveSuggestion();
      if (!outcome.applied || !outcome.preview) {
        return {
          ok: false,
          stale: outcome.stale,
          actionType: action.type,
          summary: outcome.reason ?? 'No active suggestion to preview.',
        };
      }
      return {
        ok: true,
        valid: !outcome.preview.issues.some((i) => i.severity === 'error'),
        actionType: action.type,
        objectId: outcome.preview.objectId,
        summary: outcome.preview.lastActionSummary,
      };
    }

    case 'dismiss_proactive_suggestion': {
      store.dismissProactiveSuggestion();
      return {
        ok: true,
        actionType: action.type,
        summary: 'Dismissed suggestion and will not repeat it unless the room changes.',
      };
    }
  }
}
