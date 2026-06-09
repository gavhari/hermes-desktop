import { Suspense, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import {
  OrbitControls,
  Environment,
  Lightformer,
  useGLTF,
  useTexture,
} from "@react-three/drei";
import { configureTextBuilder } from "troika-three-text";
import * as THREE from "three";
import { clone as SkeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { AgentModel } from "./objects/agents";
import { RIGGED_EMPLOYEE_URL, RIGGED_MAN_URL } from "./objects/RiggedCharacter";
import atmGlbUrl from "./assets/atm.glb?url";
import sofaGlbUrl from "./assets/loungeSofa.glb?url";
import sofaChairGlbUrl from "./assets/sofa_chair.glb?url";
import manGlbUrl from "./assets/man.glb?url";
import baseBankLogoUrl from "./assets/images/base-bank.webp";
import hermesHqLogoUrl from "./assets/images/hermes-one-hq.webp";
import { Workstations, FurniturePieces } from "./objects/furniture";
import {
  buildWorkstations,
  REST_SEATS,
  REST_FURNITURE,
  EXECUTIVE_DECOR,
  INTERIOR_WALLS,
  DIVIDER_X,
  DOOR_Y,
  type Workstation,
  type Seat,
} from "./layout";
import { WORLD_W, WORLD_H, WALK_SPEED, SCALE } from "./core/constants";
import { toWorld } from "./core/geometry";
import type { OfficeAgent, RenderAgent } from "./core/types";
import officeFontUrl from "../../../assets/fonts/Manrope-Medium.ttf";

// drei's <Text> (agent nameplates / speech bubbles, via troika) defaults to two
// behaviours the renderer's strict CSP (`script-src`/`default-src 'self'`)
// blocks: spawning a blob-backed Web Worker, and fetching its default font from
// a CDN. Disable the worker (typeset on the main thread) and point troika at
// our locally-bundled Manrope so labels render fully offline without loosening
// the app's Content-Security-Policy.
configureTextBuilder({ useWorker: false, defaultFontURL: officeFontUrl });

// Walking speed (canvas units / second) and arrival threshold.
const WALK_UNITS_PER_SEC = 130;
const ARRIVE_DISTANCE = 8;

// The world's day/night look (floor, walls, lighting) is driven by the system
// clock, NOT the app's UI theme — so future 3D worlds can reuse this same
// time-of-day model. Only the canvas background follows the app theme.
interface WorldPalette {
  floor: string;
  rug: string;
  wallNS: string;
  wallEW: string;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  ambient: number;
  directional: number;
  // Image-based-lighting (Lightformer environment) strength + warmth. With
  // ACES tone mapping the punchier directional + soft IBL replace the old flat
  // fill, so ambient/hemi are dialled down to avoid washing the scene out.
  envIntensity: number;
  keyColor: string;
}

const DAY_PALETTE: WorldPalette = {
  floor: "#e7e2d8",
  rug: "#cdd7e5",
  wallNS: "#c9c2b4",
  wallEW: "#d2ccbf",
  hemiSky: "#ffffff",
  hemiGround: "#b9b4a8",
  hemiIntensity: 0.45,
  ambient: 0.22,
  directional: 2.0,
  envIntensity: 0.75,
  keyColor: "#fff4e2",
};

// Only the canvas background follows the app's light/dark theme.
const THEME_BACKGROUND = { light: "#f3f1ec", dark: "#16181d" } as const;

type ControllerMode = "toSeat" | "seated";
interface ControllerState {
  mode: ControllerMode;
  /** Which seat the agent is currently heading to / sitting at. */
  goalKey: "desk" | "rest" | null;
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// Doorway waypoints just inside each room, so agents pass through the gap in
// the partition instead of clipping the wall (we have no full pathfinder).
function routeTarget(
  ax: number,
  finalX: number,
  finalY: number,
): { x: number; y: number } {
  const onEast = ax > DIVIDER_X;
  const targetEast = finalX > DIVIDER_X;
  if (onEast === targetEast) return { x: finalX, y: finalY };
  return { x: targetEast ? DIVIDER_X + 60 : DIVIDER_X - 60, y: DOOR_Y };
}

function makeRenderAgent(agent: OfficeAgent): RenderAgent {
  // Spawn near the entrance (south edge); the controller routes the agent to
  // its assigned desk from there.
  const x = randomBetween(820, 1000);
  const y = 1650;
  return {
    ...agent,
    x,
    y,
    targetX: x,
    targetY: y,
    path: [],
    facing: Math.PI,
    frame: Math.floor(randomBetween(0, 240)),
    walkSpeed: WALK_SPEED,
    phaseOffset: randomBetween(0, Math.PI * 2),
    state: "standing",
  };
}

/**
 * Holds the live agent simulation. Each agent walks to its desk (gateway up)
 * or to a rest-room beanbag (gateway off) and sits. Positions are mutated
 * in-place on the refs each frame so avatars animate without React re-renders.
 */
function AgentsLayer({
  agents,
  workstations,
  selectedId,
  onSelect,
}: {
  agents: OfficeAgent[];
  workstations: Workstation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const agentsRef = useRef<RenderAgent[]>([]) as React.MutableRefObject<
    RenderAgent[]
  >;
  const lookupRef = useRef<Map<string, RenderAgent>>(new Map());
  const controllerRef = useRef<Map<string, ControllerState>>(new Map());

  const deskSeatByAgent = useMemo(() => {
    const map = new Map<string, Seat>();
    for (const w of workstations) {
      map.set(w.agentId, { x: w.seatX, y: w.seatY, facing: w.seatFacing });
    }
    return map;
  }, [workstations]);

  // Assign each agent a rest-room beanbag (round-robin) for when its gateway
  // is off.
  const restSeatByAgent = useMemo(() => {
    const map = new Map<string, Seat>();
    if (REST_SEATS.length > 0) {
      agents.forEach((agent, index) => {
        map.set(agent.id, REST_SEATS[index % REST_SEATS.length]);
      });
    }
    return map;
  }, [agents]);

  // Reconcile the simulation list whenever the set of agents changes, keeping
  // existing agents' positions so they don't teleport on a profile refresh.
  // This mutates simulation refs, so it must run as an effect (not in useMemo,
  // which React may re-run arbitrarily and would reset live walk/controller
  // state). useLayoutEffect runs synchronously before paint so the next
  // useFrame always sees a consistent ref.
  useLayoutEffect(() => {
    const prev = lookupRef.current;
    // Guard: if every agent already exists with the same status and position,
    // nothing meaningful changed — keep the current simulation objects so
    // agents don't teleport or reset their pose on a parent re-render.
    let unchanged = agents.length === prev.size;
    if (unchanged) {
      for (const agent of agents) {
        const existing = prev.get(agent.id);
        const existingPos =
          existing && "position" in existing
            ? (existing as unknown as OfficeAgent).position
            : undefined;
        if (
          !existing ||
          existing.status !== agent.status ||
          existingPos !== agent.position
        ) {
          unchanged = false;
          break;
        }
      }
    }
    if (unchanged) return;

    const next: RenderAgent[] = agents.map((agent) => {
      const existing = prev.get(agent.id);
      if (existing) {
        return { ...existing, ...agent };
      }
      return makeRenderAgent(agent);
    });
    (agentsRef as React.MutableRefObject<RenderAgent[]>).current = next;
    const lookup = new Map<string, RenderAgent>();
    for (const a of next) lookup.set(a.id, a);
    lookupRef.current = lookup;
    // Drop controller state for removed agents.
    const controller = controllerRef.current;
    for (const id of [...controller.keys()]) {
      if (!lookup.has(id)) controller.delete(id);
    }
  }, [agents]);

  useFrame((_, delta) => {
    const step = Math.min(delta, 0.05); // clamp big frame gaps
    const liveAgents = (agentsRef as React.MutableRefObject<RenderAgent[]>)
      .current;
    for (const agent of liveAgents) {
      // eslint-disable-next-line -- simulation state is intentionally mutated in-place each frame
      agent.frame += step * 60;

      // Working agents (gateway up) sit at their desk; everyone else rests in
      // the rest room.
      const working = agent.status === "working";
      const goalKey: "desk" | "rest" = working ? "desk" : "rest";
      const goal = working
        ? deskSeatByAgent.get(agent.id)
        : restSeatByAgent.get(agent.id);

      let ctrl = controllerRef.current.get(agent.id);
      if (!ctrl) {
        ctrl = { mode: "toSeat", goalKey: null };
        controllerRef.current.set(agent.id, ctrl);
      }

      if (!goal) {
        agent.state = "standing";
        continue;
      }

      // Gateway flipped (profile started/stopped) — head to the new seat.
      if (ctrl.goalKey !== goalKey) {
        ctrl.goalKey = goalKey;
        ctrl.mode = "toSeat";
      }

      const moveToward = (tx: number, ty: number): boolean => {
        const dx = tx - agent.x;
        const dy = ty - agent.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= ARRIVE_DISTANCE) {
          agent.x = tx;
          agent.y = ty;
          return true;
        }
        const move = Math.min(dist, WALK_UNITS_PER_SEC * step);
        agent.x += (dx / dist) * move;
        agent.y += (dy / dist) * move;
        agent.facing = Math.atan2(dx, dy);
        agent.state = "walking";
        return false;
      };

      if (ctrl.mode === "seated") {
        agent.x = goal.x;
        agent.y = goal.y;
        agent.facing = goal.facing;
        agent.state = "sitting";
        continue;
      }

      // Heading to the seat, routing through the doorway when changing rooms.
      const wp = routeTarget(agent.x, goal.x, goal.y);
      const reachedFinal = wp.x === goal.x && wp.y === goal.y;
      if (moveToward(wp.x, wp.y) && reachedFinal) {
        agent.facing = goal.facing;
        agent.state = "sitting";
        ctrl.mode = "seated";
      }
    }
  });

  return (
    <>
      {agents.map((agent) => (
        <AgentModel
          key={agent.id}
          agentId={agent.id}
          name={agent.name}
          // Nameplate shows the name only; the model/provider stays in the
          // selection panel rather than cluttering the 3D head label.
          subtitle={null}
          status={agent.status}
          color={agent.color}
          appearance={agent.avatarProfile}
          agentsRef={agentsRef}
          agentLookupRef={lookupRef}
          onClick={onSelect}
          showSpeech={selectedId === agent.id}
          speechText={selectedId === agent.id ? `Hi, I'm ${agent.name}` : null}
          riggedModelUrl={
            agent.position === "ceo" ? RIGGED_EMPLOYEE_URL : RIGGED_MAN_URL
          }
          riggedModelTint={agent.position === "ceo" ? null : agent.color}
        />
      ))}
    </>
  );
}

// ── Bank dimensions (world units) ─────────────────────────────────────────
const BANK_W = 22;
const BANK_D = 18;
const BANK_WALL_H = 3.2;
const BANK_WALL_T = 0.25;
// Gap (street) between the south bank wall and the north office wall
const BANK_STREET_GAP = 4.0;
// Z centre of the bank building (north of the office)
const BANK_Z = -(WORLD_H / 2 + BANK_STREET_GAP + BANK_D / 2);

const BANK_PALETTE = {
  floor: "#d4c8b8",
  wall: "#e8e0d4",
  counter: "#8b7355",
  counterTop: "#f5f0e8",
  atm: "#2d5a8a",
  atmScreen: "#1a3a5c",
  personShirt: ["#c44", "#44c", "#4a4", "#a4a", "#c84", "#488"],
  personPants: "#334",
};

function bankRng(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function BankLogoSign(): React.JSX.Element {
  const texture = useTexture(baseBankLogoUrl, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
  });
  // Logo aspect ratio ≈ 3.5 : 1 (roughly 720×200 px)
  const logoW = 6.0;
  const logoH = logoW / 5;
  const halfD = BANK_D / 2;
  return (
    <mesh position={[0, BANK_WALL_H * 0.72, -halfD + BANK_WALL_T / 2 + 0.01]}>
      <planeGeometry args={[logoW, logoH]} />
      <meshStandardMaterial
        map={texture}
        roughness={0.4}
        metalness={0.0}
        transparent
        alphaTest={0.05}
      />
    </mesh>
  );
}

function BankShell(): React.JSX.Element {
  const halfW = BANK_W / 2;
  const halfD = BANK_D / 2;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[BANK_W, BANK_D]} />
        <meshStandardMaterial color={BANK_PALETTE.floor} roughness={0.75} />
      </mesh>
      <mesh position={[0, BANK_WALL_H / 2, -halfD]}>
        <boxGeometry args={[BANK_W, BANK_WALL_H, BANK_WALL_T]} />
        <meshStandardMaterial color={BANK_PALETTE.wall} />
      </mesh>
      <Suspense fallback={null}>
        <BankLogoSign />
      </Suspense>
      {/* South wall — open doorway in the centre (2 u wide) so agents can enter */}
      <mesh position={[-halfW / 2 - 1, BANK_WALL_H / 2, halfD]}>
        <boxGeometry args={[BANK_W / 2 - 2, BANK_WALL_H, BANK_WALL_T]} />
        <meshStandardMaterial color={BANK_PALETTE.wall} />
      </mesh>
      <mesh position={[halfW / 2 + 1, BANK_WALL_H / 2, halfD]}>
        <boxGeometry args={[BANK_W / 2 - 2, BANK_WALL_H, BANK_WALL_T]} />
        <meshStandardMaterial color={BANK_PALETTE.wall} />
      </mesh>
      <mesh position={[-halfW, BANK_WALL_H / 2, 0]}>
        <boxGeometry args={[BANK_WALL_T, BANK_WALL_H, BANK_D]} />
        <meshStandardMaterial color={BANK_PALETTE.wall} />
      </mesh>
      <mesh position={[halfW, BANK_WALL_H / 2, 0]}>
        <boxGeometry args={[BANK_WALL_T, BANK_WALL_H, BANK_D]} />
        <meshStandardMaterial color={BANK_PALETTE.wall} />
      </mesh>
    </group>
  );
}

function BankCounterRow(): React.JSX.Element {
  const counterW = 10;
  const counterD = 1.2;
  const counterH = 1.1;
  const numStations = 3;
  const stationW = counterW / numStations;
  return (
    <group position={[0, 0, -BANK_D / 2 + 2.5]}>
      <mesh position={[0, counterH / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[counterW, counterH, counterD]} />
        <meshStandardMaterial color={BANK_PALETTE.counter} roughness={0.6} />
      </mesh>
      <mesh position={[0, counterH + 0.04, 0]} castShadow>
        <boxGeometry args={[counterW + 0.2, 0.08, counterD + 0.1]} />
        <meshStandardMaterial color={BANK_PALETTE.counterTop} roughness={0.3} />
      </mesh>
      {Array.from({ length: numStations - 1 }).map((_, i) => (
        <mesh
          key={`div-${i}`}
          position={[
            -counterW / 2 + stationW * (i + 1),
            counterH * 0.75,
            counterD / 2 + 0.1,
          ]}
          castShadow
        >
          <boxGeometry args={[0.08, counterH * 0.5, 0.02]} />
          <meshStandardMaterial color="#6b5a45" roughness={0.5} />
        </mesh>
      ))}
      {Array.from({ length: numStations }).map((_, i) => (
        <mesh
          key={`plate-${i}`}
          position={[
            -counterW / 2 + stationW * (i + 0.5),
            counterH + 0.3,
            counterD / 2 + 0.02,
          ]}
        >
          <boxGeometry args={[1.2, 0.3, 0.02]} />
          <meshStandardMaterial color="#f0ece4" roughness={0.4} />
        </mesh>
      ))}
    </group>
  );
}

// ── Helpers for loading GLBs in bank section ──────────────────────────────

function glbClone(scene: THREE.Object3D, tint: string | null): THREE.Object3D {
  const tintColor = tint ? new THREE.Color(tint) : null;
  const copy = scene.clone(true);
  copy.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const isArray = Array.isArray(mesh.material);
    const mats = isArray
      ? (mesh.material as THREE.Material[])
      : [mesh.material as THREE.Material];
    const converted = mats.map((m) => {
      const src = m as THREE.Material & {
        color?: THREE.Color;
        map?: THREE.Texture | null;
      };
      const lit = new THREE.MeshStandardMaterial({
        color: src.color ? src.color.clone() : new THREE.Color("#ffffff"),
        map: src.map ?? null,
        roughness: 0.72,
        metalness: 0.0,
        envMapIntensity: 0.85,
      });
      if (tintColor) lit.color.lerp(tintColor, 0.75);
      return lit;
    });
    mesh.material = isArray ? converted : converted[0];
  });
  return copy;
}

function BankGlbItem({
  url,
  position,
  rotation,
  scale,
  tint = null,
}: {
  url: string;
  position: [number, number, number];
  rotation?: [number, number, number];
  scale: [number, number, number];
  tint?: string | null;
}): React.JSX.Element {
  const { scene } = useGLTF(url, false, false);
  const object = useMemo(() => glbClone(scene, tint), [scene, tint]);
  return (
    <group position={position} rotation={rotation ?? [0, 0, 0]} scale={scale}>
      <primitive object={object} />
    </group>
  );
}

function BankATMs(): React.JSX.Element {
  const positions: Array<{ pos: [number, number, number]; rotY: number }> = [
    { pos: [-BANK_W / 2 + 1.2, 0, BANK_D / 2 - 2], rotY: Math.PI },
    { pos: [-BANK_W / 2 + 3.0, 0, BANK_D / 2 - 2], rotY: Math.PI },
    { pos: [BANK_W / 2 - 1.2, 0, -BANK_D / 2 + 4], rotY: 0 },
    { pos: [BANK_W / 2 - 3.0, 0, -BANK_D / 2 + 4], rotY: 0 },
  ];
  return (
    <group>
      {positions.map(({ pos, rotY }, i) => (
        <BankGlbItem
          key={`atm-${i}`}
          url={atmGlbUrl}
          position={pos}
          rotation={[0, rotY, 0]}
          scale={[4.5, 4.5, 4.5]}
          tint={null}
        />
      ))}
    </group>
  );
}

function BankDecor(): React.JSX.Element {
  return (
    <group>
      {(
        [
          [-BANK_W / 2 + 0.8, -BANK_D / 2 + 0.8],
          [BANK_W / 2 - 0.8, -BANK_D / 2 + 0.8],
          [-BANK_W / 2 + 0.8, BANK_D / 2 - 0.8],
          [BANK_W / 2 - 0.8, BANK_D / 2 - 0.8],
        ] as Array<[number, number]>
      ).map(([x, z], i) => (
        <group key={`bplant-${i}`} position={[x, 0, z]}>
          <mesh position={[0, 0.35, 0]} castShadow>
            <cylinderGeometry args={[0.2, 0.25, 0.7, 8]} />
            <meshStandardMaterial color="#ddd" roughness={0.7} />
          </mesh>
          <mesh position={[0, 1.0, 0]} castShadow>
            <sphereGeometry args={[0.45, 8, 8]} />
            <meshStandardMaterial color="#3a7c47" roughness={0.9} />
          </mesh>
        </group>
      ))}
      {/* Waiting area: sofa + two chairs */}
      <BankGlbItem
        url={sofaGlbUrl}
        position={[-BANK_W / 2 + 3.5, 0, 2.5]}
        rotation={[0, Math.PI / 2, 0]}
        scale={[1.6, 1.6, 1.6]}
        tint="#3d5575"
      />
      <BankGlbItem
        url={sofaChairGlbUrl}
        position={[-BANK_W / 2 + 1.2, 0, 1.2]}
        rotation={[0, Math.PI / 2, 0]}
        scale={[1.4, 1.4, 1.4]}
        tint="#4a5568"
      />
      <BankGlbItem
        url={sofaChairGlbUrl}
        position={[-BANK_W / 2 + 1.2, 0, 3.8]}
        rotation={[0, Math.PI / 2, 0]}
        scale={[1.4, 1.4, 1.4]}
        tint="#4a5568"
      />
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.01, 0]}
        receiveShadow
      >
        <planeGeometry args={[BANK_W * 0.5, BANK_D * 0.35]} />
        <meshStandardMaterial color="#b8a898" roughness={0.95} />
      </mesh>
    </group>
  );
}

interface BankPersonState {
  x: number;
  z: number;
  facing: number;
  walkSpeed: number;
  path: Array<[number, number]>;
  pathIndex: number;
}

function makeBankPeopleStates(count: number): BankPersonState[] {
  const people: BankPersonState[] = [];
  const waypoints: Array<[number, number]> = [
    [0, BANK_D / 2 - 3],
    [0, 0],
    [-BANK_W / 2 + 3, 0],
    [BANK_W / 2 - 3, 0],
    [-BANK_W / 2 + 3, -BANK_D / 2 + 4],
    [BANK_W / 2 - 3, -BANK_D / 2 + 4],
    [-4, -BANK_D / 2 + 3],
    [4, -BANK_D / 2 + 3],
    [0, BANK_D / 2 - 5],
    [-6, 2],
    [6, -2],
  ];
  for (let i = 0; i < count; i++) {
    const start = waypoints[i % waypoints.length];
    const next = waypoints[(i + 1) % waypoints.length];
    people.push({
      x: start[0] + (bankRng(i + 100) - 0.5) * 2,
      z: start[1] + (bankRng(i + 200) - 0.5) * 2,
      facing: Math.atan2(next[0] - start[0], next[1] - start[1]),
      walkSpeed: 0.8 + bankRng(i + 400) * 0.6,
      path: [start, next, waypoints[(i + 2) % waypoints.length]],
      pathIndex: 0,
    });
  }
  return people;
}

function BankManInstance({
  state,
  tint,
}: {
  state: BankPersonState;
  tint: string;
}): React.JSX.Element {
  const groupRef = useRef<THREE.Group>(null);
  const { scene, animations } = useGLTF(manGlbUrl);

  const { cloned, mixer, walkIdx, idleIdx, autoScale } = useMemo(() => {
    const c = SkeletonClone(scene);
    c.updateMatrixWorld(true);
    const tintColor = new THREE.Color(tint);
    c.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        child.frustumCulled = false;
        const isArr = Array.isArray(child.material);
        const mats = isArr
          ? (child.material as THREE.Material[])
          : [child.material as THREE.Material];
        const tinted = mats.map((m) => {
          const src = m as THREE.MeshStandardMaterial;
          const next = src.clone();
          if (next instanceof THREE.MeshStandardMaterial && next.color) {
            next.color.lerp(tintColor, 0.5);
          }
          return next;
        });
        child.material = isArr ? tinted : tinted[0];
      }
    });
    const bbox = new THREE.Box3().setFromObject(c);
    const size = new THREE.Vector3();
    bbox.getSize(size);
    const aScale = size.y > 0 ? 0.65 / size.y : 1;
    const m = new THREE.AnimationMixer(c);
    const names = animations.map((a) => a.name.toLowerCase());
    const wIdx = names.findIndex((n) => n.includes("walk"));
    const iIdx = names.findIndex((n) => n.includes("idle"));
    return {
      cloned: c,
      mixer: m,
      walkIdx: wIdx,
      idleIdx: iIdx,
      autoScale: aScale,
    };
  }, [scene, animations, tint]);

  useEffect(() => {
    const idx = walkIdx >= 0 ? walkIdx : idleIdx;
    if (idx >= 0 && animations[idx]) {
      mixer.clipAction(animations[idx], cloned).reset().play();
    }
    return () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(cloned);
    };
  }, [mixer, cloned, animations, walkIdx, idleIdx]);

  useFrame((_, delta) => {
    mixer.update(Math.min(delta, 1 / 30));
    if (!groupRef.current) return;
    groupRef.current.position.set(state.x, 0, state.z);
    groupRef.current.rotation.y = state.facing;
    const step = Math.min(delta, 0.05);
    const target = state.path[state.pathIndex];
    if (!target) return;
    const dx = target[0] - state.x;
    const dz = target[1] - state.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.5) {
      state.pathIndex = (state.pathIndex + 1) % state.path.length;
      return;
    }
    const move = state.walkSpeed * step;
    state.x += (dx / dist) * move;
    state.z += (dz / dist) * move;
    state.facing = Math.atan2(dx, dz);
  });

  return (
    <group ref={groupRef}>
      <primitive object={cloned} scale={autoScale * 1.45} />
    </group>
  );
}

function BankFakePeople({ count }: { count: number }): React.JSX.Element {
  const states = useRef<BankPersonState[]>(makeBankPeopleStates(count));
  return (
    <>
      {states.current.map((s, i) => (
        <BankManInstance
          key={`bfp-${i}`}
          state={s}
          tint={BANK_PALETTE.personShirt[i % BANK_PALETTE.personShirt.length]}
        />
      ))}
    </>
  );
}

/** Street / walkway connecting office south-exit to bank north-entry. */
function ConnectingStreet(): React.JSX.Element {
  const streetZ = -(WORLD_H / 2 + BANK_STREET_GAP / 2);
  const markingZ = streetZ;
  return (
    <group>
      {/* Pavement strip between the two buildings */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0, streetZ]}
        receiveShadow
      >
        <planeGeometry args={[BANK_W, BANK_STREET_GAP]} />
        <meshStandardMaterial color="#c0c5cd" roughness={0.88} />
      </mesh>
      {/* Dashed centre line */}
      {[-3, -1, 1, 3].map((i) => (
        <mesh
          key={`dash-${i}`}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[i * 2, 0.01, markingZ]}
          receiveShadow
        >
          <planeGeometry args={[1.2, 0.18]} />
          <meshStandardMaterial color="#fff" roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

/** The complete bank building placed north of the office. */
function BankSection(): React.JSX.Element {
  return (
    <group position={[0, 0, BANK_Z]}>
      <BankShell />
      <BankCounterRow />
      <Suspense fallback={null}>
        <BankATMs />
        <BankDecor />
        <BankFakePeople count={8} />
      </Suspense>
    </group>
  );
}

/** Sparse city backdrop — a few buildings north/west/east, trees south. */
function CityBackdrop(): React.JSX.Element {
  const { buildings, trees } = useMemo(() => {
    const buildings: Array<{
      x: number;
      z: number;
      w: number;
      d: number;
      h: number;
      color: string;
    }> = [];
    const trees: Array<{ x: number; z: number; h: number }> = [];

    const rng = (seed: number) => {
      const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
      return x - Math.floor(x);
    };

    const cell = 4.5;
    const rows = 14;
    const cols = 10;
    const margin = 2.5;
    const officeW = WORLD_W + margin;
    const officeH = WORLD_H + margin;
    // Also clear the bank lot
    const bankMinZ = BANK_Z - BANK_D / 2 - margin;
    const bankMaxZ = BANK_Z + BANK_D / 2 + margin;
    const bankMinX = -BANK_W / 2 - margin;
    const bankMaxX = BANK_W / 2 + margin;

    for (let ix = 0; ix < cols; ix++) {
      for (let iz = 0; iz < rows; iz++) {
        const x = (ix - cols / 2 + 0.5) * cell;
        const z = (iz - rows / 2 + 0.5) * cell;

        // Leave the office lot empty
        if (
          x > -officeW / 2 &&
          x < officeW / 2 &&
          z > -officeH / 2 &&
          z < officeH / 2
        ) {
          continue;
        }

        // Leave the bank lot empty
        if (x > bankMinX && x < bankMaxX && z > bankMinZ && z < bankMaxZ) {
          continue;
        }

        // No buildings on the south (camera-facing) side — use trees instead
        if (z > officeH / 2) {
          const seed = ix * 100 + iz;
          if (rng(seed) < 0.25) {
            trees.push({
              x: x + (rng(seed + 1) - 0.5) * cell * 0.6,
              z: z + (rng(seed + 2) - 0.5) * cell * 0.6,
              h: 1.2 + rng(seed + 3) * 1.5,
            });
          }
          continue;
        }

        const seed = ix * 100 + iz;
        if (rng(seed) < 0.35) {
          const w = cell * (0.5 + rng(seed + 1) * 0.3);
          const d = cell * (0.5 + rng(seed + 2) * 0.3);
          const h = 3 + rng(seed + 3) * 10;
          const lightness = 55 + rng(seed + 4) * 25;
          buildings.push({
            x,
            z,
            w,
            d,
            h,
            color: `hsl(210, 8%, ${lightness}%)`,
          });
        }
      }
    }
    return { buildings, trees };
  }, []);

  return (
    <group>
      {/* Street / pavement extending beyond both buildings */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.02, 0]}
        receiveShadow
      >
        <planeGeometry args={[80, 80]} />
        <meshStandardMaterial color="#b0b5bd" roughness={0.92} metalness={0} />
      </mesh>
      {buildings.map((b, i) => (
        <mesh
          key={`b-${i}`}
          position={[b.x, b.h / 2, b.z]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[b.w, b.h, b.d]} />
          <meshStandardMaterial
            color={b.color}
            roughness={0.88}
            metalness={0.04}
          />
        </mesh>
      ))}
      {trees.map((t, i) => (
        <group key={`t-${i}`} position={[t.x, 0, t.z]}>
          {/* Trunk */}
          <mesh position={[0, t.h * 0.25, 0]} castShadow>
            <cylinderGeometry args={[0.06, 0.09, t.h * 0.5, 6]} />
            <meshStandardMaterial color="#8b6f47" roughness={0.95} />
          </mesh>
          {/* Canopy */}
          <mesh position={[0, t.h * 0.65, 0]} castShadow>
            <coneGeometry args={[t.h * 0.35, t.h * 0.7, 7]} />
            <meshStandardMaterial color="#4a7c59" roughness={0.9} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** North wall — 3.6 m tall with three window openings and glass panels. */
function NorthWall({ palette }: { palette: WorldPalette }): React.JSX.Element {
  const halfW = WORLD_W / 2;
  const z = -WORLD_H / 2;
  const wallT = 0.2;
  const wallH = 3.6;
  const windowW = 5.0;
  const windowH = 1.4;
  const windowY = 2.2;
  const numWindows = 3;

  const gap = (WORLD_W - numWindows * windowW) / (numWindows + 1);
  const winBottom = windowY - windowH / 2;
  const winTop = windowY + windowH / 2;

  return (
    <group>
      {/* Bottom solid strip */}
      <mesh position={[0, winBottom / 2, z]}>
        <boxGeometry args={[WORLD_W, winBottom, wallT]} />
        <meshStandardMaterial color={palette.wallNS} />
      </mesh>
      {/* Top solid strip */}
      <mesh position={[0, winTop + (wallH - winTop) / 2, z]}>
        <boxGeometry args={[WORLD_W, wallH - winTop, wallT]} />
        <meshStandardMaterial color={palette.wallNS} />
      </mesh>
      {/* Vertical pillars between windows */}
      {Array.from({ length: numWindows + 1 }).map((_, i) => {
        const x = -halfW + gap * (i + 0.5) + windowW * i;
        return (
          <mesh key={`p-${i}`} position={[x, windowY, z]}>
            <boxGeometry args={[gap, windowH, wallT]} />
            <meshStandardMaterial color={palette.wallNS} />
          </mesh>
        );
      })}
      {/* Window glass */}
      {Array.from({ length: numWindows }).map((_, i) => {
        const x = -halfW + gap * (i + 1) + windowW * (i + 0.5);
        return (
          <mesh key={`g-${i}`} position={[x, windowY, z + wallT / 2 + 0.02]}>
            <planeGeometry args={[windowW - 0.2, windowH - 0.2]} />
            <meshStandardMaterial
              color="#c8dae8"
              roughness={0.05}
              metalness={0.4}
              envMapIntensity={1.0}
              side={THREE.DoubleSide}
            />
          </mesh>
        );
      })}
    </group>
  );
}

/** Floor, rug and perimeter walls — a clean, minimal office shell. */
function OfficeLogo(): React.JSX.Element {
  const texture = useTexture(hermesHqLogoUrl, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
  });
  // Logo aspect ratio ≈ 4.3 : 1
  const logoW = 8.0;
  const logoH = logoW / 4.3;
  const halfH = WORLD_H / 2;
  const wallT = 0.2;
  const z = halfH + wallT / 2 + 0.01;
  return (
    <mesh position={[0, 1.5, z]}>
      <planeGeometry args={[logoW, logoH]} />
      <meshStandardMaterial
        map={texture}
        roughness={0.4}
        metalness={0.0}
        envMapIntensity={2.5}
        emissiveIntensity={0.6}
        transparent
        alphaTest={0.05}
      />
    </mesh>
  );
}

function Room({ palette }: { palette: WorldPalette }): React.JSX.Element {
  const halfW = WORLD_W / 2;
  const halfH = WORLD_H / 2;
  const wallH = 2.4;
  const wallT = 0.2;
  return (
    <group>
      {/* Floor — slightly glossy so the IBL adds a soft sheen + grounding. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[WORLD_W, WORLD_H]} />
        <meshStandardMaterial
          color={palette.floor}
          roughness={0.78}
          metalness={0}
          envMapIntensity={0.6}
        />
      </mesh>
      {/* Center rug for a bit of warmth (matte). */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.01, 0]}
        receiveShadow
      >
        <planeGeometry args={[WORLD_W * 0.42, WORLD_H * 0.42]} />
        <meshStandardMaterial
          color={palette.rug}
          roughness={0.95}
          metalness={0}
          envMapIntensity={0.4}
        />
      </mesh>
      {/* North wall — taller with windows */}
      <NorthWall palette={palette} />
      {/* South / east / west walls */}
      <mesh position={[0, wallH / 2, halfH]}>
        <boxGeometry args={[WORLD_W, wallH, wallT]} />
        <meshStandardMaterial color={palette.wallNS} />
      </mesh>
      <Suspense fallback={null}>
        <OfficeLogo />
      </Suspense>
      <mesh position={[-halfW, wallH / 2, 0]}>
        <boxGeometry args={[wallT, wallH, WORLD_H]} />
        <meshStandardMaterial color={palette.wallEW} />
      </mesh>
      <mesh position={[halfW, wallH / 2, 0]}>
        <boxGeometry args={[wallT, wallH, WORLD_H]} />
        <meshStandardMaterial color={palette.wallEW} />
      </mesh>
    </group>
  );
}

/** Interior partition walls (e.g. the work-area / rest-room divider). */
function InteriorWalls({
  palette,
}: {
  palette: WorldPalette;
}): React.JSX.Element {
  const wallH = 2.4;
  return (
    <group>
      {INTERIOR_WALLS.map((wall) => {
        const [cx, , cz] = toWorld(wall.x + wall.w / 2, wall.y + wall.h / 2);
        return (
          <mesh key={wall.id} position={[cx, wallH / 2, cz]} castShadow>
            <boxGeometry args={[wall.w * SCALE, wallH, wall.h * SCALE]} />
            <meshStandardMaterial color={palette.wallEW} />
          </mesh>
        );
      })}
    </group>
  );
}

/**
 * The native, in-renderer 3D office. Replaces the old webview that pointed at a
 * separately-cloned hermes-office dev server. Each agent corresponds to a
 * desktop profile.
 */
export default function Office3D({
  agents,
  selectedId,
  onSelectAgent,
}: {
  agents: OfficeAgent[];
  selectedId: string | null;
  onSelectAgent: (id: string | null) => void;
}): React.JSX.Element {
  // Clicking the selected agent again clears the selection.
  const handleSelect = (id: string): void => {
    onSelectAgent(id === selectedId ? null : id);
  };

  // The CEO (if any) gets a separate executive desk; everyone else grids up.
  const ceoId = useMemo(
    () => agents.find((a) => a.position === "ceo")?.id ?? null,
    [agents],
  );

  // One desk per agent, assigned in profile order.
  const workstations = useMemo(
    () =>
      buildWorkstations(
        agents.map((a) => a.id),
        ceoId,
      ),
    [agents, ceoId],
  );

  const palette = DAY_PALETTE;

  return (
    <Canvas
      shadows="percentage"
      dpr={[1, 2]}
      camera={{ position: [0, 38, 48], fov: 50 }}
      gl={{
        antialias: true,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.05,
      }}
      onPointerMissed={() => onSelectAgent(null)}
      style={{ width: "100%", height: "100%" }}
    >
      <color attach="background" args={[THEME_BACKGROUND.light]} />
      {/* Soft image-based lighting baked once from in-scene Lightformers — no
          external HDRI fetch, so it stays within the renderer's strict CSP. */}
      <Environment frames={1} resolution={256} background={false}>
        <Lightformer
          form="rect"
          intensity={palette.envIntensity}
          color={palette.keyColor}
          position={[0, 20, 0]}
          rotation={[Math.PI / 2, 0, 0]}
          scale={[36, 36, 1]}
        />
        <Lightformer
          form="rect"
          intensity={palette.envIntensity * 0.6}
          color="#eaf0ff"
          position={[0, 8, 24]}
          rotation={[0, 0, 0]}
          scale={[36, 14, 1]}
        />
        <Lightformer
          form="rect"
          intensity={palette.envIntensity * 0.4}
          color="#ffffff"
          position={[-24, 9, 0]}
          rotation={[0, Math.PI / 2, 0]}
          scale={[36, 14, 1]}
        />
        <Lightformer
          form="rect"
          intensity={palette.envIntensity * 0.4}
          color="#ffffff"
          position={[24, 9, 0]}
          rotation={[0, -Math.PI / 2, 0]}
          scale={[36, 14, 1]}
        />
      </Environment>
      <hemisphereLight
        args={[palette.hemiSky, palette.hemiGround, palette.hemiIntensity]}
      />
      <ambientLight intensity={palette.ambient} />
      {/* Key light. The shadow camera is sized to the whole room (~32 world
          units across) — the default ±5 frustum only covered the centre, so
          most furniture cast no shadow before. */}
      <directionalLight
        position={[14, 36, 16]}
        intensity={palette.directional}
        color={palette.keyColor}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-camera-near={1}
        shadow-camera-far={120}
        shadow-camera-left={-36}
        shadow-camera-right={36}
        shadow-camera-top={36}
        shadow-camera-bottom={-36}
      />
      <CityBackdrop />
      <ConnectingStreet />
      <Room palette={palette} />
      <InteriorWalls palette={palette} />
      <BankSection />
      <Suspense fallback={null}>
        <Workstations workstations={workstations} />
        <FurniturePieces pieces={REST_FURNITURE} />
        {ceoId && <FurniturePieces pieces={EXECUTIVE_DECOR} />}
      </Suspense>
      <AgentsLayer
        agents={agents}
        workstations={workstations}
        selectedId={selectedId}
        onSelect={handleSelect}
      />
      <OrbitControls
        makeDefault
        enablePan
        minDistance={8}
        maxDistance={80}
        maxPolarAngle={Math.PI / 2.15}
        target={new THREE.Vector3(0, 0, BANK_Z / 2)}
      />
    </Canvas>
  );
}

useGLTF.preload(atmGlbUrl, false, false);
useGLTF.preload(sofaGlbUrl, false, false);
useGLTF.preload(sofaChairGlbUrl, false, false);
useGLTF.preload(manGlbUrl);
