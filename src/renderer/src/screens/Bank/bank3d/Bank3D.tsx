import { Suspense, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Environment, Lightformer } from "@react-three/drei";
import * as THREE from "three";

const ROOM_W = 22;
const ROOM_H = 18;
const WALL_H = 3.2;
const WALL_T = 0.25;

const PALETTE = {
  floor: "#d4c8b8",
  wall: "#e8e0d4",
  counter: "#8b7355",
  counterTop: "#f5f0e8",
  atm: "#2d5a8a",
  atmScreen: "#1a3a5c",
  personShirt: ["#c44", "#44c", "#4a4", "#a4a", "#c84", "#488"],
  personPants: "#334",
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function rng(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/* ── Room shell ─────────────────────────────────────────────────────────── */

function BankRoom(): React.JSX.Element {
  const halfW = ROOM_W / 2;
  const halfH = ROOM_H / 2;
  return (
    <group>
      {/* Floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[ROOM_W, ROOM_H]} />
        <meshStandardMaterial color={PALETTE.floor} roughness={0.75} />
      </mesh>
      {/* Walls */}
      <mesh position={[0, WALL_H / 2, -halfH]}>
        <boxGeometry args={[ROOM_W, WALL_H, WALL_T]} />
        <meshStandardMaterial color={PALETTE.wall} />
      </mesh>
      <mesh position={[0, WALL_H / 2, halfH]}>
        <boxGeometry args={[ROOM_W, WALL_H, WALL_T]} />
        <meshStandardMaterial color={PALETTE.wall} />
      </mesh>
      <mesh position={[-halfW, WALL_H / 2, 0]}>
        <boxGeometry args={[WALL_T, WALL_H, ROOM_H]} />
        <meshStandardMaterial color={PALETTE.wall} />
      </mesh>
      <mesh position={[halfW, WALL_H / 2, 0]}>
        <boxGeometry args={[WALL_T, WALL_H, ROOM_H]} />
        <meshStandardMaterial color={PALETTE.wall} />
      </mesh>
    </group>
  );
}

/* ── Counter row ──────────────────────────────────────────────────────────── */

function CounterRow(): React.JSX.Element {
  const counterW = 10;
  const counterD = 1.2;
  const counterH = 1.1;
  const numStations = 3;
  const stationW = counterW / numStations;

  return (
    <group position={[0, 0, -ROOM_H / 2 + 2.5]}>
      {/* Main counter body */}
      <mesh position={[0, counterH / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[counterW, counterH, counterD]} />
        <meshStandardMaterial color={PALETTE.counter} roughness={0.6} />
      </mesh>
      {/* Counter top */}
      <mesh position={[0, counterH + 0.04, 0]} castShadow>
        <boxGeometry args={[counterW + 0.2, 0.08, counterD + 0.1]} />
        <meshStandardMaterial color={PALETTE.counterTop} roughness={0.3} />
      </mesh>
      {/* Divider panels between stations */}
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
      {/* Teller nameplates */}
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

/* ── ATM machines ─────────────────────────────────────────────────────────── */

function ATMMachines(): React.JSX.Element {
  const atmW = 1.4;
  const atmD = 0.8;
  const atmH = 2.4;
  const positions = [
    [-ROOM_W / 2 + 1.2, 0, ROOM_H / 2 - 2],
    [-ROOM_W / 2 + 3.0, 0, ROOM_H / 2 - 2],
    [ROOM_W / 2 - 1.2, 0, -ROOM_H / 2 + 4],
    [ROOM_W / 2 - 3.0, 0, -ROOM_H / 2 + 4],
  ];

  return (
    <group>
      {positions.map((pos, i) => (
        <group key={`atm-${i}`} position={pos}>
          {/* ATM body */}
          <mesh position={[0, atmH / 2, 0]} castShadow receiveShadow>
            <boxGeometry args={[atmW, atmH, atmD]} />
            <meshStandardMaterial
              color={PALETTE.atm}
              roughness={0.4}
              metalness={0.3}
            />
          </mesh>
          {/* Screen */}
          <mesh position={[0, atmH * 0.55, atmD / 2 + 0.01]}>
            <planeGeometry args={[atmW * 0.6, atmH * 0.2]} />
            <meshStandardMaterial
              color={PALETTE.atmScreen}
              roughness={0.1}
              metalness={0.5}
              emissive="#3a7fcf"
              emissiveIntensity={0.3}
            />
          </mesh>
          {/* Keypad */}
          <mesh position={[0, atmH * 0.22, atmD / 2 + 0.01]}>
            <planeGeometry args={[atmW * 0.35, atmH * 0.12]} />
            <meshStandardMaterial color="#1a1a1a" roughness={0.3} />
          </mesh>
          {/* Card slot */}
          <mesh position={[atmW * 0.25, atmH * 0.38, atmD / 2 + 0.01]}>
            <boxGeometry args={[0.35, 0.04, 0.02]} />
            <meshStandardMaterial color="#111" roughness={0.2} />
          </mesh>
          {/* Cash dispenser */}
          <mesh position={[0, atmH * 0.08, atmD / 2 + 0.01]}>
            <boxGeometry args={[atmW * 0.4, 0.06, 0.02]} />
            <meshStandardMaterial color="#111" roughness={0.2} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/* ── Fake people ──────────────────────────────────────────────────────────── */

interface FakePerson {
  x: number;
  z: number;
  facing: number;
  shirtColor: string;
  height: number;
  walkSpeed: number;
  path: Array<[number, number]>;
  pathIndex: number;
}

function makeFakePeople(count: number): FakePerson[] {
  const people: FakePerson[] = [];
  const waypoints: Array<[number, number]> = [
    [0, ROOM_H / 2 - 3],
    [0, 0],
    [-ROOM_W / 2 + 3, 0],
    [ROOM_W / 2 - 3, 0],
    [-ROOM_W / 2 + 3, -ROOM_H / 2 + 4],
    [ROOM_W / 2 - 3, -ROOM_H / 2 + 4],
    [-4, -ROOM_H / 2 + 3],
    [4, -ROOM_H / 2 + 3],
    [0, ROOM_H / 2 - 5],
    [-6, 2],
    [6, -2],
  ];

  for (let i = 0; i < count; i++) {
    const start = waypoints[i % waypoints.length];
    const next = waypoints[(i + 1) % waypoints.length];
    const color = PALETTE.personShirt[i % PALETTE.personShirt.length];
    people.push({
      x: start[0] + (rng(i + 100) - 0.5) * 2,
      z: start[1] + (rng(i + 200) - 0.5) * 2,
      facing: Math.atan2(next[0] - start[0], next[1] - start[1]),
      shirtColor: color,
      height: 1.6 + rng(i + 300) * 0.25,
      walkSpeed: 0.8 + rng(i + 400) * 0.6,
      path: [start, next, waypoints[(i + 2) % waypoints.length]],
      pathIndex: 0,
    });
  }
  return people;
}

function FakePeople({ count }: { count: number }): React.JSX.Element {
  const peopleRef = useRef<FakePerson[]>(makeFakePeople(count));

  useFrame((_, delta) => {
    const step = Math.min(delta, 0.05);
    for (const p of peopleRef.current) {
      const target = p.path[p.pathIndex];
      if (!target) continue;
      const dx = target[0] - p.x;
      const dz = target[1] - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.5) {
        p.pathIndex = (p.pathIndex + 1) % p.path.length;
        continue;
      }
      const move = p.walkSpeed * step;
      p.x += (dx / dist) * move;
      p.z += (dz / dist) * move;
      p.facing = Math.atan2(dx, dz);
    }
  });

  return (
    <>
      {peopleRef.current.map((p, i) => (
        <group
          key={`fp-${i}`}
          position={[p.x, 0, p.z]}
          rotation={[0, p.facing, 0]}
        >
          {/* Legs / pants */}
          <mesh position={[0, p.height * 0.25, 0]} castShadow>
            <boxGeometry args={[0.35, p.height * 0.5, 0.25]} />
            <meshStandardMaterial color={PALETTE.personPants} roughness={0.9} />
          </mesh>
          {/* Torso / shirt */}
          <mesh position={[0, p.height * 0.6, 0]} castShadow>
            <boxGeometry args={[0.4, p.height * 0.3, 0.28]} />
            <meshStandardMaterial color={p.shirtColor} roughness={0.85} />
          </mesh>
          {/* Head */}
          <mesh position={[0, p.height * 0.85, 0]} castShadow>
            <sphereGeometry args={[0.18, 8, 8]} />
            <meshStandardMaterial color="#dcb" roughness={0.8} />
          </mesh>
        </group>
      ))}
    </>
  );
}

/* ── Decor ────────────────────────────────────────────────────────────────── */

function Decor(): React.JSX.Element {
  return (
    <group>
      {/* Potted plants in corners */}
      {[
        [-ROOM_W / 2 + 0.8, -ROOM_H / 2 + 0.8],
        [ROOM_W / 2 - 0.8, -ROOM_H / 2 + 0.8],
        [-ROOM_W / 2 + 0.8, ROOM_H / 2 - 0.8],
        [ROOM_W / 2 - 0.8, ROOM_H / 2 - 0.8],
      ].map(([x, z], i) => (
        <group key={`plant-${i}`} position={[x, 0, z]}>
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
      {/* Waiting bench */}
      <group position={[-ROOM_W / 2 + 1.5, 0, 3]}>
        <mesh position={[0, 0.45, 0]} castShadow receiveShadow>
          <boxGeometry args={[2.5, 0.08, 0.7]} />
          <meshStandardMaterial color="#6b5a45" roughness={0.6} />
        </mesh>
        <mesh position={[-1.0, 0.22, 0]} castShadow>
          <boxGeometry args={[0.1, 0.45, 0.6]} />
          <meshStandardMaterial color="#5a4a35" roughness={0.6} />
        </mesh>
        <mesh position={[1.0, 0.22, 0]} castShadow>
          <boxGeometry args={[0.1, 0.45, 0.6]} />
          <meshStandardMaterial color="#5a4a35" roughness={0.6} />
        </mesh>
      </group>
      {/* Coffee table near bench */}
      <group position={[-ROOM_W / 2 + 1.5, 0, 5]}>
        <mesh position={[0, 0.4, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[0.4, 0.4, 0.05, 12]} />
          <meshStandardMaterial color="#888" roughness={0.3} metalness={0.4} />
        </mesh>
        <mesh position={[0, 0.2, 0]} castShadow>
          <cylinderGeometry args={[0.06, 0.08, 0.4, 8]} />
          <meshStandardMaterial color="#666" roughness={0.3} metalness={0.5} />
        </mesh>
      </group>
      {/* Rug in centre */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.01, 0]}
        receiveShadow
      >
        <planeGeometry args={[ROOM_W * 0.5, ROOM_H * 0.35]} />
        <meshStandardMaterial color="#b8a898" roughness={0.95} />
      </mesh>
      {/* Ceiling lights */}
      {[-5, 0, 5].map((x) =>
        [-4, 0, 4].map((z) => (
          <mesh key={`light-${x}-${z}`} position={[x, WALL_H - 0.05, z]}>
            <boxGeometry args={[1.8, 0.06, 1.2]} />
            <meshStandardMaterial
              color="#fffaf0"
              emissive="#fffaf0"
              emissiveIntensity={0.6}
            />
          </mesh>
        )),
      )}
    </group>
  );
}

/* ── Bank 3D scene ────────────────────────────────────────────────────────── */

export default function Bank3D(): React.JSX.Element {
  return (
    <Canvas
      shadows="percentage"
      dpr={[1, 2]}
      camera={{ position: [0, 18, 22], fov: 50 }}
      gl={{
        antialias: true,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.05,
      }}
      style={{ width: "100%", height: "100%" }}
    >
      <color attach="background" args={["#f3f1ec"]} />
      <Environment frames={1} resolution={256} background={false}>
        <Lightformer
          form="rect"
          intensity={0.8}
          color="#fff4e2"
          position={[0, 18, 0]}
          rotation={[Math.PI / 2, 0, 0]}
          scale={[32, 32, 1]}
        />
        <Lightformer
          form="rect"
          intensity={0.5}
          color="#eaf0ff"
          position={[0, 6, 20]}
          rotation={[0, 0, 0]}
          scale={[32, 12, 1]}
        />
      </Environment>
      <hemisphereLight args={["#ffffff", "#b9b4a8", 0.45]} />
      <ambientLight intensity={0.25} />
      <directionalLight
        position={[12, 22, 14]}
        intensity={2.0}
        color="#fff4e2"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-camera-near={1}
        shadow-camera-far={60}
        shadow-camera-left={-16}
        shadow-camera-right={16}
        shadow-camera-top={16}
        shadow-camera-bottom={-16}
      />
      <Suspense fallback={null}>
        <BankRoom />
        <CounterRow />
        <ATMMachines />
        <Decor />
        <FakePeople count={8} />
      </Suspense>
      <OrbitControls
        makeDefault
        enablePan
        minDistance={6}
        maxDistance={40}
        maxPolarAngle={Math.PI / 2.1}
        target={new THREE.Vector3(0, 0, 0)}
      />
    </Canvas>
  );
}
