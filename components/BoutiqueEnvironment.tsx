'use client';

import { useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Environment, Grid, Lightformer } from '@react-three/drei';
import * as THREE from 'three';
import { FT_TO_METERS, type RoomWall, type ShopScene } from '@/lib/schema';
import { getLimePlasterTextures, getOakFloorTextures } from '@/lib/textures';

export interface BoutiqueEnvironmentProps {
  scene: ShopScene;
  showGrid: boolean;
  hasBlockedPath: boolean;
  isWalkthrough: boolean;
  onFloorClick: () => void;
}

const WALL_THICKNESS = 0.14;
const BASEBOARD_HEIGHT = 0.095;
const BASEBOARD_DEPTH = 0.016;
const NOOP_RAYCAST = () => null;

const signTextureCache = new Map<string, THREE.CanvasTexture>();
const wallPlaqueTextureCache = new Map<string, THREE.CanvasTexture>();
const entranceDecalCache = new Map<string, THREE.CanvasTexture>();

/**
 * Generates an offline, high-DPI architectural etched-brass transom sign texture.
 */
function getTransomSignTexture(brandText: string): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const cached = signTextureCache.get(brandText);
  if (cached) {
    return cached;
  }

  const width = 1024;
  const height = 256;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
    bgGrad.addColorStop(0, '#272320');
    bgGrad.addColorStop(0.5, '#1d1a17');
    bgGrad.addColorStop(1, '#171412');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(222, 196, 148, 0.34)';
    ctx.lineWidth = 2;
    ctx.strokeRect(24, 24, width - 48, height - 48);

    const letters = brandText.split('');
    const fontSize = 62;
    const tracking = 24;
    ctx.font = `300 ${fontSize}px "Helvetica Neue", "Avenir Next", Arial, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    const charWidths = letters.map((ch) => ctx.measureText(ch).width);
    const totalWidth =
      charWidths.reduce((sum, w) => sum + w, 0) + tracking * Math.max(0, letters.length - 1);

    let cursorX = (width - totalWidth) / 2;
    const centerY = height / 2 + 2;

    ctx.shadowColor = 'rgba(235, 206, 152, 0.38)';
    ctx.shadowBlur = 14;
    ctx.fillStyle = '#e7d1a4';

    for (let i = 0; i < letters.length; i += 1) {
      const cw = charWidths[i];
      ctx.fillText(letters[i], cursorX + cw / 2, centerY);
      cursorX += cw + tracking;
    }

    ctx.shadowBlur = 0;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;

  signTextureCache.set(brandText, texture);
  return texture;
}

/**
 * Generates an offline, gallery-grade etched brushed-brass architectural wordmark plaque
 * for the north feature wall.
 */
function getNorthWallPlaqueTexture(brandText: string): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const cached = wallPlaqueTextureCache.get(brandText);
  if (cached) {
    return cached;
  }

  const width = 1024;
  const height = 256;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    // Warm brushed champagne-brass / honed gallery plaster tablet gradient.
    const bgGrad = ctx.createLinearGradient(0, 0, width, height);
    bgGrad.addColorStop(0, '#ebe3d5');
    bgGrad.addColorStop(0.5, '#f2ece1');
    bgGrad.addColorStop(1, '#e5dccb');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    // Subtle horizontal brushed-metal / honed stone hairline grain.
    ctx.strokeStyle = 'rgba(160, 134, 92, 0.06)';
    ctx.lineWidth = 1;
    for (let y = 4; y < height; y += 5) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Crisp hairline brushed-brass architectural border inset.
    ctx.strokeStyle = 'rgba(166, 134, 82, 0.55)';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(22, 22, width - 44, height - 44);

    // Subtle inner micro-fillet.
    ctx.strokeStyle = 'rgba(166, 134, 82, 0.24)';
    ctx.lineWidth = 1;
    ctx.strokeRect(32, 32, width - 64, height - 64);

    // Wide-tracked etched burnished-brass wordmark ("SPACESTAGE").
    const letters = brandText.split('');
    const fontSize = 54;
    const tracking = 28;
    ctx.font = `400 ${fontSize}px "Helvetica Neue", "Avenir Next", Arial, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    const charWidths = letters.map((ch) => ctx.measureText(ch).width);
    const totalWidth =
      charWidths.reduce((sum, w) => sum + w, 0) + tracking * Math.max(0, letters.length - 1);

    let cursorX = (width - totalWidth) / 2;
    const centerY = height / 2 - 6;

    // Subtle debossed upper highlight + burnished bronze-brass glyph fill.
    ctx.fillStyle = 'rgba(255, 252, 245, 0.72)';
    let hlX = cursorX;
    for (let i = 0; i < letters.length; i += 1) {
      const cw = charWidths[i];
      ctx.fillText(letters[i], hlX + cw / 2, centerY + 1.5);
      hlX += cw + tracking;
    }

    ctx.fillStyle = '#7c6239';
    for (let i = 0; i < letters.length; i += 1) {
      const cw = charWidths[i];
      ctx.fillText(letters[i], cursorX + cw / 2, centerY);
      cursorX += cw + tracking;
    }

    // Refined hairline brass accent rule beneath wordmark.
    const ruleHalf = Math.min(180, totalWidth * 0.24);
    const ruleY = centerY + 46;
    const ruleGrad = ctx.createLinearGradient(width / 2 - ruleHalf, 0, width / 2 + ruleHalf, 0);
    ruleGrad.addColorStop(0, 'rgba(155, 124, 74, 0)');
    ruleGrad.addColorStop(0.2, 'rgba(155, 124, 74, 0.7)');
    ruleGrad.addColorStop(0.8, 'rgba(155, 124, 74, 0.7)');
    ruleGrad.addColorStop(1, 'rgba(155, 124, 74, 0)');
    ctx.strokeStyle = ruleGrad;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(width / 2 - ruleHalf, ruleY);
    ctx.lineTo(width / 2 + ruleHalf, ruleY);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;

  wallPlaqueTextureCache.set(brandText, texture);
  return texture;
}

/**
 * Generates an offline WebGL floor decal canvas texture for the entrance indicator
 * (replaces DOM <Html> portals to avoid React 19 portal unmount errors).
 */
function getEntranceDecalTexture(blocked: boolean): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const key = blocked ? 'blocked' : 'clear';
  const cached = entranceDecalCache.get(key);
  if (cached) {
    return cached;
  }

  const width = 512;
  const height = 128;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    ctx.clearRect(0, 0, width, height);

    const padX = 24;
    const padY = 20;
    const pillW = width - padX * 2;
    const pillH = height - padY * 2;
    const radius = pillH / 2;

    ctx.beginPath();
    ctx.roundRect(padX, padY, pillW, pillH, radius);
    ctx.fillStyle = blocked ? 'rgba(46, 16, 18, 0.88)' : 'rgba(20, 22, 20, 0.82)';
    ctx.fill();

    ctx.lineWidth = 3;
    ctx.strokeStyle = blocked ? 'rgba(239, 68, 68, 0.85)' : 'rgba(52, 211, 153, 0.65)';
    ctx.stroke();

    const label = blocked ? 'PATH BLOCKED' : 'ENTRANCE';
    ctx.font = '600 32px "Helvetica Neue", "Avenir Next", Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    const letters = label.split('');
    const tracking = 7;
    const charWidths = letters.map((ch) => ctx.measureText(ch).width);
    const textW =
      charWidths.reduce((sum, w) => sum + w, 0) + tracking * Math.max(0, letters.length - 1);

    const dotR = 9;
    const dotGap = 18;
    const contentW = dotR * 2 + dotGap + textW;
    const startX = (width - contentW) / 2;
    const cy = height / 2 + 1;

    // Status indicator dot
    ctx.beginPath();
    ctx.arc(startX + dotR, cy, dotR, 0, Math.PI * 2);
    ctx.fillStyle = blocked ? '#ef4444' : '#34d399';
    ctx.fill();

    // Tracked uppercase label
    ctx.fillStyle = blocked ? '#fecaca' : '#f3eee4';
    let tx = startX + dotR * 2 + dotGap;
    for (let i = 0; i < letters.length; i += 1) {
      ctx.fillText(letters[i], tx, cy);
      tx += charWidths[i] + tracking;
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;

  entranceDecalCache.set(key, texture);
  return texture;
}

interface WallPlacement {
  wall: RoomWall;
  position: [number, number, number];
  rotationY: number;
  span: number;
  extendEnds: boolean;
  entranceLocalU: number;
}

function getWallPlacements(
  width: number,
  depth: number,
  entranceOffset: number,
): Record<RoomWall, WallPlacement> {
  return {
    north: {
      wall: 'north',
      position: [0, 0, -depth / 2],
      rotationY: 0,
      span: width,
      extendEnds: true,
      entranceLocalU: entranceOffset,
    },
    south: {
      wall: 'south',
      position: [0, 0, depth / 2],
      rotationY: Math.PI,
      span: width,
      extendEnds: true,
      entranceLocalU: -entranceOffset,
    },
    west: {
      wall: 'west',
      position: [-width / 2, 0, 0],
      rotationY: Math.PI / 2,
      span: depth,
      extendEnds: false,
      entranceLocalU: -entranceOffset,
    },
    east: {
      wall: 'east',
      position: [width / 2, 0, 0],
      rotationY: -Math.PI / 2,
      span: depth,
      extendEnds: false,
      entranceLocalU: entranceOffset,
    },
  };
}

interface NorthFeaturePlaqueProps {
  span: number;
  height: number;
}

/**
 * Flush architectural etched brushed-brass wordmark plaque & recessed shadow niche
 * mounted on the upper north wall to anchor eye-level gallery sightlines.
 */
function NorthFeaturePlaque({ span, height }: NorthFeaturePlaqueProps) {
  const plaqueTexture = useMemo(() => getNorthWallPlaqueTexture('SPACESTAGE'), []);

  const isWide = span >= 5.2;
  const plaqueX = isWide ? span * 0.24 : span * 0.22;
  const plaqueY = isWide ? Math.min(height - 0.58, 2.28) : Math.min(height - 0.56, 2.06);
  const plaqueW = isWide
    ? Math.min(Math.max(1.35, span * 0.26), 1.88)
    : Math.min(Math.max(1.05, span * 0.34), 1.28);
  const plaqueH = Math.min(0.34, height * 0.12);
  const framePadX = 0.065;
  const framePadY = 0.05;
  const nicheW = plaqueW + framePadX * 2;
  const nicheH = plaqueH + framePadY * 2;

  return (
    <group position={[plaqueX, plaqueY, 0]}>
      {/* Recessed dark architectural shadow-niche surround */}
      <mesh position={[0, 0, 0.004]} raycast={NOOP_RAYCAST}>
        <boxGeometry args={[nicheW, nicheH, 0.006]} />
        <meshStandardMaterial color="#342e28" roughness={0.88} />
      </mesh>

      {/* Subtle architectural Venetian plaster framing reveal rails */}
      <mesh position={[0, nicheH / 2 + 0.012, 0.012]} castShadow receiveShadow raycast={NOOP_RAYCAST}>
        <boxGeometry args={[nicheW + 0.048, 0.024, 0.022]} />
        <meshStandardMaterial color="#ede7dd" roughness={0.85} />
      </mesh>
      <mesh position={[0, -nicheH / 2 - 0.012, 0.012]} receiveShadow raycast={NOOP_RAYCAST}>
        <boxGeometry args={[nicheW + 0.048, 0.024, 0.022]} />
        <meshStandardMaterial color="#ede7dd" roughness={0.85} />
      </mesh>
      <mesh position={[-nicheW / 2 - 0.012, 0, 0.012]} receiveShadow raycast={NOOP_RAYCAST}>
        <boxGeometry args={[0.024, nicheH, 0.022]} />
        <meshStandardMaterial color="#ede7dd" roughness={0.85} />
      </mesh>
      <mesh position={[nicheW / 2 + 0.012, 0, 0.012]} receiveShadow raycast={NOOP_RAYCAST}>
        <boxGeometry args={[0.024, nicheH, 0.022]} />
        <meshStandardMaterial color="#ede7dd" roughness={0.85} />
      </mesh>

      {/* Concealed warm linear cove wash tucked beneath top niche lip */}
      <mesh position={[0, nicheH / 2 - 0.007, 0.014]} raycast={NOOP_RAYCAST}>
        <boxGeometry args={[plaqueW + 0.04, 0.008, 0.008]} />
        <meshStandardMaterial
          color="#fff5e4"
          emissive="#ffdfa6"
          emissiveIntensity={1.5}
          roughness={0.22}
        />
      </mesh>

      {/* Flush brushed champagne-brass mounting bevel backing */}
      <mesh position={[0, 0, 0.0115]} castShadow raycast={NOOP_RAYCAST}>
        <boxGeometry args={[plaqueW + 0.012, plaqueH + 0.012, 0.008]} />
        <meshStandardMaterial color="#c3a46f" metalness={0.78} roughness={0.3} />
      </mesh>

      {/* Etched SPACESTAGE gallery wordmark face */}
      <mesh position={[0, 0, 0.0168]} raycast={NOOP_RAYCAST}>
        <planeGeometry args={[plaqueW, plaqueH]} />
        <meshStandardMaterial
          map={plaqueTexture}
          roughness={0.44}
          metalness={0.22}
        />
      </mesh>
    </group>
  );
}

interface SolidGalleryWallProps {
  placement: WallPlacement;
  height: number;
  showFeaturePlaque?: boolean;
}

function SolidGalleryWall({
  placement,
  height,
  showFeaturePlaque = false,
}: SolidGalleryWallProps) {
  const { span, extendEnds, position, rotationY } = placement;
  // Slightly inset non-extended side walls (west/east) by 2mm at each end to prevent any corner coplanar z-fighting.
  const wallSpan = extendEnds ? span + WALL_THICKNESS * 2 : Math.max(0.2, span - 0.004);
  const trimSpan = extendEnds ? span : Math.max(0.2, span - 0.04);

  const plaster = useMemo(
    () => getLimePlasterTextures(Math.max(1, wallSpan / 2.6), Math.max(1, height / 2.6)),
    [wallSpan, height],
  );

  const coveLipY = height - 0.145;
  const coveLedY = height - 0.095;

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* Main Venetian lime-plaster structural wall */}
      <mesh
        position={[0, height / 2, -WALL_THICKNESS / 2]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[wallSpan, height, WALL_THICKNESS]} />
        <meshStandardMaterial
          map={plaster.map}
          bumpMap={plaster.bumpMap}
          bumpScale={0.008}
          color="#f4f0e8"
          roughness={0.86}
          metalness={0.0}
        />
      </mesh>

      {/* European oak baseboard trim along interior floor edge */}
      <mesh
        position={[0, BASEBOARD_HEIGHT / 2, BASEBOARD_DEPTH / 2]}
        receiveShadow
      >
        <boxGeometry args={[trimSpan, BASEBOARD_HEIGHT, BASEBOARD_DEPTH]} />
        <meshStandardMaterial color="#aa8963" roughness={0.62} metalness={0.04} />
      </mesh>

      {/* Fine recessed shadow-reveal bead above baseboard */}
      <mesh position={[0, BASEBOARD_HEIGHT + 0.003, BASEBOARD_DEPTH / 2 - 0.002]}>
        <boxGeometry args={[trimSpan, 0.006, BASEBOARD_DEPTH - 0.004]} />
        <meshStandardMaterial color="#3c342b" roughness={0.85} />
      </mesh>

      {/* Top architectural plaster cove valance lip */}
      <mesh position={[0, coveLipY, 0.022]} castShadow receiveShadow>
        <boxGeometry args={[trimSpan, 0.055, 0.044]} />
        <meshStandardMaterial color="#ede8df" roughness={0.84} />
      </mesh>

      {/* Shadow-gap reveal directly beneath cove valance */}
      <mesh position={[0, coveLipY - 0.032, 0.006]}>
        <boxGeometry args={[trimSpan, 0.012, 0.012]} />
        <meshStandardMaterial color="#36302a" roughness={0.9} />
      </mesh>

      {/* Recessed warm 2700K indirect LED cove diffuser strip */}
      <mesh position={[0, coveLedY, 0.018]}>
        <boxGeometry args={[Math.max(0.2, trimSpan - 0.08), 0.016, 0.014]} />
        <meshStandardMaterial
          color="#fff4e0"
          emissive="#ffdca2"
          emissiveIntensity={1.85}
          roughness={0.25}
        />
      </mesh>

      {/* Soft warm upper cove grazing highlight band */}
      <mesh position={[0, height - 0.042, 0.002]}>
        <planeGeometry args={[trimSpan, 0.08]} />
        <meshStandardMaterial
          color="#f7efe2"
          emissive="#ffe2b5"
          emissiveIntensity={0.28}
          roughness={0.9}
        />
      </mesh>

      {/* Architectural upper north wall focal wordmark plaque & niche */}
      {showFeaturePlaque && <NorthFeaturePlaque span={span} height={height} />}
    </group>
  );
}

interface CutawayGlassWallProps {
  placement: WallPlacement;
  hasEntrance: boolean;
  entranceWidth: number;
}

/**
 * Orbit-mode cutaway perimeter wall: sleek 0.22 m low architectural bronze curb with
 * delicate frameless frosted glass edge + flush bronze/brass doorway threshold frame.
 * Zero tall mullions obstruct 3/4 interior sightlines, and ends are cleanly offset from
 * adjacent solid walls to eliminate corner z-fighting.
 */
function CutawayGlassWall({
  placement,
  hasEntrance,
  entranceWidth,
}: CutawayGlassWallProps) {
  const { wall, span, position, rotationY, entranceLocalU } = placement;

  const curbBaseHeight = 0.08;
  const glassEdgeHeight = 0.14;
  const totalHeight = curbBaseHeight + glassEdgeHeight; // 0.22 m total height
  const curbDepth = 0.068;
  // Sit strictly 8mm outside the interior floor edge so cutaway planes never coplanar-overlap solid walls.
  const curbCenterZ = -(0.008 + curbDepth / 2);

  // Compute exact non-overlapping local U bounds [uStart, uEnd] for each wall orientation:
  // - On east (rotationY = -PI/2): local u = +Z. North end (-span/2) leaves 12mm reveal from solid north wall;
  //   south end (+span/2) stops 2mm short of south cutaway inner face (+span/2 + 0.008).
  // - On south (rotationY = PI): local u = -X. Left end (-span/2 => +X SE corner) wraps seamlessly around east curb;
  //   right end (+span/2 => -X SW corner) leaves 12mm reveal from solid west wall.
  const uStart =
    wall === 'south'
      ? -span / 2 - (0.008 + curbDepth)
      : -span / 2 + 0.012;
  const uEnd =
    wall === 'east'
      ? span / 2 + 0.006
      : span / 2 - 0.012;

  const clampedDoorWidth = Math.min(Math.max(entranceWidth, 0.7), span - 0.24);
  const halfDoor = clampedDoorWidth / 2;
  const maxOffset = Math.max(0, span / 2 - halfDoor - 0.1);
  const doorCenterU = Math.max(-maxOffset, Math.min(maxOffset, entranceLocalU));
  const doorLeft = doorCenterU - halfDoor;
  const doorRight = doorCenterU + halfDoor;

  const endCapHalf = 0.018;
  const leftSpan = Math.max(0, doorLeft - endCapHalf - 0.001 - uStart);
  const rightSpan = Math.max(0, uEnd - (doorRight + endCapHalf + 0.001));
  const fullSpan = Math.max(0.1, uEnd - uStart);
  const fullCenterU = (uStart + uEnd) / 2;

  const renderCurbSegment = (segCenterU: number, segWidth: number, keyPrefix: string) => {
    if (segWidth <= 0.03) return null;
    return (
      <group key={keyPrefix} position={[segCenterU, 0, curbCenterZ]}>
        {/* Matte oiled-bronze architectural low perimeter curb */}
        <mesh position={[0, curbBaseHeight / 2, 0]} receiveShadow raycast={NOOP_RAYCAST}>
          <boxGeometry args={[segWidth, curbBaseHeight, curbDepth]} />
          <meshStandardMaterial color="#272320" metalness={0.62} roughness={0.38} />
        </mesh>

        {/* Hairline brushed-brass shoe molding channel */}
        <mesh position={[0, curbBaseHeight + 0.004, 0]} raycast={NOOP_RAYCAST}>
          <boxGeometry args={[segWidth, 0.008, 0.026]} />
          <meshStandardMaterial color="#b99a67" metalness={0.76} roughness={0.3} />
        </mesh>

        {/* Delicate frameless frosted architectural glass edge rising to 0.22 m */}
        <mesh
          position={[0, curbBaseHeight + glassEdgeHeight / 2, 0]}
          raycast={NOOP_RAYCAST}
        >
          <boxGeometry args={[segWidth, glassEdgeHeight, 0.012]} />
          <meshPhysicalMaterial
            color="#eef4f7"
            transparent
            opacity={0.26}
            roughness={0.22}
            metalness={0.06}
            reflectivity={0.85}
            depthWrite={false}
          />
        </mesh>

        {/* Subtle polished glass top-edge catchlight strip */}
        <mesh position={[0, totalHeight + 0.002, 0]} raycast={NOOP_RAYCAST}>
          <boxGeometry args={[segWidth, 0.004, 0.013]} />
          <meshStandardMaterial
            color="#f5f2eb"
            emissive="#efe8dc"
            emissiveIntensity={0.22}
            transparent
            opacity={0.72}
            roughness={0.18}
          />
        </mesh>
      </group>
    );
  };

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {hasEntrance ? (
        <>
          {/* Flanking low perimeter curbs + frameless frosted glass edges */}
          {renderCurbSegment(uStart + leftSpan / 2, leftSpan, 'cut-left')}
          {renderCurbSegment(doorRight + endCapHalf + 0.001 + rightSpan / 2, rightSpan, 'cut-right')}

          {/* Low flush bronze doorway threshold jamb end-caps (0.22 m height, never blocking sightlines) */}
          <mesh
            position={[doorLeft, totalHeight / 2, curbCenterZ]}
            raycast={NOOP_RAYCAST}
          >
            <boxGeometry args={[0.036, totalHeight, curbDepth + 0.008]} />
            <meshStandardMaterial color="#231f1c" metalness={0.72} roughness={0.32} />
          </mesh>
          <mesh
            position={[doorLeft, totalHeight + 0.003, curbCenterZ]}
            raycast={NOOP_RAYCAST}
          >
            <boxGeometry args={[0.038, 0.006, curbDepth + 0.01]} />
            <meshStandardMaterial color="#c3a46f" metalness={0.8} roughness={0.26} />
          </mesh>

          <mesh
            position={[doorRight, totalHeight / 2, curbCenterZ]}
            raycast={NOOP_RAYCAST}
          >
            <boxGeometry args={[0.036, totalHeight, curbDepth + 0.008]} />
            <meshStandardMaterial color="#231f1c" metalness={0.72} roughness={0.32} />
          </mesh>
          <mesh
            position={[doorRight, totalHeight + 0.003, curbCenterZ]}
            raycast={NOOP_RAYCAST}
          >
            <boxGeometry args={[0.038, 0.006, curbDepth + 0.01]} />
            <meshStandardMaterial color="#c3a46f" metalness={0.8} roughness={0.26} />
          </mesh>

          {/* Flush architectural bronze + brushed-brass doorway threshold frame */}
          <mesh
            position={[doorCenterU, 0.005, curbCenterZ]}
            receiveShadow
            raycast={NOOP_RAYCAST}
          >
            <boxGeometry args={[Math.max(0.2, clampedDoorWidth - 0.038), 0.01, curbDepth + 0.036]} />
            <meshStandardMaterial color="#25211e" metalness={0.68} roughness={0.36} />
          </mesh>
          <mesh
            position={[doorCenterU, 0.012, curbCenterZ]}
            receiveShadow
            raycast={NOOP_RAYCAST}
          >
            <boxGeometry args={[Math.max(0.16, clampedDoorWidth - 0.06), 0.004, curbDepth + 0.01]} />
            <meshStandardMaterial color="#c7a872" metalness={0.82} roughness={0.24} />
          </mesh>
        </>
      ) : (
        renderCurbSegment(fullCenterU, fullSpan, 'cut-full')
      )}
    </group>
  );
}

interface LuxuryStorefrontWallProps {
  placement: WallPlacement;
  height: number;
  entranceWidth: number;
}

function LuxuryStorefrontWall({
  placement,
  height,
  entranceWidth,
}: LuxuryStorefrontWallProps) {
  const { span, extendEnds, position, rotationY, entranceLocalU } = placement;
  const outerSpan = extendEnds ? span + WALL_THICKNESS * 2 : span;

  const signTexture = useMemo(() => getTransomSignTexture('SPACESTAGE'), []);

  const clampedDoorWidth = Math.min(Math.max(entranceWidth, 0.85), span - 0.36);
  const halfDoor = clampedDoorWidth / 2;
  const maxOffset = Math.max(0, span / 2 - halfDoor - 0.14);
  const doorCenterU = Math.max(-maxOffset, Math.min(maxOffset, entranceLocalU));
  const doorLeft = doorCenterU - halfDoor;
  const doorRight = doorCenterU + halfDoor;

  const leftSpan = Math.max(0, doorLeft - -span / 2);
  const rightSpan = Math.max(0, span / 2 - doorRight);

  const doorHeight = Math.min(height - 0.56, 2.38);
  const transomBottom = doorHeight + 0.035;
  const transomTop = height - 0.055;
  const transomHeight = Math.max(0.28, transomTop - transomBottom);
  const transomCenterY = transomBottom + transomHeight / 2;

  const kickplateHeight = 0.18;
  const sidelightGlassHeight = Math.max(0.2, doorHeight - kickplateHeight - 0.035);
  const sidelightGlassCenterY = kickplateHeight + sidelightGlassHeight / 2;

  const mullionDepth = 0.095;
  const mullionZ = -WALL_THICKNESS / 2;

  const leftSubMullions = useMemo(() => {
    if (leftSpan < 1.35) return [];
    const count = Math.floor(leftSpan / 1.1);
    return Array.from({ length: count }, (_, idx) => {
      const t = (idx + 1) / (count + 1);
      return -span / 2 + leftSpan * t;
    });
  }, [leftSpan, span]);

  const rightSubMullions = useMemo(() => {
    if (rightSpan < 1.35) return [];
    const count = Math.floor(rightSpan / 1.1);
    return Array.from({ length: count }, (_, idx) => {
      const t = (idx + 1) / (count + 1);
      return doorRight + rightSpan * t;
    });
  }, [rightSpan, doorRight]);

  const signPanelWidth = Math.min(
    span - 0.12,
    Math.max(clampedDoorWidth + 0.36, Math.min(2.5, span * 0.56)),
  );
  const signPanelCenterU = Math.max(
    -span / 2 + signPanelWidth / 2 + 0.06,
    Math.min(span / 2 - signPanelWidth / 2 - 0.06, doorCenterU),
  );
  const signPanelHeight = Math.max(0.24, transomHeight - 0.06);

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* Dark bronze outer architectural perimeter cornice & flush corner piers */}
      <mesh position={[0, height - 0.028, mullionZ]} castShadow receiveShadow>
        <boxGeometry args={[outerSpan, 0.056, WALL_THICKNESS]} />
        <meshStandardMaterial color="#231f1c" metalness={0.72} roughness={0.32} />
      </mesh>
      <mesh
        position={[
          extendEnds ? -span / 2 - WALL_THICKNESS / 2 : -span / 2 + 0.035,
          height / 2,
          mullionZ,
        ]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[extendEnds ? WALL_THICKNESS : 0.07, height, WALL_THICKNESS]} />
        <meshStandardMaterial color="#231f1c" metalness={0.72} roughness={0.32} />
      </mesh>
      <mesh
        position={[
          extendEnds ? span / 2 + WALL_THICKNESS / 2 : span / 2 - 0.035,
          height / 2,
          mullionZ,
        ]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[extendEnds ? WALL_THICKNESS : 0.07, height, WALL_THICKNESS]} />
        <meshStandardMaterial color="#231f1c" metalness={0.72} roughness={0.32} />
      </mesh>

      {/* Full-width horizontal dark bronze transom beam */}
      <mesh position={[0, doorHeight, mullionZ]} castShadow receiveShadow>
        <boxGeometry args={[outerSpan, 0.07, mullionDepth + 0.02]} />
        <meshStandardMaterial color="#24201d" metalness={0.74} roughness={0.3} />
      </mesh>

      {/* Heavy dark bronze doorway jamb mullions */}
      <mesh position={[doorLeft, height / 2, mullionZ]} castShadow receiveShadow>
        <boxGeometry args={[0.064, height, mullionDepth + 0.015]} />
        <meshStandardMaterial color="#24201d" metalness={0.74} roughness={0.3} />
      </mesh>
      <mesh position={[doorRight, height / 2, mullionZ]} castShadow receiveShadow>
        <boxGeometry args={[0.064, height, mullionDepth + 0.015]} />
        <meshStandardMaterial color="#24201d" metalness={0.74} roughness={0.3} />
      </mesh>

      {/* Brushed brass doorway threshold plate */}
      <mesh position={[doorCenterU, 0.005, mullionZ]} receiveShadow>
        <boxGeometry args={[clampedDoorWidth, 0.01, WALL_THICKNESS + 0.02]} />
        <meshStandardMaterial color="#c3a470" metalness={0.8} roughness={0.26} />
      </mesh>

      {/* Left sidelight: bronze kickplate, vertical mullions, clear architectural glazing */}
      {leftSpan > 0.06 && (
        <>
          <mesh
            position={[-span / 2 + leftSpan / 2, kickplateHeight / 2, mullionZ]}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[leftSpan, kickplateHeight, mullionDepth]} />
            <meshStandardMaterial color="#26221f" metalness={0.68} roughness={0.36} />
          </mesh>

          <mesh position={[-span / 2 + leftSpan / 2, kickplateHeight + 0.006, mullionZ]}>
            <boxGeometry args={[leftSpan, 0.012, mullionDepth + 0.006]} />
            <meshStandardMaterial color="#b99a67" metalness={0.78} roughness={0.28} />
          </mesh>

          <mesh
            position={[-span / 2 + leftSpan / 2, sidelightGlassCenterY, mullionZ]}
            raycast={NOOP_RAYCAST}
          >
            <boxGeometry args={[Math.max(0.02, leftSpan - 0.04), sidelightGlassHeight, 0.014]} />
            <meshPhysicalMaterial
              color="#eef5f7"
              transparent
              opacity={0.18}
              roughness={0.05}
              metalness={0.08}
              reflectivity={0.92}
              depthWrite={false}
            />
          </mesh>

          {leftSubMullions.map((u) => (
            <mesh key={`lm-${u.toFixed(2)}`} position={[u, height / 2, mullionZ]}>
              <boxGeometry args={[0.036, height, mullionDepth - 0.01]} />
              <meshStandardMaterial color="#24201d" metalness={0.72} roughness={0.34} />
            </mesh>
          ))}
        </>
      )}

      {/* Right sidelight: bronze kickplate, vertical mullions, clear architectural glazing */}
      {rightSpan > 0.06 && (
        <>
          <mesh
            position={[doorRight + rightSpan / 2, kickplateHeight / 2, mullionZ]}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[rightSpan, kickplateHeight, mullionDepth]} />
            <meshStandardMaterial color="#26221f" metalness={0.68} roughness={0.36} />
          </mesh>

          <mesh position={[doorRight + rightSpan / 2, kickplateHeight + 0.006, mullionZ]}>
            <boxGeometry args={[rightSpan, 0.012, mullionDepth + 0.006]} />
            <meshStandardMaterial color="#b99a67" metalness={0.78} roughness={0.28} />
          </mesh>

          <mesh
            position={[doorRight + rightSpan / 2, sidelightGlassCenterY, mullionZ]}
            raycast={NOOP_RAYCAST}
          >
            <boxGeometry args={[Math.max(0.02, rightSpan - 0.04), sidelightGlassHeight, 0.014]} />
            <meshPhysicalMaterial
              color="#eef5f7"
              transparent
              opacity={0.18}
              roughness={0.05}
              metalness={0.08}
              reflectivity={0.92}
              depthWrite={false}
            />
          </mesh>

          {rightSubMullions.map((u) => (
            <mesh key={`rm-${u.toFixed(2)}`} position={[u, height / 2, mullionZ]}>
              <boxGeometry args={[0.036, height, mullionDepth - 0.01]} />
              <meshStandardMaterial color="#24201d" metalness={0.72} roughness={0.34} />
            </mesh>
          ))}
        </>
      )}

      {/* Clear clerestory transom glass spanning the upper band */}
      <mesh position={[0, transomCenterY, mullionZ]} raycast={NOOP_RAYCAST}>
        <boxGeometry args={[span - 0.04, transomHeight, 0.014]} />
        <meshPhysicalMaterial
          color="#edf4f7"
          transparent
          opacity={0.16}
          roughness={0.06}
          metalness={0.08}
          depthWrite={false}
        />
      </mesh>

      {/* Architectural overhead SPACESTAGE sign transom fascia */}
      <group position={[signPanelCenterU, transomCenterY, mullionZ]}>
        <mesh castShadow>
          <boxGeometry args={[signPanelWidth, signPanelHeight, 0.066]} />
          <meshStandardMaterial color="#1f1b18" metalness={0.7} roughness={0.35} />
        </mesh>

        <mesh position={[0, signPanelHeight / 2 + 0.005, 0]}>
          <boxGeometry args={[signPanelWidth + 0.012, 0.01, 0.072]} />
          <meshStandardMaterial color="#c9ac78" metalness={0.8} roughness={0.28} />
        </mesh>
        <mesh position={[0, -signPanelHeight / 2 - 0.005, 0]}>
          <boxGeometry args={[signPanelWidth + 0.012, 0.01, 0.072]} />
          <meshStandardMaterial color="#c9ac78" metalness={0.8} roughness={0.28} />
        </mesh>

        <mesh position={[0, 0, 0.035]}>
          <planeGeometry args={[signPanelWidth - 0.04, signPanelHeight - 0.03]} />
          <meshStandardMaterial
            map={signTexture}
            emissive="#d9be8d"
            emissiveMap={signTexture}
            emissiveIntensity={0.45}
            roughness={0.38}
            metalness={0.35}
          />
        </mesh>

        <mesh position={[0, 0, -0.035]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[signPanelWidth - 0.04, signPanelHeight - 0.03]} />
          <meshStandardMaterial
            map={signTexture}
            emissive="#d9be8d"
            emissiveMap={signTexture}
            emissiveIntensity={0.45}
            roughness={0.38}
            metalness={0.35}
          />
        </mesh>
      </group>
    </group>
  );
}

interface ArchitecturalCeilingProps {
  width: number;
  depth: number;
  height: number;
}

function ArchitecturalCeiling({ width, depth, height }: ArchitecturalCeilingProps) {
  const plaster = useMemo(
    () => getLimePlasterTextures(Math.max(1, width / 2.6), Math.max(1, depth / 2.6)),
    [width, depth],
  );

  const marginX = Math.min(0.68, width * 0.16);
  const marginZ = Math.min(0.68, depth * 0.16);
  const cofferW = Math.max(0.8, width - marginX * 2);
  const cofferD = Math.max(0.8, depth - marginZ * 2);
  const slatSpacing = 0.115;
  const slatCount = Math.max(4, Math.floor(cofferW / slatSpacing));
  const slatPositions = useMemo(() => {
    const start = -((slatCount - 1) * slatSpacing) / 2;
    return Array.from({ length: slatCount }, (_, i) => start + i * slatSpacing);
  }, [slatCount, slatSpacing]);

  const tracksAlongZ = depth >= width * 0.85;
  const railLength = (tracksAlongZ ? depth : width) * 0.74;
  const railOffset = (tracksAlongZ ? width : depth) * 0.25;
  const railY = height - 0.18;
  const spotOffsets = useMemo(() => {
    const count = 4;
    const span = railLength * 0.82;
    return Array.from({ length: count }, (_, i) => -span / 2 + (span * i) / (count - 1));
  }, [railLength]);

  const soffitThickness = 0.095;
  const soffitY = height - soffitThickness / 2;
  const coveGap = 0.055;

  return (
    <group>
      {/* Upper recessed Venetian plaster ceiling plane */}
      <mesh
        position={[0, height + 0.015, 0]}
        rotation={[Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <planeGeometry args={[width + WALL_THICKNESS * 2, depth + WALL_THICKNESS * 2]} />
        <meshStandardMaterial
          map={plaster.map}
          bumpMap={plaster.bumpMap}
          bumpScale={0.005}
          color="#efeae1"
          roughness={0.88}
        />
      </mesh>

      {/* Recessed perimeter plaster soffit framing the ceiling cove */}
      <mesh
        position={[0, soffitY, -depth / 2 + coveGap + (marginZ - coveGap) / 2]}
        receiveShadow
      >
        <boxGeometry args={[width - coveGap * 2, soffitThickness, Math.max(0.12, marginZ - coveGap)]} />
        <meshStandardMaterial color="#f0ebe2" roughness={0.86} />
      </mesh>
      <mesh
        position={[0, soffitY, depth / 2 - coveGap - (marginZ - coveGap) / 2]}
        receiveShadow
      >
        <boxGeometry args={[width - coveGap * 2, soffitThickness, Math.max(0.12, marginZ - coveGap)]} />
        <meshStandardMaterial color="#f0ebe2" roughness={0.86} />
      </mesh>
      <mesh
        position={[-width / 2 + coveGap + (marginX - coveGap) / 2, soffitY, 0]}
        receiveShadow
      >
        <boxGeometry args={[Math.max(0.12, marginX - coveGap), soffitThickness, cofferD]} />
        <meshStandardMaterial color="#f0ebe2" roughness={0.86} />
      </mesh>
      <mesh
        position={[width / 2 - coveGap - (marginX - coveGap) / 2, soffitY, 0]}
        receiveShadow
      >
        <boxGeometry args={[Math.max(0.12, marginX - coveGap), soffitThickness, cofferD]} />
        <meshStandardMaterial color="#f0ebe2" roughness={0.86} />
      </mesh>

      {/* Dark acoustic felt plenum backing inside central ceiling coffer */}
      <mesh position={[0, height - 0.012, 0]}>
        <boxGeometry args={[cofferW, 0.02, cofferD]} />
        <meshStandardMaterial color="#23201d" roughness={0.96} />
      </mesh>

      {/* Warm European oak timber acoustic ceiling slats */}
      {slatPositions.map((sx, idx) => (
        <mesh key={`slat-${idx}`} position={[sx, height - 0.045, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.032, 0.048, cofferD - 0.04]} />
          <meshStandardMaterial color="#bc9970" roughness={0.62} metalness={0.02} />
        </mesh>
      ))}

      {/* Two matte-black suspended architectural track lighting rails */}
      {([-1, 1] as const).map((side) => {
        const railPos: [number, number, number] = tracksAlongZ
          ? [side * railOffset, railY, 0]
          : [0, railY, side * railOffset];
        const railRotY = tracksAlongZ ? 0 : Math.PI / 2;

        return (
          <group key={`track-${side}`} position={railPos} rotation={[0, railRotY, 0]}>
            <mesh castShadow>
              <boxGeometry args={[0.036, 0.028, railLength]} />
              <meshStandardMaterial color="#1a1918" metalness={0.62} roughness={0.38} />
            </mesh>

            {[-0.4, 0, 0.4].map((frac) => (
              <group key={`rod-${frac}`} position={[0, 0.09, railLength * frac]}>
                <mesh>
                  <cylinderGeometry args={[0.005, 0.005, 0.18, 8]} />
                  <meshStandardMaterial color="#1a1918" metalness={0.65} roughness={0.36} />
                </mesh>
                <mesh position={[0, 0.085, 0]}>
                  <cylinderGeometry args={[0.022, 0.022, 0.012, 12]} />
                  <meshStandardMaterial color="#1a1918" metalness={0.65} roughness={0.36} />
                </mesh>
              </group>
            ))}

            {spotOffsets.map((zOff, idx) => {
              const aimDir = idx % 2 === 0 ? -side : side;
              const aimTiltZ = aimDir * 0.44;
              const aimTiltX = (idx % 2 === 0 ? 1 : -1) * 0.14;

              return (
                <group key={`spot-${idx}`} position={[0, -0.028, zOff]}>
                  <mesh position={[0, 0.008, 0]}>
                    <boxGeometry args={[0.032, 0.024, 0.056]} />
                    <meshStandardMaterial color="#1c1b1a" metalness={0.6} roughness={0.4} />
                  </mesh>
                  <mesh position={[0, -0.02, 0]}>
                    <cylinderGeometry args={[0.006, 0.006, 0.036, 8]} />
                    <meshStandardMaterial color="#1c1b1a" metalness={0.6} roughness={0.4} />
                  </mesh>

                  <group position={[0, -0.058, 0]} rotation={[aimTiltX, 0, aimTiltZ]}>
                    <mesh castShadow>
                      <cylinderGeometry args={[0.036, 0.038, 0.11, 18]} />
                      <meshStandardMaterial color="#1b1a19" metalness={0.58} roughness={0.36} />
                    </mesh>
                    <mesh position={[0, -0.048, 0]}>
                      <cylinderGeometry args={[0.0385, 0.0385, 0.008, 18]} />
                      <meshStandardMaterial color="#b49562" metalness={0.78} roughness={0.3} />
                    </mesh>
                    <mesh position={[0, -0.056, 0]} rotation={[Math.PI / 2, 0, 0]}>
                      <circleGeometry args={[0.031, 16]} />
                      <meshStandardMaterial
                        color="#fff7e6"
                        emissive="#ffdfa8"
                        emissiveIntensity={2.4}
                        roughness={0.18}
                      />
                    </mesh>
                  </group>
                </group>
              );
            })}
          </group>
        );
      })}
    </group>
  );
}

interface EntranceClearanceZoneProps {
  scene: ShopScene;
  hasBlockedPath: boolean;
  isWalkthrough: boolean;
}

function EntranceClearanceZone({
  scene,
  hasBlockedPath,
  isWalkthrough,
}: EntranceClearanceZoneProps) {
  const { width, depth, entrance } = scene.room;

  const fillMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const borderMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const chevronLeftMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const chevronRightMatRef = useRef<THREE.MeshStandardMaterial>(null);

  const decalTexture = useMemo(
    () => getEntranceDecalTexture(hasBlockedPath),
    [hasBlockedPath],
  );

  const zone = useMemo(() => {
    const isNS = entrance.wall === 'north' || entrance.wall === 'south';
    const wallSpan = isNS ? width : depth;
    const roomAcross = isNS ? depth : width;

    const clearW = Math.min(Math.max(entrance.width, 0.6), wallSpan - 0.12);
    const clearD = Math.min(Math.max(scene.minWalkwayWidth, 0.9144), roomAcross - 0.12);

    const maxOff = Math.max(0, wallSpan / 2 - clearW / 2 - 0.06);
    const clampedOff = Math.max(-maxOff, Math.min(maxOff, entrance.offset));

    let centerX = 0;
    let centerZ = 0;
    let rotY = 0;

    if (entrance.wall === 'south') {
      centerX = clampedOff;
      centerZ = depth / 2 - clearD / 2;
      rotY = 0;
    } else if (entrance.wall === 'north') {
      centerX = clampedOff;
      centerZ = -depth / 2 + clearD / 2;
      rotY = Math.PI;
    } else if (entrance.wall === 'east') {
      centerX = width / 2 - clearD / 2;
      centerZ = clampedOff;
      rotY = Math.PI / 2;
    } else {
      centerX = -width / 2 + clearD / 2;
      centerZ = clampedOff;
      rotY = -Math.PI / 2;
    }

    return { clearW, clearD, centerX, centerZ, rotY };
  }, [width, depth, entrance.wall, entrance.offset, entrance.width, scene.minWalkwayWidth]);

  const stroke = 0.026;

  // Single seamless mitered perimeter border shape (zero corner alpha-overlap).
  const borderShape = useMemo(() => {
    const hw = zone.clearW / 2;
    const hd = zone.clearD / 2;
    const iw = Math.max(0.05, hw - stroke);
    const id = Math.max(0.05, hd - stroke);

    const outer = new THREE.Shape();
    outer.moveTo(-hw, -hd);
    outer.lineTo(hw, -hd);
    outer.lineTo(hw, hd);
    outer.lineTo(-hw, hd);
    outer.closePath();

    const hole = new THREE.Path();
    hole.moveTo(-iw, -id);
    hole.lineTo(-iw, id);
    hole.lineTo(iw, id);
    hole.lineTo(iw, -id);
    hole.closePath();
    outer.holes.push(hole);

    return outer;
  }, [zone.clearW, zone.clearD]);

  useFrame(({ clock }) => {
    const fillMat = fillMatRef.current;
    const borderMat = borderMatRef.current;
    const chevL = chevronLeftMatRef.current;
    const chevR = chevronRightMatRef.current;
    if (!fillMat || !borderMat) {
      return;
    }

    if (hasBlockedPath) {
      const pulse = 0.5 + 0.5 * Math.sin(clock.getElapsedTime() * 4.6);
      fillMat.opacity = 0.14 + pulse * 0.16;
      borderMat.opacity = 0.68 + pulse * 0.32;
      borderMat.emissiveIntensity = 0.85 + pulse * 1.15;
      if (chevL && chevR) {
        chevL.opacity = 0.72 + pulse * 0.28;
        chevR.opacity = 0.72 + pulse * 0.28;
        chevL.emissiveIntensity = 0.85 + pulse * 1.15;
        chevR.emissiveIntensity = 0.85 + pulse * 1.15;
      }
    } else {
      fillMat.opacity = 0.075;
      borderMat.opacity = 0.62;
      borderMat.emissiveIntensity = 0.25;
      if (chevL && chevR) {
        chevL.opacity = 0.68;
        chevR.opacity = 0.68;
        chevL.emissiveIntensity = 0.25;
        chevR.emissiveIntensity = 0.25;
      }
    }
  });

  const accentColor = hasBlockedPath ? '#e5484d' : '#2e9e6f';
  const decalW = Math.min(0.56, zone.clearW * 0.74);
  const decalH = decalW * 0.25;

  return (
    <group position={[zone.centerX, 0.005, zone.centerZ]} rotation={[0, zone.rotY, 0]}>
      {/* Translucent floor fill */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={NOOP_RAYCAST}>
        <planeGeometry args={[zone.clearW, zone.clearD]} />
        <meshStandardMaterial
          ref={fillMatRef}
          color={accentColor}
          emissive={accentColor}
          emissiveIntensity={hasBlockedPath ? 0.45 : 0.12}
          transparent
          opacity={hasBlockedPath ? 0.2 : 0.075}
          depthWrite={false}
        />
      </mesh>

      {/* Seamless mitered architectural floor perimeter outline */}
      <mesh position={[0, 0.001, 0]} rotation={[-Math.PI / 2, 0, 0]} raycast={NOOP_RAYCAST}>
        <shapeGeometry args={[borderShape]} />
        <meshStandardMaterial
          ref={borderMatRef}
          color={accentColor}
          emissive={accentColor}
          emissiveIntensity={hasBlockedPath ? 1.1 : 0.25}
          transparent
          opacity={hasBlockedPath ? 0.88 : 0.62}
          depthWrite={false}
        />
      </mesh>

      {/* Minimal inward threshold chevron indicating entry flow */}
      <group position={[0, 0.0015, -zone.clearD * 0.06]}>
        <mesh position={[-0.085, 0, 0]} rotation={[0, Math.PI / 4, 0]} raycast={NOOP_RAYCAST}>
          <boxGeometry args={[0.22, 0.002, 0.022]} />
          <meshStandardMaterial
            ref={chevronLeftMatRef}
            color={accentColor}
            emissive={accentColor}
            emissiveIntensity={hasBlockedPath ? 1.0 : 0.25}
            transparent
            opacity={0.68}
            depthWrite={false}
          />
        </mesh>
        <mesh position={[0.085, 0, 0]} rotation={[0, -Math.PI / 4, 0]} raycast={NOOP_RAYCAST}>
          <boxGeometry args={[0.22, 0.002, 0.022]} />
          <meshStandardMaterial
            ref={chevronRightMatRef}
            color={accentColor}
            emissive={accentColor}
            emissiveIntensity={hasBlockedPath ? 1.0 : 0.25}
            transparent
            opacity={0.68}
            depthWrite={false}
          />
        </mesh>
      </group>

      {/* Crisp native WebGL floor decal pill shown in Orbit mode only (zero DOM portals) */}
      {!isWalkthrough && decalTexture && (
        <mesh
          position={[0, 0.0022, zone.clearD * 0.28]}
          rotation={[-Math.PI / 2, 0, 0]}
          raycast={NOOP_RAYCAST}
        >
          <planeGeometry args={[decalW, decalH]} />
          <meshBasicMaterial
            map={decalTexture}
            transparent
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      )}
    </group>
  );
}

export function BoutiqueEnvironment({
  scene,
  showGrid,
  hasBlockedPath,
  isWalkthrough,
  onFloorClick,
}: BoutiqueEnvironmentProps) {
  const { width, depth, height, entrance } = scene.room;

  // Wide-plank European oak floor (~20cm wide planks x ~180cm staggered boards).
  const oakTextures = useMemo(
    () => getOakFloorTextures(Math.max(1, width / 1.25), Math.max(1, depth / 1.85)),
    [width, depth],
  );

  const walls = useMemo(
    () => getWallPlacements(width, depth, entrance.offset),
    [width, depth, entrance.offset],
  );

  // Angle warm storefront daylight from outside the entrance wall across the boutique floor.
  const sunRig = useMemo(() => {
    const halfSpan = Math.max(width, depth) * 0.72 + 1.4;
    const elev = Math.max(height * 1.9, 5.4);
    let pos: [number, number, number];

    switch (entrance.wall) {
      case 'north':
        pos = [width * 0.45, elev, -depth * 1.35];
        break;
      case 'east':
        pos = [width * 1.35, elev, depth * 0.45];
        break;
      case 'west':
        pos = [-width * 1.35, elev, depth * 0.45];
        break;
      case 'south':
      default:
        pos = [width * 0.48, elev, depth * 1.35];
        break;
    }

    return { pos, halfSpan, far: halfSpan * 4 + 10 };
  }, [width, depth, height, entrance.wall]);

  const handleFloorClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    onFloorClick();
  };

  const wallList: RoomWall[] = ['north', 'west', 'south', 'east'];

  return (
    <group name="boutique-environment">
      {/* Offline Studio Architectural IBL Environment for photorealistic reflections */}
      <Environment resolution={256} frames={1}>
        <Lightformer
          form="rect"
          intensity={2.2}
          color="#fffaf2"
          position={[0, 7, 0]}
          rotation={[Math.PI / 2, 0, 0]}
          scale={[10, 8, 1]}
        />
        <Lightformer
          form="rect"
          intensity={2.8}
          color="#fff3df"
          position={[0, 6.2, -3.2]}
          rotation={[Math.PI / 2.25, 0, 0]}
          scale={[8, 1.5, 1]}
        />
        <Lightformer
          form="rect"
          intensity={2.5}
          color="#fff5e6"
          position={[0, 2.4, 9]}
          rotation={[0, Math.PI, 0]}
          scale={[10, 5, 1]}
        />
        <Lightformer
          form="rect"
          intensity={1.15}
          color="#dfeaf5"
          position={[4.5, 5.2, 8.2]}
          rotation={[0.32, Math.PI - 0.35, 0]}
          scale={[6, 3.2, 1]}
        />
        <Lightformer
          form="rect"
          intensity={1.2}
          color="#f4e9da"
          position={[-9, 2.4, 0]}
          rotation={[0, Math.PI / 2, 0]}
          scale={[9, 5, 1]}
        />
        <Lightformer
          form="rect"
          intensity={1.0}
          color="#eee5d8"
          position={[9, 2.4, 0]}
          rotation={[0, -Math.PI / 2, 0]}
          scale={[9, 5, 1]}
        />
        <Lightformer
          form="rect"
          intensity={0.55}
          color="#92785b"
          position={[0, -4.5, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          scale={[12, 12, 1]}
        />
      </Environment>

      {/* Architectural Lighting Rig */}
      <hemisphereLight
        args={['#fff7eb', '#4a4035', isWalkthrough ? 0.56 : 0.66]}
      />
      <ambientLight color="#fff6ea" intensity={isWalkthrough ? 0.14 : 0.18} />

      {/* Storefront angled sunlight with tight 2048px soft shadows */}
      <directionalLight
        key={`sun-${width.toFixed(1)}-${depth.toFixed(1)}-${entrance.wall}`}
        position={sunRig.pos}
        intensity={isWalkthrough ? 1.45 : 1.65}
        color="#fff2dd"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-sunRig.halfSpan}
        shadow-camera-right={sunRig.halfSpan}
        shadow-camera-top={sunRig.halfSpan}
        shadow-camera-bottom={-sunRig.halfSpan}
        shadow-camera-near={0.5}
        shadow-camera-far={sunRig.far}
        shadow-bias={-0.00035}
        shadow-normalBias={0.024}
      />

      {/* Warm interior ceiling track light pools illuminating hero island & gallery walls */}
      <pointLight
        position={[0, height - 0.34, 0]}
        color="#ffedd4"
        intensity={isWalkthrough ? 4.0 : 3.0}
        distance={Math.max(width, depth) * 1.45}
        decay={2}
      />
      <pointLight
        position={[-width * 0.28, height - 0.32, -depth * 0.26]}
        color="#ffe8c8"
        intensity={isWalkthrough ? 2.8 : 2.1}
        distance={Math.max(width, depth) * 1.25}
        decay={2}
      />
      <pointLight
        position={[width * 0.28, height - 0.32, -depth * 0.24]}
        color="#ffe9cc"
        intensity={isWalkthrough ? 2.7 : 2.0}
        distance={Math.max(width, depth) * 1.25}
        decay={2}
      />
      <pointLight
        position={[-width * 0.24, height - 0.34, depth * 0.22]}
        color="#ffebd0"
        intensity={isWalkthrough ? 2.3 : 1.65}
        distance={Math.max(width, depth) * 1.2}
        decay={2}
      />

      {/* Wide-Plank European Oak Floor */}
      <mesh
        position={[0, 0, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
        onClick={handleFloorClick}
      >
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial
          map={oakTextures.map}
          bumpMap={oakTextures.bumpMap}
          bumpScale={0.012}
          roughnessMap={oakTextures.roughnessMap}
          roughness={0.92}
          metalness={0.02}
        />
      </mesh>

      {/* Recessed dark architectural shadow-reveal plinth & base slab beneath floor */}
      <mesh position={[0, -0.014, 0]} receiveShadow>
        <boxGeometry
          args={[
            width + WALL_THICKNESS * 2 - 0.04,
            0.026,
            depth + WALL_THICKNESS * 2 - 0.04,
          ]}
        />
        <meshStandardMaterial color="#1a1816" roughness={0.9} metalness={0.1} />
      </mesh>
      <mesh position={[0, -0.092, 0]} receiveShadow>
        <boxGeometry
          args={[
            width + WALL_THICKNESS * 2 + 0.14,
            0.13,
            depth + WALL_THICKNESS * 2 + 0.14,
          ]}
        />
        <meshStandardMaterial color="#25221f" roughness={0.86} metalness={0.08} />
      </mesh>

      {/* Optional crisp 1 ft architectural layout grid */}
      {showGrid && (
        <Grid
          position={[0, 0.003, 0]}
          args={[width, depth]}
          cellSize={FT_TO_METERS}
          cellThickness={0.55}
          cellColor="#9b8d7a"
          sectionSize={FT_TO_METERS * 4}
          sectionThickness={1.05}
          sectionColor="#6e5e4d"
          fadeDistance={Math.max(width, depth) * 2.5}
          fadeStrength={0.45}
          infiniteGrid={false}
        />
      )}

      {/* Perimeter Boutique Walls (Orbit low cutaway vs Walkthrough full architectural shell) */}
      {wallList.map((wallId) => {
        const placement = walls[wallId];
        const isEntranceWall = wallId === entrance.wall;

        if (isWalkthrough) {
          if (isEntranceWall) {
            return (
              <LuxuryStorefrontWall
                key={wallId}
                placement={placement}
                height={height}
                entranceWidth={entrance.width}
              />
            );
          }

          return (
            <SolidGalleryWall
              key={wallId}
              placement={placement}
              height={height}
              showFeaturePlaque={wallId === 'north'}
            />
          );
        }

        // Orbit mode: north & west solid plaster walls; south & east sleek 0.22 m cutaway curbs.
        const isCutaway = wallId === 'south' || wallId === 'east' || isEntranceWall;
        if (isCutaway) {
          return (
            <CutawayGlassWall
              key={wallId}
              placement={placement}
              hasEntrance={isEntranceWall}
              entranceWidth={entrance.width}
            />
          );
        }

        return (
          <SolidGalleryWall
            key={wallId}
            placement={placement}
            height={height}
            showFeaturePlaque={wallId === 'north'}
          />
        );
      })}

      {/* Architectural Ceiling, Timber Acoustic Slats & Matte-Black Track Lighting (Walkthrough mode) */}
      {isWalkthrough && (
        <ArchitecturalCeiling width={width} depth={depth} height={height} />
      )}

      {/* Native WebGL Entrance Clearance Zone & Threshold Indicator (zero DOM <Html>) */}
      <EntranceClearanceZone
        scene={scene}
        hasBlockedPath={hasBlockedPath}
        isWalkthrough={isWalkthrough}
      />
    </group>
  );
}
