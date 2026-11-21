import { describe, expect, it, vi } from 'vitest';
import { compactDemoScene } from '@/fixtures/demoScene';
import { ShopSceneSchema } from '@/lib/schema';
import {
  ANALYZE_MODEL_ID,
  analyzeSpaceMedia,
  analyzeSpaceUrl,
  generateShopPlan,
  PLAN_MODEL_ID,
  replaceObjectInScene,
} from '@/lib/gemini';
import { DEFAULT_MIN_WALKWAY_METERS, feetToMeters } from '@/lib/constraints';
import { POST as analyzePOST } from './route';
import { POST as planPOST } from '../plan/route';
import { POST as replacePOST } from '../replace/route';

describe('POST /api/analyze — multipart & YouTube JSON contracts (MediaIntakeModal + SetupWizard)', () => {
  it('extracts grounded observations inline and enforces uncalibrated warnings', async () => {
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
            uncertainty: 'Exact dimensions cannot be verified without scale reference.',
            likelyWallMounted: false,
          },
        ],
        roomCues: ['White painted drywall', 'Glass storefront entrance on south side'],
        warnings: [],
      }),
    });

    const result = await analyzeSpaceMedia({
      buffer: Buffer.from('fake-webm-bytes'),
      mimeType: 'video/webm;codecs=vp9',
      fileName: 'live-walkthrough.webm',
      notes: '12x10 skincare boutique',
      requestId: 'test-req-analyze',
      clientOverride: {
        models: { generateContent },
        files: { upload: vi.fn(), get: vi.fn(), delete: vi.fn() },
      } as never,
    });

    expect(result.modelUsed).toBe(ANALYZE_MODEL_ID);
    expect(result.uploadMethod).toBe('inline');
    expect(result.observations).toHaveLength(1);
    expect(result.warnings.some((w) => /uncalibrated/i.test(w))).toBe(true);
  });

  it('supports YouTube URL JSON payload sent by MediaIntakeModal', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        observations: [
          {
            id: 'obs-yt-1',
            kind: 'shelf',
            label: 'Freestanding oak display shelf',
            visualCues: ['4 open tiers'],
            possibleLocation: 'west wall',
            evidence: '00:05-00:11',
            confidence: 'medium',
            uncertainty: 'Uncalibrated walkthrough clip.',
          },
        ],
        roomCues: ['Track lighting'],
        warnings: [],
      }),
    });

    const ytResult = await analyzeSpaceUrl({
      mediaUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      youtubeId: 'dQw4w9WgXcQ',
      requestId: 'test-yt-001',
      clientOverride: {
        models: { generateContent },
        files: { upload: vi.fn(), get: vi.fn(), delete: vi.fn() },
      } as never,
    });

    expect(ytResult.uploadMethod).toBe('youtube_uri');
    expect(ytResult.observations[0].id).toBe('obs-yt-1');
    expect(ytResult.warnings.some((w) => /uncalibrated/i.test(w))).toBe(true);
  });

  it('uses Gemini Files API upload, polls ACTIVE, and deletes temporary remote file when forceFilesApi is true', async () => {
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
  });
});

describe('POST /api/plan — ShopSceneSchema contract, MediaIntakeModal currentScene, & 1-pass repair', () => {
  it('accepts MediaIntakeModal currentScene + analysis payload, performs 1 repair pass on blocked doorway, strips invented variant IDs, and passes ShopSceneSchema', async () => {
    const generateContent = vi
      .fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          objects: [
            {
              id: 'compact-owned-counter',
              kind: 'counter',
              label: 'Owned Checkout Counter',
              source: 'owned',
              position: [0.92, 0, -1.16],
              size: [1.44, 0.96, 0.52],
              rotationY: 0,
              dimensionsVerified: true,
            },
            {
              id: 'compact-owned-shelf',
              kind: 'shelf',
              label: 'Owned Natural Oak Wall Shelf',
              source: 'owned',
              position: [-1.54, 0, 0.12],
              size: [1.46, 2.05, 0.4],
              rotationY: Math.PI / 2,
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
              selectedVariantId: 'hallucinated-variant-999',
            },
          ],
          warnings: [],
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          objects: [
            {
              id: 'compact-owned-counter',
              kind: 'counter',
              label: 'Owned Checkout Counter',
              source: 'owned',
              position: [0.92, 0, -1.16],
              size: [1.44, 0.96, 0.52],
              rotationY: 0,
              dimensionsVerified: true,
            },
            {
              id: 'compact-owned-shelf',
              kind: 'shelf',
              label: 'Owned Natural Oak Wall Shelf',
              source: 'owned',
              position: [-1.54, 0, 0.12],
              size: [1.46, 2.05, 0.4],
              rotationY: Math.PI / 2,
              dimensionsVerified: true,
            },
            {
              id: 'new-table',
              kind: 'table',
              label: 'Repaired Birch Display Table',
              source: 'shopify',
              position: [0.1, 0, 0.02],
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
        purpose: compactDemoScene.purpose,
        style: compactDemoScene.style,
        budgetCents: 40000,
        minWalkwayWidth: DEFAULT_MIN_WALKWAY_METERS,
        noDrilling: true,
        analysis: {
          observations: [],
          roomCues: ['Warm wood floor'],
          warnings: [],
        },
        currentScene: compactDemoScene,
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
        requestId: 'test-plan-repair',
        clientOverride: { models: { generateContent } } as never,
      }
    );

    expect(result.modelUsed).toBe(PLAN_MODEL_ID);
    expect(result.repairCount).toBe(1);
    expect(result.valid).toBe(true);
    expect(ShopSceneSchema.safeParse(result.scene).success).toBe(true);

    const shopifyObj = result.scene.objects.find((o) => o.id === 'new-table');
    expect(shopifyObj?.source).toBe('shopify');
    expect(shopifyObj?.product?.variantId).toBe(
      'gid://shopify/ProductVariant/real-555'
    );
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
  });

  it('accepts SetupWizard DetectedObservation items with widthMeters/heightMeters/depthMeters and measurementsConfirmed room', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        objects: [
          {
            id: 'obs-1',
            kind: 'counter',
            label: 'Merchant Counter',
            source: 'owned',
            position: [-0.9, 0, -1.0],
            size: [1.2, 0.95, 0.55],
            rotationY: 0,
            dimensionsVerified: true,
          },
        ],
        warnings: [],
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
        purpose: 'Stage a skincare shop',
        style: 'Warm Minimalist',
        brief: 'Beauty & Skincare: Stage a skincare shop',
        budgetCents: 40000,
        minWalkwayWidth: DEFAULT_MIN_WALKWAY_METERS,
        noDrilling: true,
        currentScene: compactDemoScene,
        items: [
          {
            id: 'obs-1',
            kind: 'counter',
            label: 'Merchant Counter',
            owned: true,
            exclude: false,
            dimensionsVerified: true,
            widthMeters: 1.2,
            heightMeters: 0.95,
            depthMeters: 0.55,
          },
        ],
      },
      {
        requestId: 'test-setup-wizard',
        clientOverride: { models: { generateContent } } as never,
      }
    );

    expect(result.valid).toBe(true);
    expect(result.scene.objects[0]).toMatchObject({
      id: 'obs-1',
      source: 'owned',
      size: [1.2, 0.95, 0.55],
      dimensionsVerified: true,
    });
  });
});

describe('POST /api/replace — voice/text 3D object swap & mockup generator', () => {
  it('replaces a selected object with a new 3D mockup while preserving position and clamping inside room bounds', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        action: 'replace',
        targetObjectId: 'compact-proposal-table',
        replacement: {
          kind: 'table',
          label: 'Cream Linen Lounge Sofa',
          size: [1.85, 0.82, 0.88],
        },
        explanation:
          'Replaced the display table with a Cream Linen Lounge Sofa mockup.',
      }),
    });

    const result = await replaceObjectInScene(
      {
        command: 'Replace this with a cream linen lounge sofa',
        scene: compactDemoScene,
        selectedObjectId: 'compact-proposal-table',
      },
      {
        requestId: 'test-replace-01',
        clientOverride: { models: { generateContent } } as never,
      }
    );

    expect(result.action).toBe('replace');
    expect(result.targetObjectId).toBe('compact-proposal-table');
    expect(result.replacedObject?.label).toBe('Cream Linen Lounge Sofa');
    expect(result.replacedObject?.size).toEqual([1.85, 0.82, 0.88]);
    expect(ShopSceneSchema.safeParse(result.scene).success).toBe(true);
  });

  it('returns 400 structured error JSON on empty /api/replace command', async () => {
    const request = new Request('http://localhost:3000/api/replace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: '', scene: compactDemoScene }),
    });

    const response = await replacePOST(request);
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe('INVALID_INPUT');
  });
});
