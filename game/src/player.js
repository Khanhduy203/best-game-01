// How the player moves: a capsule approximated by a box, pushed around by
// acceleration and friction, pulled down by gravity, and stopped by the
// world's colliders one axis at a time. Health sits here too, with armour
// soaking half of every hit until it is spent.
import * as THREE from 'three';

const BODY_R = 0.34;
const H_TALL = 1.72;
const H_LOW = 1.12;
const EYE_TALL = 1.6;
const EYE_LOW = 1.02;
const V_RUN = 5.2;
const V_SNEAK = 2.4;
const V_AIM = 3.2;
const A_FLOOR = 42;
const A_SKY = 9;
const DRAG = 9;
const PULL = 20;
const V_HOP = 6.2;
const PITCH_MAX = 1.45;
const LOOK_GAIN = 0.0022;

export function createPlayer(colliders) {
  const self = {
    position: new THREE.Vector3(0, 0, 21),
    velocity: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    eye: EYE_TALL,
    onGround: true,
    crouching: false,
    height: H_TALL,
    health: 100,
    armour: 0,
    alive: true,
  };
  const box = new THREE.Box3();
  const wish = new THREE.Vector3();

  const damp = (from, to, rate, dt) => from + (to - from) * Math.min(1, rate * dt);

  // The box is shrunk by `inset` top and bottom, so the floor underfoot and
  // the ceiling overhead never register as a wall in the way.
  function collidesAt(px, py, pz, h, inset) {
    box.min.set(px - BODY_R, py + inset, pz - BODY_R);
    box.max.set(px + BODY_R, py + h - inset, pz + BODY_R);
    for (const wall of colliders) {
      if (box.intersectsBox(wall)) return wall;
    }
    return null;
  }

  function turn(dx, dy, gain = LOOK_GAIN) {
    self.yaw -= dx * gain;
    self.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, self.pitch - dy * gain));
  }

  function kick(up, sideways) {
    self.pitch = Math.min(PITCH_MAX, self.pitch + up);
    self.yaw += sideways;
  }

  function updateCrouch(keys) {
    const wantLow = keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC');
    if (wantLow === self.crouching) return;
    if (wantLow) {
      self.crouching = true;
      self.height = H_LOW;
      return;
    }
    // Standing back up needs headroom; without it the player stays crouched.
    if (!collidesAt(self.position.x, self.position.y, self.position.z, H_TALL, 0.02)) {
      self.crouching = false;
      self.height = H_TALL;
    }
  }

  function wishDir(keys) {
    const fwd = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const side = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    wish.set(0, 0, 0);
    if (fwd === 0 && side === 0) return false;
    const sin = Math.sin(self.yaw);
    const cos = Math.cos(self.yaw);
    // Facing is -Z at yaw 0; the right hand is +X.
    wish.set(-sin * fwd + cos * side, 0, -cos * fwd - sin * side).normalize();
    return true;
  }

  function tick(dt, keys, aiming) {
    if (!self.alive) return;
    updateCrouch(keys);
    self.eye = damp(self.eye, self.crouching ? EYE_LOW : EYE_TALL, 12, dt);

    const moving = wishDir(keys);
    let top = self.crouching ? V_SNEAK : V_RUN;
    if (aiming && !self.crouching) top = V_AIM;
    const accel = self.onGround ? A_FLOOR : A_SKY;
    const blend = Math.min(1, (accel * dt) / top);
    self.velocity.x += (wish.x * top - self.velocity.x) * blend;
    self.velocity.z += (wish.z * top - self.velocity.z) * blend;
    if (self.onGround && !moving) {
      const kept = Math.max(0, 1 - DRAG * dt);
      self.velocity.x *= kept;
      self.velocity.z *= kept;
    }

    if (keys.has('Space') && self.onGround) {
      self.velocity.y = V_HOP;
      self.onGround = false;
    }
    self.velocity.y -= PULL * dt;

    const nx = self.position.x + self.velocity.x * dt;
    if (!collidesAt(nx, self.position.y, self.position.z, self.height, 0.04)) self.position.x = nx;
    else self.velocity.x = 0;
    const nz = self.position.z + self.velocity.z * dt;
    if (!collidesAt(self.position.x, self.position.y, nz, self.height, 0.04)) self.position.z = nz;
    else self.velocity.z = 0;

    self.position.y += self.velocity.y * dt;
    self.onGround = false;
    const under = collidesAt(self.position.x, self.position.y, self.position.z, self.height, 0);
    if (under && self.velocity.y <= 0) {
      self.position.y = under.max.y;
      self.velocity.y = 0;
      self.onGround = true;
    } else if (under) {
      self.position.y = under.min.y - self.height;
      self.velocity.y = 0;
    }
    if (self.position.y < 0) {
      self.position.y = 0;
      self.velocity.y = 0;
      self.onGround = true;
    }
    if (self.velocity.y < -30) self.velocity.y = -30;
  }

  // Armour takes half the hit (rounded up) and spends that many of its own
  // points; whatever is left comes off health.
  function hurt(amount) {
    if (!self.alive) return 0;
    const soaked = self.armour > 0 ? Math.min(self.armour, Math.ceil(amount / 2)) : 0;
    self.armour -= soaked;
    const taken = amount - soaked;
    self.health = Math.max(0, self.health - taken);
    if (self.health <= 0) self.alive = false;
    return taken;
  }

  function spawn(x, z, yaw) {
    self.position.set(x, 0, z);
    self.velocity.set(0, 0, 0);
    self.yaw = yaw;
    self.pitch = 0;
    self.eye = EYE_TALL;
    self.height = H_TALL;
    self.crouching = false;
    self.onGround = true;
    self.health = 100;
    self.alive = true;
    // A fresh round starts unarmoured; the economy hands armour back only to
    // a player who survived the previous round.
    self.armour = 0;
  }

  function speed() {
    return Math.hypot(self.velocity.x, self.velocity.z);
  }

  return {
    state: self,
    step: tick,
    look: turn,
    recoil: kick,
    damage: hurt,
    reset: spawn,
    groundSpeed: speed,
  };
}
