'use client';

import React, {
  Component,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useGLTF } from '@react-three/drei';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import {
  GLB_MODEL_PATHS,
  resolveGlbForObject,
  type GlbModelSpec,
} from '@/lib/modelCatalog';
import {
  deriveProductVisuals,
  type ProductVisualSpec,
} from '@/lib/productVisuals';
import type { SceneObject as SceneObjectType } from '@/lib/schema';
import {
  getFlutedOakTextures,
  getTravertineTextures,
} from '@/lib/textures';
import { useSceneStore } from '@/store/useSceneStore';

export interface SceneObjectProps {
  object: SceneObjectType;
  isSelected: boolean;
  isVoiceHighlighted?: boolean;
  isPreviewOrigin?: boolean;
  hasError: boolean;
  hasWarning: boolean;
  interactive: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, position: [number, number, number]) => void;
  onDragStateChange: (dragging: boolean) => void;
}

const SNAP_STEP_METERS = 0.02; // 2 cm floor-plane snap

if (typeof window !== 'undefined') {
  useGLTF.preload(GLB_MODEL_PATHS.plant);
  useGLTF.preload(GLB_MODEL_PATHS.lamp);
  useGLTF.preload(GLB_MODEL_PATHS.chair);
  useGLTF.preload(GLB_MODEL_PATHS.vase);
}

// ---------------------------------------------------------------------------
// Error Boundary for resilient GLB streaming
// ---------------------------------------------------------------------------

interface GlbErrorBoundaryProps {
  fallback: ReactNode;
  resetKey: string;
  children: ReactNode;
}

interface GlbErrorBoundaryState {
  hasError: boolean;
}

class GlbErrorBoundary extends Component<
  GlbErrorBoundaryProps,
  GlbErrorBoundaryState
> {
  constructor(props: GlbErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): GlbErrorBoundaryState {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: GlbErrorBoundaryProps): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Real GLB Renderer with exact Box3 normalization & floor grounding
// ---------------------------------------------------------------------------

interface GlbNormalizedModelProps {
  url: string;
  targetSize: [number, number, number];
  fitMode: GlbModelSpec['fitMode'];
  yOffset?: number;
  tintLabel?: string;
  explicitTint?: { hex: string; overrideAlbedo: boolean };
}

const LABEL_COLOR_TINTS: Array<[RegExp, string, boolean?]> = [
  [/\b(pure\s*white|crisp\s*white|snow\s*white|white|boucl[eé])\b/i, '#f3f1ec', true],
  [/\b(cream|ivory|off[- ]?white|linen|alabaster)\b/i, '#ebe4d6', true],
  [/olive|moss|forest/i, '#6b7750'],
  [/sage|grey[- ]?green|gray[- ]?green|eucalyptus/i, '#7f9282'],
  [/mustard|ochre|gold|amber/i, '#c99738'],
  [/rust|terracotta|burnt|cognac/i, '#a95836'],
  [/emerald|green/i, '#4d7a60'],
  [/navy|indigo|slate\s*blue|blue/i, '#3c4f6b'],
  [/beige|sand|oatmeal/i, '#d9ccb8'],
  [/charcoal|black|espresso/i, '#343230'],
  [/grey|gray|taupe/i, '#8c877f'],
  [/blush|rose|pink/i, '#c79b93'],
];

function resolveTintSpec(
  label?: string
): { hex: string; overrideAlbedo: boolean } | null {
  if (!label) return null;
  for (const [pattern, hex, overrideAlbedo] of LABEL_COLOR_TINTS) {
    if (pattern.test(label)) {
      return { hex, overrideAlbedo: Boolean(overrideAlbedo) };
    }
  }
  return null;
}

function GlbNormalizedModel({
  url,
  targetSize,
  fitMode,
  yOffset = 0,
  tintLabel,
  explicitTint,
}: GlbNormalizedModelProps) {
  const gltf = useGLTF(url);
  const [targetW, targetH, targetD] = targetSize;

  const { sceneClone, scaleVec, offset } = useMemo(() => {
    const cloned = gltf.scene.clone(true);
    const tintSpec = explicitTint ?? resolveTintSpec(tintLabel);
    const tintColor = tintSpec ? new THREE.Color(tintSpec.hex) : null;

    cloned.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        if (tintColor && tintSpec && node.material) {
          const applyTint = (mat: THREE.Material): THREE.Material => {
            if (
              mat instanceof THREE.MeshStandardMaterial ||
              mat instanceof THREE.MeshPhysicalMaterial
            ) {
              const copy = mat.clone();
              if (tintSpec.overrideAlbedo) {
                copy.map = null;
                copy.color.copy(tintColor);
                copy.roughness = Math.max(copy.roughness, 0.82);
                copy.needsUpdate = true;
              } else {
                copy.color.lerp(tintColor, 0.62);
              }
              return copy;
            }
            return mat;
          };
          node.material = Array.isArray(node.material)
            ? node.material.map(applyTint)
            : applyTint(node.material);
        }
      } else if (node instanceof THREE.Light) {
        node.visible = false;
        node.intensity = 0;
      }
    });

    cloned.updateMatrixWorld(true);
    const rawBox = new THREE.Box3().setFromObject(cloned);
    const rawSize = new THREE.Vector3();
    rawBox.getSize(rawSize);

    const rawWiderThanDeep = rawSize.x > rawSize.z * 1.2;
    const rawDeeperThanWide = rawSize.z > rawSize.x * 1.2;
    const targetWiderThanDeep = targetW > targetD * 1.2;
    const targetDeeperThanWide = targetD > targetW * 1.2;
    if (
      (rawWiderThanDeep && targetDeeperThanWide) ||
      (rawDeeperThanWide && targetWiderThanDeep)
    ) {
      cloned.rotation.y += Math.PI / 2;
      cloned.updateMatrixWorld(true);
    }

    const box = new THREE.Box3().setFromObject(cloned);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const sx = size.x > 1e-4 ? size.x : 1;
    const sy = size.y > 1e-4 ? size.y : 1;
    const sz = size.z > 1e-4 ? size.z : 1;

    let finalScale: [number, number, number];
    if (fitMode === 'height') {
      const byHeight = targetH / sy;
      const byWidth = (targetW * 1.55) / sx;
      const byDepth = (targetD * 1.55) / sz;
      const u = Math.min(byHeight, byWidth, byDepth);
      const safeU = Number.isFinite(u) && u > 0 ? u : 1;
      finalScale = [safeU, safeU, safeU];
    } else if (fitMode === 'fill') {
      const rx = targetW / sx;
      const ry = targetH / sy;
      const rz = targetD / sz;
      const base = Math.cbrt(Math.max(1e-6, rx * ry * rz));
      const clampAxis = (r: number) =>
        Math.max(base * 0.72, Math.min(base * 1.38, r));
      finalScale = [
        Math.min(rx, clampAxis(rx)),
        Math.min(ry, clampAxis(ry)),
        Math.min(rz, clampAxis(rz)),
      ];
    } else {
      const u = Math.min(targetW / sx, targetH / sy, targetD / sz);
      const safeU = Number.isFinite(u) && u > 0 ? u : 1;
      finalScale = [safeU, safeU, safeU];
    }

    const computedOffset: [number, number, number] = [
      -center.x * finalScale[0],
      -box.min.y * finalScale[1] + yOffset,
      -center.z * finalScale[2],
    ];

    return {
      sceneClone: cloned,
      scaleVec: finalScale,
      offset: computedOffset,
    };
  }, [gltf.scene, targetW, targetH, targetD, fitMode, yOffset, tintLabel, explicitTint]);

  return (
    <group position={offset} scale={scaleVec}>
      <primitive object={sceneClone} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Bespoke Architectural PBR Retail Fixtures
// ---------------------------------------------------------------------------

const SKINCARE_PALETTE = [
  { color: '#7c3f1c', cap: '#1e1b18', roughness: 0.14, clearcoat: 0.88 }, // Amber serum
  { color: '#e8e2d5', cap: '#c6a975', roughness: 0.22, clearcoat: 0.72 }, // Frosted alabaster
  { color: '#c4cec2', cap: '#524030', roughness: 0.24, clearcoat: 0.7 }, // Sage apothecary
  { color: '#5c3119', cap: '#c6a975', roughness: 0.12, clearcoat: 0.9 }, // Dark amber oil
  { color: '#ded4c4', cap: '#221f1c', roughness: 0.28, clearcoat: 0.65 }, // Stone cream jar
];

interface SkincareBottleProps {
  position: [number, number, number];
  radius: number;
  height: number;
  styleIndex: number;
  isJar?: boolean;
}

function SkincareBottle({
  position,
  radius,
  height,
  styleIndex,
  isJar = false,
}: SkincareBottleProps) {
  const style = SKINCARE_PALETTE[styleIndex % SKINCARE_PALETTE.length];
  const bodyH = isJar ? height * 0.72 : height * 0.76;
  const capH = height - bodyH;
  const capRadius = isJar ? radius * 0.94 : radius * 0.44;

  return (
    <group position={position}>
      {/* Glass / ceramic vessel body */}
      <mesh position={[0, bodyH / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[radius, radius * 1.02, bodyH, 16]} />
        <meshPhysicalMaterial
          color={style.color}
          roughness={style.roughness}
          metalness={0.04}
          clearcoat={style.clearcoat}
          clearcoatRoughness={0.14}
        />
      </mesh>
      {/* Minimalist matte label band */}
      <mesh position={[0, bodyH * 0.48, 0]}>
        <cylinderGeometry
          args={[radius * 1.025, radius * 1.025, bodyH * 0.36, 16]}
        />
        <meshStandardMaterial color="#f4efe6" roughness={0.86} />
      </mesh>
      {/* Brushed brass / matte cap */}
      <mesh position={[0, bodyH + capH / 2, 0]} castShadow>
        <cylinderGeometry args={[capRadius, capRadius, capH, 14]} />
        <meshStandardMaterial
          color={style.cap}
          metalness={style.cap === '#c6a975' ? 0.85 : 0.2}
          roughness={style.cap === '#c6a975' ? 0.26 : 0.55}
        />
      </mesh>
    </group>
  );
}

function ApothecaryShelfFixture({ size }: { size: [number, number, number] }) {
  const [w, h, d] = size;
  const flutedOak = useMemo(
    () => getFlutedOakTextures(Math.max(2, Math.round(w * 1.4)), 1),
    [w]
  );
  const travertine = useMemo(() => getTravertineTextures(1, 1), []);

  const plinthH = 0.09;
  const sideThick = 0.045;
  const shelfThick = 0.036;
  const innerW = Math.max(0.4, w - sideThick * 2);
  const shelfLevels = [
    plinthH + 0.36,
    plinthH + (h - plinthH) * 0.41,
    plinthH + (h - plinthH) * 0.62,
    plinthH + (h - plinthH) * 0.81,
  ];
  const dividerOffsets = w > 1.75 ? [-innerW / 6, innerW / 6] : [];

  return (
    <group>
      {/* Recessed matte dark-bronze plinth */}
      <mesh position={[0, plinthH / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[w - 0.04, plinthH, d - 0.04]} />
        <meshStandardMaterial color="#2a241f" roughness={0.62} metalness={0.28} />
      </mesh>

      {/* Architectural fluted-oak back panel */}
      <mesh
        position={[0, plinthH + (h - plinthH) / 2, -d / 2 + 0.022]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[w - 0.02, h - plinthH - 0.02, 0.036]} />
        <meshStandardMaterial
          color="#d5b895"
          map={flutedOak.map ?? undefined}
          bumpMap={flutedOak.bumpMap ?? undefined}
          bumpScale={0.014}
          roughness={0.66}
        />
      </mesh>

      {/* Solid white-oak vertical outer stiles */}
      {([-1, 1] as const).map((dir) => (
        <mesh
          key={dir}
          position={[dir * (w / 2 - sideThick / 2), h / 2, 0]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[sideThick, h, d]} />
          <meshStandardMaterial color="#c9aa84" roughness={0.58} />
        </mesh>
      ))}

      {/* Optional vertical bay dividers */}
      {dividerOffsets.map((xPos, idx) => (
        <mesh
          key={idx}
          position={[xPos, plinthH + (h - plinthH) / 2, 0.01]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[0.026, h - plinthH - 0.04, d - 0.05]} />
          <meshStandardMaterial color="#c6a680" roughness={0.6} />
        </mesh>
      ))}

      {/* Base deck & top architectural cornice */}
      <mesh position={[0, plinthH + shelfThick / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[innerW + 0.01, shelfThick, d]} />
        <meshStandardMaterial color="#cca982" roughness={0.56} />
      </mesh>
      <mesh position={[0, h - shelfThick / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, shelfThick + 0.01, d + 0.01]} />
        <meshStandardMaterial color="#c8a780" roughness={0.56} />
      </mesh>

      {/* Horizontal shelves with warm recessed LED accent & brass lip */}
      {shelfLevels.map((yLevel, shelfIdx) => {
        const bottleCount = Math.max(4, Math.min(8, Math.floor(innerW / 0.25)));
        const spacing = (innerW - 0.22) / Math.max(1, bottleCount - 1);

        return (
          <group key={shelfIdx} position={[0, yLevel, 0]}>
            <mesh castShadow receiveShadow>
              <boxGeometry args={[innerW, shelfThick, d - 0.02]} />
              <meshStandardMaterial color="#cca982" roughness={0.55} />
            </mesh>
            {/* Brushed champagne brass front edge trim */}
            <mesh position={[0, 0, (d - 0.02) / 2 + 0.004]}>
              <boxGeometry args={[innerW, 0.012, 0.008]} />
              <meshStandardMaterial
                color="#caa974"
                metalness={0.86}
                roughness={0.26}
              />
            </mesh>
            {/* Recessed warm shelf LED strip underneath */}
            <mesh position={[0, -shelfThick / 2 - 0.004, -d * 0.14]}>
              <boxGeometry args={[innerW - 0.08, 0.008, 0.016]} />
              <meshStandardMaterial
                color="#fff3d6"
                emissive="#ffdfa8"
                emissiveIntensity={0.75}
                roughness={0.3}
              />
            </mesh>

            {/* Stone display tray on alternating shelves */}
            {shelfIdx % 2 === 0 && (
              <mesh
                position={[0, shelfThick / 2 + 0.01, 0.02]}
                castShadow
                receiveShadow
              >
                <boxGeometry args={[innerW * 0.34, 0.02, d * 0.56]} />
                <meshStandardMaterial
                  color="#e7dfd2"
                  map={travertine.map ?? undefined}
                  bumpMap={travertine.bumpMap ?? undefined}
                  bumpScale={0.008}
                  roughness={0.44}
                />
              </mesh>
            )}

            {/* Curated apothecary bottles & cream jars */}
            {Array.from({ length: bottleCount }).map((_, idx) => {
              const x = -innerW / 2 + 0.11 + idx * spacing;
              // Skip if too close to an interior divider
              if (dividerOffsets.some((divX) => Math.abs(x - divX) < 0.07)) {
                return null;
              }
              const isJar = (idx + shelfIdx) % 3 === 1;
              const isCenterTray =
                shelfIdx % 2 === 0 && Math.abs(x) < innerW * 0.16;
              const baseY = shelfThick / 2 + (isCenterTray ? 0.02 : 0);
              const bottleH = isJar ? 0.095 : 0.16 + ((idx + shelfIdx) % 3) * 0.028;
              const bottleR = isJar ? 0.044 : 0.029 + ((idx + shelfIdx) % 2) * 0.006;

              return (
                <SkincareBottle
                  key={idx}
                  position={[x, baseY, 0.02 + ((idx % 2) - 0.5) * 0.03]}
                  radius={bottleR}
                  height={bottleH}
                  styleIndex={idx + shelfIdx * 2}
                  isJar={isJar}
                />
              );
            })}
          </group>
        );
      })}

      {/* Folded spa towels & ceramic vessels on lowest deck */}
      <group position={[-innerW * 0.28, plinthH + shelfThick, 0.02]}>
        {[0, 1, 2].map((stackIdx) => (
          <mesh
            key={stackIdx}
            position={[0, 0.026 + stackIdx * 0.052, 0]}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[0.28, 0.048, d * 0.62]} />
            <meshStandardMaterial
              color={stackIdx === 1 ? '#ddd4c5' : '#ece6db'}
              roughness={0.92}
            />
          </mesh>
        ))}
      </group>
      <mesh
        position={[innerW * 0.28, plinthH + shelfThick + 0.12, 0.02]}
        castShadow
        receiveShadow
      >
        <cylinderGeometry args={[0.072, 0.092, 0.24, 20]} />
        <meshStandardMaterial color="#d8cec0" roughness={0.68} />
      </mesh>
    </group>
  );
}

let cachedPosScreenTexture: THREE.CanvasTexture | null = null;

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function getPosScreenTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') {
    return null;
  }
  if (cachedPosScreenTexture) {
    return cachedPosScreenTexture;
  }

  const width = 512;
  const height = 340;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return null;
  }

  // Deep obsidian charcoal dark-mode canvas
  const bgGrad = ctx.createLinearGradient(0, 0, width, height);
  bgGrad.addColorStop(0, '#14161a');
  bgGrad.addColorStop(1, '#0e1014');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Subtle ambient header strip
  ctx.fillStyle = '#1b1f26';
  ctx.fillRect(0, 0, width, 46);
  ctx.fillStyle = '#282e38';
  ctx.fillRect(0, 45, width, 1);

  // Emerald live POS status dot + soft glow
  ctx.save();
  ctx.beginPath();
  ctx.arc(28, 23, 9, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(16, 185, 129, 0.22)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(28, 23, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = '#10b981';
  ctx.fill();
  ctx.restore();

  // Header brand & status pills
  ctx.fillStyle = '#d7cfc2';
  drawRoundedRect(ctx, 46, 17, 94, 11, 5);
  ctx.fill();

  ctx.fillStyle = '#272c35';
  drawRoundedRect(ctx, width - 108, 13, 88, 20, 10);
  ctx.fill();
  ctx.fillStyle = '#9aa3b2';
  drawRoundedRect(ctx, width - 92, 20, 56, 6, 3);
  ctx.fill();

  // Left pane: curated boutique cart line items
  const swatches = ['#9a5b32', '#d7cfc2', '#8ca189'];
  for (let i = 0; i < 3; i += 1) {
    const rowY = 66 + i * 74;
    ctx.fillStyle = '#1a1e25';
    drawRoundedRect(ctx, 22, rowY, 276, 60, 10);
    ctx.fill();
    ctx.strokeStyle = '#272d37';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Product thumbnail swatch
    ctx.fillStyle = swatches[i];
    drawRoundedRect(ctx, 34, rowY + 12, 36, 36, 8);
    ctx.fill();

    // Title & subtitle UI bars
    ctx.fillStyle = '#e5ded2';
    drawRoundedRect(ctx, 84, rowY + 18, 118 - i * 10, 9, 4);
    ctx.fill();
    ctx.fillStyle = '#687182';
    drawRoundedRect(ctx, 84, rowY + 35, 76 + i * 8, 7, 3.5);
    ctx.fill();

    // Right-aligned amount bar
    ctx.fillStyle = '#c8aa74';
    drawRoundedRect(ctx, 240, rowY + 24, 42, 9, 4);
    ctx.fill();
  }

  // Bottom quick-action pill bar on left pane
  ctx.fillStyle = '#1a1e25';
  drawRoundedRect(ctx, 22, 294, 132, 26, 8);
  ctx.fill();
  drawRoundedRect(ctx, 166, 294, 132, 26, 8);
  ctx.fill();
  ctx.fillStyle = '#5c6474';
  drawRoundedRect(ctx, 48, 304, 80, 6, 3);
  ctx.fill();
  drawRoundedRect(ctx, 192, 304, 80, 6, 3);
  ctx.fill();

  // Right pane: sleek dark checkout summary card
  ctx.fillStyle = '#181c23';
  drawRoundedRect(ctx, 316, 66, 174, 254, 12);
  ctx.fill();
  ctx.strokeStyle = '#2a303b';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Summary breakdown rows
  for (let i = 0; i < 3; i += 1) {
    const y = 90 + i * 32;
    ctx.fillStyle = '#6c7587';
    drawRoundedRect(ctx, 334, y, 56 + (i % 2) * 14, 7, 3.5);
    ctx.fill();
    ctx.fillStyle = '#b4bcc9';
    drawRoundedRect(ctx, 428, y, 44, 7, 3.5);
    ctx.fill();
  }

  // Subtle horizontal divider
  ctx.fillStyle = '#2c3340';
  ctx.fillRect(334, 190, 138, 1.5);

  // Total highlight bars
  ctx.fillStyle = '#9aa3b2';
  drawRoundedRect(ctx, 334, 208, 48, 8, 4);
  ctx.fill();
  ctx.fillStyle = '#f2e8d6';
  drawRoundedRect(ctx, 404, 204, 68, 15, 5);
  ctx.fill();

  // Warm champagne-gold checkout CTA button
  const btnGrad = ctx.createLinearGradient(334, 254, 472, 302);
  btnGrad.addColorStop(0, '#d8b67b');
  btnGrad.addColorStop(1, '#b89254');
  ctx.fillStyle = btnGrad;
  drawRoundedRect(ctx, 334, 256, 138, 44, 10);
  ctx.fill();

  // Centered CTA label bar
  ctx.fillStyle = '#151310';
  drawRoundedRect(ctx, 370, 274, 66, 8, 4);
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  cachedPosScreenTexture = texture;
  return texture;
}

function FlutedCounterFixture({ size }: { size: [number, number, number] }) {
  const [w, h, d] = size;
  const flutedOak = useMemo(
    () => getFlutedOakTextures(Math.max(2, Math.round(w * 1.6)), 1),
    [w]
  );
  const travertine = useMemo(
    () => getTravertineTextures(Math.max(1, Number((w * 0.8).toFixed(1))), 1),
    [w]
  );
  const posScreenTexture = useMemo(() => getPosScreenTexture(), []);

  const toeKickH = 0.09;
  const topSlabH = 0.065;
  const revealH = 0.014;
  const bodyH = Math.max(0.3, h - toeKickH - topSlabH - revealH);
  const bodyW = w - 0.05;
  const bodyD = d - 0.05;

  return (
    <group>
      {/* Recessed dark bronze toe-kick */}
      <mesh position={[0, toeKickH / 2, -0.015]} castShadow receiveShadow>
        <boxGeometry args={[bodyW - 0.08, toeKickH, bodyD - 0.06]} />
        <meshStandardMaterial color="#25201c" roughness={0.58} metalness={0.34} />
      </mesh>

      {/* Architectural fluted white-oak counter carcass */}
      <mesh
        position={[0, toeKickH + bodyH / 2, 0]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[bodyW, bodyH, bodyD]} />
        <meshStandardMaterial
          color="#d2b48e"
          map={flutedOak.map ?? undefined}
          bumpMap={flutedOak.bumpMap ?? undefined}
          bumpScale={0.02}
          roughness={0.62}
        />
      </mesh>

      {/* Solid mitered oak end cheeks */}
      {([-1, 1] as const).map((dir) => (
        <mesh
          key={dir}
          position={[dir * (bodyW / 2 - 0.012), toeKickH + bodyH / 2, 0]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[0.026, bodyH, bodyD + 0.004]} />
          <meshStandardMaterial color="#c4a27b" roughness={0.58} />
        </mesh>
      ))}

      {/* Brushed champagne brass shadow-reveal trim */}
      <mesh
        position={[0, toeKickH + bodyH + revealH / 2, 0]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[bodyW - 0.02, revealH, bodyD - 0.02]} />
        <meshStandardMaterial color="#c8a872" metalness={0.86} roughness={0.24} />
      </mesh>

      {/* Thick honed Italian travertine stone countertop with crisp overhang */}
      <mesh
        position={[0, h - topSlabH / 2, 0]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[w, topSlabH, d]} />
        <meshStandardMaterial
          color="#ebe3d5"
          map={travertine.map ?? undefined}
          bumpMap={travertine.bumpMap ?? undefined}
          bumpScale={0.012}
          roughness={0.42}
        />
      </mesh>

      {/* Sleek matte-black POS terminal */}
      <group position={[w * 0.24, h, -d * 0.04]} rotation={[0, -0.25, 0]}>
        {/* Weighted base */}
        <mesh position={[0, 0.012, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.16, 0.024, 0.14]} />
          <meshStandardMaterial color="#1d1f23" metalness={0.6} roughness={0.32} />
        </mesh>
        {/* Tilted neck */}
        <mesh position={[0, 0.09, -0.02]} rotation={[-0.25, 0, 0]} castShadow>
          <boxGeometry args={[0.05, 0.16, 0.024]} />
          <meshStandardMaterial color="#1d1f23" metalness={0.65} roughness={0.3} />
        </mesh>
        {/* Display bezel */}
        <group position={[0, 0.19, 0.01]} rotation={[-0.42, 0, 0]}>
          <mesh castShadow>
            <boxGeometry args={[0.3, 0.21, 0.016]} />
            <meshStandardMaterial color="#181a1e" metalness={0.55} roughness={0.28} />
          </mesh>
          {/* Illuminated dark-mode boutique POS OLED screen */}
          <mesh position={[0, 0, 0.009]}>
            <planeGeometry args={[0.275, 0.185]} />
            <meshStandardMaterial
              color={posScreenTexture ? '#ffffff' : '#14161a'}
              map={posScreenTexture ?? undefined}
              emissive={posScreenTexture ? '#ffffff' : '#14161a'}
              emissiveMap={posScreenTexture ?? undefined}
              emissiveIntensity={posScreenTexture ? 0.72 : 0.2}
              roughness={0.14}
              metalness={0.05}
            />
          </mesh>
        </group>
      </group>

      {/* Ceramic consultation tester tray with sample vials */}
      <group position={[-w * 0.24, h, d * 0.08]}>
        <mesh position={[0, 0.012, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[0.145, 0.135, 0.024, 24]} />
          <meshStandardMaterial color="#ece6db" roughness={0.58} />
        </mesh>
        <SkincareBottle position={[-0.05, 0.024, -0.02]} radius={0.022} height={0.13} styleIndex={0} />
        <SkincareBottle position={[0.025, 0.024, 0.03]} radius={0.026} height={0.095} styleIndex={1} isJar />
        <SkincareBottle position={[0.06, 0.024, -0.04]} radius={0.02} height={0.145} styleIndex={3} />
      </group>

      {/* Smoked-glass botanical reed diffuser */}
      <group position={[-w * 0.02, h, -d * 0.14]}>
        <mesh position={[0, 0.065, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[0.042, 0.048, 0.13, 18]} />
          <meshPhysicalMaterial
            color="#3d352e"
            roughness={0.14}
            clearcoat={0.85}
            clearcoatRoughness={0.12}
          />
        </mesh>
        {[-0.22, -0.08, 0.09, 0.24].map((tilt, idx) => (
          <mesh
            key={idx}
            position={[tilt * 0.06, 0.19, ((idx % 2) - 0.5) * 0.02]}
            rotation={[((idx % 2) - 0.5) * 0.15, 0, tilt]}
            castShadow
          >
            <cylinderGeometry args={[0.003, 0.003, 0.24, 6]} />
            <meshStandardMaterial color="#9e8260" roughness={0.85} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

function TravertineHeroIslandFixture({ size }: { size: [number, number, number] }) {
  const [w, h, d] = size;
  const travertine = useMemo(
    () =>
      getTravertineTextures(
        Math.max(1, Number((w * 0.85).toFixed(1))),
        Math.max(1, Number((d * 0.85).toFixed(1)))
      ),
    [w, d]
  );
  const plinthTex = useMemo(() => getTravertineTextures(1, 1), []);

  const slabH = 0.078;
  const brassGapH = 0.018;
  const legH = Math.max(0.2, h - slabH - brassGapH);
  const legRadius = Math.min(0.18, d * 0.22, w * 0.14);
  const legOffsetX = w * 0.29;
  const isWide = w >= 1.4;

  const vaseTarget: [number, number, number] = isWide
    ? [0.42, 0.4, 0.28]
    : [0.28, 0.3, 0.22];
  const vasePosition: [number, number, number] = isWide
    ? [w * 0.24, h, -d * 0.05]
    : [w * 0.2, h, -d * 0.04];

  return (
    <group>
      {/* Dual sculptural cylindrical honed-travertine plinth columns */}
      {([-1, 1] as const).map((dir) => (
        <group key={dir} position={[dir * legOffsetX, 0, 0]}>
          {/* Brushed champagne brass floor ring */}
          <mesh position={[0, 0.012, 0]} castShadow receiveShadow>
            <cylinderGeometry args={[legRadius + 0.012, legRadius + 0.014, 0.024, 32]} />
            <meshStandardMaterial color="#c8a872" metalness={0.88} roughness={0.24} />
          </mesh>
          {/* Travertine column */}
          <mesh position={[0, 0.024 + (legH - 0.024) / 2, 0]} castShadow receiveShadow>
            <cylinderGeometry args={[legRadius, legRadius * 1.03, legH - 0.024, 32]} />
            <meshStandardMaterial
              color="#e6ddd0"
              map={plinthTex.map ?? undefined}
              bumpMap={plinthTex.bumpMap ?? undefined}
              bumpScale={0.012}
              roughness={0.44}
            />
          </mesh>
        </group>
      ))}

      {/* Recessed brushed-brass sub-frame creating architectural shadow gap */}
      <mesh position={[0, legH + brassGapH / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[w - 0.14, brassGapH, d - 0.14]} />
        <meshStandardMaterial color="#c6a670" metalness={0.86} roughness={0.25} />
      </mesh>

      {/* Thick honed Italian travertine island slab */}
      <mesh position={[0, h - slabH / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, slabH, d]} />
        <meshStandardMaterial
          color="#ece4d6"
          map={travertine.map ?? undefined}
          bumpMap={travertine.bumpMap ?? undefined}
          bumpScale={0.013}
          roughness={0.39}
        />
      </mesh>

      {/* Stepped display podiums + curated luxury hero skincare collection */}
      <group position={[-w * 0.18, h, 0.04]}>
        {/* Lower travertine display riser */}
        <mesh position={[0, 0.024, 0]} castShadow receiveShadow>
          <boxGeometry args={[w * 0.44, 0.048, d * 0.5]} />
          <meshStandardMaterial
            color="#e4dacb"
            map={plinthTex.map ?? undefined}
            bumpMap={plinthTex.bumpMap ?? undefined}
            bumpScale={0.008}
            roughness={0.42}
          />
        </mesh>
        {/* Upper brushed-brass & stone hero pedestal */}
        <mesh position={[-w * 0.09, 0.072, -d * 0.06]} castShadow receiveShadow>
          <cylinderGeometry args={[0.13, 0.135, 0.048, 28]} />
          <meshStandardMaterial color="#ede6da" roughness={0.38} />
        </mesh>
        <mesh position={[-w * 0.09, 0.097, -d * 0.06]}>
          <cylinderGeometry args={[0.132, 0.132, 0.006, 28]} />
          <meshStandardMaterial color="#c8a872" metalness={0.88} roughness={0.22} />
        </mesh>

        {/* 6 curated frosted & amber glass skincare hero bottles */}
        <SkincareBottle position={[-w * 0.11, 0.1, -d * 0.08]} radius={0.032} height={0.21} styleIndex={0} />
        <SkincareBottle position={[-w * 0.05, 0.1, -d * 0.03]} radius={0.038} height={0.11} styleIndex={1} isJar />
        <SkincareBottle position={[w * 0.04, 0.048, -d * 0.09]} radius={0.03} height={0.185} styleIndex={2} />
        <SkincareBottle position={[w * 0.11, 0.048, -d * 0.02]} radius={0.028} height={0.165} styleIndex={3} />
        <SkincareBottle position={[w * 0.02, 0.048, d * 0.08]} radius={0.042} height={0.095} styleIndex={4} isJar />
        <SkincareBottle position={[-w * 0.12, 0.048, d * 0.11]} radius={0.026} height={0.15} styleIndex={0} />
      </group>

      {/* Real photorealistic /models/vase.glb floral glass centerpiece */}
      <group position={vasePosition}>
        <GlbErrorBoundary resetKey={GLB_MODEL_PATHS.vase} fallback={null}>
          <Suspense fallback={null}>
            <GlbNormalizedModel
              url={GLB_MODEL_PATHS.vase}
              targetSize={vaseTarget}
              fitMode="contain"
              yOffset={0}
            />
          </Suspense>
        </GlbErrorBoundary>
      </group>
    </group>
  );
}

function BrassDisplayRackFixture({ size }: { size: [number, number, number] }) {
  const [w, h, d] = size;
  const travertine = useMemo(() => getTravertineTextures(1.4, 0.8), []);

  const plinthH = 0.1;
  const tubeR = 0.015;
  const railSpan = Math.max(0.5, w - 0.12);
  const railY = h - tubeR;
  const garmentColors = ['#eee8dd', '#d9cebd', '#c7baa7', '#b5c0b3', '#9d8c78'];
  const garmentCount = Math.max(3, Math.min(5, Math.floor(railSpan / 0.24)));

  return (
    <group>
      {/* Honed travertine plinth base */}
      <mesh position={[0, plinthH / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, plinthH, d]} />
        <meshStandardMaterial
          color="#e8e0d2"
          map={travertine.map ?? undefined}
          bumpMap={travertine.bumpMap ?? undefined}
          bumpScale={0.011}
          roughness={0.44}
        />
      </mesh>

      {/* Brushed champagne brass vertical uprights & top hanging rail */}
      {([-1, 1] as const).map((dir) => (
        <mesh
          key={dir}
          position={[dir * (railSpan / 2), plinthH + (railY - plinthH) / 2, 0]}
          castShadow
        >
          <cylinderGeometry args={[tubeR, tubeR, railY - plinthH, 16]} />
          <meshStandardMaterial color="#cbb07c" metalness={0.88} roughness={0.22} />
        </mesh>
      ))}
      <mesh position={[0, railY, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[tubeR, tubeR, railSpan + tubeR * 2, 16]} />
        <meshStandardMaterial color="#cbb07c" metalness={0.88} roughness={0.22} />
      </mesh>

      {/* Draped neutral linen / silk spa robes & boutique garments */}
      {Array.from({ length: garmentCount }).map((_, idx) => {
        const spacing = (railSpan - 0.26) / Math.max(1, garmentCount - 1);
        const x = -(railSpan - 0.26) / 2 + idx * spacing;
        const drapeH = Math.min(0.98, (railY - plinthH) * 0.58) + (idx % 2) * 0.07;
        const drapeTopY = railY - 0.06;

        return (
          <group key={idx} position={[x, 0, 0]}>
            {/* Brass hanger hook & shoulder bar */}
            <mesh position={[0, railY - 0.03, 0]}>
              <cylinderGeometry args={[0.004, 0.004, 0.06, 8]} />
              <meshStandardMaterial color="#cbb07c" metalness={0.88} roughness={0.22} />
            </mesh>
            <mesh position={[0, drapeTopY, 0]} castShadow receiveShadow>
              <boxGeometry args={[0.045, 0.018, d * 0.72]} />
              <meshStandardMaterial color="#b8986b" roughness={0.46} />
            </mesh>
            {/* Flowing linen garment silhouette */}
            <mesh
              position={[0, drapeTopY - drapeH / 2 - 0.01, 0]}
              castShadow
              receiveShadow
            >
              <boxGeometry args={[0.058, drapeH, d * 0.68]} />
              <meshStandardMaterial
                color={garmentColors[idx % garmentColors.length]}
                roughness={0.88}
              />
            </mesh>
          </group>
        );
      })}

      {/* Folded linen stacks on plinth base */}
      <group position={[-w * 0.25, plinthH, 0]}>
        {[0, 1, 2].map((i) => (
          <mesh key={i} position={[0, 0.025 + i * 0.048, 0]} castShadow receiveShadow>
            <boxGeometry args={[0.32, 0.044, d * 0.64]} />
            <meshStandardMaterial
              color={i === 1 ? '#d8cebe' : '#ede7dc'}
              roughness={0.92}
            />
          </mesh>
        ))}
      </group>
      <group position={[w * 0.25, plinthH, 0]}>
        {[0, 1].map((i) => (
          <mesh key={i} position={[0, 0.025 + i * 0.048, 0]} castShadow receiveShadow>
            <boxGeometry args={[0.28, 0.044, d * 0.58]} />
            <meshStandardMaterial
              color={i === 0 ? '#c4cec2' : '#ebe4d8'}
              roughness={0.9}
            />
          </mesh>
        ))}
      </group>
    </group>
  );
}

function FloorLeaningArtFixture({ size }: { size: [number, number, number] }) {
  const [w, h, d] = size;
  const frameDepth = Math.min(0.055, d * 0.65);
  const border = 0.045;

  return (
    <group position={[0, 0, 0]} rotation={[-0.045, 0, 0]}>
      {/* Deep walnut gallery frame perimeter */}
      <mesh position={[0, h - border / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, border, frameDepth]} />
        <meshStandardMaterial color="#4e3829" roughness={0.56} />
      </mesh>
      <mesh position={[0, border / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, border, frameDepth]} />
        <meshStandardMaterial color="#4e3829" roughness={0.56} />
      </mesh>
      {([-1, 1] as const).map((dir) => (
        <mesh
          key={dir}
          position={[dir * (w / 2 - border / 2), h / 2, 0]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[border, h - border * 2, frameDepth]} />
          <meshStandardMaterial color="#4e3829" roughness={0.56} />
        </mesh>
      ))}

      {/* Warm raw oatmeal linen gallery canvas recessed inside the walnut frame */}
      <mesh position={[0, h / 2, -0.008]} castShadow receiveShadow>
        <boxGeometry args={[w - border * 1.8, h - border * 1.8, 0.014]} />
        <meshStandardMaterial color="#e8dfd1" roughness={0.92} />
      </mesh>

      {/* Flush museum-grade plaster & terracotta geometric relief (<= 0.012 m protrusion) */}
      <mesh
        position={[-w * 0.08, h * 0.6, 0.004]}
        rotation={[Math.PI / 2, 0, 0]}
        castShadow
        receiveShadow
      >
        <cylinderGeometry args={[w * 0.21, w * 0.21, 0.01, 48]} />
        <meshStandardMaterial color="#c88d6c" roughness={0.86} />
      </mesh>
      <mesh position={[w * 0.11, h * 0.37, 0.0035]} castShadow receiveShadow>
        <boxGeometry args={[w * 0.38, h * 0.32, 0.009]} />
        <meshStandardMaterial color="#d9c3a5" roughness={0.88} />
      </mesh>
      <mesh position={[-w * 0.22, h * 0.41, 0.003]} castShadow receiveShadow>
        <boxGeometry args={[w * 0.07, h * 0.26, 0.008]} />
        <meshStandardMaterial color="#f2ece2" roughness={0.9} />
      </mesh>
      <mesh position={[-w * 0.05, h * 0.26, 0.005]} castShadow receiveShadow>
        <boxGeometry args={[w * 0.48, h * 0.036, 0.012]} />
        <meshStandardMaterial color="#6e5746" roughness={0.82} />
      </mesh>
    </group>
  );
}

function LampFallbackFixture({ size }: { size: [number, number, number] }) {
  const [w, h, d] = size;
  const baseR = Math.min(w, d) * 0.3;
  const shadeR = Math.min(w, d) * 0.44;
  const shadeH = Math.min(0.42, h * 0.24);

  return (
    <group>
      <mesh position={[0, 0.04, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[baseR * 0.92, baseR, 0.08, 28]} />
        <meshStandardMaterial color="#e5dcd0" roughness={0.44} />
      </mesh>
      <mesh position={[0, h * 0.48, 0]} castShadow>
        <cylinderGeometry args={[0.014, 0.016, h - shadeH * 0.6, 16]} />
        <meshStandardMaterial color="#c8a872" metalness={0.86} roughness={0.25} />
      </mesh>
      <mesh position={[0, h - shadeH / 2, 0]} castShadow>
        <cylinderGeometry args={[shadeR * 0.78, shadeR, shadeH, 28, 1, true]} />
        <meshStandardMaterial
          color="#f6efe2"
          emissive="#ffe2b5"
          emissiveIntensity={0.35}
          roughness={0.85}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}

function PlantFallbackFixture({ size }: { size: [number, number, number] }) {
  const [w, h, d] = size;
  const potR = Math.min(w, d) * 0.26;
  const potH = Math.min(0.46, h * 0.34);

  return (
    <group>
      <mesh position={[0, potH / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[potR, potR * 0.82, potH, 24]} />
        <meshStandardMaterial color="#ded5c8" roughness={0.62} />
      </mesh>
      <mesh position={[0, potH * 0.96, 0]} receiveShadow>
        <cylinderGeometry args={[potR * 0.92, potR * 0.92, 0.03, 20]} />
        <meshStandardMaterial color="#3c2f25" roughness={0.95} />
      </mesh>
      {[
        [0, potH + (h - potH) * 0.48, 0, Math.min(w, d) * 0.26],
        [-potR * 0.45, potH + (h - potH) * 0.34, potR * 0.25, Math.min(w, d) * 0.2],
        [potR * 0.45, potH + (h - potH) * 0.38, -potR * 0.2, Math.min(w, d) * 0.21],
        [0.05, potH + (h - potH) * 0.72, 0.04, Math.min(w, d) * 0.18],
      ].map(([x, y, z, r], idx) => (
        <mesh key={idx} position={[x, y, z]} castShadow receiveShadow>
          <dodecahedronGeometry args={[r, 1]} />
          <meshStandardMaterial
            color={idx % 2 === 0 ? '#5b7254' : '#4a6044'}
            roughness={0.78}
          />
        </mesh>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Shopify Product-Faithful Dynamic PBR 3D Fixtures
// ---------------------------------------------------------------------------

function ShopifyLampFixture({
  size,
  visuals,
}: {
  size: [number, number, number];
  visuals: ProductVisualSpec;
}) {
  const [w, h, d] = size;
  const { finish, lampStyle } = visuals;
  const baseR = Math.min(0.18, Math.min(w, d) * 0.34);

  if (lampStyle === 'midcentury-globe') {
    const poleH = h * 0.88;
    const armLen = Math.min(0.28, Math.max(0.18, Math.min(w, d) * 0.44));
    const globeR = Math.min(0.125, Math.max(0.085, Math.min(w, d) * 0.22));
    return (
      <group>
        {/* Flat weighted mid-century circular disc base */}
        <mesh position={[0, 0.018, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[baseR, baseR * 1.04, 0.036, 32]} />
          <meshStandardMaterial
            color={finish.metal}
            metalness={Math.max(0.45, finish.metalness)}
            roughness={Math.min(0.42, finish.roughness)}
          />
        </mesh>
        {/* Slender vertical mid-century matte stem */}
        <mesh position={[-armLen * 0.28, 0.036 + poleH / 2, 0]} castShadow>
          <cylinderGeometry args={[0.012, 0.014, poleH, 16]} />
          <meshStandardMaterial
            color={finish.metal}
            metalness={Math.max(0.45, finish.metalness)}
            roughness={Math.min(0.4, finish.roughness)}
          />
        </mesh>
        {/* Angled cantilevered arm */}
        <mesh
          position={[armLen * 0.14, poleH + 0.055, 0]}
          rotation={[0, 0, -0.34]}
          castShadow
        >
          <cylinderGeometry args={[0.01, 0.011, armLen * 1.15, 14]} />
          <meshStandardMaterial
            color={finish.metal}
            metalness={Math.max(0.45, finish.metalness)}
            roughness={Math.min(0.38, finish.roughness)}
          />
        </mesh>
        {/* Brass/metal globe collar */}
        <mesh position={[armLen * 0.52, poleH + 0.015, 0]} castShadow>
          <cylinderGeometry args={[0.028, 0.036, 0.045, 18]} />
          <meshStandardMaterial color={finish.accent} metalness={0.82} roughness={0.25} />
        </mesh>
        {/* Luminous frosted milk-glass mid-century LED orb */}
        <mesh position={[armLen * 0.52, poleH - globeR * 0.72, 0]} castShadow>
          <sphereGeometry args={[globeR, 32, 24]} />
          <meshPhysicalMaterial
            color="#fffdf8"
            emissive="#ffefd1"
            emissiveIntensity={1.65}
            roughness={0.18}
            clearcoat={0.85}
          />
        </mesh>
      </group>
    );
  }

  if (lampStyle === 'minimal-column') {
    const shadeH = Math.min(0.58, h * 0.34);
    const shadeR = Math.min(0.14, Math.min(w, d) * 0.28);
    const poleH = h - shadeH * 0.75;
    return (
      <group>
        {/* Minimalist dark/metallic circular base */}
        <mesh position={[0, 0.016, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[baseR, baseR * 1.03, 0.032, 32]} />
          <meshStandardMaterial
            color={finish.metal}
            metalness={Math.max(0.4, finish.metalness)}
            roughness={0.38}
          />
        </mesh>
        {/* Slim minimalist standing column pole */}
        <mesh position={[0, 0.032 + poleH / 2, 0]} castShadow>
          <cylinderGeometry args={[0.011, 0.012, poleH, 16]} />
          <meshStandardMaterial
            color={finish.metal}
            metalness={Math.max(0.5, finish.metalness)}
            roughness={0.32}
          />
        </mesh>
        {/* Tall glowing minimalist cylindrical linen column shade */}
        <mesh position={[0, h - shadeH / 2, 0]} castShadow>
          <cylinderGeometry args={[shadeR, shadeR * 1.04, shadeH, 32]} />
          <meshStandardMaterial
            color="#fff8ea"
            emissive="#ffe2ae"
            emissiveIntensity={1.15}
            roughness={0.72}
          />
        </mesh>
        {/* Top & bottom horizontal trim rings */}
        <mesh position={[0, h - 0.008, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[shadeR, 0.006, 10, 28]} />
          <meshStandardMaterial color={finish.metal} metalness={0.7} roughness={0.3} />
        </mesh>
        <mesh position={[0, h - shadeH + 0.008, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[shadeR * 1.04, 0.006, 10, 28]} />
          <meshStandardMaterial color={finish.metal} metalness={0.7} roughness={0.3} />
        </mesh>
      </group>
    );
  }

  // Arched brass / contemporary drum shade floor lamp
  const shadeR = Math.min(0.22, Math.min(w, d) * 0.42);
  const shadeH = Math.min(0.36, h * 0.22);
  return (
    <group>
      <mesh position={[0, 0.025, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[baseR * 1.05, baseR * 1.1, 0.05, 32]} />
        <meshStandardMaterial
          color={finish.primary}
          metalness={finish.metalness}
          roughness={finish.roughness}
        />
      </mesh>
      <mesh position={[0, h * 0.46, 0]} castShadow>
        <cylinderGeometry args={[0.013, 0.015, h - shadeH * 0.7, 16]} />
        <meshStandardMaterial
          color={finish.metal}
          metalness={Math.max(0.55, finish.metalness)}
          roughness={0.28}
        />
      </mesh>
      <mesh position={[0, h - shadeH / 2, 0]} castShadow>
        <cylinderGeometry args={[shadeR * 0.86, shadeR, shadeH, 32, 1, true]} />
        <meshStandardMaterial
          color="#f8f2e6"
          emissive="#ffdfa6"
          emissiveIntensity={0.8}
          roughness={0.78}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}

function ShopifyShelfFixture({
  size,
  visuals,
}: {
  size: [number, number, number];
  visuals: ProductVisualSpec;
}) {
  const [w, h, d] = size;
  const { finish, shelfStyle } = visuals;

  if (shelfStyle === 'led-cabinet') {
    const drawerH = Math.min(0.34, h * 0.2);
    const sideT = 0.036;
    const innerW = Math.max(0.35, w - sideT * 2);
    const shelfYs = [
      drawerH + (h - drawerH) * 0.24,
      drawerH + (h - drawerH) * 0.48,
      drawerH + (h - drawerH) * 0.72,
    ];
    return (
      <group>
        {/* Bottom enclosed drawer cabinet */}
        <mesh position={[0, drawerH / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[w, drawerH, d]} />
          <meshStandardMaterial
            color={finish.primary}
            roughness={finish.roughness}
            metalness={finish.metalness}
          />
        </mesh>
        {/* Recessed drawer face + sleek metallic pull handle */}
        <mesh position={[0, drawerH * 0.52, d / 2 + 0.006]} castShadow>
          <boxGeometry args={[w - 0.06, drawerH * 0.74, 0.014]} />
          <meshStandardMaterial color={finish.secondary} roughness={0.42} metalness={0.22} />
        </mesh>
        <mesh position={[0, drawerH * 0.62, d / 2 + 0.022]} castShadow>
          <boxGeometry args={[Math.min(0.24, w * 0.28), 0.016, 0.018]} />
          <meshStandardMaterial color={finish.accent} metalness={0.85} roughness={0.24} />
        </mesh>

        {/* Left, right, top & back display carcass */}
        <mesh position={[-w / 2 + sideT / 2, drawerH + (h - drawerH) / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[sideT, h - drawerH, d]} />
          <meshStandardMaterial color={finish.primary} roughness={finish.roughness} metalness={finish.metalness} />
        </mesh>
        <mesh position={[w / 2 - sideT / 2, drawerH + (h - drawerH) / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[sideT, h - drawerH, d]} />
          <meshStandardMaterial color={finish.primary} roughness={finish.roughness} metalness={finish.metalness} />
        </mesh>
        <mesh position={[0, h - sideT / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[w, sideT, d]} />
          <meshStandardMaterial color={finish.primary} roughness={finish.roughness} metalness={finish.metalness} />
        </mesh>
        <mesh position={[0, drawerH + (h - drawerH) / 2, -d / 2 + 0.012]} receiveShadow>
          <boxGeometry args={[innerW, h - drawerH - sideT, 0.02]} />
          <meshStandardMaterial color={finish.secondary} roughness={0.55} />
        </mesh>

        {/* Top luminous LED showcase strip */}
        <mesh position={[0, h - sideT - 0.006, 0]}>
          <boxGeometry args={[innerW - 0.04, 0.01, 0.028]} />
          <meshStandardMaterial
            color="#ffffff"
            emissive="#fff1d0"
            emissiveIntensity={2.8}
            toneMapped={false}
          />
        </mesh>

        {/* Tempered glass shelves + glowing LED light bars + skincare vessels */}
        {shelfYs.map((sy, idx) => (
          <group key={idx} position={[0, sy, 0]}>
            <mesh castShadow receiveShadow>
              <boxGeometry args={[innerW - 0.01, 0.014, d * 0.88]} />
              <meshPhysicalMaterial
                color="#dce8ee"
                roughness={0.08}
                metalness={0.05}
                transmission={0.55}
                transparent
                opacity={0.72}
              />
            </mesh>
            {/* Under-shelf LED strip */}
            <mesh position={[0, -0.01, -d * 0.34]}>
              <boxGeometry args={[innerW - 0.05, 0.007, 0.014]} />
              <meshStandardMaterial
                color="#fffdf8"
                emissive="#ffeac2"
                emissiveIntensity={2.4}
                toneMapped={false}
              />
            </mesh>
            {/* Featured boutique bottles */}
            <SkincareBottle position={[-innerW * 0.28, 0.008, 0]} radius={0.03} height={0.17} styleIndex={idx} />
            <SkincareBottle position={[0, 0.008, 0.02]} radius={0.034} height={0.11} styleIndex={idx + 1} isJar />
            <SkincareBottle position={[innerW * 0.26, 0.008, -0.01]} radius={0.028} height={0.19} styleIndex={idx + 2} />
          </group>
        ))}

        {/* Front subtle glass showcase door frame */}
        <mesh position={[0, drawerH + (h - drawerH) / 2, d / 2 - 0.008]}>
          <planeGeometry args={[innerW - 0.02, h - drawerH - sideT - 0.02]} />
          <meshPhysicalMaterial
            color="#e9f2f7"
            transparent
            opacity={0.13}
            roughness={0.05}
            metalness={0.1}
            depthWrite={false}
          />
        </mesh>
      </group>
    );
  }

  // Minimalist crisp-white / walnut / metal bookcase
  const sideT = 0.034;
  const innerW = Math.max(0.35, w - sideT * 2);
  const shelfCount = 5;
  const ys = Array.from({ length: shelfCount }, (_, i) => 0.08 + ((h - 0.12) / (shelfCount - 1)) * i);
  const frameColor = shelfStyle === 'metal-etagere' ? finish.metal : finish.primary;
  const boardColor = shelfStyle === 'minimal-bookcase' ? finish.primary : finish.secondary;

  return (
    <group>
      {/* Left & right panels / posts */}
      <mesh position={[-w / 2 + sideT / 2, h / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[sideT, h, d]} />
        <meshStandardMaterial color={frameColor} roughness={finish.roughness} metalness={finish.metalness} />
      </mesh>
      <mesh position={[w / 2 - sideT / 2, h / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[sideT, h, d]} />
        <meshStandardMaterial color={frameColor} roughness={finish.roughness} metalness={finish.metalness} />
      </mesh>
      {/* Clean back panel for bookcase */}
      {shelfStyle !== 'metal-etagere' && (
        <mesh position={[0, h / 2, -d / 2 + 0.01]} receiveShadow>
          <boxGeometry args={[innerW, h - 0.04, 0.018]} />
          <meshStandardMaterial color={finish.secondary} roughness={0.62} />
        </mesh>
      )}
      {/* Center vertical cube divider */}
      <mesh position={[0, h / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.026, h - 0.08, d * 0.92]} />
        <meshStandardMaterial color={frameColor} roughness={finish.roughness} />
      </mesh>
      {/* Horizontal shelves + curated bottles */}
      {ys.map((sy, idx) => (
        <group key={idx} position={[0, sy, 0]}>
          <mesh castShadow receiveShadow>
            <boxGeometry args={[innerW, 0.028, d * 0.96]} />
            <meshStandardMaterial color={boardColor} roughness={finish.roughness} />
          </mesh>
          {idx > 0 && idx < shelfCount - 1 && (
            <>
              <SkincareBottle position={[-innerW * 0.25, 0.016, 0]} radius={0.03} height={0.16} styleIndex={idx} />
              <SkincareBottle position={[innerW * 0.25, 0.016, 0]} radius={0.032} height={0.12} styleIndex={idx + 2} isJar />
            </>
          )}
        </group>
      ))}
    </group>
  );
}

function ShopifyTableFixture({
  size,
  visuals,
}: {
  size: [number, number, number];
  visuals: ProductVisualSpec;
}) {
  const [w, h, d] = size;
  const { finish, tableStyle } = visuals;

  if (tableStyle === 'round-metal') {
    const r = Math.min(w, d) / 2;
    const topT = 0.042;
    const lowerY = h * 0.34;
    const legAngles = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];

    return (
      <group>
        {/* Circular walnut / wood tabletop */}
        <mesh position={[0, h - topT / 2, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[r, r * 0.99, topT, 40]} />
          <meshStandardMaterial
            color={finish.primary}
            roughness={finish.roughness}
            metalness={finish.metalness}
          />
        </mesh>
        {/* Lower open circular display shelf */}
        <mesh position={[0, lowerY, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[r * 0.84, r * 0.84, 0.028, 36]} />
          <meshStandardMaterial color={finish.secondary} roughness={finish.roughness + 0.05} />
        </mesh>
        {/* Matte metal leg frame + circular ring */}
        {legAngles.map((ang, i) => (
          <mesh
            key={i}
            position={[Math.cos(ang) * r * 0.82, (h - topT) / 2, Math.sin(ang) * r * 0.82]}
            castShadow
          >
            <cylinderGeometry args={[0.013, 0.013, h - topT, 12]} />
            <meshStandardMaterial color={finish.metal} metalness={0.72} roughness={0.34} />
          </mesh>
        ))}
        <mesh position={[0, h - topT - 0.012, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[r * 0.82, 0.011, 10, 36]} />
          <meshStandardMaterial color={finish.metal} metalness={0.72} roughness={0.34} />
        </mesh>
        {/* Curated hero skincare trio on round tabletop */}
        <SkincareBottle position={[-r * 0.28, h, -r * 0.1]} radius={0.032} height={0.18} styleIndex={0} />
        <SkincareBottle position={[r * 0.12, h, r * 0.12]} radius={0.038} height={0.1} styleIndex={1} isJar />
        <SkincareBottle position={[r * 0.25, h, -r * 0.2]} radius={0.028} height={0.16} styleIndex={2} />
      </group>
    );
  }

  // Cherry / Walnut / Matte architectural wood display table
  const topT = 0.048;
  const legW = 0.055;
  const legH = h - topT;
  const legCoords: [number, number][] = [
    [-w / 2 + 0.09, -d / 2 + 0.09],
    [w / 2 - 0.09, -d / 2 + 0.09],
    [-w / 2 + 0.09, d / 2 - 0.09],
    [w / 2 - 0.09, d / 2 - 0.09],
  ];

  return (
    <group>
      <mesh position={[0, h - topT / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, topT, d]} />
        <meshStandardMaterial
          color={finish.primary}
          roughness={finish.roughness}
          metalness={finish.metalness}
        />
      </mesh>
      <mesh position={[0, h * 0.28, 0]} castShadow receiveShadow>
        <boxGeometry args={[w - 0.14, 0.026, d - 0.14]} />
        <meshStandardMaterial color={finish.secondary} roughness={finish.roughness + 0.06} />
      </mesh>
      {legCoords.map(([lx, lz], idx) => (
        <mesh key={idx} position={[lx, legH / 2, lz]} castShadow receiveShadow>
          <boxGeometry args={[legW, legH, legW]} />
          <meshStandardMaterial color={finish.secondary} roughness={finish.roughness} />
        </mesh>
      ))}
      <SkincareBottle position={[-w * 0.22, h, 0]} radius={0.034} height={0.19} styleIndex={0} />
      <SkincareBottle position={[0, h, -d * 0.08]} radius={0.04} height={0.11} styleIndex={1} isJar />
      <SkincareBottle position={[w * 0.22, h, d * 0.06]} radius={0.03} height={0.17} styleIndex={3} />
    </group>
  );
}

function ShopifyRackFixture({
  size,
  visuals,
}: {
  size: [number, number, number];
  visuals: ProductVisualSpec;
}) {
  const [w, h, d] = size;
  const { finish } = visuals;
  const railSpan = Math.max(0.5, w - 0.1);
  const railY = h - 0.02;

  return (
    <group>
      <mesh position={[0, 0.04, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, 0.08, d]} />
        <meshStandardMaterial color={finish.secondary} roughness={finish.roughness} metalness={finish.metalness} />
      </mesh>
      {([-1, 1] as const).map((dir) => (
        <mesh key={dir} position={[dir * (railSpan / 2), h / 2, 0]} castShadow>
          <cylinderGeometry args={[0.016, 0.016, h, 16]} />
          <meshStandardMaterial color={finish.metal} metalness={0.78} roughness={0.28} />
        </mesh>
      ))}
      <mesh position={[0, railY, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.016, 0.016, railSpan + 0.04, 16]} />
        <meshStandardMaterial color={finish.metal} metalness={0.78} roughness={0.28} />
      </mesh>
      {[-0.28, 0, 0.28].map((frac, idx) => (
        <mesh key={idx} position={[railSpan * frac, railY - 0.45, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.065, 0.78, d * 0.65]} />
          <meshStandardMaterial
            color={idx === 1 ? finish.accent : idx === 0 ? '#ede7dc' : '#cfd5cc'}
            roughness={0.86}
          />
        </mesh>
      ))}
    </group>
  );
}

function ParametricFixture({ object }: { object: SceneObjectType }) {
  const visuals = useMemo(
    () => (object.source === 'shopify' && object.product ? deriveProductVisuals(object.product) : null),
    [object.source, object.product]
  );

  if (visuals) {
    switch (object.kind) {
      case 'lamp':
        return <ShopifyLampFixture size={object.size} visuals={visuals} />;
      case 'shelf':
        return <ShopifyShelfFixture size={object.size} visuals={visuals} />;
      case 'table':
        return <ShopifyTableFixture size={object.size} visuals={visuals} />;
      case 'rack':
        return <ShopifyRackFixture size={object.size} visuals={visuals} />;
      case 'counter':
        return <FlutedCounterFixture size={object.size} />;
      case 'art':
        return <FloorLeaningArtFixture size={object.size} />;
      case 'plant':
        return <PlantFallbackFixture size={object.size} />;
    }
  }

  switch (object.kind) {
    case 'shelf':
      return <ApothecaryShelfFixture size={object.size} />;
    case 'counter':
      return <FlutedCounterFixture size={object.size} />;
    case 'table':
      return <TravertineHeroIslandFixture size={object.size} />;
    case 'rack':
      return <BrassDisplayRackFixture size={object.size} />;
    case 'art':
      return <FloorLeaningArtFixture size={object.size} />;
    case 'lamp':
      return <LampFallbackFixture size={object.size} />;
    case 'plant':
      return <PlantFallbackFixture size={object.size} />;
  }
}

// ---------------------------------------------------------------------------
// Selection Wireframe & Floor Footprint Ring
// ---------------------------------------------------------------------------

function SelectionHalo({
  size,
  color,
  ringColor,
}: {
  size: [number, number, number];
  color: string;
  ringColor: string;
}) {
  const [w, h, d] = size;

  const { boxEdges, ringEdges } = useMemo(() => {
    const boxGeo = new THREE.BoxGeometry(w + 0.03, h + 0.03, d + 0.03);
    const edges = new THREE.EdgesGeometry(boxGeo);
    boxGeo.dispose();

    const padW = w + 0.09;
    const padD = d + 0.09;
    const hw = padW / 2;
    const hd = padD / 2;
    const ringGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-hw, 0, -hd),
      new THREE.Vector3(hw, 0, -hd),
      new THREE.Vector3(hw, 0, -hd),
      new THREE.Vector3(hw, 0, hd),
      new THREE.Vector3(hw, 0, hd),
      new THREE.Vector3(-hw, 0, hd),
      new THREE.Vector3(-hw, 0, hd),
      new THREE.Vector3(-hw, 0, -hd),
    ]);

    return { boxEdges: edges, ringEdges: ringGeo };
  }, [w, h, d]);

  useEffect(() => {
    return () => {
      boxEdges.dispose();
      ringEdges.dispose();
    };
  }, [boxEdges, ringEdges]);

  return (
    <group>
      {/* Bounding wireframe box */}
      <lineSegments position={[0, h / 2, 0]} geometry={boxEdges}>
        <lineBasicMaterial color={color} transparent opacity={0.9} />
      </lineSegments>

      {/* Floor footprint translucent glow */}
      <mesh position={[0, 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w + 0.09, d + 0.09]} />
        <meshBasicMaterial
          color={ringColor}
          transparent
          opacity={0.16}
          depthWrite={false}
        />
      </mesh>

      {/* Crisp floor footprint perimeter line */}
      <lineSegments position={[0, 0.008, 0]} geometry={ringEdges}>
        <lineBasicMaterial color={ringColor} transparent opacity={0.95} />
      </lineSegments>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Main SceneObject Component
// ---------------------------------------------------------------------------

export function SceneObject({
  object,
  isSelected,
  isVoiceHighlighted = false,
  isPreviewOrigin = false,
  hasError,
  hasWarning,
  interactive,
  onSelect,
  onMove,
  onDragStateChange,
}: SceneObjectProps) {
  const { camera, gl } = useThree();
  const [isHovered, setIsHovered] = useState(false);
  const [isLocalDragging, setIsLocalDragging] = useState(false);

  const dragOffsetRef = useRef<{ dx: number; dz: number }>({ dx: 0, dz: 0 });
  const elevationYRef = useRef<number>(object.position[1]);
  const onMoveRef = useRef(onMove);
  const onDragStateChangeRef = useRef(onDragStateChange);

  useEffect(() => {
    elevationYRef.current = object.position[1];
  }, [object.position]);

  useEffect(() => {
    onMoveRef.current = onMove;
    onDragStateChangeRef.current = onDragStateChange;
  }, [onMove, onDragStateChange]);

  const effectiveDragging = interactive && isLocalDragging && !object.locked;
  const effectiveHovered = interactive && isHovered;

  // Safely manage document cursor via React effect (React 19 ESLint clean)
  useEffect(() => {
    if (!interactive) {
      return;
    }

    if (effectiveDragging) {
      document.body.style.cursor = 'grabbing';
    } else if (effectiveHovered) {
      document.body.style.cursor = object.locked ? 'not-allowed' : 'grab';
    } else {
      document.body.style.cursor = 'auto';
    }

    return () => {
      document.body.style.cursor = 'auto';
    };
  }, [interactive, effectiveDragging, effectiveHovered, object.locked]);

  // Smooth full-viewport Y=0 floor-plane drag tracking
  useEffect(() => {
    if (!effectiveDragging) {
      return;
    }

    const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const hitPoint = new THREE.Vector3();

    const handlePointerMove = (ev: PointerEvent) => {
      const rect = gl.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }

      ndc.set(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1
      );
      raycaster.setFromCamera(ndc, camera);

      if (raycaster.ray.intersectPlane(floorPlane, hitPoint)) {
        const rawX = hitPoint.x + dragOffsetRef.current.dx;
        const rawZ = hitPoint.z + dragOffsetRef.current.dz;
        const snappedX =
          Math.round(rawX / SNAP_STEP_METERS) * SNAP_STEP_METERS;
        const snappedZ =
          Math.round(rawZ / SNAP_STEP_METERS) * SNAP_STEP_METERS;

        onMoveRef.current(object.id, [
          Number(snappedX.toFixed(3)),
          elevationYRef.current,
          Number(snappedZ.toFixed(3)),
        ]);
      }
    };

    const finishDrag = () => {
      setIsLocalDragging(false);
      onDragStateChangeRef.current(false);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
    window.addEventListener('blur', finishDrag);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
      window.removeEventListener('blur', finishDrag);
    };
  }, [effectiveDragging, camera, gl, object.id]);

  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    if (!interactive) {
      return;
    }
    event.stopPropagation();
    onSelect(object.id);

    if (object.locked) {
      return;
    }

    const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hitPoint = new THREE.Vector3();
    if (event.ray.intersectPlane(floorPlane, hitPoint)) {
      dragOffsetRef.current = {
        dx: object.position[0] - hitPoint.x,
        dz: object.position[2] - hitPoint.z,
      };
    } else {
      dragOffsetRef.current = { dx: 0, dz: 0 };
    }

    setIsLocalDragging(true);
    onDragStateChange(true);
  };

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    if (!interactive) {
      return;
    }
    event.stopPropagation();
    onSelect(object.id);
  };

  const handlePointerOver = (event: ThreeEvent<PointerEvent>) => {
    if (!interactive) {
      return;
    }
    event.stopPropagation();
    setIsHovered(true);
  };

  const handlePointerOut = (event: ThreeEvent<PointerEvent>) => {
    if (!interactive) {
      return;
    }
    event.stopPropagation();
    setIsHovered(false);
  };

  const glbSpec = useMemo(() => resolveGlbForObject(object), [object]);
  const meshGroupRef = useRef<THREE.Group>(null);
  const swapAnimRef = useRef<number>(1);
  const prevVariantRef = useRef<string | undefined>(object.product?.variantId);
  const [recentlySwapped, setRecentlySwapped] = useState(false);

  // Trigger silky visual pop + emerald highlight pulse when replaced with a Shopify SKU
  useEffect(() => {
    const nextVariant = object.product?.variantId;
    if (nextVariant && nextVariant !== prevVariantRef.current) {
      swapAnimRef.current = 0;
      setRecentlySwapped(true);
      const timer = setTimeout(() => setRecentlySwapped(false), 1600);
      prevVariantRef.current = nextVariant;
      return () => clearTimeout(timer);
    }
    prevVariantRef.current = nextVariant;
    return undefined;
  }, [object.product?.variantId]);

  useFrame((_, delta) => {
    const g = meshGroupRef.current;
    if (!g) return;
    if (swapAnimRef.current < 1) {
      swapAnimRef.current = Math.min(1, swapAnimRef.current + delta * 2.6);
      const t = swapAnimRef.current;
      // Smooth spring overshoot curve: 0.84 -> 1.045 -> 1.0
      const s = 1 - 0.16 * Math.exp(-6 * t) * Math.cos(t * Math.PI * 2.2);
      g.scale.set(s, s, s);
    } else if (g.scale.x !== 1) {
      g.scale.set(1, 1, 1);
    }
  });

  const showHalo =
    isSelected ||
    hasError ||
    recentlySwapped ||
    isVoiceHighlighted ||
    isPreviewOrigin;
  const haloColor = hasError
    ? '#ef4444'
    : isVoiceHighlighted
      ? '#a855f7'
      : isPreviewOrigin
        ? '#f59e0b'
        : recentlySwapped
          ? '#10b981'
          : object.source === 'shopify'
            ? '#34d399'
            : '#0ea5e9';
  const ringColor = hasError
    ? '#ef4444'
    : isVoiceHighlighted
      ? '#c084fc'
      : isPreviewOrigin
        ? '#fbbf24'
        : recentlySwapped || object.source === 'shopify'
          ? '#10b981'
          : hasWarning
            ? '#f59e0b'
            : '#0ea5e9';

  const visionOverride = useSceneStore(
    (state) => state.visionModelOverrides[object.id]
  );
  const effectiveGlbSpec: GlbModelSpec | null = visionOverride
    ? {
        url: GLB_MODEL_PATHS[visionOverride.glbKey],
        fitMode: visionOverride.glbKey === 'lamp' ? 'height' : 'fill',
      }
    : glbSpec;

  return (
    <group
      position={object.position}
      rotation={[0, object.rotationY, 0]}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
      onPointerOver={handlePointerOver}
      onPointerOut={handlePointerOut}
    >
      <group ref={meshGroupRef}>
        {effectiveGlbSpec ? (
          <GlbErrorBoundary
            resetKey={`${object.id}:${effectiveGlbSpec.url}`}
            fallback={<ParametricFixture object={object} />}
          >
            <Suspense fallback={<ParametricFixture object={object} />}>
              <GlbNormalizedModel
                url={effectiveGlbSpec.url}
                targetSize={object.size}
                fitMode={effectiveGlbSpec.fitMode}
                yOffset={effectiveGlbSpec.yOffset ?? 0}
                tintLabel={object.product?.title ?? object.label}
                explicitTint={
                  visionOverride
                    ? {
                        hex: visionOverride.dominantColorHex,
                        overrideAlbedo: visionOverride.overrideAlbedo,
                      }
                    : undefined
                }
              />
            </Suspense>
          </GlbErrorBoundary>
        ) : (
          <ParametricFixture object={object} />
        )}
      </group>

      {/* Subtle warm boutique pool of light for architectural floor lamps */}
      {object.kind === 'lamp' && (
        <pointLight
          position={[0, object.size[1] * 0.72, 0]}
          color="#ffdfb3"
          intensity={1.15}
          distance={3.6}
          decay={2}
        />
      )}

      {showHalo && (
        <SelectionHalo
          size={object.size}
          color={haloColor}
          ringColor={ringColor}
        />
      )}
    </group>
  );
}
