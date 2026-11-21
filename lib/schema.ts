import { z } from 'zod';

/**
 * SpaceStage Spatial & Commerce Contract
 *
 * Coordinate Conventions (all lengths in meters, Y-up):
 * - Room floor is on the X/Z plane at Y = 0, centered at (0, 0).
 * - Room bounds: X in [-room.width / 2, +room.width / 2],
 *                Z in [-room.depth / 2, +room.depth / 2],
 *                Y in [0, room.height].
 * - Walls: north (z = -depth/2), south (z = +depth/2),
 *          west (x = -width/2), east (x = +width/2).
 * - entrance.offset: signed offset in meters from the center of that wall (0 = centered).
 * - SceneObject.position: [x, y, z] where x,z is footprint center and y is bottom elevation (0 = floor).
 * - SceneObject.size: [width, height, depth] in meters at rotationY = 0.
 * - SceneObject.rotationY: counter-clockwise rotation in radians around Y.
 * - Prices: integer cents. Owned items contribute 0 cents to new-purchase budget.
 */

export const FT_TO_METERS = 0.3048;

export type Vec3 = [number, number, number];

export type ProductRef = {
  title: string;
  seller: string;
  sellerDomain: string;
  productId: string;
  variantId: string;
  priceCents: number;
  currency: string;
  productUrl: string;
  imageUrl?: string;
  available?: boolean;
};

export type SceneObjectKind =
  | 'shelf'
  | 'counter'
  | 'table'
  | 'rack'
  | 'lamp'
  | 'plant'
  | 'art';

export type SceneObjectSource = 'owned' | 'shopify' | 'proposal';

export type SceneObject = {
  id: string;
  kind: SceneObjectKind;
  label: string;
  source: SceneObjectSource;
  position: Vec3;
  size: Vec3;
  rotationY: number;
  dimensionsVerified: boolean;
  locked?: boolean;
  product?: ProductRef;
};

export type RoomWall = 'north' | 'south' | 'east' | 'west';

export type ShopScene = {
  room: {
    width: number;
    depth: number;
    height: number;
    entrance: {
      wall: RoomWall;
      offset: number;
      width: number;
    };
  };
  purpose: string;
  style: string;
  budgetCents: number;
  minWalkwayWidth: number;
  noDrilling: boolean;
  objects: SceneObject[];
  warnings: string[];
};

export type ConstraintIssueCode =
  | 'OUT_OF_BOUNDS'
  | 'COLLISION'
  | 'BLOCKED_PATH'
  | 'OVER_BUDGET'
  | 'NO_DRILLING'
  | 'UNVERIFIED_DIMENSIONS';

export type ConstraintIssue = {
  code: ConstraintIssueCode;
  objectIds: string[];
  message: string;
  severity: 'error' | 'warning';
};

export type SceneValidator = (scene: ShopScene) => ConstraintIssue[];

// --- Zod runtime schemas matching the exact TypeScript contract ---

export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

export const ProductRefSchema = z.object({
  title: z.string(),
  seller: z.string(),
  sellerDomain: z.string(),
  productId: z.string(),
  variantId: z.string(),
  priceCents: z.number().int().nonnegative(),
  currency: z.string(),
  productUrl: z.string().url(),
  imageUrl: z.string().url().optional(),
  available: z.boolean().optional(),
});

export const SceneObjectSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['shelf', 'counter', 'table', 'rack', 'lamp', 'plant', 'art']),
  label: z.string().min(1),
  source: z.enum(['owned', 'shopify', 'proposal']),
  position: Vec3Schema,
  size: Vec3Schema,
  rotationY: z.number(),
  dimensionsVerified: z.boolean(),
  locked: z.boolean().optional(),
  product: ProductRefSchema.optional(),
});

export const ShopSceneSchema = z.object({
  room: z.object({
    width: z.number().positive(),
    depth: z.number().positive(),
    height: z.number().positive(),
    entrance: z.object({
      wall: z.enum(['north', 'south', 'east', 'west']),
      offset: z.number(),
      width: z.number().positive(),
    }),
  }),
  purpose: z.string(),
  style: z.string(),
  budgetCents: z.number().int().nonnegative(),
  minWalkwayWidth: z.number().positive(),
  noDrilling: z.boolean(),
  objects: z.array(SceneObjectSchema),
  warnings: z.array(z.string()),
});

export const ConstraintIssueSchema = z.object({
  code: z.enum([
    'OUT_OF_BOUNDS',
    'COLLISION',
    'BLOCKED_PATH',
    'OVER_BUDGET',
    'NO_DRILLING',
    'UNVERIFIED_DIMENSIONS',
  ]),
  objectIds: z.array(z.string()),
  message: z.string(),
  severity: z.enum(['error', 'warning']),
});
