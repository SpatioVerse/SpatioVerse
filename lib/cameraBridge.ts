import type { Vec3 } from '@/lib/schema';

export interface CameraBasis {
  position: Vec3;
  /** Unit vector on XZ floor plane in the direction the camera is looking */
  forwardXZ: [number, number];
  /** Unit vector on XZ floor plane to the viewer's right ("on my left" = -rightXZ) */
  rightXZ: [number, number];
  /** Viewer facing compass hint for grounded prompts */
  facingWall: 'north' | 'south' | 'east' | 'west';
}

const DEFAULT_CAMERA_BASIS: CameraBasis = {
  position: [5.4, 4.4, 6.2],
  forwardXZ: [-0.66, -0.75],
  rightXZ: [0.75, -0.66],
  facingWall: 'north',
};

let currentBasis: CameraBasis = DEFAULT_CAMERA_BASIS;
let frameCapturer: (() => string | null) | null = null;

export function inferFacingWall(
  forwardXZ: [number, number]
): 'north' | 'south' | 'east' | 'west' {
  const [fx, fz] = forwardXZ;
  if (Math.abs(fx) >= Math.abs(fz)) {
    return fx >= 0 ? 'east' : 'west';
  }
  return fz >= 0 ? 'south' : 'north';
}

export function updateCameraBasis(
  position: Vec3,
  forwardXZ: [number, number],
  rightXZ: [number, number]
): void {
  currentBasis = {
    position,
    forwardXZ,
    rightXZ,
    facingWall: inferFacingWall(forwardXZ),
  };
}

export function getCameraBasis(): CameraBasis {
  return currentBasis;
}

export function registerFrameCapturer(
  capturer: (() => string | null) | null
): void {
  frameCapturer = capturer;
}

export function captureCanvasFrameBase64(): string | null {
  if (!frameCapturer) {
    return null;
  }
  try {
    return frameCapturer();
  } catch {
    return null;
  }
}
