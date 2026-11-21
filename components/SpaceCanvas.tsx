'use client';

import { Suspense, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ContactShadows, OrbitControls, useGLTF } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import { BoutiqueEnvironment } from '@/components/BoutiqueEnvironment';
import { FirstPersonRig, type WalkerPose } from '@/components/FirstPersonRig';
import { SceneObject } from '@/components/SceneObject';
import {
  registerFrameCapturer,
  updateCameraBasis,
} from '@/lib/cameraBridge';
import { GLB_MODEL_PATHS } from '@/lib/modelCatalog';
import type { SceneObject as SceneObjectType, SceneValidator, ShopScene } from '@/lib/schema';
import type { VoicePreviewState } from '@/lib/voiceActions';
import {
  useSceneStore,
  type CameraPreset,
} from '@/store/useSceneStore';

interface SpaceCanvasProps {
  validator?: SceneValidator;
  onWalkerPose?: (pose: WalkerPose) => void;
}

const ORBIT_FOV = 44;
let modelsPreloaded = false;

function computeOrbitGoal(
  room: ShopScene['room'],
  preset: CameraPreset
): { position: THREE.Vector3; target: THREE.Vector3 } {
  const span = Math.max(room.width, room.depth, 3.2);

  if (preset === 'top') {
    return {
      position: new THREE.Vector3(0, span * 1.38, 0.01),
      target: new THREE.Vector3(0, 0, 0),
    };
  }

  if (preset === 'entrance') {
    const camY = Math.max(1.72, room.height * 0.56);
    const pullBack = span * 0.36;
    const { wall, offset } = room.entrance;

    switch (wall) {
      case 'north':
        return {
          position: new THREE.Vector3(
            offset,
            camY,
            -(room.depth * 0.5 + pullBack)
          ),
          target: new THREE.Vector3(0, 0.95, room.depth * 0.12),
        };
      case 'east':
        return {
          position: new THREE.Vector3(
            room.width * 0.5 + pullBack,
            camY,
            offset
          ),
          target: new THREE.Vector3(-room.width * 0.12, 0.95, 0),
        };
      case 'west':
        return {
          position: new THREE.Vector3(
            -(room.width * 0.5 + pullBack),
            camY,
            offset
          ),
          target: new THREE.Vector3(room.width * 0.12, 0.95, 0),
        };
      case 'south':
      default:
        return {
          position: new THREE.Vector3(
            offset,
            camY,
            room.depth * 0.5 + pullBack
          ),
          target: new THREE.Vector3(0, 0.95, -room.depth * 0.12),
        };
    }
  }

  // Default architectural 3/4 hero perspective scaled dynamically to room size
  return {
    position: new THREE.Vector3(span * 0.74, span * 0.6, span * 0.85),
    target: new THREE.Vector3(0, Math.min(0.85, room.height * 0.25), -0.12),
  };
}

interface OrbitCameraControllerProps {
  room: ShopScene['room'];
  cameraPreset: CameraPreset;
  cameraPresetTick: number;
  enabled: boolean;
}

function OrbitCameraController({
  room,
  cameraPreset,
  cameraPresetTick,
  enabled,
}: OrbitCameraControllerProps) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const goalPosRef = useRef<THREE.Vector3 | null>(null);
  const goalTargetRef = useRef<THREE.Vector3 | null>(null);
  const animatingRef = useRef(false);
  const needsFovRestoreRef = useRef(true);

  const roomWidth = room.width;
  const roomDepth = room.depth;
  const roomHeight = room.height;
  const entranceWall = room.entrance.wall;
  const entranceOffset = room.entrance.offset;
  const entranceWidth = room.entrance.width;

  useEffect(() => {
    const goal = computeOrbitGoal(
      {
        width: roomWidth,
        depth: roomDepth,
        height: roomHeight,
        entrance: {
          wall: entranceWall,
          offset: entranceOffset,
          width: entranceWidth,
        },
      },
      cameraPreset
    );
    goalPosRef.current = goal.position;
    goalTargetRef.current = goal.target;
    animatingRef.current = true;
    needsFovRestoreRef.current = true;
  }, [
    roomWidth,
    roomDepth,
    roomHeight,
    entranceWall,
    entranceOffset,
    entranceWidth,
    cameraPreset,
    cameraPresetTick,
  ]);

  useFrame((state, rawDelta) => {
    const dt = Math.min(rawDelta, 0.05);
    const cam = state.camera;

    if (
      cam instanceof THREE.PerspectiveCamera &&
      (needsFovRestoreRef.current || Math.abs(cam.fov - ORBIT_FOV) > 0.05)
    ) {
      needsFovRestoreRef.current = false;
      cam.fov = ORBIT_FOV;
      cam.updateProjectionMatrix();
    }

    if (!animatingRef.current || !goalPosRef.current || !goalTargetRef.current) {
      return;
    }

    const alpha = 1 - Math.exp(-8.5 * dt);
    cam.position.lerp(goalPosRef.current, alpha);

    const controls = controlsRef.current;
    if (controls) {
      controls.target.lerp(goalTargetRef.current, alpha);
      controls.update();
    } else {
      cam.lookAt(goalTargetRef.current);
    }

    const posDist = cam.position.distanceTo(goalPosRef.current);
    const targetDist = controls
      ? controls.target.distanceTo(goalTargetRef.current)
      : 0;

    if (posDist < 0.02 && targetDist < 0.02) {
      cam.position.copy(goalPosRef.current);
      if (controls) {
        controls.target.copy(goalTargetRef.current);
        controls.update();
      }
      animatingRef.current = false;
    }
  });

  const maxOrbitDist = Math.max(room.width, room.depth) * 2.8;

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enabled={enabled}
      enableDamping
      dampingFactor={0.075}
      rotateSpeed={0.85}
      zoomSpeed={0.9}
      panSpeed={0.8}
      minDistance={1.35}
      maxDistance={maxOrbitDist}
      maxPolarAngle={Math.PI * 0.485}
      onStart={() => {
        animatingRef.current = false;
      }}
    />
  );
}

/**
 * Publishes live camera orientation (forwardXZ / rightXZ) and an on-demand
 * JPEG canvas snapshot function to `lib/cameraBridge` with zero React re-renders.
 */
function CameraBridgeSync() {
  const { gl, scene, camera } = useThree();
  const forwardRef = useRef(new THREE.Vector3());
  const rightRef = useRef(new THREE.Vector3());
  const upRef = useRef(new THREE.Vector3(0, 1, 0));

  useEffect(() => {
    registerFrameCapturer(() => {
      try {
        gl.render(scene, camera);
        const src = gl.domElement;
        const maxW = 512;
        const scale = src.width > maxW ? maxW / src.width : 1;
        const outW = Math.max(1, Math.round(src.width * scale));
        const outH = Math.max(1, Math.round(src.height * scale));
        const offscreen = document.createElement('canvas');
        offscreen.width = outW;
        offscreen.height = outH;
        const ctx = offscreen.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(src, 0, 0, outW, outH);
        const dataUrl = offscreen.toDataURL('image/jpeg', 0.65);
        return dataUrl.split(',')[1] ?? null;
      } catch {
        return null;
      }
    });

    return () => {
      registerFrameCapturer(null);
    };
  }, [gl, scene, camera]);

  useFrame(() => {
    camera.getWorldDirection(forwardRef.current);
    const fx = forwardRef.current.x;
    const fz = forwardRef.current.z;
    const fLen = Math.hypot(fx, fz);
    const normFx = fLen > 1e-4 ? fx / fLen : 0;
    const normFz = fLen > 1e-4 ? fz / fLen : -1;

    rightRef.current
      .set(normFx, 0, normFz)
      .cross(upRef.current)
      .normalize();

    updateCameraBasis(
      [camera.position.x, camera.position.y, camera.position.z],
      [normFx, normFz],
      [rightRef.current.x, rightRef.current.z]
    );
  });

  return null;
}

function shortestAngleDelta(from: number, to: number): number {
  let diff = (to - from) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

interface VoicePreviewGhostProps {
  object: SceneObjectType;
  preview: VoicePreviewState;
}

/**
 * Smoothly animated translucent 3D preview ghost that slides/rotates to the
 * proposed pose while the original fixture stays visible until confirmed.
 */
function VoicePreviewGhost({ object, preview }: VoicePreviewGhostProps) {
  const ghostGroupRef = useRef<THREE.Group | null>(null);
  const currentPosRef = useRef(
    new THREE.Vector3(
      preview.originalPosition[0],
      preview.originalPosition[1],
      preview.originalPosition[2]
    )
  );
  const currentYawRef = useRef(preview.originalRotationY);
  const lastObjectIdRef = useRef(preview.objectId);

  const hasError = preview.issues.some((i) => i.severity === 'error');
  const accentColor = hasError
    ? '#ef4444'
    : preview.frozen
      ? '#f59e0b'
      : '#38bdf8';

  const [w, h, d] = object.size;

  const boxEdges = useMemo(() => {
    const geom = new THREE.BoxGeometry(w, h, d);
    const edges = new THREE.EdgesGeometry(geom);
    geom.dispose();
    return edges;
  }, [w, h, d]);

  useEffect(() => {
    return () => {
      boxEdges.dispose();
    };
  }, [boxEdges]);

  useFrame((_, rawDelta) => {
    const group = ghostGroupRef.current;
    if (!group) return;

    if (lastObjectIdRef.current !== preview.objectId) {
      lastObjectIdRef.current = preview.objectId;
      currentPosRef.current.set(
        preview.originalPosition[0],
        preview.originalPosition[1],
        preview.originalPosition[2]
      );
      currentYawRef.current = preview.originalRotationY;
    }

    const dt = Math.min(rawDelta, 0.05);
    const speed = preview.frozen ? 22 : 9.5;
    const alpha = 1 - Math.exp(-speed * dt);

    currentPosRef.current.x +=
      (preview.previewPosition[0] - currentPosRef.current.x) * alpha;
    currentPosRef.current.y +=
      (preview.previewPosition[1] - currentPosRef.current.y) * alpha;
    currentPosRef.current.z +=
      (preview.previewPosition[2] - currentPosRef.current.z) * alpha;

    const dYaw = shortestAngleDelta(
      currentYawRef.current,
      preview.previewRotationY
    );
    currentYawRef.current += dYaw * alpha;

    group.position.copy(currentPosRef.current);
    group.rotation.set(0, currentYawRef.current, 0);
  });

  // Floor connector ribbon between original center and preview target center
  const dx = preview.previewPosition[0] - preview.originalPosition[0];
  const dz = preview.previewPosition[2] - preview.originalPosition[2];
  const moveDist = Math.hypot(dx, dz);
  const midX = (preview.originalPosition[0] + preview.previewPosition[0]) / 2;
  const midZ = (preview.originalPosition[2] + preview.previewPosition[2]) / 2;
  const pathAngle = Math.atan2(dx, dz);

  return (
    <group>
      {/* Translucent animated holographic preview volume */}
      <group
        ref={ghostGroupRef}
        position={preview.originalPosition}
        rotation={[0, preview.originalRotationY, 0]}
      >
        <mesh position={[0, h / 2, 0]}>
          <boxGeometry args={[w, h, d]} />
          <meshStandardMaterial
            color={accentColor}
            emissive={accentColor}
            emissiveIntensity={hasError ? 0.45 : 0.28}
            transparent
            opacity={hasError ? 0.36 : 0.28}
            roughness={0.25}
            depthWrite={false}
          />
        </mesh>

        <lineSegments position={[0, h / 2, 0]} geometry={boxEdges}>
          <lineBasicMaterial color={accentColor} transparent opacity={0.95} />
        </lineSegments>

        {/* Crisp floor footprint glow */}
        <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[w + 0.08, d + 0.08]} />
          <meshBasicMaterial
            color={accentColor}
            transparent
            opacity={hasError ? 0.34 : 0.22}
            depthWrite={false}
          />
        </mesh>
      </group>

      {/* Motion path ribbon from original position to preview target */}
      {moveDist > 0.05 && (
        <mesh
          position={[midX, 0.015, midZ]}
          rotation={[-Math.PI / 2, 0, pathAngle]}
        >
          <planeGeometry args={[0.045, moveDist]} />
          <meshBasicMaterial
            color={accentColor}
            transparent
            opacity={0.75}
            depthWrite={false}
          />
        </mesh>
      )}

      {/* Optional validated alternative footprint suggestion on the floor */}
      {preview.suggestedAlternative && (
        <group
          position={[
            preview.suggestedAlternative.position[0],
            0.014,
            preview.suggestedAlternative.position[2],
          ]}
          rotation={[0, preview.suggestedAlternative.rotationY, 0]}
        >
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[w + 0.06, d + 0.06]} />
            <meshBasicMaterial
              color="#10b981"
              transparent
              opacity={0.28}
              depthWrite={false}
            />
          </mesh>
        </group>
      )}
    </group>
  );
}

export function SpaceCanvas({ validator, onWalkerPose }: SpaceCanvasProps) {
  const scene = useSceneStore((state) => state.scene);
  const selectedId = useSceneStore((state) => state.selectedId);
  const isDragging = useSceneStore((state) => state.isDragging);
  const cameraMode = useSceneStore((state) => state.cameraMode);
  const cameraPreset = useSceneStore((state) => state.cameraPreset);
  const cameraPresetTick = useSceneStore((state) => state.cameraPresetTick);
  const showGrid = useSceneStore((state) => state.showGrid);
  const issues = useSceneStore((state) => state.issues);
  const voicePreview = useSceneStore((state) => state.voicePreview);
  const voiceHighlightIds = useSceneStore((state) => state.voiceHighlightIds);
  const selectObject = useSceneStore((state) => state.selectObject);
  const moveObject = useSceneStore((state) => state.moveObject);
  const setDragging = useSceneStore((state) => state.setDragging);
  const setValidator = useSceneStore((state) => state.setValidator);

  // Safely preload local PBR GLB assets on client mount
  useEffect(() => {
    if (modelsPreloaded) return;
    modelsPreloaded = true;
    useGLTF.preload(GLB_MODEL_PATHS.plant);
    useGLTF.preload(GLB_MODEL_PATHS.lamp);
    useGLTF.preload(GLB_MODEL_PATHS.vase);
    useGLTF.preload(GLB_MODEL_PATHS.chair);
  }, []);

  // Sync optional external validator into Zustand store
  useEffect(() => {
    if (validator) {
      setValidator(validator);
    }
  }, [validator, setValidator]);

  const { errorIds, warningIds, hasBlockedPath } = useMemo(() => {
    const errors = new Set<string>();
    const warnings = new Set<string>();
    let blocked = false;

    const allIssues = voicePreview
      ? [...issues, ...voicePreview.issues]
      : issues;

    for (const issue of allIssues) {
      if (issue.code === 'BLOCKED_PATH') {
        blocked = true;
      }
      for (const id of issue.objectIds) {
        if (issue.severity === 'error') {
          errors.add(id);
        } else {
          warnings.add(id);
        }
      }
    }

    return { errorIds: errors, warningIds: warnings, hasBlockedPath: blocked };
  }, [issues, voicePreview]);

  const voiceHighlightSet = useMemo(
    () => new Set(voiceHighlightIds),
    [voiceHighlightIds]
  );

  const previewTargetObject = useMemo(
    () =>
      voicePreview
        ? scene.objects.find((o) => o.id === voicePreview.objectId) ?? null
        : null,
    [scene.objects, voicePreview]
  );

  const isWalkthrough = cameraMode === 'walkthrough';
  const contactShadowScale = Math.max(scene.room.width, scene.room.depth) * 1.5;

  return (
    <div className="relative h-full w-full select-none">
      <Canvas
        shadows="percentage"
        dpr={[1, 2]}
        gl={{
          antialias: true,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.04,
        }}
        camera={{
          position: [5.4, 4.4, 6.2],
          fov: ORBIT_FOV,
          near: 0.08,
          far: 80,
        }}
        onPointerMissed={() => {
          if (!isWalkthrough) {
            selectObject(null);
          }
        }}
      >
        <color
          attach="background"
          args={[isWalkthrough ? '#dce4ec' : '#121110']}
        />

        <Suspense fallback={null}>
          <BoutiqueEnvironment
            scene={scene}
            showGrid={showGrid}
            hasBlockedPath={hasBlockedPath}
            isWalkthrough={isWalkthrough}
            onFloorClick={() => selectObject(null)}
          />

          {scene.objects.map((obj) => (
            <SceneObject
              key={obj.id}
              object={obj}
              isSelected={selectedId === obj.id && !isWalkthrough}
              isVoiceHighlighted={voiceHighlightSet.has(obj.id) && !isWalkthrough}
              isPreviewOrigin={voicePreview?.objectId === obj.id && !isWalkthrough}
              hasError={errorIds.has(obj.id)}
              hasWarning={warningIds.has(obj.id)}
              interactive={!isWalkthrough}
              onSelect={selectObject}
              onMove={moveObject}
              onDragStateChange={setDragging}
            />
          ))}

          {voicePreview && previewTargetObject && (
            <VoicePreviewGhost
              object={previewTargetObject}
              preview={voicePreview}
            />
          )}

          <CameraBridgeSync />

          <ContactShadows
            position={[0, 0.002, 0]}
            opacity={0.34}
            scale={contactShadowScale}
            blur={1.9}
            far={2.8}
          />
        </Suspense>

        {isWalkthrough ? (
          <FirstPersonRig scene={scene} onPoseChange={onWalkerPose} />
        ) : (
          <OrbitCameraController
            room={scene.room}
            cameraPreset={cameraPreset}
            cameraPresetTick={cameraPresetTick}
            enabled={!isDragging}
          />
        )}
      </Canvas>
    </div>
  );
}
