import * as THREE from 'three';

export interface OakFloorTextureSet {
  map: THREE.CanvasTexture | null;
  bumpMap: THREE.CanvasTexture | null;
  roughnessMap: THREE.CanvasTexture | null;
}

export interface MaterialBumpTextureSet {
  map: THREE.CanvasTexture | null;
  bumpMap: THREE.CanvasTexture | null;
}

interface OakBaseCanvases {
  albedo: HTMLCanvasElement;
  bump: HTMLCanvasElement;
  roughness: HTMLCanvasElement;
}

interface DualBaseCanvases {
  albedo: HTMLCanvasElement;
  bump: HTMLCanvasElement;
}

const TWO_PI = Math.PI * 2;

const oakTextureCache = new Map<string, OakFloorTextureSet>();
const plasterTextureCache = new Map<string, MaterialBumpTextureSet>();
const travertineTextureCache = new Map<string, MaterialBumpTextureSet>();
const flutedOakTextureCache = new Map<string, MaterialBumpTextureSet>();

let oakBaseCache: OakBaseCanvases | null = null;
let plasterBaseCache: DualBaseCanvases | null = null;
let travertineBaseCache: DualBaseCanvases | null = null;
let flutedOakBaseCache: DualBaseCanvases | null = null;

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

function hash2D(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

function tileableValueNoise(
  u: number,
  v: number,
  periodX: number,
  periodY: number,
  seed: number,
): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);

  const ix0 = ((x0 % periodX) + periodX) % periodX;
  const iy0 = ((y0 % periodY) + periodY) % periodY;
  const ix1 = (ix0 + 1) % periodX;
  const iy1 = (iy0 + 1) % periodY;

  const n00 = hash2D(ix0, iy0, seed);
  const n10 = hash2D(ix1, iy0, seed);
  const n01 = hash2D(ix0, iy1, seed);
  const n11 = hash2D(ix1, iy1, seed);

  const nx0 = n00 + (n10 - n00) * sx;
  const nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sy;
}

function tileableFbm(
  u: number,
  v: number,
  basePeriodX: number,
  basePeriodY: number,
  octaves: number,
  seed: number,
): number {
  let total = 0;
  let amplitude = 0.5;
  let norm = 0;
  let px = basePeriodX;
  let py = basePeriodY;

  for (let i = 0; i < octaves; i += 1) {
    total += tileableValueNoise(u, v, px, py, seed + i * 31) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    px *= 2;
    py *= 2;
  }

  return total / norm;
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function configureTexture(
  canvas: HTMLCanvasElement,
  repeatX: number,
  repeatY: number,
  isColor: boolean,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.anisotropy = 8;
  texture.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function formatRepeatKey(repeatX: number, repeatY: number): string {
  return `${repeatX.toFixed(2)}:${repeatY.toFixed(2)}`;
}

function buildOakFloorCanvases(): OakBaseCanvases {
  if (oakBaseCache) {
    return oakBaseCache;
  }

  const size = 1024;
  const albedo = createCanvas(size, size);
  const bump = createCanvas(size, size);
  const roughness = createCanvas(size, size);

  const aCtx = albedo.getContext('2d');
  const bCtx = bump.getContext('2d');
  const rCtx = roughness.getContext('2d');

  if (!aCtx || !bCtx || !rCtx) {
    oakBaseCache = { albedo, bump, roughness };
    return oakBaseCache;
  }

  const aImg = aCtx.createImageData(size, size);
  const bImg = bCtx.createImageData(size, size);
  const rImg = rCtx.createImageData(size, size);
  const aData = aImg.data;
  const bData = bImg.data;
  const rData = rImg.data;

  const plankCount = 6;
  const plankWidth = size / plankCount;

  // Two staggered butt-joints per column so y=0 and y=size belong to the same board (seamless Y wrap).
  const jointA: number[] = [];
  const jointB: number[] = [];
  for (let col = 0; col < plankCount; col += 1) {
    const a = Math.floor((((col * 0.37 + 0.14) % 0.44) + 0.05) * size);
    const span = Math.floor((0.46 + ((col * 17) % 5) * 0.025) * size);
    jointA.push(a);
    jointB.push((a + span) % size);
  }

  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    const vSin1 = Math.sin(TWO_PI * v);
    const vCos1 = Math.cos(TWO_PI * v);
    const vSin2 = Math.sin(TWO_PI * 2 * v);

    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const col = Math.min(plankCount - 1, Math.floor(x / plankWidth));
      const localX = (x - col * plankWidth) / plankWidth;

      const jA = jointA[col];
      const jB = jointB[col];
      const inFirstBoard = jA < jB ? y >= jA && y < jB : y >= jA || y < jB;
      const boardIndex = col * 2 + (inFirstBoard ? 0 : 1);

      const boardSeed = 101 + boardIndex * 53;
      const toneShift = (hash2D(boardIndex, 1, 7) - 0.5) * 24;
      const warmthShift = (hash2D(boardIndex, 2, 13) - 0.5) * 10;
      const ringFreq = 6.5 + hash2D(boardIndex, 3, 19) * 5.5;
      const ringCenter = 0.2 + hash2D(boardIndex, 4, 29) * 0.6;
      const grainPhase = hash2D(boardIndex, 5, 37) * TWO_PI;

      // Seamless periodic grain distortion along Y so the wrapping board shows zero seam.
      const waveWarp =
        tileableValueNoise(u, v, 12, 4, boardSeed) * 0.42 +
        tileableValueNoise(u, v, 24, 8, boardSeed + 17) * 0.18 +
        0.08 * Math.sin(grainPhase + vSin1 * 1.4 + vCos1 * 0.9 + vSin2 * 0.5);

      const radial = Math.abs(localX - ringCenter) * 1.35 + waveWarp;
      const ringSignal = Math.sin(radial * ringFreq * TWO_PI + grainPhase);
      const grainBand = Math.pow(0.5 + 0.5 * ringSignal, 1.85);

      // Fine longitudinal oak fiber streaks & open pores.
      const fiberStreak = tileableValueNoise(u, v, 96, 10, boardSeed + 41);
      const finePore = tileableValueNoise(u, v, 160, 28, boardSeed + 67);
      const poreDip = finePore > 0.8 ? (finePore - 0.8) / 0.2 : 0;

      // Medullary ray shimmer (subtle pale horizontal flecks typical of quartersawn European oak).
      const rayNoise = tileableValueNoise(u, v, 28, 72, boardSeed + 89);
      const rayHighlight = rayNoise > 0.83 ? ((rayNoise - 0.83) / 0.17) * 9 : 0;

      // Subtle sapwood-to-heartwood cross-board tonal gradient.
      const crossGradient = (localX - 0.5) * 7;

      // Plank seams (longitudinal V-bevel + horizontal butt-joint micro-bevel).
      const distEdgeX = Math.min(localX * plankWidth, (1 - localX) * plankWidth);
      const distJointA = Math.min(Math.abs(y - jA), size - Math.abs(y - jA));
      const distJointB = Math.min(Math.abs(y - jB), size - Math.abs(y - jB));
      const distJointY = Math.min(distJointA, distJointB);

      const seamX = distEdgeX < 2.2 ? 1 - distEdgeX / 2.2 : 0;
      const seamY = distJointY < 1.8 ? 1 - distJointY / 1.8 : 0;
      const seamFactor = Math.max(seamX, seamY);

      // Warm European white oak palette (gallery satin-matte finish).
      let r = 199 + toneShift + warmthShift * 0.6 + crossGradient;
      let g = 169 + toneShift * 0.88 + warmthShift * 0.2 + crossGradient * 0.85;
      let b = 133 + toneShift * 0.72 - warmthShift * 0.3 + crossGradient * 0.68;

      // Darken latewood grain lines and fine open oak pores.
      const grainDarken = (1 - grainBand) * 19 + (fiberStreak - 0.5) * 13 + poreDip * 26;
      r = r - grainDarken + rayHighlight;
      g = g - grainDarken * 0.96 + rayHighlight * 0.92;
      b = b - grainDarken * 0.88 + rayHighlight * 0.82;

      // Deepen subtle beveled plank joints.
      if (seamFactor > 0) {
        const shade = 1 - seamFactor * 0.52;
        r *= shade;
        g *= shade * 0.98;
        b *= shade * 0.95;
      }

      // Bump height: mid-high oak surface, subtle grain relief, recessed pores, crisp plank bevels.
      const bumpVal =
        158 +
        (grainBand - 0.5) * 18 +
        (fiberStreak - 0.5) * 14 -
        poreDip * 34 -
        seamFactor * 118;

      // Roughness: satin-matte oiled oak (~0.62-0.78), glossier on dense grain, matte in pores/grooves.
      const roughVal =
        168 +
        (1 - grainBand) * 16 +
        (0.5 - fiberStreak) * 14 +
        poreDip * 36 +
        seamFactor * 64 +
        (hash2D(boardIndex, 9, 97) - 0.5) * 14;

      const idx = (y * size + x) * 4;
      aData[idx] = clampByte(r);
      aData[idx + 1] = clampByte(g);
      aData[idx + 2] = clampByte(b);
      aData[idx + 3] = 255;

      const bv = clampByte(bumpVal);
      bData[idx] = bv;
      bData[idx + 1] = bv;
      bData[idx + 2] = bv;
      bData[idx + 3] = 255;

      const rv = clampByte(roughVal);
      rData[idx] = rv;
      rData[idx + 1] = rv;
      rData[idx + 2] = rv;
      rData[idx + 3] = 255;
    }
  }

  aCtx.putImageData(aImg, 0, 0);
  bCtx.putImageData(bImg, 0, 0);
  rCtx.putImageData(rImg, 0, 0);

  oakBaseCache = { albedo, bump, roughness };
  return oakBaseCache;
}

function buildLimePlasterCanvases(): DualBaseCanvases {
  if (plasterBaseCache) {
    return plasterBaseCache;
  }

  const size = 512;
  const albedo = createCanvas(size, size);
  const bump = createCanvas(size, size);

  const aCtx = albedo.getContext('2d');
  const bCtx = bump.getContext('2d');

  if (!aCtx || !bCtx) {
    plasterBaseCache = { albedo, bump };
    return plasterBaseCache;
  }

  const aImg = aCtx.createImageData(size, size);
  const bImg = bCtx.createImageData(size, size);
  const aData = aImg.data;
  const bData = bImg.data;

  // Base alabaster Venetian lime plaster #eee9e0 -> rgb(238, 233, 224).
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;

      // Broad billowing Venetian plaster clouds.
      const broadCloud = tileableFbm(u, v, 3, 3, 4, 211);
      // Sweeping diagonal trowel passes (periodic warp).
      const warpU = (u + (broadCloud - 0.5) * 0.14 + 1) % 1;
      const warpV = (v + (broadCloud - 0.5) * 0.08 + 1) % 1;
      const trowelSweep = tileableFbm(warpU, warpV, 5, 2, 3, 307);

      // Fine lime mineral aggregate micro-grain.
      const microGrain = tileableValueNoise(u, v, 64, 64, 409);
      const chalkSpeck = hash2D(x, y, 521) - 0.5;

      // Subtle ridge where trowel passes meet.
      const ridge = Math.abs(trowelSweep - 0.5) < 0.045 ? (0.045 - Math.abs(trowelSweep - 0.5)) / 0.045 : 0;

      const delta = (broadCloud - 0.5) * 14 + (trowelSweep - 0.5) * 10 + (microGrain - 0.5) * 4 + chalkSpeck * 2.5 - ridge * 4;

      const r = 238 + delta;
      const g = 233 + delta * 0.98;
      const b = 224 + delta * 0.94;

      const bumpVal =
        134 +
        (broadCloud - 0.5) * 32 +
        (trowelSweep - 0.5) * 38 +
        ridge * 22 +
        (microGrain - 0.5) * 16 +
        chalkSpeck * 8;

      const idx = (y * size + x) * 4;
      aData[idx] = clampByte(r);
      aData[idx + 1] = clampByte(g);
      aData[idx + 2] = clampByte(b);
      aData[idx + 3] = 255;

      const bv = clampByte(bumpVal);
      bData[idx] = bv;
      bData[idx + 1] = bv;
      bData[idx + 2] = bv;
      bData[idx + 3] = 255;
    }
  }

  aCtx.putImageData(aImg, 0, 0);
  bCtx.putImageData(bImg, 0, 0);

  plasterBaseCache = { albedo, bump };
  return plasterBaseCache;
}

function buildTravertineCanvases(): DualBaseCanvases {
  if (travertineBaseCache) {
    return travertineBaseCache;
  }

  const size = 512;
  const albedo = createCanvas(size, size);
  const bump = createCanvas(size, size);

  const aCtx = albedo.getContext('2d');
  const bCtx = bump.getContext('2d');

  if (!aCtx || !bCtx) {
    travertineBaseCache = { albedo, bump };
    return travertineBaseCache;
  }

  const aImg = aCtx.createImageData(size, size);
  const bImg = bCtx.createImageData(size, size);
  const aData = aImg.data;
  const bData = bImg.data;

  // Honed ivory/beige Italian travertine #e5ddd1 -> rgb(229, 221, 209).
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;

      // Gentle sedimentary undulation warping horizontal mineral strata.
      const strataWarp = tileableFbm(u, v, 3, 3, 3, 613);
      const warpedV = (v + (strataWarp - 0.5) * 0.065 + 1) % 1;

      // Layered horizontal mineral striations (periodic in Y).
      const bandPrimary =
        0.5 +
        0.28 * Math.sin(TWO_PI * (warpedV * 5)) +
        0.14 * Math.sin(TWO_PI * (warpedV * 13 + 0.7)) +
        0.08 * Math.cos(TWO_PI * (warpedV * 23 + 1.4));
      const bandNoise = tileableFbm(u, warpedV, 4, 18, 3, 701);

      // Subtle calcite cream veins.
      const calciteLine = Math.pow(Math.max(0, Math.sin(TWO_PI * (warpedV * 9 + 0.25))), 12);

      // Authentic horizontal travertine micro-pores.
      const poreField = tileableValueNoise(u, warpedV, 16, 68, 811);
      const poreMask = tileableValueNoise(u, warpedV, 6, 20, 863);
      const poreSignal = poreField * 0.7 + poreMask * 0.3;
      const poreDepth = poreSignal > 0.76 ? (poreSignal - 0.76) / 0.24 : 0;

      const stoneGrain = tileableValueNoise(u, v, 48, 48, 919) - 0.5;

      const strataDelta = (bandPrimary - 0.5) * 18 + (bandNoise - 0.5) * 20 + calciteLine * 12 + stoneGrain * 5;
      const r = 229 + strataDelta - poreDepth * 34;
      const g = 221 + strataDelta * 0.96 - poreDepth * 34;
      const b = 209 + strataDelta * 0.9 - poreDepth * 32;

      const bumpVal =
        178 +
        (bandPrimary - 0.5) * 14 +
        (bandNoise - 0.5) * 12 +
        stoneGrain * 10 -
        poreDepth * 108;

      const idx = (y * size + x) * 4;
      aData[idx] = clampByte(r);
      aData[idx + 1] = clampByte(g);
      aData[idx + 2] = clampByte(b);
      aData[idx + 3] = 255;

      const bv = clampByte(bumpVal);
      bData[idx] = bv;
      bData[idx + 1] = bv;
      bData[idx + 2] = bv;
      bData[idx + 3] = 255;
    }
  }

  aCtx.putImageData(aImg, 0, 0);
  bCtx.putImageData(bImg, 0, 0);

  travertineBaseCache = { albedo, bump };
  return travertineBaseCache;
}

function buildFlutedOakCanvases(): DualBaseCanvases {
  if (flutedOakBaseCache) {
    return flutedOakBaseCache;
  }

  const size = 512;
  const albedo = createCanvas(size, size);
  const bump = createCanvas(size, size);

  const aCtx = albedo.getContext('2d');
  const bCtx = bump.getContext('2d');

  if (!aCtx || !bCtx) {
    flutedOakBaseCache = { albedo, bump };
    return flutedOakBaseCache;
  }

  const aImg = aCtx.createImageData(size, size);
  const bImg = bCtx.createImageData(size, size);
  const aData = aImg.data;
  const bData = bImg.data;

  const fluteCount = 16;

  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const flutePos = u * fluteCount;
      const fluteIdx = Math.floor(flutePos);
      const localU = flutePos - fluteIdx;

      // Rounded architectural oak slat with deep crisp vertical shadow groove.
      const grooveWidth = 0.13;
      let profile: number;
      let aoShade: number;

      if (localU < grooveWidth || localU > 1 - grooveWidth) {
        const edgeT = localU < grooveWidth ? localU / grooveWidth : (1 - localU) / grooveWidth;
        profile = 0.08 + edgeT * edgeT * 0.22;
        aoShade = 0.34 + edgeT * 0.42;
      } else {
        const t = (localU - grooveWidth) / (1 - grooveWidth * 2);
        const arch = Math.sin(t * Math.PI);
        profile = 0.3 + Math.pow(arch, 0.72) * 0.7;
        aoShade = 0.78 + Math.pow(arch, 0.55) * 0.24;
      }

      // Per-slat warm oak tonal diversity + continuous vertical oak grain.
      const slatTone = (hash2D(fluteIdx, 3, 1013) - 0.5) * 16;
      const verticalGrain = tileableFbm(u, v, 48, 6, 3, 1103 + fluteIdx * 7);
      const fineFiber = tileableValueNoise(u, v, 128, 16, 1217);

      const grainDelta = (verticalGrain - 0.5) * 24 + (fineFiber - 0.5) * 10;

      const r = (196 + slatTone + grainDelta) * aoShade;
      const g = (161 + slatTone * 0.88 + grainDelta * 0.92) * aoShade;
      const b = (120 + slatTone * 0.74 + grainDelta * 0.82) * aoShade;

      const bumpVal = 20 + profile * 218 + (verticalGrain - 0.5) * 16;

      const idx = (y * size + x) * 4;
      aData[idx] = clampByte(r);
      aData[idx + 1] = clampByte(g);
      aData[idx + 2] = clampByte(b);
      aData[idx + 3] = 255;

      const bv = clampByte(bumpVal);
      bData[idx] = bv;
      bData[idx + 1] = bv;
      bData[idx + 2] = bv;
      bData[idx + 3] = 255;
    }
  }

  aCtx.putImageData(aImg, 0, 0);
  bCtx.putImageData(bImg, 0, 0);

  flutedOakBaseCache = { albedo, bump };
  return flutedOakBaseCache;
}

/**
 * Generates and caches European wide-plank oak floor PBR textures.
 * SSR-safe: returns null textures when executed outside a browser DOM.
 */
export function getOakFloorTextures(repeatX = 2, repeatY = 2): OakFloorTextureSet {
  if (typeof document === 'undefined') {
    return { map: null, bumpMap: null, roughnessMap: null };
  }

  const key = formatRepeatKey(repeatX, repeatY);
  const cached = oakTextureCache.get(key);
  if (cached) {
    return cached;
  }

  const base = buildOakFloorCanvases();
  const textures: OakFloorTextureSet = {
    map: configureTexture(base.albedo, repeatX, repeatY, true),
    bumpMap: configureTexture(base.bump, repeatX, repeatY, false),
    roughnessMap: configureTexture(base.roughness, repeatX, repeatY, false),
  };

  oakTextureCache.set(key, textures);
  return textures;
}

/**
 * Generates and caches warm alabaster Venetian lime-plaster wall PBR textures.
 */
export function getLimePlasterTextures(repeatX = 2, repeatY = 1): MaterialBumpTextureSet {
  if (typeof document === 'undefined') {
    return { map: null, bumpMap: null };
  }

  const key = formatRepeatKey(repeatX, repeatY);
  const cached = plasterTextureCache.get(key);
  if (cached) {
    return cached;
  }

  const base = buildLimePlasterCanvases();
  const textures: MaterialBumpTextureSet = {
    map: configureTexture(base.albedo, repeatX, repeatY, true),
    bumpMap: configureTexture(base.bump, repeatX, repeatY, false),
  };

  plasterTextureCache.set(key, textures);
  return textures;
}

/**
 * Generates and caches honed Italian travertine stone PBR textures.
 */
export function getTravertineTextures(repeatX = 1, repeatY = 1): MaterialBumpTextureSet {
  if (typeof document === 'undefined') {
    return { map: null, bumpMap: null };
  }

  const key = formatRepeatKey(repeatX, repeatY);
  const cached = travertineTextureCache.get(key);
  if (cached) {
    return cached;
  }

  const base = buildTravertineCanvases();
  const textures: MaterialBumpTextureSet = {
    map: configureTexture(base.albedo, repeatX, repeatY, true),
    bumpMap: configureTexture(base.bump, repeatX, repeatY, false),
  };

  travertineTextureCache.set(key, textures);
  return textures;
}

/**
 * Generates and caches architectural vertical fluted oak slat PBR textures.
 */
export function getFlutedOakTextures(repeatX = 2, repeatY = 1): MaterialBumpTextureSet {
  if (typeof document === 'undefined') {
    return { map: null, bumpMap: null };
  }

  const key = formatRepeatKey(repeatX, repeatY);
  const cached = flutedOakTextureCache.get(key);
  if (cached) {
    return cached;
  }

  const base = buildFlutedOakCanvases();
  const textures: MaterialBumpTextureSet = {
    map: configureTexture(base.albedo, repeatX, repeatY, true),
    bumpMap: configureTexture(base.bump, repeatX, repeatY, false),
  };

  flutedOakTextureCache.set(key, textures);
  return textures;
}
