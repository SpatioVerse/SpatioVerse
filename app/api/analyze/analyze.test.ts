import { describe, expect, it, vi } from 'vitest';
import {
  ANALYZE_MODEL_ID,
  analyzeSpaceMedia,
  generateShopPlan,
  PLAN_MODEL_ID,
} from '../../../lib/gemini';
import { DEFAULT_MIN_WALKWAY_METERS, feetToMeters } from '../../../lib/constraints';
import { POST as analyzePOST } from './route';
import { POST as planPOST } from '../plan/route';

describe('Gemini 4 Neon — analyzeSpaceMedia & POST /api/analyze', () => {
  it('extracts grounded observations inline, preserves model ID gemini-4-neon, and enforces uncalibrated warnings', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        observations: [
          {
            id: 'obs-1',
            kind: 'counter',
            label: 'Light wood checkout counter',
            visualCues: ['matte oak veneer', 'freestanding rectangular base'],
            possibleLocation: 'back-left corner against west wall',
            evidence: '00:02-00:06 — counter visible on left pan',
            confidence: 'high',
            uncertainty: 'Depth and exact width cannot be verified without scale reference.',
            likelyWallMounted: false,
          },
        ],
        roomCues: ['White painted drywall', 'Glass storefront entrance on south side'],
        warnings: [],
      }),
    });

    const mockClient = {
      models: { generateContent },
      files: {
        upload: vi.fn(),
        get: vi.fn(),
        delete: vi.fn(),
      },
    };

    const result = await analyzeSpaceMedia({
      buffer: Buffer.from('fake-mp4-bytes'),
      mimeType: 'video/mp4',
      fileName: 'shop-walkthrough.mp4',
      notes: '12x10 skincare boutique',
      requestId: 'test-req-analyze',
      clientOverride: mockClient as never,
    });

    expect(result.modelUsed).toBe(ANALYZE_MODEL_ID);
    expect(result.modelUsed).toBe('gemini-4-neon');
    expect(result.uploadMethod).toBe('inline');
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].id).toBe('obs-1');
    expect(result.warnings.some((w) => /uncalibrated/i.test(w))).toBe(true);
    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-4-neon',
      })
    );
  });

  it('uses Gemini Files API upload, polls PROCESSING -> ACTIVE, and cleans up remote file when forceFilesApi is true', async () => {
    const upload = vi.fn().mockResolvedValue({
      name: 'files/temp-shop-clip',
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/temp-shop-clip',
      mimeType: 'video/mp4',
      state: 'ACTIVE',
    });
    const del = vi.fn().mockResolvedValue({});
    const generateContent = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        observations: [],
        roomCues: ['Empty concrete floor'],
        warnings: ['Uncalibrated handheld clip'],
      }),
    });

    const result = await analyzeSpaceMedia({
      buffer: Buffer.from('large-video-payload'),
      mimeType: 'video/mp4',
      requestId: 'test-files-api',
      forceFilesApi: true,
      clientOverride: {
        models: { generateContent },
        files: { upload, get: vi.fn(), delete: del },
      } as never,
    });

    expect(result.uploadMethod).toBe('files_api');
    expect(upload).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith({ name: 'files/temp-shop-clip' });
  });

  it('rejects unsupported MIME uploads on POST /api/analyze with 415 structured error JSON', async () => {
    const form = new FormData();
    form.append(
      'file',
      new File([Buffer.from('not-media')], 'document.pdf', {
        type: 'application/pdf',
      })
    );

    const request = new Request('http://localhost:3000/api/analyze', {
      method: 'POST',
      body: form,
    });

    const response = await analyzePOST(request);
    const payload = await response.json();

    expect(response.status).toBe(415);
    expect(payload.error.code).toBe('INVALID_MIME');
    expect(payload.error.modelAttempted).toBe('gemini-4-neon');
  });
});

describe('Gemini 4 Hydrogen — generateShopPlan & POST /api/plan', () => {
  it('runs deterministic validation, performs 1 Hydrogen repair pass when initial layout blocks entrance, and strips hallucinated Shopify IDs', async () => {
    const generateContent = vi
      .fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          objects: [
            {
              id: 'owned-counter',
              kind: 'counter',
              label: 'Owned Checkout Counter',
              source: 'owned',
              position: [-1.1, 0, -1.0],
              size: [1.1, 0.95, 0.55],
              rotationY: 0,
              dimensionsVerified: true,
            },
            {
              id: 'new-table',
              kind: 'table',
              label: 'Display Table Blocking Door',
              source: 'shopify',
              position: [0, 0, 1.2], // Blocks south entrance!
              size: [1.0, 0.8, 0.6],
              rotationY: 0,
              dimensionsVerified: true,
              selectedVariantId: 'hallucinated-variant-999', // Not in candidate list!
            },
          ],
          warnings: [],
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          objects: [
            {
              id: 'owned-counter',
              kind: 'counter',
              label: 'Owned Checkout Counter',
              source: 'owned',
              position: [-1.1, 0, -1.0],
              size: [1.1, 0.95, 0.55],
              rotationY: 0,
              dimensionsVerified: true,
            },
            {
              id: 'new-table',
              kind: 'table',
              label: 'Repaired Birch Display Table',
              source: 'shopify',
              position: [1.15, 0, -0.5], // Valid clear placement!
              size: [0.9, 0.8, 0.55],
              rotationY: 0,
              dimensionsVerified: false,
              selectedVariantId: 'gid://shopify/ProductVariant/real-555',
            },
          ],
          warnings: ['Moved display table away from south entrance to restore 3ft walkway.'],
        }),
      });

    const result = await generateShopPlan(
      {
        room: {
          width: feetToMeters(12),
          depth: feetToMeters(10),
          height: feetToMeters(9),
          entrance: {
            wall: 'south',
            offset: 0,
            width: DEFAULT_MIN_WALKWAY_METERS,
          },
        },
        purpose: 'Skincare boutique showcasing 6 hero products',
        style: 'Minimal warm oak aesthetic',
        budgetCents: 40000,
        minWalkwayWidth: DEFAULT_MIN_WALKWAY_METERS,
        noDrilling: true,
        existingObjects: [
          {
            id: 'owned-counter',
            kind: 'counter',
            label: 'Owned Checkout Counter',
            size: [1.1, 0.95, 0.55],
            dimensionsVerified: true,
          },
        ],
        products: [
          {
            title: 'Real Shopify Birch Table',
            seller: 'Nordic Retail Co',
            sellerDomain: 'nordicretail.myshopify.com',
            productId: 'gid://shopify/Product/555',
            variantId: 'gid://shopify/ProductVariant/real-555',
            priceCents: 24500,
            currency: 'USD',
            productUrl: 'https://nordicretail.myshopify.com/products/birch-table',
            available: true,
          },
        ],
      },
      {
        requestId: 'test-h2-repair',
        clientOverride: { models: { generateContent } } as never,
      }
    );

    expect(result.modelUsed).toBe(PLAN_MODEL_ID);
    expect(result.modelUsed).toBe('gemini-4-hydrogen');
    expect(result.repairCount).toBe(1);
    expect(result.valid).toBe(true);
    expect(generateContent).toHaveBeenCalledTimes(2);

    const shopifyObj = result.scene.objects.find((o) => o.id === 'new-table');
    expect(shopifyObj?.source).toBe('shopify');
    expect(shopifyObj?.product?.variantId).toBe(
      'gid://shopify/ProductVariant/real-555'
    );
    expect(shopifyObj?.product?.priceCents).toBe(24500);
    expect(shopifyObj?.dimensionsVerified).toBe(false);
    expect(
      result.issues.some((i) => i.code === 'UNVERIFIED_DIMENSIONS')
    ).toBe(true);
  });

  it('returns 400 structured error JSON on invalid /api/plan request body', async () => {
    const request = new Request('http://localhost:3000/api/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budgetCents: -10 }),
    });

    const response = await planPOST(request);
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe('INVALID_INPUT');
    expect(payload.error.modelAttempted).toBe('gemini-4-hydrogen');
  });
});
