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

export type SceneObject = {
  id: string;
  kind: 'shelf' | 'counter' | 'table' | 'rack' | 'lamp' | 'plant' | 'art';
  label: string;
  source: 'owned' | 'shopify' | 'proposal';
  position: Vec3;
  size: Vec3;
  rotationY: number;
  dimensionsVerified: boolean;
  locked?: boolean;
  product?: ProductRef;
};

export type ShopScene = {
  room: {
    width: number;
    depth: number;
    height: number;
    entrance: {
      wall: 'north' | 'south' | 'east' | 'west';
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

export type ConstraintIssue = {
  code:
    | 'OUT_OF_BOUNDS'
    | 'COLLISION'
    | 'BLOCKED_PATH'
    | 'OVER_BUDGET'
    | 'NO_DRILLING'
    | 'UNVERIFIED_DIMENSIONS';
  objectIds: string[];
  message: string;
  severity: 'error' | 'warning';
};
