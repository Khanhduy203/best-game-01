// Everything a shot does once it leaves a barrel: the player's raycast, the
// bots' geometric aim, the grenade's arc and blast, and the feedback — tracers
// and impact sparks — that sells each hit. Tracers and sparks share one pool
// factory: a fixed ring of objects, reused forever, so the frame loop never
// allocates mid-fight.
import * as THREE from 'three';
import { BOT_DAMAGE } from './bots.js';

const FUSE = 2.2;
const BLAST_RADIUS = 6.5;
const BLAST_MAX = 130;
const TRACER_SECONDS = 0.09;
const TRACER_COUNT = 24;
const SPARK_COUNT = 48;
const GRAVITY = 20;
const GRENADE_UP = 2.5;

function damageAtRange(base, distance, fullUntil) {
  if (distance <= fullUntil) return base;
  const past = Math.min(1, (distance - fullUntil) / fullUntil);
  return base * (1 - 0.5 * past);
}

// One axis of the slab test: the interval of t where the ray is inside the
// slab, or null when it never enters. The caller intersects the three.
function axisSpan(origin, delta, lo, hi) {
  if (Math.abs(delta) < 1e-9) return origin >= lo && origin <= hi ? [0, Infinity] : null;
  const a = (lo - origin) / delta;
  const b = (hi - origin) / delta;
  return a < b ? [a, b] : [b, a];
}

// Ray against an axis-aligned box: the entry distance, or -1 on a miss.
function rayHitsBox(origin, dir, min, max) {
  let enter = 0;
  let exit = Infinity;
  const axes = [
    [origin.x, dir.x, min.x, max.x],
    [origin.y, dir.y, min.y, max.y],
    [origin.z, dir.z, min.z, max.z],
  ];
  for (const [o, d, lo, hi] of axes) {
    const span = axisSpan(o, d, lo, hi);
    if (!span) return -1;
    if (span[0] > enter) enter = span[0];
    if (span[1] < exit) exit = span[1];
    if (enter > exit) return -1;
  }
  return enter;
}

// A ring pool: `take()` hands out the next object forever, `sweep()` visits
// each live one once per frame.
function makePool(count, build) {
  const items = [];
  for (let i = 0; i < count; i += 1) items.push(build());
  let cursor = 0;
  return {
    take() {
      const item = items[cursor];
      cursor = (cursor + 1) % count;
      return item;
    },
    sweep(fn) {
      for (const item of items) fn(item);
    },
    all: items,
  };
}

export function createCombat(scene, world, random, audio) {
  const caster = new THREE.Raycaster();
  caster.far = 120;
  const scratch = {
    eye: new THREE.Vector3(),
    dir: new THREE.Vector3(),
    end: new THREE.Vector3(),
    next: new THREE.Vector3(),
    lo: new THREE.Vector3(),
    hi: new THREE.Vector3(),
  };

  const tracerMats = {
    ours: new THREE.LineBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.9 }),
    theirs: new THREE.LineBasicMaterial({ color: 0xff9a5c, transparent: true, opacity: 0.9 }),
  };
  const tracers = makePool(TRACER_COUNT, () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const line = new THREE.Line(geometry, tracerMats.ours);
    line.visible = false;
    line.frustumCulled = false;
    scene.add(line);
    return { line, life: 0 };
  });

  function drawTracer(from, to, hostile) {
    const tracer = tracers.take();
    const points = tracer.line.geometry.attributes.position;
    points.setXYZ(0, from.x, from.y, from.z);
    points.setXYZ(1, to.x, to.y, to.z);
    points.needsUpdate = true;
    tracer.line.material = hostile ? tracerMats.theirs : tracerMats.ours;
    tracer.line.visible = true;
    tracer.life = TRACER_SECONDS;
  }

  const sparkGeo = new THREE.BoxGeometry(0.07, 0.07, 0.07);
  const sparkMats = {
    spark: new THREE.MeshBasicMaterial({ color: 0xffc46b }),
    dust: new THREE.MeshBasicMaterial({ color: 0xc8a86a }),
    ember: new THREE.MeshBasicMaterial({ color: 0xff6a2e }),
  };
  const sparks = makePool(SPARK_COUNT, () => {
    const mesh = new THREE.Mesh(sparkGeo, sparkMats.spark);
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, velocity: new THREE.Vector3(), life: 0, span: 1 };
  });

  function burst(point, count, kind, speed, seconds, lift = 2) {
    for (let i = 0; i < count; i += 1) {
      const spark = sparks.take();
      spark.mesh.material = sparkMats[kind];
      spark.mesh.visible = true;
      spark.mesh.position.copy(point);
      spark.velocity.set((random() - 0.5) * speed, random() * lift, (random() - 0.5) * speed);
      spark.life = seconds * (0.6 + random() * 0.7);
      spark.span = spark.life;
      spark.mesh.scale.setScalar(1);
    }
  }

  const blastLight = new THREE.PointLight(0xff8a3c, 0, 18, 1.6);
  scene.add(blastLight);
  let blastLightLeft = 0;

  function flashBlast(point, power, seconds) {
    blastLight.position.set(point.x, point.y + 0.5, point.z);
    blastLight.intensity = power;
    blastLightLeft = seconds;
  }

  function explosion(point) {
    flashBlast(point, 90, 0.6);
    burst(point, 26, 'ember', 9, 0.9, 6);
    burst(point, 14, 'dust', 5, 1.4, 4);
  }

  const live = [];
  const shellGeo = new THREE.SphereGeometry(0.09, 10, 8);
  const shellMat = new THREE.MeshStandardMaterial({ color: 0x2a2723, roughness: 0.5, metalness: 0.6 });

  function throwGrenade(from, dir, owner, speed = 13) {
    const mesh = new THREE.Mesh(shellGeo, shellMat);
    mesh.castShadow = true;
    mesh.position.copy(from);
    scene.add(mesh);
    live.push({
      mesh,
      position: mesh.position,
      velocity: new THREE.Vector3(dir.x * speed, dir.y * speed + GRENADE_UP, dir.z * speed),
      fuse: FUSE,
      owner,
      team: owner === 'player' ? 0 : owner.team,
      alive: true,
    });
    audio.grenadeThrow();
  }

  function detonate(g, ctx) {
    g.alive = false;
    scene.remove(g.mesh);
    const p = g.position;
    flashBlast(p, 60, 0.35);
    burst(p, 22, 'ember', 7, 0.7, 5);
    burst(p, 10, 'dust', 4, 1.1, 3);
    const flat = Math.hypot(p.x - ctx.playerPos.x, p.z - ctx.playerPos.z);
    audio.explosion(flat);
    ctx.onExplosion(p, flat);
    const hurt = (x, y, z, team, target) => {
      if (team === g.team && target !== g.owner) return;
      const dx = x - p.x;
      const dy = y - p.y;
      const dz = z - p.z;
      const range = Math.hypot(dx, dy, dz);
      if (range > BLAST_RADIUS) return;
      if (world.losBlocked(p.x, p.y, p.z, x, y, z)) return;
      const amount = Math.round(BLAST_MAX * (1 - (range / BLAST_RADIUS) * 0.85));
      ctx.damageTarget(target, amount, 'blast', g.owner);
    };
    if (ctx.playerAlive) hurt(ctx.playerPos.x, ctx.playerPos.y + 1, ctx.playerPos.z, 0, 'player');
    for (const bot of ctx.bots) {
      if (bot.alive) hurt(bot.position.x, bot.position.y + 1, bot.position.z, bot.team, bot);
    }
  }

  // One bounce step: slide the grenade, reflect off the shallowest wall it
  // entered, settle on the floor. Returns nothing; mutates g and next.
  function bounceStep(g, next) {
    const r = 0.09;
    for (const box of world.colliders) {
      const inside =
        next.x > box.min.x - r && next.x < box.max.x + r &&
        next.y > box.min.y - r && next.y < box.max.y + r &&
        next.z > box.min.z - r && next.z < box.max.z + r;
      if (!inside) continue;
      const depth = [
        Math.min(next.x - (box.min.x - r), box.max.x + r - next.x),
        Math.min(next.y - (box.min.y - r), box.max.y + r - next.y),
        Math.min(next.z - (box.min.z - r), box.max.z + r - next.z),
      ];
      if (depth[1] <= depth[0] && depth[1] <= depth[2]) {
        const rolling = Math.abs(g.velocity.y) < 1.2;
        g.velocity.y = rolling ? 0 : -g.velocity.y * 0.4;
        g.velocity.x *= 0.7;
        g.velocity.z *= 0.7;
        if (rolling) next.y = box.max.y + r;
      } else if (depth[0] <= depth[2]) {
        g.velocity.x = -g.velocity.x * 0.45;
      } else {
        g.velocity.z = -g.velocity.z * 0.45;
      }
      return true;
    }
    return false;
  }

  function stepGrenades(dt, ctx) {
    for (let i = live.length - 1; i >= 0; i -= 1) {
      const g = live[i];
      if (!g.alive) {
        live.splice(i, 1);
        continue;
      }
      g.fuse -= dt;
      g.velocity.y -= GRAVITY * dt;
      const next = scratch.next.copy(g.position).addScaledVector(g.velocity, dt);
      const hitWall = bounceStep(g, next);
      if (!hitWall && next.y < 0.09) {
        next.y = 0.09;
        const rolling = Math.abs(g.velocity.y) < 1.2;
        g.velocity.y = rolling ? 0 : -g.velocity.y * 0.4;
        g.velocity.x *= 0.7;
        g.velocity.z *= 0.7;
      }
      g.position.copy(next);
      g.mesh.rotation.x += dt * 9;
      if (g.fuse <= 0) detonate(g, ctx);
    }
  }

  function playerShoot(origin, dir, def, shootables) {
    caster.set(origin, dir);
    const hits = caster.intersectObjects(shootables, false);
    let struck = null;
    for (const candidate of hits) {
      const bot = candidate.object.userData.bot;
      if (bot && !bot.alive) continue;
      struck = candidate;
      break;
    }
    if (!struck) {
      const far = scratch.end.copy(origin).addScaledVector(dir, 60);
      drawTracer(origin, far, false);
      return null;
    }
    drawTracer(origin, struck.point, false);
    const bot = struck.object.userData.bot;
    if (bot && bot.alive) {
      const part = struck.object.userData.part;
      const scaled = damageAtRange(def.damage, struck.distance, def.falloff);
      const amount = Math.round(scaled * (part === 'head' ? def.headMult : 1));
      burst(struck.point, 5, 'spark', 3, 0.4);
      return { bot, part, amount, distance: struck.distance };
    }
    burst(struck.point, 4, 'dust', 2.5, 0.5);
    return { wall: true, distance: struck.distance };
  }

  // Body zones, standing or crouched: [bottom, top, half-width, half-depth, part].
  function zonesFor(kind, crouching) {
    if (crouching) {
      return [
        [0.95, 1.18, 0.16, 0.16, 'head'],
        [0.35, 0.95, 0.26, 0.18, 'torso'],
      ];
    }
    const torsoTop = kind === 'player' ? 1.35 : 1.17;
    return [
      [1.27, 1.57, 0.16, 0.16, 'head'],
      [0.55, torsoTop, 0.26, 0.18, 'torso'],
    ];
  }

  function botShoot(bot, target, ctx) {
    const eye = scratch.eye.set(bot.position.x, bot.position.y + 1.5, bot.position.z);
    let aimX;
    let aimY;
    let aimZ;
    let targetSpeed;
    let crouching = false;
    if (target.kind === 'player') {
      crouching = ctx.playerCrouching;
      aimX = ctx.playerPos.x;
      aimY = ctx.playerPos.y + (crouching ? 0.7 : 1.15);
      aimZ = ctx.playerPos.z;
      targetSpeed = ctx.playerSpeed;
    } else {
      aimX = target.bot.position.x;
      aimY = target.bot.position.y + 1.15;
      aimZ = target.bot.position.z;
      targetSpeed = target.bot.moving ? 4.3 : 0;
    }
    const range = Math.hypot(aimX - eye.x, aimY - eye.y, aimZ - eye.z);
    const error = 0.22 + range * 0.014 + targetSpeed * 0.07;
    aimX += (random() - 0.5) * 2 * error;
    aimY += (random() - 0.5) * 2 * error * 0.7;
    aimZ += (random() - 0.5) * 2 * error;
    const dir = scratch.dir.set(aimX - eye.x, aimY - eye.y, aimZ - eye.z).normalize();
    if (world.losBlocked(eye.x, eye.y, eye.z, aimX, aimY, aimZ)) {
      const short = scratch.end.copy(eye).addScaledVector(dir, Math.min(range, 40));
      drawTracer(eye, short, true);
      return null;
    }
    const px = target.kind === 'player' ? ctx.playerPos.x : target.bot.position.x;
    const py = target.kind === 'player' ? ctx.playerPos.y : target.bot.position.y;
    const pz = target.kind === 'player' ? ctx.playerPos.z : target.bot.position.z;
    let part = null;
    let hitDist = Infinity;
    for (const [bottom, top, halfW, halfD, zone] of zonesFor(target.kind, crouching)) {
      scratch.lo.set(px - halfW, py + bottom, pz - halfD);
      scratch.hi.set(px + halfW, py + top, pz + halfD);
      const t = rayHitsBox(eye, dir, scratch.lo, scratch.hi);
      if (t >= 0 && t < hitDist) {
        part = zone;
        hitDist = t;
      }
    }
    const end = scratch.end.copy(eye).addScaledVector(dir, part ? hitDist : Math.min(range + 8, 60));
    drawTracer(eye, end, true);
    if (!part) return null;
    const amount = Math.round(damageAtRange(BOT_DAMAGE, hitDist, 25) * (part === 'head' ? 2 : 1));
    return { part, amount, distance: hitDist, target };
  }

  function update(dt, ctx) {
    stepGrenades(dt, ctx);
    tracers.sweep((tracer) => {
      if (tracer.life <= 0) return;
      tracer.life -= dt;
      if (tracer.life <= 0) tracer.line.visible = false;
    });
    sparks.sweep((spark) => {
      if (spark.life <= 0) return;
      spark.life -= dt;
      if (spark.life <= 0) {
        spark.mesh.visible = false;
        return;
      }
      spark.velocity.y -= 9 * dt;
      spark.mesh.position.addScaledVector(spark.velocity, dt);
      spark.mesh.scale.setScalar(Math.max(0.2, spark.life / spark.span));
    });
    if (blastLightLeft > 0) {
      blastLightLeft -= dt;
      blastLight.intensity = Math.max(0, blastLight.intensity - dt * 220);
    }
  }

  function reset() {
    for (const g of live) scene.remove(g.mesh);
    live.length = 0;
    tracers.sweep((tracer) => {
      tracer.line.visible = false;
      tracer.life = 0;
    });
    sparks.sweep((spark) => {
      spark.mesh.visible = false;
      spark.life = 0;
    });
    blastLight.intensity = 0;
    blastLightLeft = 0;
  }

  return {
    playerShoot,
    botShoot,
    throwGrenade,
    explosion,
    update,
    reset,
    activeGrenades() {
      return live.length;
    },
  };
}
