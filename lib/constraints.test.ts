import { describe, expect, it } from 'vitest';
import type { ProductRef, SceneObject, ShopScene } from './schema';
import {
  DEFAULT_MIN_WALKWAY_METERS,
  feetToMeters,
  validateScene,
} from './constraints';

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
  // 12 ft x 10 ft x 9 ft room: 3.6576 m x 3.048 m x 2.7432 m
  // Centered origin: X in [-1.8288, +1.8288], Z in [-1.524, +1.524]
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
      width: feetToMeters(12), // 3.6576 m
      depth: feetToMeters(10), // 3.048 m
      height: feetToMeters(9), // 2.7432 m
      entrance: {
        wall: 'south',
        offset: 0,
        width: DEFAULT_MIN_WALKWAY_METERS, // 0.9144 m (3 ft)
      },
    },
    purpose: 'Display six skincare products with clear checkout',
    style: 'Modern, minimal, premium skincare boutique',
    budgetCents: 40000, // $400.00
    minWalkwayWidth: DEFAULT_MIN_WALKWAY_METERS,
    noDrilling: true,
    objects: [ownedCounter, ownedShelf, shopifyTable],
    warnings: [],
    ...overrides,
  };
}

describe('validateScene — deterministic spatial & commerce constraints', () => {
  it('1. passes a valid 12x10 ft boutique scene with owned + Shopify fixtures within $400 budget', () => {
    const scene = createBaseSkincareScene();
    const result = validateScene(scene);

    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.summary.newPurchaseCents).toBe(22000);
    expect(result.summary.remainingBudgetCents).toBe(18000);
  });

  it('2. flags OUT_OF_BOUNDS when a rotated fixture corner extends past a room wall or exceeds ceiling height', () => {
    const base = createBaseSkincareScene();
    // Place a 1.4m wide rack near the east wall (+1.8288) rotated 45 deg so corner pokes past +1.8288
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
    // Also add an oversized tall shelf exceeding 9ft (2.7432m) ceiling
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

    const result = validateScene({
      ...base,
      objects: [protrudingRack, tallShelf],
    });

    expect(result.valid).toBe(false);
    const oobIssues = result.issues.filter((i) => i.code === 'OUT_OF_BOUNDS');
    expect(oobIssues).toHaveLength(2);
    expect(oobIssues.flatMap((i) => i.objectIds)).toEqual(
      expect.arrayContaining(['rack-oob', 'shelf-too-tall'])
    );
  });

  it('3. detects exact rotated rectangle COLLISION via SAT while allowing non-overlapping angled items', () => {
    const base = createBaseSkincareScene();
    const tableA: SceneObject = {
      id: 'table-a',
      kind: 'table',
      label: 'Center Display A',
      source: 'owned',
      position: [0, 0, -0.3],
      size: [1.2, 0.85, 0.5],
      rotationY: Math.PI / 6, // 30 deg
      dimensionsVerified: true,
    };
    const tableB: SceneObject = {
      id: 'table-b',
      kind: 'table',
      label: 'Center Display B',
      source: 'owned',
      position: [0.35, 0, -0.15],
      size: [1.0, 0.85, 0.5],
      rotationY: -Math.PI / 4, // -45 deg overlapping tableA
      dimensionsVerified: true,
    };

    const colliding = validateScene({
      ...base,
      objects: [tableA, tableB],
    });

    expect(colliding.valid).toBe(false);
    const collisionIssue = colliding.issues.find((i) => i.code === 'COLLISION');
    expect(collisionIssue).toBeDefined();
    expect(collisionIssue?.objectIds).toEqual(['table-a', 'table-b']);
  });

  it('4. allows a tabletop lamp resting on top of a counter without false COLLISION or NO_DRILLING errors', () => {
    const base = createBaseSkincareScene();
    const counter = base.objects[0]; // top at y = 0.95, position [-1.15, 0, -1.1]
    const tabletopLamp: SceneObject = {
      id: 'accent-lamp-1',
      kind: 'lamp',
      label: 'Tabletop Ceramic Accent Lamp',
      source: 'owned',
      // Center-Y at 0.95 + 0.20 = 1.15 -> bottomY = 0.95 (resting on counter top)
      position: [counter.position[0], 1.15, counter.position[2]],
      size: [0.25, 0.4, 0.25],
      rotationY: 0,
      dimensionsVerified: true,
    };

    const result = validateScene({
      ...base,
      objects: [...base.objects, tabletopLamp],
    });

    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.code === 'COLLISION')).toHaveLength(0);
    expect(result.issues.filter((i) => i.code === 'NO_DRILLING')).toHaveLength(0);
  });

  it('5. flags BLOCKED_PATH when a fixture sits inside the 3ft entrance clearance zone', () => {
    const base = createBaseSkincareScene();
    // South wall is at z = +1.524, entrance offset = 0 -> blocking table right at [0, 0, 1.1]
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

    const result = validateScene({
      ...base,
      objects: [...base.objects, doorwayBlocker],
    });

    expect(result.valid).toBe(false);
    const pathIssue = result.issues.find((i) => i.code === 'BLOCKED_PATH');
    expect(pathIssue).toBeDefined();
    expect(pathIssue?.objectIds).toContain('blocking-table');
  });

  it('6. flags BLOCKED_PATH when fixtures pinch the interior corridor narrower than 3ft (0.9144m)', () => {
    const base = createBaseSkincareScene();
    // Create a horizontal barrier across z = 0.2 leaving only a 0.55m gap (< 0.9144m) so rear counter is unreachable by a 3ft walkway
    const leftBarrier: SceneObject = {
      id: 'left-wide-counter',
      kind: 'counter',
      label: 'Left Wide Counter',
      source: 'owned',
      position: [-0.95, 0, 0.1],
      size: [1.65, 0.95, 0.5], // spans [-1.775, -0.125]
      rotationY: 0,
      dimensionsVerified: true,
    };
    const rightBarrier: SceneObject = {
      id: 'right-wide-shelf',
      kind: 'shelf',
      label: 'Right Wide Shelf',
      source: 'owned',
      position: [1.1, 0, 0.1],
      size: [1.35, 1.6, 0.5], // spans [0.425, 1.775] -> center gap is [-0.125, +0.425] = 0.55m (< 0.9144m)
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

    const result = validateScene({
      ...base,
      objects: [leftBarrier, rightBarrier, rearCounter],
    });

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'BLOCKED_PATH')).toBe(true);
  });

  it('7. flags OVER_BUDGET for new Shopify items while treating owned items as $0 even if priced', () => {
    const base = createBaseSkincareScene({ budgetCents: 35000 }); // $350 budget
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
        priceCents: 19500, // $220 + $195 = $415 > $350
      },
    };
    // Owned item with accidental product metadata must still contribute $0
    const ownedWithOldPrice: SceneObject = {
      ...base.objects[0],
      product: { ...SAMPLE_PRODUCT, priceCents: 99900 },
    };

    const result = validateScene({
      ...base,
      objects: [ownedWithOldPrice, base.objects[1], base.objects[2], expensiveRack],
    });

    expect(result.valid).toBe(false);
    expect(result.summary.newPurchaseCents).toBe(41500);
    const budgetIssue = result.issues.find((i) => i.code === 'OVER_BUDGET');
    expect(budgetIssue).toBeDefined();
    expect(budgetIssue?.objectIds).toEqual(['shopify-table-1', 'shopify-rack-2']);
  });

  it('8. flags NO_DRILLING for wall-mounted shelves, hanging sconces, or framed wall art when noDrilling is true', () => {
    const base = createBaseSkincareScene({ noDrilling: true });
    const floatingWallShelf: SceneObject = {
      id: 'wall-shelf-1',
      kind: 'shelf',
      label: 'Floating Wall-Mounted Display Shelf',
      source: 'owned',
      position: [0, 1.45, -1.4],
      size: [1.0, 0.25, 0.25],
      rotationY: 0,
      dimensionsVerified: true,
    };

    const blockedResult = validateScene({
      ...base,
      objects: [...base.objects, floatingWallShelf],
    });
    expect(blockedResult.valid).toBe(false);
    expect(
      blockedResult.issues.some(
        (i) => i.code === 'NO_DRILLING' && i.objectIds.includes('wall-shelf-1')
      )
    ).toBe(true);

    // Turning off noDrilling allows wall-mounted fixtures
    const allowedResult = validateScene({
      ...base,
      noDrilling: false,
      objects: [...base.objects, floatingWallShelf],
    });
    expect(allowedResult.issues.filter((i) => i.code === 'NO_DRILLING')).toHaveLength(0);
  });

  it('9. emits UNVERIFIED_DIMENSIONS as a warning (not a hard error) when dimensionsVerified is false', () => {
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

    const result = validateScene({
      ...base,
      objects: [...base.objects, unverifiedPlant],
    });

    expect(result.valid).toBe(true);
    expect(result.summary.errorCount).toBe(0);
    expect(result.summary.warningCount).toBe(1);
    expect(result.issues[0]).toMatchObject({
      code: 'UNVERIFIED_DIMENSIONS',
      severity: 'warning',
      objectIds: ['plant-approx'],
    });
  });

  it('10. enforces entrance clearance on alternate walls (east entrance)', () => {
    const base = createBaseSkincareScene({
      room: {
        width: feetToMeters(12),
        depth: feetToMeters(10),
        height: feetToMeters(9),
        entrance: {
          wall: 'east',
          offset: 0,
          width: DEFAULT_MIN_WALKWAY_METERS,
        },
      },
    });
    // Place shelf right inside east doorway (+1.8288) at [1.45, 0, 0]
    const eastBlocker: SceneObject = {
      id: 'east-door-blocker',
      kind: 'shelf',
      label: 'Shelf Blocking East Door',
      source: 'owned',
      position: [1.45, 0, 0],
      size: [0.5, 1.6, 0.9],
      rotationY: 0,
      dimensionsVerified: true,
    };

    const result = validateScene({
      ...base,
      objects: [base.objects[0], eastBlocker],
    });

    expect(result.valid).toBe(false);
    expect(
      result.issues.some(
        (i) =>
          i.code === 'BLOCKED_PATH' && i.objectIds.includes('east-door-blocker')
      )
    ).toBe(true);
  });
});
