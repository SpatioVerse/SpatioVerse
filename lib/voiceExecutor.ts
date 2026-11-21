import { getCameraBasis } from '@/lib/cameraBridge';
import { computeReplacementPatch } from '@/lib/productVisuals';
import {
  deduplicateSceneObjects,
  normalizeObjectSizeForRoom,
} from '@/lib/roomProportions';
import {
  ShopSceneSchema,
  type ProductRef,
  type RoomWall,
  type SceneObject,
  type Vec3,
} from '@/lib/schema';
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
  products?: Array<{
    index: number;
    title: string;
    seller: string;
    price: string;
  }>;
  checkoutUrl?: string | null;
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

    case 'browse_shopify_products': {
      store.requestOpenShopDrawer(action.query);
      return {
        ok: true,
        actionType: action.type,
        summary: `Opened Shop Products side view for "${action.query}".`,
      };
    }

    case 'apply_shopify_product': {
      return {
        ok: false,
        actionType: action.type,
        summary: 'Use executeVoiceActionAsync for Shopify product placement.',
      };
    }

    case 'place_shopify_order': {
      store.requestOpenShopDrawer();
      return {
        ok: true,
        actionType: action.type,
        summary: 'Opened Shop Products side view for order handoff.',
      };
    }

    case 'clear_room': {
      const keepSet = new Set(action.keepObjectIds ?? []);
      const kept =
        keepSet.size > 0
          ? store.scene.objects.filter((o) => keepSet.has(o.id))
          : [];
      const removedCount = store.scene.objects.length - kept.length;
      store.replaceSceneUndoable({
        ...store.scene,
        objects: kept,
      });
      return {
        ok: true,
        actionType: action.type,
        summary:
          kept.length > 0
            ? `Cleared ${removedCount} item${removedCount === 1 ? '' : 's'} and kept ${kept.length} requested item${kept.length === 1 ? '' : 's'}.`
            : `Cleared all ${removedCount} objects from the room. You can now describe any style you want or say undo.`,
      };
    }

    case 'remove_objects': {
      const removeSet = new Set(action.objectIds);
      const removed = store.scene.objects.filter((o) => removeSet.has(o.id));
      if (removed.length === 0) {
        return {
          ok: false,
          actionType: action.type,
          summary: 'None of the specified items were found in the room.',
        };
      }
      const remaining = store.scene.objects.filter((o) => !removeSet.has(o.id));
      store.replaceSceneUndoable({
        ...store.scene,
        objects: remaining,
      });
      const names = removed.map((o) => o.label).join(' and ');
      return {
        ok: true,
        actionType: action.type,
        summary: `Removed ${names}. Every other item in the room stayed right where it was.`,
      };
    }

    case 'redesign_room_style': {
      return {
        ok: false,
        actionType: action.type,
        summary: 'Use executeVoiceActionAsync for full-room style redesign.',
      };
    }

    case 'draft_design_prompt': {
      const promptText = action.prompt.trim();
      const wantsWholeRoom =
        /\b(whole\s+room|entire\s+room|whole\s+layout|full\s+layout|entire\s+layout|redesign\s+(the\s+|my\s+)?room|restyle\s+(the\s+|my\s+)?room|replace\s+the\s+whole|change\s+the\s+whole|minimalist\s+look|decorative\s+look|start\s+fresh)\b/i.test(
          promptText
        );
      let safeMode: 'redesign' | 'add' | 'replace' = action.mode;
      if (safeMode === 'redesign' && !wantsWholeRoom) {
        safeMode = /\b(add|place|put|insert|bring\s+in)\b/i.test(promptText)
          ? 'add'
          : 'replace';
      }
      store.setDraftedDesignPrompt({
        prompt: promptText,
        mode: safeMode,
        style: action.style,
        budgetDollars: action.budgetDollars,
        keepObjectIds: action.keepObjectIds,
        targetObjectId: action.targetObjectId,
        createdAt: Date.now(),
      });
      return {
        ok: true,
        actionType: action.type,
        summary: `Drafted ${safeMode} prompt: "${promptText}". Ask the user to confirm before calling render_from_prompt.`,
      };
    }

    case 'render_from_prompt': {
      return {
        ok: false,
        actionType: action.type,
        summary: 'Use executeVoiceActionAsync to render the drafted design prompt.',
      };
    }
  }
}

function formatPriceDollars(cents: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function findOpenFloorPosition(
  scene: ReturnType<typeof useSceneStore.getState>['scene'],
  size: Vec3
): Vec3 {
  const halfW = Math.max(0.4, scene.room.width / 2 - size[0] / 2 - 0.2);
  const halfD = Math.max(0.4, scene.room.depth / 2 - size[2] / 2 - 0.2);
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

  for (const [cx, cz] of candidates) {
    if (Math.abs(cx) > halfW || Math.abs(cz) > halfD) continue;
    let collides = false;
    for (const obj of scene.objects) {
      const dx = Math.abs(cx - obj.position[0]);
      const dz = Math.abs(cz - obj.position[2]);
      const minX = (size[0] + obj.size[0]) / 2 + 0.12;
      const minZ = (size[2] + obj.size[2]) / 2 + 0.12;
      if (dx < minX && dz < minZ) {
        collides = true;
        break;
      }
    }
    if (!collides) {
      return [Number(cx.toFixed(2)), 0, Number(cz.toFixed(2))];
    }
  }

  return [0, 0, 0];
}

function triggerVisionGlbMatch(objectId: string, product: ProductRef): void {
  const { setVisionModelOverride, updateObject } = useSceneStore.getState();
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
      if (Array.isArray(match.estimatedSize) && match.estimatedSize.length === 3) {
        updateObject(objectId, {
          ...(match.inferredKind ? { kind: match.inferredKind } : {}),
          size: match.estimatedSize as Vec3,
        });
      }
    })
    .catch(() => {
      // Fallback to deterministic catalog match
    });
}

let lastPromptRenderAt = 0;

/**
 * Async wrapper over `executeVoiceAction` that also executes live Shopify
 * browsing, 3D product add/replace, and merchant order/checkout handoff.
 */
export async function executeVoiceActionAsync(
  action: VoiceAction,
  expectedEpoch?: number
): Promise<ActionExecutionResult> {
  const store = useSceneStore.getState();

  if (action.type === 'browse_shopify_products') {
    const selectedObj = store.selectedId
      ? store.scene.objects.find((o) => o.id === store.selectedId)
      : null;
    const effectiveQuery =
      (action.query ?? '').trim() ||
      (selectedObj ? selectedObj.kind : 'furniture');

    store.requestOpenShopDrawer(effectiveQuery);
    try {
      const params = new URLSearchParams();
      if (effectiveQuery) {
        params.set('q', effectiveQuery);
      }
      if (typeof action.maxPriceDollars === 'number' && action.maxPriceDollars > 0) {
        params.set('maxPrice', String(Math.round(action.maxPriceDollars * 100)));
      } else if (store.scene.budgetCents > 0) {
        params.set('maxPrice', String(Math.floor(store.scene.budgetCents)));
      }

      const res = await fetch(`/api/products?${params.toString()}`);
      const data = (await res.json().catch(() => null)) as {
        products?: ProductRef[];
        error?: { message?: string };
      } | null;

      if (!res.ok) {
        return {
          ok: false,
          actionType: action.type,
          summary:
            data?.error?.message ||
            `Shopify product search failed (HTTP ${res.status}).`,
        };
      }

      const rawProducts = Array.isArray(data?.products) ? data.products : [];
      // Deduplicate by productId so spoken numbers 1..N match the cards in ProductPanel
      const deduped: ProductRef[] = [];
      const seen = new Set<string>();
      for (const p of rawProducts) {
        if (!seen.has(p.productId)) {
          seen.add(p.productId);
          deduped.push(p);
        }
      }

      store.setVoiceShopResults(effectiveQuery, deduped);

      if (deduped.length === 0) {
        return {
          ok: true,
          actionType: action.type,
          products: [],
          summary: `Opened Shop Products for "${effectiveQuery}", but no live products matched right now.`,
        };
      }

      const topList = deduped.slice(0, 6).map((p, idx) => ({
        index: idx + 1,
        title: p.title,
        seller: p.seller,
        price: formatPriceDollars(p.priceCents, p.currency),
      }));

      const spokenPreview = topList
        .slice(0, 3)
        .map((p) => `${p.index}. ${p.title} (${p.price} from ${p.seller})`)
        .join('; ');

      return {
        ok: true,
        actionType: action.type,
        products: topList,
        summary: `Opened Shop Products side view with ${deduped.length} live Shopify results for "${effectiveQuery}". Top options: ${spokenPreview}.`,
      };
    } catch (err) {
      return {
        ok: false,
        actionType: action.type,
        summary:
          err instanceof Error
            ? err.message
            : 'Unable to fetch Shopify products right now.',
      };
    }
  }

  if (action.type === 'apply_shopify_product') {
    const product = store.voiceShopProducts[action.productIndex - 1];
    if (!product) {
      return {
        ok: false,
        actionType: action.type,
        summary: `No Shopify product #${action.productIndex} is loaded. Browse products first.`,
      };
    }

    const targetId =
      action.mode === 'replace'
        ? resolveTargetObjectId(action.targetObjectId)
        : null;

    if (action.mode === 'replace' && targetId) {
      const currentObj = store.scene.objects.find((o) => o.id === targetId);
      if (currentObj) {
        const patch = computeReplacementPatch(currentObj, product);
        const nextKind = patch.kind ?? currentObj.kind;
        const normalizedSize = normalizeObjectSizeForRoom(
          (patch.size as Vec3 | undefined) ?? currentObj.size,
          nextKind,
          store.scene.room,
          product.title
        );
        store.updateObject(targetId, { ...patch, size: normalizedSize });
        store.selectObject(targetId);
        triggerVisionGlbMatch(targetId, product);
        return {
          ok: true,
          actionType: action.type,
          objectId: targetId,
          summary: `Replaced "${currentObj.label}" with ${product.title} (${formatPriceDollars(product.priceCents, product.currency)}).`,
        };
      }
    }

    // Deduplicate: if this exact Shopify product is already in the room, select & update it instead of spawning a duplicate
    const existingSameProduct = store.scene.objects.find(
      (o) => o.product?.productId === product.productId
    );
    if (existingSameProduct) {
      store.selectObject(existingSameProduct.id);
      return {
        ok: true,
        actionType: action.type,
        objectId: existingSameProduct.id,
        summary: `${product.title} is already in the room — selected the existing item instead of duplicating it.`,
      };
    }

    const templateObj: SceneObject = {
      id: `shopify-${Date.now()}`,
      kind: 'table',
      label: product.title,
      source: 'shopify',
      position: [0, 0, 0],
      size: [1.0, 0.85, 0.7],
      rotationY: 0,
      dimensionsVerified: false,
    };
    const patch = computeReplacementPatch(templateObj, product);
    const nextKind = patch.kind ?? templateObj.kind;
    const nextSize = normalizeObjectSizeForRoom(
      (patch.size as Vec3 | undefined) ?? templateObj.size,
      nextKind,
      store.scene.room,
      product.title
    );
    const pos = findOpenFloorPosition(store.scene, nextSize);

    const newObj: SceneObject = {
      ...templateObj,
      ...patch,
      id: templateObj.id,
      kind: nextKind,
      label: product.title,
      source: 'shopify',
      product,
      position: pos,
      size: nextSize,
      rotationY: 0,
      dimensionsVerified: false,
    };

    store.replaceSceneUndoable({
      ...store.scene,
      objects: deduplicateSceneObjects([...store.scene.objects, newObj]),
    });
    store.selectObject(newObj.id);
    triggerVisionGlbMatch(newObj.id, product);

    return {
      ok: true,
      actionType: action.type,
      objectId: newObj.id,
      summary: `Added ${product.title} (${formatPriceDollars(product.priceCents, product.currency)}) to the 3D room.`,
    };
  }

  if (action.type === 'place_shopify_order') {
    store.requestOpenShopDrawer();

    const chosenProducts: ProductRef[] = [];
    if (typeof action.productIndex === 'number') {
      const p = store.voiceShopProducts[action.productIndex - 1];
      if (!p) {
        return {
          ok: false,
          actionType: action.type,
          summary: `Product #${action.productIndex} is not in the current Shopify list. Ask me to browse products first.`,
        };
      }
      chosenProducts.push(p);
    } else {
      for (const obj of store.scene.objects) {
        if (obj.source === 'shopify' && obj.product) {
          chosenProducts.push(obj.product);
        }
      }
      if (chosenProducts.length === 0 && store.voiceShopProducts.length > 0) {
        chosenProducts.push(store.voiceShopProducts[0]);
      }
    }

    if (chosenProducts.length === 0) {
      return {
        ok: false,
        actionType: action.type,
        summary:
          'No Shopify products are selected or placed in the room yet. Ask me to browse Shopify products first.',
      };
    }

    try {
      const lines = chosenProducts.map((p) => ({
        variantId: p.variantId,
        seller: p.seller,
        sellerDomain: p.sellerDomain,
        productUrl: p.productUrl,
        quantity: 1,
      }));

      const res = await fetch('/api/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines }),
      });
      const data = (await res.json().catch(() => null)) as {
        carts?: Array<{
          seller: string;
          sellerDomain?: string;
          cartUrl: string | null;
          checkoutUrl?: string | null;
          subtotalCents?: number;
          totalCents?: number;
          currency?: string;
          fallbackProductUrls?: Array<{
            variantId: string;
            quantity: number;
            productUrl: string | null;
          }>;
        }>;
        warnings?: string[];
        error?: { message?: string };
      } | null;

      if (!res.ok || !data?.carts) {
        return {
          ok: false,
          actionType: action.type,
          summary:
            data?.error?.message ||
            `Could not create merchant order cart (HTTP ${res.status}).`,
        };
      }

      store.setVoiceOrderResult({
        carts: data.carts,
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
      });

      const totalCents = chosenProducts.reduce((sum, p) => sum + p.priceCents, 0);
      const firstCheckout =
        data.carts.find((c) => c.cartUrl || c.checkoutUrl)?.cartUrl ??
        data.carts.find((c) => c.checkoutUrl)?.checkoutUrl ??
        null;
      const itemSummary =
        chosenProducts.length === 1
          ? `${chosenProducts[0].title} (${formatPriceDollars(totalCents, chosenProducts[0].currency)})`
          : `${chosenProducts.length} Shopify items totaling ${formatPriceDollars(totalCents, chosenProducts[0].currency)}`;

      return {
        ok: true,
        actionType: action.type,
        checkoutUrl: firstCheckout,
        summary: firstCheckout
          ? `Order cart ready for ${itemSummary}. I opened the Shop Products side panel with the merchant checkout link so you can complete your order.`
          : `Prepared merchant order links for ${itemSummary} in the Shop Products side panel.`,
      };
    } catch (err) {
      return {
        ok: false,
        actionType: action.type,
        summary:
          err instanceof Error
            ? err.message
            : 'Unable to create Shopify checkout cart right now.',
      };
    }
  }

  if (action.type === 'redesign_room_style') {
    const budgetCents =
      typeof action.budgetDollars === 'number' && action.budgetDollars >= 0
        ? Math.round(action.budgetDollars * 100)
        : store.scene.budgetCents;

    const keepSet = new Set(action.keepObjectIds ?? []);
    const keptObjects: SceneObject[] =
      keepSet.size > 0
        ? store.scene.objects.filter((o) => keepSet.has(o.id))
        : action.keepExistingObjects
          ? store.scene.objects
          : [];

    const styleLower = action.style.toLowerCase();
    const isMinimal = /minimal|clean|simple|scandi|zen|japandi/.test(styleLower);
    const searchQueries = isMinimal
      ? ['minimalist table', 'modern floor lamp', 'wooden shelf']
      : ['accent table', 'display shelf', 'floor lamp', 'potted plant'];

    // Fetch live Shopify candidates within budget in parallel
    const candidateMap = new Map<string, ProductRef>();
    await Promise.all(
      searchQueries.map(async (q) => {
        try {
          const params = new URLSearchParams();
          params.set('q', q);
          if (budgetCents > 0) {
            params.set('maxPrice', String(budgetCents));
          }
          const res = await fetch(`/api/products?${params.toString()}`);
          if (!res.ok) return;
          const data = (await res.json().catch(() => null)) as {
            products?: ProductRef[];
          } | null;
          for (const p of (data?.products ?? []).slice(0, 3)) {
            if (!candidateMap.has(p.variantId)) {
              candidateMap.set(p.variantId, p);
            }
          }
        } catch {
          // Graceful fallback: plan can still generate 3D mockups without Shopify candidates
        }
      })
    );

    const candidates = Array.from(candidateMap.values()).slice(0, 10);

    try {
      const planRes = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room: store.scene.room,
          style: action.style,
          brief:
            action.brief ||
            `Create a complete ${action.style} room layout${
              keptObjects.length > 0
                ? ` keeping the ${keptObjects.length} specified owned item(s)`
                : ' from a clean slate'
            }.`,
          budgetCents,
          minWalkwayWidth: store.scene.minWalkwayWidth,
          noDrilling: store.scene.noDrilling,
          existingObjects: keptObjects.map((o) => ({
            id: o.id,
            kind: o.kind,
            label: o.label,
            widthMeters: o.size[0],
            heightMeters: o.size[1],
            depthMeters: o.size[2],
            position: o.position,
            rotationY: o.rotationY,
          })),
          products: candidates,
        }),
      });

      const planData = (await planRes.json().catch(() => null)) as {
        scene?: unknown;
        valid?: boolean;
        error?: { message?: string };
      } | null;

      if (!planRes.ok) {
        return {
          ok: false,
          actionType: action.type,
          summary:
            planData?.error?.message ||
            `Room redesign failed (HTTP ${planRes.status}).`,
        };
      }

      const parsed = ShopSceneSchema.safeParse(planData?.scene);
      if (!parsed.success) {
        return {
          ok: false,
          actionType: action.type,
          summary: 'Redesigned scene failed schema validation.',
        };
      }

      const rawScene = parsed.data;
      const nextScene = {
        ...rawScene,
        objects: deduplicateSceneObjects(
          rawScene.objects.map((o) => ({
            ...o,
            size: normalizeObjectSizeForRoom(o.size, o.kind, rawScene.room, o.label),
          }))
        ),
      };
      store.replaceSceneUndoable(nextScene);

      // Fire vision-based GLB matching for any Shopify items placed in the redesigned room
      for (const obj of nextScene.objects) {
        if (obj.source === 'shopify' && obj.product) {
          triggerVisionGlbMatch(obj.id, obj.product);
        }
      }

      const shopifyCostCents = nextScene.objects.reduce(
        (sum, o) =>
          o.source === 'shopify' && o.product ? sum + o.product.priceCents : sum,
        0
      );

      return {
        ok: true,
        valid: Boolean(planData?.valid),
        actionType: action.type,
        summary: `Redesigned the room in a ${action.style} style with ${nextScene.objects.length} items${
          shopifyCostCents > 0
            ? ` (${formatPriceDollars(shopifyCostCents)} in new Shopify items against your ${formatPriceDollars(budgetCents)} budget)`
            : ''
        }. Say "undo" anytime to restore the previous layout.`,
      };
    } catch (err) {
      return {
        ok: false,
        actionType: action.type,
        summary:
          err instanceof Error
            ? err.message
            : 'Unable to redesign the room right now.',
      };
    }
  }

  if (action.type === 'render_from_prompt') {
    const draft = store.draftedDesignPrompt;
    if (!draft) {
      return {
        ok: false,
        actionType: action.type,
        summary:
          'No design prompt is drafted right now. Wait for a new request before drafting or rendering.',
      };
    }
    if (store.isRenderingPrompt || Date.now() - lastPromptRenderAt < 3500) {
      return {
        ok: false,
        actionType: action.type,
        summary: 'Render already completed or in progress — skipping duplicate render.',
      };
    }

    // Consume the draft immediately so concurrent/follow-up voice turns can NEVER re-render it
    store.setDraftedDesignPrompt(null);
    store.setIsRenderingPrompt(true);
    lastPromptRenderAt = Date.now();
    try {
      const wantsWholeRoom =
        draft.mode === 'redesign' &&
        /\b(whole\s+room|entire\s+room|whole\s+layout|full\s+layout|entire\s+layout|redesign\s+(the\s+|my\s+)?room|restyle\s+(the\s+|my\s+)?room|replace\s+the\s+whole|change\s+the\s+whole|minimalist\s+look|decorative\s+look|start\s+fresh)\b/i.test(
          `${draft.prompt} ${draft.style ?? ''}`
        );

      if (wantsWholeRoom) {
        const res = await executeVoiceActionAsync(
          {
            type: 'redesign_room_style',
            style: draft.style || draft.prompt,
            brief: draft.prompt,
            budgetDollars: draft.budgetDollars,
            keepObjectIds: draft.keepObjectIds,
          },
          expectedEpoch
        );
        return { ...res, actionType: 'render_from_prompt' };
      }

      const effectiveMode: 'add' | 'replace' =
        draft.mode === 'add' ? 'add' : 'replace';
      const cmd =
        effectiveMode === 'add' &&
        !/^(add|place|put|insert)\b/i.test(draft.prompt)
          ? `Add ${draft.prompt}`
          : draft.prompt;

      const res = await fetch('/api/replace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: cmd,
          scene: store.scene,
          selectedObjectId:
            effectiveMode === 'add'
              ? null
              : (draft.targetObjectId ?? store.selectedId ?? null),
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        scene?: unknown;
        targetObjectId?: string;
        replacedObject?: SceneObject | null;
        explanation?: string;
        error?: { message?: string };
      } | null;

      if (!res.ok) {
        return {
          ok: false,
          actionType: action.type,
          summary:
            data?.error?.message || `Render failed (HTTP ${res.status}).`,
        };
      }

      const parsed = ShopSceneSchema.safeParse(data?.scene);
      if (!parsed.success) {
        return {
          ok: false,
          actionType: action.type,
          summary: 'Rendered scene failed schema validation.',
        };
      }

      // Surgical update: preserve EVERY other object in the current room verbatim
      const latestScene = useSceneStore.getState().scene;
      const targetId = data?.targetObjectId ?? null;
      const updatedObjFromApi =
        (targetId
          ? parsed.data.objects.find((o) => o.id === targetId)
          : null) ??
        data?.replacedObject ??
        null;

      let nextObjects: SceneObject[];
      if (updatedObjFromApi) {
        const normalizedSingle: SceneObject = {
          ...updatedObjFromApi,
          size: normalizeObjectSizeForRoom(
            updatedObjFromApi.size,
            updatedObjFromApi.kind,
            latestScene.room,
            updatedObjFromApi.label
          ),
        };
        const existsIdx = latestScene.objects.findIndex(
          (o) => o.id === normalizedSingle.id
        );
        if (existsIdx >= 0) {
          nextObjects = latestScene.objects.map((o, idx) =>
            idx === existsIdx ? normalizedSingle : o
          );
        } else {
          nextObjects = deduplicateSceneObjects([
            ...latestScene.objects,
            normalizedSingle,
          ]);
        }
      } else {
        nextObjects = deduplicateSceneObjects(
          parsed.data.objects.map((o) => ({
            ...o,
            size: normalizeObjectSizeForRoom(
              o.size,
              o.kind,
              latestScene.room,
              o.label
            ),
          }))
        );
      }

      store.replaceSceneUndoable({
        ...latestScene,
        objects: nextObjects,
      });
      if (typeof targetId === 'string') {
        store.selectObject(targetId);
      }

      return {
        ok: true,
        actionType: action.type,
        objectId: targetId ?? undefined,
        summary:
          data?.explanation ||
          `Updated only that single item without changing the rest of the room.`,
      };
    } catch (err) {
      return {
        ok: false,
        actionType: action.type,
        summary:
          err instanceof Error
            ? err.message
            : 'Unable to render the drafted prompt right now.',
      };
    } finally {
      store.setIsRenderingPrompt(false);
    }
  }

  return executeVoiceAction(action, expectedEpoch);
}
