// One bomb, one lifecycle: it starts in the player's hands, drops where
// its carrier falls, gets planted by holding E inside a site, and then
// ticks down to an explosion that only a WARDEN standing beside it can
// stop. The lamp blinks and the beeps quicken as the fuse runs out.
import * as THREE from 'three';
import { MATCH, TEAMS } from './state.js';
import { SITES } from './world.js';

const DEFUSE_RADIUS = 1.6;

export function createBomb(scene, audio) {
  const rig = new THREE.Group();
  // Casing, warning lamp, antenna: the look lives in a parts list, not in
  // a run of constructor calls.
  const PARTS = [
    {
      geo: () => new THREE.BoxGeometry(0.34, 0.2, 0.24),
      mat: () => new THREE.MeshStandardMaterial({ color: 0x2a2723, roughness: 0.5, metalness: 0.6 }),
      at: [0, 0.1, 0],
      shadow: true,
    },
    {
      geo: () => new THREE.SphereGeometry(0.045, 8, 8),
      mat: () => new THREE.MeshBasicMaterial({ color: 0xff3b30 }),
      at: [0.1, 0.22, 0],
      shadow: false,
    },
    {
      geo: () => new THREE.CylinderGeometry(0.008, 0.008, 0.3, 6),
      mat: () => new THREE.MeshBasicMaterial({ color: 0x888888 }),
      at: [-0.12, 0.3, 0],
      shadow: false,
    },
  ];
  const meshes = PARTS.map((part) => {
    const mesh = new THREE.Mesh(part.geo(), part.mat());
    mesh.position.set(...part.at);
    mesh.castShadow = part.shadow;
    rig.add(mesh);
    return mesh;
  });
  const bulbMat = meshes[1].material;
  rig.visible = false;
  scene.add(rig);

  let nextBeep = 0;
  let nextBlink = 0;
  let lit = true;

  function showAt(x, z) {
    rig.visible = true;
    rig.position.set(x, 0, z);
  }

  // Who could be planting right now: the player holding E, or the carrier
  // bot. Returns the planter's id and position, or null.
  function findPlanter(ctx, bomb) {
    if (bomb.carrier === 'player') {
      if (!ctx.playerAlive || !ctx.plantHeld) return null;
      return { who: 'player', x: ctx.playerPos.x, z: ctx.playerPos.z };
    }
    if (!bomb.carrier) return null;
    const carrier = ctx.bots.find((b) => b.id === bomb.carrier);
    if (!carrier || !carrier.alive) return null;
    return { who: carrier.id, x: carrier.position.x, z: carrier.position.z };
  }

  function tickCarried(dt, ctx, bomb) {
    rig.visible = false;
    const planter = findPlanter(ctx, bomb);
    const site = planter ? ctx.world.siteAt(planter.x, planter.z) : null;
    if (!site) {
      bomb.plantProgress = Math.max(0, bomb.plantProgress - dt * 2);
      return;
    }
    bomb.planter = planter.who;
    bomb.plantProgress += dt / MATCH.plantTime;
    if (bomb.plantProgress < 1) return;
    bomb.plantProgress = 0;
    bomb.state = 'planted';
    bomb.site = site;
    bomb.x = SITES[site].x;
    bomb.z = SITES[site].z;
    // Planted means grounded: the carrier no longer holds it, so dying
    // afterwards cannot drop it again.
    if (bomb.carrier && bomb.carrier !== 'player') {
      const carrier = ctx.bots.find((b) => b.id === bomb.carrier);
      if (carrier) carrier.hasBomb = false;
    }
    bomb.carrier = null;
    ctx.state.timer = MATCH.bombTime;
    showAt(bomb.x, bomb.z);
    audio.plant();
    ctx.onPlanted(site);
  }

  function tickPlanted(dt, ctx, bomb) {
    const state = ctx.state;
    showAt(bomb.x, bomb.z);
    const band = state.timer > 15 ? 2 : state.timer > 8 ? 1 : 0;
    const gap = [0.25, 0.5, 1.0][band];
    if (state.elapsed >= nextBlink) {
      lit = !lit;
      bulbMat.color.setHex(lit ? 0xff3b30 : 0x551512);
      nextBlink = state.elapsed + gap / 2;
    }
    if (state.elapsed >= nextBeep) {
      audio.beep(state.timer <= 8);
      nextBeep = state.elapsed + gap;
    }
    // Only a WARDEN can defuse, and only by staying beside the device.
    const saboteur = ctx.bots.find((bot) => {
      if (!bot.alive || bot.team !== TEAMS.WARDEN) return false;
      const dx = bot.position.x - bomb.x;
      const dz = bot.position.z - bomb.z;
      return dx * dx + dz * dz < DEFUSE_RADIUS * DEFUSE_RADIUS;
    });
    if (!saboteur) {
      bomb.defuseProgress = Math.max(0, bomb.defuseProgress - dt * 2);
      return;
    }
    bomb.defuser = saboteur.id;
    bomb.defuseProgress += dt / MATCH.defuseTime;
    if (bomb.defuseProgress < 1) return;
    bomb.defuseProgress = 0;
    bomb.state = 'defused';
    rig.visible = false;
    audio.defuse();
    ctx.onDefused();
  }

  return {
    group: rig,
    reset() {
      rig.visible = false;
      nextBeep = 0;
      nextBlink = 0;
    },
    dropAt(x, z) {
      showAt(x, z);
    },
    detonate() {
      rig.visible = false;
    },
    update(dt, ctx) {
      const bomb = ctx.state.bomb;
      if (ctx.state.phase !== 'live') return;
      if (bomb.state === 'carried') tickCarried(dt, ctx, bomb);
      else if (bomb.state === 'dropped') showAt(bomb.x, bomb.z);
      else if (bomb.state === 'planted') tickPlanted(dt, ctx, bomb);
    },
  };
}
