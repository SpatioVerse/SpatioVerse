'use client';

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { SceneObject, ShopScene } from '@/lib/schema';

export type WalkerPose = {
  x: number;
  z: number;
  yawDeg: number;
  locked: boolean;
};

interface FirstPersonRigProps {
  scene: ShopScene;
  onPoseChange?: (pose: WalkerPose) => void;
}

const EYE_HEIGHT = 1.62;
const WALKTHROUGH_FOV = 56;
const ENTRANCE_THRESHOLD_INSET = 0.56;
const WALL_MARGIN = 0.42;
const PERSONAL_RADIUS = 0.34;
const WALK_SPEED = 2.15;
const SPRINT_SPEED = 3.2;
const KEY_TURN_SPEED = 1.85;
const MOUSE_SENSITIVITY_LOCKED = 0.0022;
const MOUSE_SENSITIVITY_DRAG = 0.0042;
const MAX_PITCH = THREE.MathUtils.degToRad(65);
const HEAD_BOB_AMPLITUDE = 0.022;
const OVERHEAD_CLEARANCE_Y = 1.9;

function clamp(value: number, min: number, max: number): number {
  if (min > max) return (min + max) * 0.5;
  return Math.max(min, Math.min(max, value));
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

/**
 * Tests whether a walker circle centered at (px, pz) with PERSONAL_RADIUS
 * intersects a SceneObject's rotated XZ footprint.
 */
function collidesWithObject(px: number, pz: number, obj: SceneObject): boolean {
  if (obj.position[1] >= OVERHEAD_CLEARANCE_Y) {
    return false;
  }

  const dx = px - obj.position[0];
  const dz = pz - obj.position[2];
  const cosR = Math.cos(obj.rotationY);
  const sinR = Math.sin(obj.rotationY);

  // Transform world offset into object's local XZ frame (inverse of Y-axis CCW rotation)
  const localX = dx * cosR - dz * sinR;
  const localZ = dx * sinR + dz * cosR;

  const halfW = obj.size[0] * 0.5;
  const halfD = obj.size[2] * 0.5;

  const closestX = clamp(localX, -halfW, halfW);
  const closestZ = clamp(localZ, -halfD, halfD);

  const distX = localX - closestX;
  const distZ = localZ - closestZ;

  return distX * distX + distZ * distZ < PERSONAL_RADIUS * PERSONAL_RADIUS;
}

function collidesWithAnyObject(
  px: number,
  pz: number,
  objects: SceneObject[]
): boolean {
  for (let i = 0; i < objects.length; i++) {
    if (collidesWithObject(px, pz, objects[i])) {
      return true;
    }
  }
  return false;
}

function clampToRoom(
  px: number,
  pz: number,
  room: ShopScene['room']
): [number, number] {
  const maxX = Math.max(0.05, room.width * 0.5 - WALL_MARGIN);
  const maxZ = Math.max(0.05, room.depth * 0.5 - WALL_MARGIN);
  return [clamp(px, -maxX, maxX), clamp(pz, -maxZ, maxZ)];
}

function computeEntranceSpawn(scene: ShopScene): {
  x: number;
  z: number;
  yaw: number;
  pitch: number;
} {
  const { width, depth, entrance } = scene.room;
  const inset = ENTRANCE_THRESHOLD_INSET;

  let rawX = 0;
  let rawZ = 0;
  let targetX = 0;
  let targetZ = -0.3;

  switch (entrance.wall) {
    case 'south':
      rawX = entrance.offset;
      rawZ = depth * 0.5 - inset;
      targetX = 0;
      targetZ = -0.3;
      break;
    case 'north':
      rawX = entrance.offset;
      rawZ = -depth * 0.5 + inset;
      targetX = 0;
      targetZ = 0.3;
      break;
    case 'east':
      rawX = width * 0.5 - inset;
      rawZ = entrance.offset;
      targetX = -0.3;
      targetZ = 0;
      break;
    case 'west':
      rawX = -width * 0.5 + inset;
      rawZ = entrance.offset;
      targetX = 0.3;
      targetZ = 0;
      break;
  }

  let [spawnX, spawnZ] = clampToRoom(rawX, rawZ, scene.room);

  // If the entrance spawn happens to touch a fixture, nudge slightly toward room center
  if (collidesWithAnyObject(spawnX, spawnZ, scene.objects)) {
    const dirX = targetX - spawnX;
    const dirZ = targetZ - spawnZ;
    const len = Math.hypot(dirX, dirZ) || 1;
    for (let step = 1; step <= 8; step++) {
      const candidate = clampToRoom(
        spawnX + (dirX / len) * step * 0.2,
        spawnZ + (dirZ / len) * step * 0.2,
        scene.room
      );
      if (!collidesWithAnyObject(candidate[0], candidate[1], scene.objects)) {
        spawnX = candidate[0];
        spawnZ = candidate[1];
        break;
      }
    }
  }

  const dx = targetX - spawnX;
  const dz = targetZ - spawnZ;
  const dy = 1.5 - EYE_HEIGHT;
  const horizDist = Math.hypot(dx, dz) || 1;

  // Camera default looks along -Z when yaw=0; forward = (-sin(yaw), 0, -cos(yaw))
  const yaw = Math.atan2(-dx, -dz);
  const pitch = clamp(Math.atan2(dy, horizDist), -MAX_PITCH, MAX_PITCH);

  return { x: spawnX, z: spawnZ, yaw, pitch };
}

function yawToCompassDeg(yaw: number): number {
  const deg = -THREE.MathUtils.radToDeg(yaw);
  return Math.round(((deg % 360) + 360) % 360) % 360;
}

export function FirstPersonRig({ scene, onPoseChange }: FirstPersonRigProps) {
  const { gl } = useThree();

  const sceneRef = useRef(scene);
  const onPoseChangeRef = useRef(onPoseChange);

  // Mutable navigation state kept cleanly in refs (zero render mutations)
  const posRef = useRef({ x: 0, z: 0 });
  const velRef = useRef({ x: 0, z: 0 });
  const lookRef = useRef({ yaw: 0, pitch: 0 });
  const bobPhaseRef = useRef(0);
  const bobOffsetRef = useRef(0);
  const needsCameraSnapRef = useRef(true);

  const keysRef = useRef<Set<string>>(new Set());
  const lockedRef = useRef(false);
  const dragRef = useRef({
    active: false,
    moved: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
  });

  const eulerRef = useRef(new THREE.Euler(0, 0, 0, 'YXZ'));
  const lastReportRef = useRef<{
    x: number;
    z: number;
    yawDeg: number;
    locked: boolean;
    time: number;
  }>({
    x: Number.NaN,
    z: Number.NaN,
    yawDeg: Number.NaN,
    locked: false,
    time: 0,
  });

  useEffect(() => {
    sceneRef.current = scene;
  }, [scene]);

  useEffect(() => {
    onPoseChangeRef.current = onPoseChange;
  }, [onPoseChange]);

  // Reset walker spawn cleanly on mount or when room geometry / entrance changes
  const roomWidth = scene.room.width;
  const roomDepth = scene.room.depth;
  const entranceWall = scene.room.entrance.wall;
  const entranceOffset = scene.room.entrance.offset;

  useEffect(() => {
    const spawn = computeEntranceSpawn(sceneRef.current);
    posRef.current.x = spawn.x;
    posRef.current.z = spawn.z;
    velRef.current.x = 0;
    velRef.current.z = 0;
    lookRef.current.yaw = spawn.yaw;
    lookRef.current.pitch = spawn.pitch;
    bobPhaseRef.current = 0;
    bobOffsetRef.current = 0;
    needsCameraSnapRef.current = true;

    const yawDeg = yawToCompassDeg(spawn.yaw);
    lastReportRef.current = {
      x: spawn.x,
      z: spawn.z,
      yawDeg,
      locked: lockedRef.current,
      time: performance.now(),
    };
    onPoseChangeRef.current?.({
      x: spawn.x,
      z: spawn.z,
      yawDeg,
      locked: lockedRef.current,
    });
  }, [roomWidth, roomDepth, entranceWall, entranceOffset]);

  // Keyboard, Pointer Lock, and Click-and-Drag look event wiring
  useEffect(() => {
    const domElement = gl.domElement;

    const reportLockChange = () => {
      const isLocked = document.pointerLockElement === domElement;
      lockedRef.current = isLocked;
      if (isLocked) {
        dragRef.current.active = false;
      }
      const yawDeg = yawToCompassDeg(lookRef.current.yaw);
      lastReportRef.current = {
        x: posRef.current.x,
        z: posRef.current.z,
        yawDeg,
        locked: isLocked,
        time: performance.now(),
      };
      onPoseChangeRef.current?.({
        x: posRef.current.x,
        z: posRef.current.z,
        yawDeg,
        locked: isLocked,
      });
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableElement(event.target)) return;
      if (
        event.code === 'ArrowUp' ||
        event.code === 'ArrowDown' ||
        event.code === 'ArrowLeft' ||
        event.code === 'ArrowRight' ||
        event.code === 'Space'
      ) {
        event.preventDefault();
      }
      keysRef.current.add(event.code);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      keysRef.current.delete(event.code);
    };

    const handleWindowBlur = () => {
      keysRef.current.clear();
      dragRef.current.active = false;
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || lockedRef.current) return;
      dragRef.current.active = true;
      dragRef.current.moved = false;
      dragRef.current.startX = event.clientX;
      dragRef.current.startY = event.clientY;
      dragRef.current.lastX = event.clientX;
      dragRef.current.lastY = event.clientY;
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (lockedRef.current) {
        lookRef.current.yaw -= event.movementX * MOUSE_SENSITIVITY_LOCKED;
        lookRef.current.pitch = clamp(
          lookRef.current.pitch - event.movementY * MOUSE_SENSITIVITY_LOCKED,
          -MAX_PITCH,
          MAX_PITCH
        );
        return;
      }

      if (!dragRef.current.active) return;

      const deltaX = event.clientX - dragRef.current.lastX;
      const deltaY = event.clientY - dragRef.current.lastY;
      dragRef.current.lastX = event.clientX;
      dragRef.current.lastY = event.clientY;

      const totalMoved = Math.hypot(
        event.clientX - dragRef.current.startX,
        event.clientY - dragRef.current.startY
      );
      if (totalMoved > 5) {
        dragRef.current.moved = true;
      }

      lookRef.current.yaw -= deltaX * MOUSE_SENSITIVITY_DRAG;
      lookRef.current.pitch = clamp(
        lookRef.current.pitch - deltaY * MOUSE_SENSITIVITY_DRAG,
        -MAX_PITCH,
        MAX_PITCH
      );
    };

    const handlePointerUp = () => {
      dragRef.current.active = false;
    };

    const handleCanvasClick = () => {
      // Only engage Pointer Lock on a clean click (not after a click-and-drag look)
      if (dragRef.current.moved || lockedRef.current) {
        dragRef.current.moved = false;
        return;
      }
      if (typeof domElement.requestPointerLock === 'function') {
        try {
          const maybePromise = domElement.requestPointerLock() as unknown;
          if (
            maybePromise &&
            typeof (maybePromise as Promise<void>).catch === 'function'
          ) {
            (maybePromise as Promise<void>).catch(() => {
              // Pointer lock may be declined by headless browsers or rapid ESC
            });
          }
        } catch {
          // Safe fallback: click-and-drag & keyboard yaw still work seamlessly
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointerlockchange', reportLockChange);
    domElement.addEventListener('pointerdown', handlePointerDown);
    domElement.addEventListener('click', handleCanvasClick);

    const activeKeys = keysRef.current;
    const dragState = dragRef.current;

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointerlockchange', reportLockChange);
      domElement.removeEventListener('pointerdown', handlePointerDown);
      domElement.removeEventListener('click', handleCanvasClick);
      activeKeys.clear();
      dragState.active = false;

      if (document.pointerLockElement === domElement) {
        try {
          document.exitPointerLock();
        } catch {
          // Ignore exit errors during teardown
        }
      }
    };
  }, [gl]);

  useFrame((state, rawDelta) => {
    const dt = Math.min(rawDelta, 0.05);
    const keys = keysRef.current;
    const activeScene = sceneRef.current;

    // 1. Keyboard yaw rotation (Q/E or ArrowLeft/ArrowRight)
    let yawInput = 0;
    if (keys.has('KeyQ') || keys.has('ArrowLeft')) yawInput += 1;
    if (keys.has('KeyE') || keys.has('ArrowRight')) yawInput -= 1;
    if (yawInput !== 0) {
      lookRef.current.yaw += yawInput * KEY_TURN_SPEED * dt;
    }

    // 2. Movement vector in camera horizontal XZ plane
    let forwardInput = 0;
    let rightInput = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) forwardInput += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) forwardInput -= 1;
    if (keys.has('KeyD')) rightInput += 1;
    if (keys.has('KeyA')) rightInput -= 1;

    const inputLen = Math.hypot(forwardInput, rightInput);
    const isSprinting = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const maxSpeed = isSprinting ? SPRINT_SPEED : WALK_SPEED;

    let targetVelX = 0;
    let targetVelZ = 0;

    if (inputLen > 0) {
      const normForward = forwardInput / inputLen;
      const normRight = rightInput / inputLen;
      const yaw = lookRef.current.yaw;

      // forward = (-sin(yaw), 0, -cos(yaw)), right = (cos(yaw), 0, -sin(yaw))
      const sinY = Math.sin(yaw);
      const cosY = Math.cos(yaw);

      const moveDirX = -sinY * normForward + cosY * normRight;
      const moveDirZ = -cosY * normForward - sinY * normRight;

      targetVelX = moveDirX * maxSpeed;
      targetVelZ = moveDirZ * maxSpeed;
    }

    // Smooth exponential acceleration & deceleration
    const accelFactor = 1 - Math.exp(-13 * dt);
    velRef.current.x += (targetVelX - velRef.current.x) * accelFactor;
    velRef.current.z += (targetVelZ - velRef.current.z) * accelFactor;

    const stepX = velRef.current.x * dt;
    const stepZ = velRef.current.z * dt;

    let curX = posRef.current.x;
    let curZ = posRef.current.z;

    // 3. Real-time collision resolution with independent X / Z wall-sliding
    if (Math.abs(stepX) > 1e-6) {
      const [clampedX] = clampToRoom(curX + stepX, curZ, activeScene.room);
      if (!collidesWithAnyObject(clampedX, curZ, activeScene.objects)) {
        curX = clampedX;
      } else {
        velRef.current.x = 0;
      }
    }

    if (Math.abs(stepZ) > 1e-6) {
      const [, clampedZ] = clampToRoom(curX, curZ + stepZ, activeScene.room);
      if (!collidesWithAnyObject(curX, clampedZ, activeScene.objects)) {
        curZ = clampedZ;
      } else {
        velRef.current.z = 0;
      }
    }

    // Always enforce room wall clamping
    const [finalX, finalZ] = clampToRoom(curX, curZ, activeScene.room);
    const actualMoved = Math.hypot(
      finalX - posRef.current.x,
      finalZ - posRef.current.z
    );
    posRef.current.x = finalX;
    posRef.current.z = finalZ;

    // 4. Subtle realistic walking head-bob only while moving
    const actualSpeed = dt > 0 ? actualMoved / dt : 0;
    if (actualSpeed > 0.12) {
      const speedRatio = clamp(actualSpeed / WALK_SPEED, 0, 1.35);
      bobPhaseRef.current += dt * (isSprinting ? 10.2 : 8.0);
      const targetBob =
        Math.sin(bobPhaseRef.current) *
        HEAD_BOB_AMPLITUDE *
        Math.min(1, speedRatio);
      bobOffsetRef.current +=
        (targetBob - bobOffsetRef.current) * (1 - Math.exp(-14 * dt));
    } else {
      bobOffsetRef.current +=
        (0 - bobOffsetRef.current) * (1 - Math.exp(-10 * dt));
    }

    // 5. Apply pose to the active R3F camera
    const cam = state.camera;
    eulerRef.current.set(lookRef.current.pitch, lookRef.current.yaw, 0, 'YXZ');
    cam.quaternion.setFromEuler(eulerRef.current);
    cam.position.set(
      posRef.current.x,
      EYE_HEIGHT + bobOffsetRef.current,
      posRef.current.z
    );

    if (
      cam instanceof THREE.PerspectiveCamera &&
      (needsCameraSnapRef.current || Math.abs(cam.fov - WALKTHROUGH_FOV) > 0.05)
    ) {
      needsCameraSnapRef.current = false;
      cam.fov = WALKTHROUGH_FOV;
      cam.updateProjectionMatrix();
    }

    // 6. Throttled pose reporting for HUD minimap & coordinates
    const now = performance.now();
    const yawDeg = yawToCompassDeg(lookRef.current.yaw);
    const last = lastReportRef.current;
    const distChanged = Math.hypot(
      posRef.current.x - last.x,
      posRef.current.z - last.z
    );
    const yawChanged = Math.abs(yawDeg - last.yawDeg);

    if (
      now - last.time >= 65 &&
      (distChanged >= 0.025 || yawChanged >= 1 || Number.isNaN(last.x))
    ) {
      lastReportRef.current = {
        x: posRef.current.x,
        z: posRef.current.z,
        yawDeg,
        locked: lockedRef.current,
        time: now,
      };
      onPoseChangeRef.current?.({
        x: posRef.current.x,
        z: posRef.current.z,
        yawDeg,
        locked: lockedRef.current,
      });
    }
  });

  return null;
}
