import type { SceneObject } from '@/lib/schema';

export const GLB_MODEL_PATHS = {
  // Plants, vases & mirrors
  plant: '/models/plant.glb',
  vase: '/models/vase.glb',
  mirror: '/models/mirror.glb',

  // Lighting varieties
  lamp: '/models/lamp.glb',
  lampTable: '/models/lamp_table.glb',

  // Sofa & lounge varieties (5)
  sofa: '/models/sofa.glb',
  sofaModern: '/models/sofa_modern.glb',
  sofaMinimal: '/models/sofa_minimal.glb',
  sofaWood: '/models/sofa_wood.glb',
  daybed: '/models/daybed.glb',

  // Chair, ottoman, bench & stool varieties (11)
  chair: '/models/chair.glb',
  chairModern: '/models/chair_modern.glb',
  chairMidcentury: '/models/chair_midcentury.glb',
  armchairClassic: '/models/armchair_classic.glb',
  chairGreen: '/models/chair_green.glb',
  chairWood: '/models/chair_wood.glb',
  ottoman: '/models/ottoman.glb',
  bench: '/models/bench.glb',
  stool: '/models/stool.glb',
  stoolBarRound: '/models/stool_bar_round.glb',
  stoolMetal: '/models/stool_metal.glb',

  // Table, desk & cart varieties (15)
  table: '/models/table.glb',
  tableRound: '/models/table_round.glb',
  tableRoundWood: '/models/table_round_wood.glb',
  tableRoundAccent: '/models/table_round_accent.glb',
  tableSide: '/models/table_side.glb',
  tableSideTall: '/models/table_side_tall.glb',
  tableSmallWood: '/models/table_small_wood.glb',
  tableCoffeeModern2: '/models/table_coffee_modern2.glb',
  tableIndustrial: '/models/table_industrial.glb',
  tableWoodClassic: '/models/table_wood_classic.glb',
  tableDining: '/models/table_dining.glb',
  tableConsole: '/models/table_console.glb',
  deskMetal: '/models/desk_metal.glb',
  cartCoffee: '/models/cart_coffee.glb',
  cartIndustrial: '/models/cart_industrial.glb',

  // Wardrobe, cabinet, dresser, nightstand & shelving varieties (10)
  wardrobe: '/models/wardrobe.glb',
  cabinet: '/models/cabinet.glb',
  cabinetPainted: '/models/cabinet_painted.glb',
  dresser: '/models/dresser.glb',
  nightstand: '/models/nightstand.glb',
  bookshelf: '/models/bookshelf.glb',
  shelf: '/models/shelf.glb',
  shelfWallUnit: '/models/shelf_wall_unit.glb',
  rack: '/models/rack.glb',
  rackSteelTall: '/models/rack_steel_tall.glb',

  // Bedroom (1)
  bed: '/models/bed.glb',
} as const;

export type GlbModelSpec = {
  url: string;
  fitMode: 'contain' | 'height' | 'fill';
  yOffset?: number;
};

/**
 * Resolves the closest-matching CC0 PBR GLB asset from our 46-model home-decor
 * & boutique library. When a Shopify product is clicked, `/api/match-model`
 * (`gemini-decision-1` + vision) overrides this with an image-grounded match.
 */
export function resolveGlbForObject(obj: SceneObject): GlbModelSpec | null {
  const isShopifyProduct = obj.source === 'shopify' && Boolean(obj.product);
  const label =
    isShopifyProduct && obj.product?.title ? obj.product.title : obj.label;

  // Plants
  if (obj.kind === 'plant') {
    return { url: GLB_MODEL_PATHS.plant, fitMode: 'contain' };
  }

  // Lighting varieties
  if (obj.kind === 'lamp') {
    if (isShopifyProduct) {
      return null;
    }
    if (/desk|table|bedside|task|reading/i.test(label)) {
      return { url: GLB_MODEL_PATHS.lampTable, fitMode: 'contain' };
    }
    return { url: GLB_MODEL_PATHS.lamp, fitMode: 'height' };
  }

  // Bedroom
  if (/\bday\s*bed|chaise/i.test(label)) {
    return { url: GLB_MODEL_PATHS.daybed, fitMode: 'fill' };
  }
  if (/\bbed\b|mattress|king\s*bed|queen\s*bed|twin\s*bed/i.test(label)) {
    return { url: GLB_MODEL_PATHS.bed, fitMode: 'fill' };
  }

  // Sofa varieties
  if (/sofa|couch|sectional|loveseat|settee/i.test(label)) {
    if (/minimal|plush|boucle|bouclé|scandi|low|white|cream|linen/i.test(label)) {
      return { url: GLB_MODEL_PATHS.sofaMinimal, fitMode: 'fill' };
    }
    if (/wood|painted|farmhouse|slat/i.test(label)) {
      return { url: GLB_MODEL_PATHS.sofaWood, fitMode: 'fill' };
    }
    if (/tufted|chesterfield|classic|vintage|leather/i.test(label)) {
      return { url: GLB_MODEL_PATHS.sofa, fitMode: 'fill' };
    }
    return { url: GLB_MODEL_PATHS.sofaModern, fitMode: 'fill' };
  }

  // Seating varieties
  if (/\bbench\b/i.test(label)) {
    return { url: GLB_MODEL_PATHS.bench, fitMode: 'fill' };
  }
  if (/ottoman|pouf|footstool/i.test(label)) {
    return { url: GLB_MODEL_PATHS.ottoman, fitMode: 'contain' };
  }
  if (/stool/i.test(label)) {
    if (/bar|round|counter/i.test(label)) {
      return { url: GLB_MODEL_PATHS.stoolBarRound, fitMode: 'contain' };
    }
    if (/metal|steel|industrial/i.test(label)) {
      return { url: GLB_MODEL_PATHS.stoolMetal, fitMode: 'contain' };
    }
    return { url: GLB_MODEL_PATHS.stool, fitMode: 'contain' };
  }
  if (/chair|lounge|seat|recliner/i.test(label)) {
    if (/mid[- ]?century|scandi|retro/i.test(label)) {
      return { url: GLB_MODEL_PATHS.chairMidcentury, fitMode: 'fill' };
    }
    if (/green|olive|emerald/i.test(label)) {
      return { url: GLB_MODEL_PATHS.chairGreen, fitMode: 'fill' };
    }
    if (/wood|dining|cafe/i.test(label)) {
      return { url: GLB_MODEL_PATHS.chairWood, fitMode: 'fill' };
    }
    if (/wingback|classic|vintage|tufted|club/i.test(label)) {
      return { url: GLB_MODEL_PATHS.armchairClassic, fitMode: 'fill' };
    }
    if (/modern|sculptural|white|cream|boucle|minimal|velvet/i.test(label)) {
      return { url: GLB_MODEL_PATHS.chairModern, fitMode: 'fill' };
    }
    return { url: GLB_MODEL_PATHS.chair, fitMode: 'fill' };
  }

  // Mirrors
  if (/mirror/i.test(label)) {
    return { url: GLB_MODEL_PATHS.mirror, fitMode: 'fill' };
  }

  // Desks & carts
  if (/cart|trolley|rolling/i.test(label)) {
    if (/industrial|storage|metal/i.test(label)) {
      return { url: GLB_MODEL_PATHS.cartIndustrial, fitMode: 'fill' };
    }
    return { url: GLB_MODEL_PATHS.cartCoffee, fitMode: 'fill' };
  }
  if (/\bdesk\b|workstation/i.test(label)) {
    return { url: GLB_MODEL_PATHS.deskMetal, fitMode: 'fill' };
  }

  // Wardrobes, dressers, nightstands
  if (/wardrobe|armoire|closet|cupboard/i.test(label)) {
    return { url: GLB_MODEL_PATHS.wardrobe, fitMode: 'fill' };
  }
  if (/dresser|chest\s*of\s*drawers|commode|drawer/i.test(label)) {
    return { url: GLB_MODEL_PATHS.dresser, fitMode: 'fill' };
  }
  if (/nightstand|bedside\s*table|night\s*table/i.test(label)) {
    return { url: GLB_MODEL_PATHS.nightstand, fitMode: 'fill' };
  }

  // Round tables (always render real round table GLBs!)
  if (/round|circular|pedestal/i.test(label) && /table|stand/i.test(label)) {
    if (/wood|walnut|oak|end\s*table|side\s*table/i.test(label)) {
      return { url: GLB_MODEL_PATHS.tableRoundWood, fitMode: 'fill' };
    }
    if (/accent|small|tall/i.test(label)) {
      return { url: GLB_MODEL_PATHS.tableRoundAccent, fitMode: 'fill' };
    }
    return { url: GLB_MODEL_PATHS.tableRound, fitMode: 'fill' };
  }

  if (isShopifyProduct) {
    return null;
  }

  if (/cabinet|credenza|sideboard|buffet/i.test(label)) {
    if (/painted|white|vintage/i.test(label)) {
      return { url: GLB_MODEL_PATHS.cabinetPainted, fitMode: 'fill' };
    }
    return { url: GLB_MODEL_PATHS.cabinet, fitMode: 'fill' };
  }
  if (/steel|metal.*(shelf|rack)|industrial.*(shelf|rack)|wire.*rack/i.test(label)) {
    if (/tall|wide|multi/i.test(label)) {
      return { url: GLB_MODEL_PATHS.rackSteelTall, fitMode: 'fill' };
    }
    return { url: GLB_MODEL_PATHS.rack, fitMode: 'fill' };
  }
  if (/bookcase|bookshelf/i.test(label)) {
    return { url: GLB_MODEL_PATHS.bookshelf, fitMode: 'fill' };
  }
  if (
    obj.kind === 'shelf' &&
    /display\s*shel|wood.*shel|oak.*shel|tier.*shel|wall\s*shel/i.test(label)
  ) {
    return { url: GLB_MODEL_PATHS.shelf, fitMode: 'fill' };
  }

  if (obj.kind === 'table') {
    if (/dining|conference|banquet/i.test(label)) {
      return { url: GLB_MODEL_PATHS.tableDining, fitMode: 'fill' };
    }
    if (/console|entryway|hallway/i.test(label)) {
      return { url: GLB_MODEL_PATHS.tableConsole, fitMode: 'fill' };
    }
    if (/tall.*side|tall.*end/i.test(label)) {
      return { url: GLB_MODEL_PATHS.tableSideTall, fitMode: 'fill' };
    }
    if (/side\s*table|end\s*table|accent\s*table/i.test(label)) {
      return { url: GLB_MODEL_PATHS.tableSide, fitMode: 'fill' };
    }
    if (/industrial/i.test(label)) {
      return { url: GLB_MODEL_PATHS.tableIndustrial, fitMode: 'fill' };
    }
    if (/coffee\s*table|low\s*table/i.test(label)) {
      return { url: GLB_MODEL_PATHS.table, fitMode: 'fill' };
    }
  }

  return null;
}
