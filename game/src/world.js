// Depot 9 as data: every wall, container, crate and barrel is a row in a table,
// and one builder turns the tables into meshes, colliders and minimap marks.
// The nav graph is a flat coordinate list plus an edge string, parsed at load.
// Same yard, same sightlines — the geometry is identical, only the telling is new.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

// Nav nodes, flattened [x0, z0, x1, z1, ...]; edges as "a-b" pairs.
const NODE_XY = [
  0, 21, -8, 16, 8, 16, -20, 14, 0, 12, 20, 14, -22, 6, -5, 8, 5, 8, 22, 6,
  -24, -2, 0, 0, 24, -2, -22, -6, -8, -4, 8, -4, 22, -6, -24, -14, 0, -12,
  24, -14, -16, -19, 0, -20, 16, -19, -8, -16, 8, -16,
];
const EDGE_TEXT =
  '0-1,0-2,0-4,1-3,1-4,2-4,2-5,3-6,4-7,4-8,5-9,6-10,7-11,8-11,9-12,10-13,' +
  '11-14,11-15,12-16,13-17,14-13,14-18,15-16,15-18,17-20,17-23,18-23,18-24,' +
  '19-22,19-24,20-23,21-23,21-24,22-24';

const NODES = [];
for (let i = 0; i < NODE_XY.length; i += 2) NODES.push([NODE_XY[i], NODE_XY[i + 1]]);
const ADJACENT = NODES.map(() => []);
for (const pair of EDGE_TEXT.split(',')) {
  const [a, b] = pair.split('-').map(Number);
  ADJACENT[a].push(b);
  ADJACENT[b].push(a);
}

export const SITES = {
  A: { x: -24, z: -14, r: 5.5, node: 17 },
  B: { x: 24, z: -14, r: 5.5, node: 19 },
};

export const SPAWNS = {
  strike: [[0, 21], [-3, 21], [3, 21]],
  warden: [[0, -20], [-4, -20], [4, -20]],
};

export const HOLD_NODES = { A: 20, B: 22, MID: 18 };

// Plain boxes: [width, height, depth, x, y, z, material, collide, onMinimap].
const BOXES = [
  [64.4, 0.4, 48.4, 0, -0.2, 0, 'sand', true, false],
  [12, 0.1, 10, -24, 0.03, -14, 'surface', true, false],
  [12, 0.1, 10, 24, 0.03, -14, 'surface', true, false],
  [0.6, 5, 48.4, -32.2, 2.5, 0, 'surface', true, true],
  [0.6, 5, 48.4, 32.2, 2.5, 0, 'surface', true, true],
  [64.4, 5, 0.6, 0, 2.5, -24.2, 'surface', true, true],
  [64.4, 5, 0.6, 0, 2.5, 24.2, 'surface', true, true],
  [0.6, 4, 6, -13, 2, 1, 'surface', true, true],
  [0.6, 4, 6, -13, 2, -9, 'surface', true, true],
  [0.6, 4, 6, 13, 2, 1, 'surface', true, true],
  [0.6, 4, 6, 13, 2, -9, 'surface', true, true],
  [4, 0.5, 2.5, 0, 0.25, 3, 'surface', true, true],
];

// Containers: [x, z, alongZ, colour]. Each is 6 x 2.6 x 2.4 m, long side along
// x unless alongZ, standing on the sand.
const CONTAINERS = [
  [-25, 8, 0, 'containerA'], [-26, -2, 1, 'containerB'], [-18, -8, 0, 'containerC'],
  [25, 8, 0, 'containerB'], [26, -2, 1, 'containerA'], [18, -8, 0, 'containerD'],
  [-20, 18, 0, 'containerD'], [20, 18, 0, 'containerA'], [-11, -9, 1, 'containerC'],
  [11, -9, 1, 'containerB'], [-27, -13, 1, 'containerA'], [-20, -21, 0, 'containerD'],
  [27, -13, 1, 'containerB'], [20, -21, 0, 'containerC'], [0, 8, 0, 'containerB'],
  [6, -22, 0, 'containerD'], [0, -16, 0, 'containerA'],
];
// Second-storey boxes over two site containers: [x, z, colour].
const STACKS = [
  [-27, -13, 'containerC'],
  [27, -13, 'containerA'],
];

// Crates: [x, z, size]; size 1.1 unless given.
const CRATES = [
  [-28, 14], [-16, 16], [-14, 2], [-28, -6], [-20, -11],
  [28, 14], [16, 16], [14, 2], [28, -6], [20, -11],
  [-2, 16], [2, 16], [-9, 0], [9, 0], [0, -4],
  [-24, -19], [24, -19], [-12, -20], [12, -20],
  [-30, -16, 1.6], [30, -16, 1.6],
];

const BARRELS = [
  [-10, 18], [-9, 18.9], [10, 18], [9.2, 18.8],
  [-30, 4], [-29, 4.8], [30, 4], [29.1, 4.9],
];

const LAMPS = [[-10, 12], [10, 12]];
const TOWER_LEGS = [[-2, -22.5], [2, -22.5], [-2, -20.5], [2, -20.5]];

export function createWorld(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const materials = {};
  for (const [name, hex] of Object.entries(PALETTE)) {
    const sheen = name === 'accent' || name === 'ink' ? 0.55 : 0.92;
    materials[name] = new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: sheen, metalness: 0.04 });
  }
  const steel = new THREE.MeshStandardMaterial({ color: 0x2a2723, roughness: 0.6, metalness: 0.5 });

  const colliders = [];
  const shootables = [];
  const minimapWalls = [];

  function place(width, height, depth, x, y, z, material, collide = true, onMap = true) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), materials[material]);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (!collide) return mesh;
    colliders.push(new THREE.Box3().setFromObject(mesh));
    shootables.push(mesh);
    if (onMap) minimapWalls.push([x, z, width, depth]);
    return mesh;
  }

  for (const [w, h, d, x, y, z, mat, collide, onMap] of BOXES) place(w, h, d, x, y, z, mat, collide, onMap);
  for (const [x, z, alongZ, colour] of CONTAINERS) {
    place(alongZ ? 2.4 : 6, 2.6, alongZ ? 6 : 2.4, x, 1.3, z, colour);
  }
  for (const [x, z, colour] of STACKS) place(2.4, 2.6, 6, x, 3.9, z, colour);
  for (const [x, z, size = 1.1] of CRATES) place(size, size, size, x, size / 2, z, 'hairline');
  for (const [x, z] of BARRELS) {
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 1.1, 12), steel);
    drum.position.set(x, 0.55, z);
    drum.castShadow = true;
    drum.receiveShadow = true;
    group.add(drum);
    colliders.push(new THREE.Box3().setFromObject(drum));
    shootables.push(drum);
  }

  for (const [lx, lz] of TOWER_LEGS) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 4.4, 0.3), steel);
    leg.position.set(lx, 2.2, lz);
    leg.castShadow = true;
    group.add(leg);
  }
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(5, 2, 3), materials.surface);
  cabin.position.set(0, 5.4, -21.5);
  cabin.castShadow = true;
  group.add(cabin);

  function paintSite(letter, x, z) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, 256, 256);
    g.strokeStyle = PALETTE.accent;
    g.lineWidth = 10;
    g.strokeRect(14, 14, 228, 228);
    g.fillStyle = PALETTE.accent;
    g.font = 'bold 150px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(letter, 128, 138);
    const decal = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 6),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false }),
    );
    decal.rotation.x = -Math.PI / 2;
    decal.position.set(x, 0.1, z);
    group.add(decal);
  }
  paintSite('A', SITES.A.x, SITES.A.z);
  paintSite('B', SITES.B.x, SITES.B.z);

  const sky = new THREE.HemisphereLight(new THREE.Color(PALETTE.sky), new THREE.Color(PALETTE.sand), 0.85);
  scene.add(sky);
  const sun = new THREE.DirectionalLight(new THREE.Color(PALETTE.sun), 2.4);
  sun.position.set(-26, 18, 12);
  sun.target.position.set(4, 0, -6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -38, right: 38, top: 30, bottom: -30, far: 90 });
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(new THREE.Color(PALETTE.sky), 0.5);
  fill.position.set(18, 12, -14);
  scene.add(fill);
  for (const [lx, lz] of LAMPS) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 5.4, 8), steel);
    pole.position.set(lx, 2.7, lz);
    pole.castShadow = true;
    group.add(pole);
    colliders.push(new THREE.Box3(new THREE.Vector3(lx - 0.2, 0, lz - 0.2), new THREE.Vector3(lx + 0.2, 5.4, lz + 0.2)));
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 10, 8),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.sun) }),
    );
    bulb.position.set(lx, 5.5, lz);
    group.add(bulb);
    const glow = new THREE.PointLight(new THREE.Color(PALETTE.sun), 14, 16, 1.8);
    glow.position.set(lx, 5.3, lz);
    scene.add(glow);
  }

  // Segment vs box: intersect the per-axis t-windows and require the overlap
  // to touch [0, 1]. One axis with no window means no hit.
  function segmentTouches(ax, ay, az, bx, by, bz, box3) {
    let low = 0;
    let high = 1;
    const runs = [
      [ax, bx - ax, box3.min.x, box3.max.x],
      [ay, by - ay, box3.min.y, box3.max.y],
      [az, bz - az, box3.min.z, box3.max.z],
    ];
    for (const [start, span, min, max] of runs) {
      if (Math.abs(span) < 1e-9) {
        if (start < min || start > max) return false;
        continue;
      }
      const near = (min - start) / span;
      const far = (max - start) / span;
      const enter = Math.min(near, far);
      const exit = Math.max(near, far);
      if (enter > low) low = enter;
      if (exit < high) high = exit;
      if (low > high) return false;
    }
    return true;
  }

  function losBlocked(ax, ay, az, bx, by, bz) {
    for (const collider of colliders) {
      if (segmentTouches(ax, ay, az, bx, by, bz, collider)) return true;
    }
    return false;
  }

  function nearestNode(x, z) {
    let best = 0;
    let bestSq = Infinity;
    NODES.forEach(([nx, nz], i) => {
      const sq = (nx - x) * (nx - x) + (nz - z) * (nz - z);
      if (sq < bestSq) {
        bestSq = sq;
        best = i;
      }
    });
    return best;
  }

  // Dijkstra over the 25 nodes. The open node with the smallest distance wins
  // each round; ties go to the lowest index, scanned in order.
  function findPath(fromIndex, toIndex) {
    if (fromIndex === toIndex) return [fromIndex];
    const dist = new Array(NODES.length).fill(Infinity);
    const prev = new Array(NODES.length).fill(-1);
    const settled = new Set();
    dist[fromIndex] = 0;
    for (;;) {
      let current = -1;
      for (let i = 0; i < NODES.length; i += 1) {
        if (settled.has(i)) continue;
        if (current === -1 || dist[i] < dist[current]) current = i;
      }
      if (current === -1 || dist[current] === Infinity || current === toIndex) break;
      settled.add(current);
      for (const next of ADJACENT[current]) {
        if (settled.has(next)) continue;
        const step = Math.hypot(NODES[next][0] - NODES[current][0], NODES[next][1] - NODES[current][1]);
        if (dist[current] + step < dist[next]) {
          dist[next] = dist[current] + step;
          prev[next] = current;
        }
      }
    }
    if (prev[toIndex] === -1) return [toIndex];
    const path = [];
    for (let node = toIndex; node !== -1; node = prev[node]) path.unshift(node);
    return path;
  }

  function isInSite(x, z, site) {
    const s = SITES[site];
    return Math.abs(x - s.x) <= s.r && Math.abs(z - s.z) <= s.r;
  }

  function siteAt(x, z) {
    for (const key of ['A', 'B']) {
      if (isInSite(x, z, key)) return key;
    }
    return null;
  }

  return {
    colliders,
    shootables,
    minimapWalls,
    losBlocked,
    nearestNode,
    findPath,
    isInSite,
    siteAt,
    nodes: NODES,
    group,
  };
}
