// Guns, in data first: one row per weapon, zipped into definitions by field
// name, so the armoury's numbers live in a table instead of four literals.
// The view models come from part lists for the same reason: a box list per gun,
// bent into a low-poly silhouette by one shared builder.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

const FIELDS = [
  'id', 'name', 'kind', 'price', 'damage', 'headMult', 'mag', 'reserve',
  'gap', 'reload', 'auto', 'spreadStill', 'spreadMove', 'recoil', 'falloff', 'zoom',
];
const ROWS = [
  ['pistol', 'P9 Sidearm', 'pistol', 0, 34, 4, 12, 48, 0.22, 1.6, false, 0.004, 0.02, 0.011, 18, 1],
  ['smg', 'VK-9 Ripper', 'smg', 1200, 26, 4, 30, 120, 0.075, 2, true, 0.006, 0.03, 0.007, 14, 1],
  ['rifle', 'AR-77 Carbine', 'rifle', 2700, 36, 4, 30, 90, 0.1, 2.2, true, 0.003, 0.026, 0.01, 24, 1.5],
  ['sniper', 'LANCE-50', 'sniper', 4500, 110, 4, 5, 15, 1.4, 3.2, false, 0.02, 0.05, 0.05, 60, 2.6],
];

export const WEAPONS = {};
for (const row of ROWS) {
  const def = {};
  FIELDS.forEach((key, i) => {
    def[key] = row[i];
  });
  WEAPONS[def.id] = def;
}
WEAPONS.sniper.adsSpread = 0.0005;
export const WEAPON_ORDER = ROWS.map((row) => row[0]);

// View-model parts: [width, height, depth, x, y, z, material] per box.
const PARTS = {
  pistol: [
    [0.07, 0.09, 0.24, 0, 0, -0.1, 'body'],
    [0.06, 0.14, 0.07, 0, -0.1, 0.04, 'grip'],
    [0.03, 0.03, 0.06, 0, 0.055, -0.16, 'dark'],
  ],
  smg: [
    [0.08, 0.1, 0.4, 0, 0, -0.12, 'body'],
    [0.05, 0.05, 0.2, 0, 0.02, -0.36, 'grip'],
    [0.06, 0.18, 0.09, 0, -0.12, -0.12, 'grip'],
    [0.07, 0.08, 0.14, 0, -0.01, 0.16, 'grip'],
  ],
  rifle: [
    [0.09, 0.1, 0.44, 0, 0, -0.1, 'body'],
    [0.045, 0.045, 0.34, 0, 0.025, -0.44, 'grip'],
    [0.075, 0.08, 0.22, 0, -0.02, 0.28, 'grip'],
    [0.06, 0.14, 0.08, 0, -0.11, -0.02, 'grip'],
    [0.04, 0.05, 0.12, 0, 0.075, -0.12, 'dark'],
  ],
  sniper: [
    [0.1, 0.11, 0.5, 0, 0, -0.12, 'dark'],
    [0.04, 0.04, 0.5, 0, 0.03, -0.56, 'body'],
    [0.05, 0.06, 0.22, 0, 0.1, -0.14, 'grip'],
    [0.08, 0.09, 0.24, 0, -0.02, 0.3, 'grip'],
    [0.06, 0.12, 0.07, 0, -0.1, 0.02, 'grip'],
  ],
};

const FLASH_SECONDS = 0.06;
const BLOOM_SHOT = 0.004;
const BLOOM_MAX = 0.03;
const BLOOM_RECOVER = 0.09;
const KICK_SHOT = 0.055;
const SWITCH_PENALTY = 0.25;

export function createWeapons(camera) {
  const mats = {
    grip: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.7, metalness: 0.2 }),
    body: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ink), roughness: 0.5, metalness: 0.35 }),
    dark: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.surface), roughness: 0.6, metalness: 0.4 }),
  };

  const models = {};
  for (const id of WEAPON_ORDER) {
    const group = new THREE.Group();
    for (const [w, h, d, x, y, z, mat] of PARTS[id]) {
      const piece = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats[mat]);
      piece.position.set(x, y, z);
      group.add(piece);
    }
    group.position.set(0.24, -0.2, -0.42);
    group.visible = false;
    camera.add(group);
    models[id] = group;
  }

  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.2, 0.2),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
  );
  flash.position.set(0.24, -0.18, -0.95);
  flash.visible = false;
  camera.add(flash);
  const flashLight = new THREE.PointLight(new THREE.Color(PALETTE.accent), 0, 6);
  flashLight.position.set(0.24, -0.16, -0.6);
  camera.add(flashLight);

  const freshSlot = (def) => ({ def, mag: def.mag, reserve: def.reserve });
  const state = {
    owned: [freshSlot(WEAPONS.pistol)],
    current: 0,
    cooldown: 0,
    reloadLeft: 0,
    reloadTotal: 0,
    flash: 0,
    kick: 0,
    bloom: 0,
    grenades: 0,
    bobTime: 0,
  };

  const slot = () => state.owned[state.current];
  const def = () => slot().def;

  function showCurrent() {
    for (const id of WEAPON_ORDER) models[id].visible = id === def().id;
    state.reloadLeft = 0;
    if (state.cooldown < SWITCH_PENALTY) state.cooldown = SWITCH_PENALTY;
  }
  showCurrent();

  function tickTimers(dt) {
    state.cooldown = Math.max(0, state.cooldown - dt);
    state.flash = Math.max(0, state.flash - dt);
    state.kick *= Math.max(0, 1 - dt * 14);
    state.bloom = Math.max(0, state.bloom - BLOOM_RECOVER * dt);
  }

  function poseModel(dt, speed, aiming) {
    const model = models[def().id];
    state.bobTime += dt * (2 + speed * 1.6);
    const stride = Math.min(1, speed / 5.2) * (aiming ? 0.15 : 1);
    const homeX = aiming ? 0 : 0.24;
    const homeY = aiming ? -0.185 : -0.2;
    const ease = Math.min(1, dt * 12);
    model.position.x += (homeX - model.position.x) * ease;
    model.position.y = homeY + Math.sin(state.bobTime * 2) * 0.006 * stride;
    model.position.z = -0.42 + state.kick + Math.cos(state.bobTime) * 0.004 * stride;
    model.rotation.x = state.kick * 2.2;
  }

  function tickReload(dt) {
    if (state.reloadLeft <= 0) return;
    state.reloadLeft = Math.max(0, state.reloadLeft - dt);
    const done = 1 - state.reloadLeft / state.reloadTotal;
    models[def().id].rotation.x = -0.55 * Math.sin(done * Math.PI);
    if (state.reloadLeft > 0) return;
    const current = slot();
    const moved = Math.min(current.def.mag - current.mag, current.reserve);
    current.mag += moved;
    current.reserve -= moved;
  }

  function step(dt, speed, aiming) {
    tickTimers(dt);
    poseModel(dt, speed, aiming);
    flash.visible = state.flash > 0;
    flash.rotation.z = state.flash * 30;
    flashLight.intensity = state.flash > 0 ? 18 : 0;
    tickReload(dt);
  }

  return {
    state,
    step,
    currentDef: def,
    currentSlot: slot,
    ready() {
      return slot().mag > 0 && state.cooldown === 0 && state.reloadLeft === 0;
    },
    pullTrigger() {
      state.cooldown = def().gap;
      state.flash = FLASH_SECONDS;
      state.kick = KICK_SHOT;
      state.bloom = Math.min(BLOOM_MAX, state.bloom + BLOOM_SHOT);
    },
    takeRound() {
      if (slot().mag <= 0) return false;
      slot().mag -= 1;
      return true;
    },
    reload() {
      const current = slot();
      if (state.reloadLeft > 0 || current.mag >= current.def.mag || current.reserve <= 0) return false;
      state.reloadLeft = current.def.reload;
      state.reloadTotal = current.def.reload;
      return true;
    },
    spread(speed, aiming, crouching, onGround) {
      const d = def();
      const pace = Math.min(1, speed / 5.2);
      let cone = d.spreadStill + pace * d.spreadMove;
      if (crouching) cone *= 0.7;
      if (!onGround) cone += 0.03;
      if (aiming) cone = d.adsSpread ?? cone * 0.45;
      return cone + state.bloom;
    },
    switchTo(index) {
      if (index < 0 || index >= state.owned.length || index === state.current) return false;
      state.current = index;
      showCurrent();
      return true;
    },
    cycle(direction) {
      if (state.owned.length < 2) return;
      const n = state.owned.length;
      state.current = (((state.current + direction) % n) + n) % n;
      showCurrent();
    },
    owns(id) {
      return state.owned.some((entry) => entry.def.id === id);
    },
    buy(id) {
      const held = state.owned.find((entry) => entry.def.id === id);
      if (held) {
        held.mag = held.def.mag;
        held.reserve = held.def.reserve;
        return true;
      }
      state.owned.push(freshSlot(WEAPONS[id]));
      state.current = state.owned.length - 1;
      showCurrent();
      return true;
    },
    refillAmmo() {
      for (const entry of state.owned) {
        entry.mag = entry.def.mag;
        entry.reserve = entry.def.reserve;
      }
    },
    dropToPistol() {
      const sidearm = state.owned.find((entry) => entry.def.id === 'pistol');
      state.owned = [sidearm ?? freshSlot(WEAPONS.pistol)];
      state.current = 0;
      state.grenades = 0;
      showCurrent();
    },
    resetRound(kept) {
      state.owned =
        kept && kept.length > 0
          ? kept.map((entry) => ({ def: entry.def, mag: entry.mag, reserve: entry.reserve }))
          : [freshSlot(WEAPONS.pistol)];
      state.current = state.owned.length - 1;
      state.cooldown = 0;
      state.reloadLeft = 0;
      state.flash = 0;
      state.kick = 0;
      state.bloom = 0;
      showCurrent();
    },
    snapshotLoadout() {
      return state.owned.map((entry) => ({ def: entry.def, mag: entry.mag, reserve: entry.reserve }));
    },
  };
}
