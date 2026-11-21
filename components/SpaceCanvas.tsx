'use client';

import { Suspense, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { ContactShadows, OrbitControls, useGLTF } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import { BoutiqueEnvironment } from '@/components/BoutiqueEnvironment';
import { FirstPersonRig, type WalkerPose } from '@/components/FirstPersonRig';
import { SceneObject } from '@/components/SceneObject';
import { GLB_MODEL_PATHS } from '@/lib/modelCatalog';
import type { SceneValidator, ShopScene } from '@/lib/schema';
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

export function SpaceCanvas({ validator, onWalkerPose }: SpaceCanvasProps) {
  const scene = useSceneStore((state) => state.scene);
  const selectedId = useSceneStore((state) => state.selectedId);
  const isDragging = useSceneStore((state) => state.isDragging);
  const cameraMode = useSceneStore((state) => state.cameraMode);
  const cameraPreset = useSceneStore((state) => state.cameraPreset);
  const cameraPresetTick = useSceneStore((state) => state.cameraPresetTick);
  const showGrid = useSceneStore((state) => state.showGrid);
  const issues = useSceneStore((state) => state.issues);
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

    for (const issue of issues) {
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
  }, [issues]);

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
              hasError={errorIds.has(obj.id)}
              hasWarning={warningIds.has(obj.id)}
              interactive={!isWalkthrough}
              onSelect={selectObject}
              onMove={moveObject}
              onDragStateChange={setDragging}
            />
          ))}

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
