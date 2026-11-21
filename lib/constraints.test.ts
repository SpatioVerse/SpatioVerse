import { describe, expect, it } from 'vitest';
import { compactDemoScene, flagshipScene } from '@/fixtures/demoScene';
import {
  type ProductRef,
  type SceneObject,
  type SceneValidator,
  type ShopScene,
} from '@/lib/schema';
import {
  DEFAULT_MIN_WALKWAY_METERS,
  evaluateScene,
  feetToMeters,
  validateScene,
} from '@/lib/constraints';

const SAMPLE_PRODUCT: ProductRef = {
  title: 'Minimal Birch Display Table',
  seller: 'Studio Nord',
  sellerDomain: 'studionord.myshopify.com',
  productId: 'gid://shopify/Product/1001',
  variantId: 'gid://shopify/ProductVariant/2001',
  priceCents: 22000, // $220.00
  currency: 'USD',
  productUrl: 'https://studionord.myshopify.com/products/minimal-birch-table',
  available: true,
};

function createBaseSkincareScene(
  overrides: Partial<ShopScene> = {}
): ShopScene {
  const ownedCounter: SceneObject = {
    id: 'owned-counter-1',
    kind: 'counter',
    label: 'Existing Wood Checkout Counter',
    source: 'owned',
    position: [-1.15, 0, -1.1],
    size: [1.1, 0.95, 0.55],
    rotationY: 0,
    dimensionsVerified: true,
  };

  const ownedShelf: SceneObject = {
    id: 'owned-shelf-1',
    kind: 'shelf',
    label: 'Existing Freestanding Oak Shelf',
    source: 'owned',
    position: [-1.55, 0, 0.2],
    size: [0.4, 1.8, 0.9],
    rotationY: 0,
    dimensionsVerified: true,
  };

  const shopifyTable: SceneObject = {
    id: 'shopify-table-1',
    kind: 'table',
    label: 'Minimal Birch Display Table',
    source: 'shopify',
    position: [1.15, 0, -0.4],
    size: [0.9, 0.8, 0.55],
    rotationY: 0,
    dimensionsVerified: true,
    product: SAMPLE_PRODUCT,
  };

  return {
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
    purpose: 'Display six skincare products with clear checkout',
    style: 'Modern, minimal, premium skincare boutique',
    budgetCents: 40000,
    minWalkwayWidth: DEFAULT_MIN_WALKWAY_METERS,
    noDrilling: true,
    objects: [ownedCounter, ownedShelf, shopifyTable],
    warnings: [],
    ...overrides,
  };
}

describe('validateScene — SceneValidator contract & deterministic spatial rules', () => {
  it('1. satisfies SceneValidator type and passes both flagshipScene and compactDemoScene from fixtures/demoScene.ts with zero errors', () => {
    const asValidator: SceneValidator = validateScene;

    const flagshipIssues = asValidator(flagshipScene);
    expect(flagshipIssues.filter((i) => i.severity === 'error')).toHaveLength(0);

    const compactIssues = asValidator(compactDemoScene);
    expect(compactIssues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('2. passes a verified 12x10 ft boutique scene within $400 budget with zero issues', () => {
    const scene = createBaseSkincareScene();
    const issues = validateScene(scene);
    const evaluated = evaluateScene(scene);

    expect(issues).toHaveLength(0);
    expect(evaluated.valid).toBe(true);
    expect(evaluated.summary.newPurchaseCents).toBe(22000);
    expect(evaluated.summary.remainingBudgetCents).toBe(18000);
  });

  it('3. flags OUT_OF_BOUNDS when a rotated fixture corner extends past a room wall or exceeds ceiling height', () => {
    const base = createBaseSkincareScene();
    const protrudingRack: SceneObject = {
      id: 'rack-oob',
      kind: 'rack',
      label: 'Angled Garment Rack',
      source: 'owned',
      position: [1.45, 0, 0],
      size: [1.4, 1.6, 0.5],
      rotationY: Math.PI / 4,
      dimensionsVerified: true,
    };
    const tallShelf: SceneObject = {
      id: 'shelf-too-tall',
      kind: 'shelf',
      label: 'Industrial Warehouse Unit',
      source: 'owned',
      position: [0, 0, -1.1],
      size: [0.8, 3.1, 0.4],
      rotationY: 0,
      dimensionsVerified: true,
    };

    const issues = validateScene({
      ...base,
      objects: [protrudingRack, tallShelf],
    });

    const oobIssues = issues.filter((i) => i.code === 'OUT_OF_BOUNDS');
    expect(oobIssues).toHaveLength(2);
    expect(oobIssues.flatMap((i) => i.objectIds)).toEqual(
      expect.arrayContaining(['rack-oob', 'shelf-too-tall'])
    );
  });

  it('4. detects exact rotated rectangle COLLISION via SAT', () => {
    const base = createBaseSkincareScene();
    const tableA: SceneObject = {
      id: 'table-a',
      kind: 'table',
      label: 'Center Display A',
      source: 'owned',
      position: [0, 0, -0.3],
      size: [1.2, 0.85, 0.5],
      rotationY: Math.PI / 6,
      dimensionsVerified: true,
    };
    const tableB: SceneObject = {
      id: 'table-b',
      kind: 'table',
      label: 'Center Display B',
      source: 'owned',
      position: [0.35, 0, -0.15],
      size: [1.0, 0.85, 0.5],
      rotationY: -Math.PI / 4,
      dimensionsVerified: true,
    };

    const issues = validateScene({
      ...base,
      objects: [tableA, tableB],
    });

    const collisionIssue = issues.find((i) => i.code === 'COLLISION');
    expect(collisionIssue).toBeDefined();
    expect(collisionIssue?.objectIds).toEqual(['table-a', 'table-b']);
  });

  it('5. allows a tabletop lamp resting on top of a counter (y = counterHeight) without false COLLISION or NO_DRILLING', () => {
    const base = createBaseSkincareScene();
    const counter = base.objects[0]; // size[1] = 0.95 -> top at y = 0.95
    const tabletopLamp: SceneObject = {
      id: 'accent-lamp-1',
      kind: 'lamp',
      label: 'Tabletop Ceramic Accent Lamp',
      source: 'owned',
      position: [counter.position[0], 0.95, counter.position[2]],
      size: [0.25, 0.4, 0.25],
      rotationY: 0,
      dimensionsVerified: true,
    };

    const issues = validateScene({
      ...base,
      objects: [...base.objects, tabletopLamp],
    });

    expect(issues.filter((i) => i.code === 'COLLISION')).toHaveLength(0);
    expect(issues.filter((i) => i.code === 'NO_DRILLING')).toHaveLength(0);
  });

  it('6. flags BLOCKED_PATH when a fixture sits inside the 3ft entrance clearance zone', () => {
    const base = createBaseSkincareScene();
    const doorwayBlocker: SceneObject = {
      id: 'blocking-table',
      kind: 'table',
      label: 'Promo Table Blocking Door',
      source: 'owned',
      position: [0, 0, 1.1],
      size: [1.0, 0.85, 0.6],
      rotationY: 0,
      dimensionsVerified: true,
    };

    const issues = validateScene({
      ...base,
      objects: [...base.objects, doorwayBlocker],
    });

    const pathIssue = issues.find((i) => i.code === 'BLOCKED_PATH');
    expect(pathIssue).toBeDefined();
    expect(pathIssue?.objectIds).toContain('blocking-table');
  });

  it('7. flags BLOCKED_PATH when fixtures pinch the interior corridor narrower than 3ft (0.9144m)', () => {
    const base = createBaseSkincareScene();
    const leftBarrier: SceneObject = {
      id: 'left-wide-counter',
      kind: 'counter',
      label: 'Left Wide Counter',
      source: 'owned',
      position: [-0.95, 0, 0.1],
      size: [1.65, 0.95, 0.5],
      rotationY: 0,
      dimensionsVerified: true,
    };
    const rightBarrier: SceneObject = {
      id: 'right-wide-shelf',
      kind: 'shelf',
      label: 'Right Wide Shelf',
      source: 'owned',
      position: [1.1, 0, 0.1],
      size: [1.35, 1.6, 0.5],
      rotationY: 0,
      dimensionsVerified: true,
    };
    const rearCounter: SceneObject = {
      id: 'rear-checkout',
      kind: 'counter',
      label: 'Rear Checkout',
      source: 'owned',
      position: [0, 0, -1.15],
      size: [1.1, 0.95, 0.5],
      rotationY: 0,
      dimensionsVerified: true,
    };

    const issues = validateScene({
      ...base,
      objects: [leftBarrier, rightBarrier, rearCounter],
    });

    expect(issues.some((i) => i.code === 'BLOCKED_PATH')).toBe(true);
  });

  it('8. flags OVER_BUDGET for new Shopify items while treating owned items as $0', () => {
    const base = createBaseSkincareScene({ budgetCents: 35000 });
    const expensiveRack: SceneObject = {
      id: 'shopify-rack-2',
      kind: 'rack',
      label: 'Brushed Brass Display Rack',
      source: 'shopify',
      position: [1.25, 0, 0.55],
      size: [0.8, 1.5, 0.45],
      rotationY: Math.PI / 2,
      dimensionsVerified: true,
      product: {
        ...SAMPLE_PRODUCT,
        variantId: 'gid://shopify/ProductVariant/3002',
        priceCents: 19500,
      },
    };
    const ownedWithOldPrice: SceneObject = {
      ...base.objects[0],
      product: { ...SAMPLE_PRODUCT, priceCents: 99900 },
    };

    const issues = validateScene({
      ...base,
      objects: [ownedWithOldPrice, base.objects[1], base.objects[2], expensiveRack],
    });

    const budgetIssue = issues.find((i) => i.code === 'OVER_BUDGET');
    expect(budgetIssue).toBeDefined();
    expect(budgetIssue?.objectIds).toEqual(['shopify-table-1', 'shopify-rack-2']);
  });

  it('9. flags NO_DRILLING for elevated wall art or wall-mounted shelves when noDrilling is true', () => {
    const base = createBaseSkincareScene({ noDrilling: true });
    const elevatedArt: SceneObject = {
      id: 'wall-art-1',
      kind: 'art',
      label: 'Framed Botanical Wall Print',
      source: 'owned',
      position: [0, 1.35, -1.45],
      size: [0.9, 0.7, 0.08],
      rotationY: 0,
      dimensionsVerified: true,
    };

    const blockedIssues = validateScene({
      ...base,
      objects: [...base.objects, elevatedArt],
    });
    expect(
      blockedIssues.some(
        (i) => i.code === 'NO_DRILLING' && i.objectIds.includes('wall-art-1')
      )
    ).toBe(true);

    const allowedIssues = validateScene({
      ...base,
      noDrilling: false,
      objects: [...base.objects, elevatedArt],
    });
    expect(allowedIssues.filter((i) => i.code === 'NO_DRILLING')).toHaveLength(0);
  });

  it('10. emits UNVERIFIED_DIMENSIONS warning without invalidating scene errors', () => {
    const base = createBaseSkincareScene();
    const unverifiedPlant: SceneObject = {
      id: 'plant-approx',
      kind: 'plant',
      label: 'Fiddle Leaf Fig Planter',
      source: 'owned',
      position: [1.45, 0, -1.2],
      size: [0.45, 1.1, 0.45],
      rotationY: 0,
      dimensionsVerified: false,
    };

    const evaluated = evaluateScene({
      ...base,
      objects: [...base.objects, unverifiedPlant],
    });

    expect(evaluated.valid).toBe(true);
    expect(evaluated.summary.errorCount).toBe(0);
    expect(evaluated.issues).toContainEqual(
      expect.objectContaining({
        code: 'UNVERIFIED_DIMENSIONS',
        severity: 'warning',
        objectIds: ['plant-approx'],
      })
    );
  });
});
