// The bots: two STRIKE teammates, three WARDEN defenders. Each one runs a
// small brain — a priority list of rules that picks its mode four times a
// second — over a nav-graph walk, with a cone of vision, ears for gunfire, and
// a burst-fire gunfight once it sees an enemy. The rules read top to bottom:
// the first one that claims the bot decides what it does next.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { TEAMS } from './state.js';
import { SITES, SPAWNS, HOLD_NODES } from './world.js';

const WALK = 4.3;
const STRAFE = 2.3;
const EYE = 1.5;
const CHEST = 1.15;
const SIGHT = 46;
const CONE = 1.05;
const HEARING = 26;
const BOT_DAMAGE = 24;
const SHOT_GAP = 0.13;

const NAMES = {
  strike: ['JUNO', 'REYES'],
  warden: ['KOVAC', 'MIRA', 'DRAKE'],
};

// Body parts: [shape, size args, material key, x, y, z, flat?].
const BODY = [
  ['box', [0.16, 0.55, 0.2], 'dark', -0.12, 0.28, 0, false],
  ['box', [0.16, 0.55, 0.2], 'dark', 0.12, 0.28, 0, false],
  ['box', [0.52, 0.62, 0.3], 'team', 0, 0.86, 0, false],
  ['sphere', [0.15, 14, 10], 'skin', 0, 1.42, 0, false],
  ['box', [0.34, 0.12, 0.34], 'dark', 0, 1.52, 0, false],
  ['box', [0.07, 0.1, 0.6], 'dark', 0.14, 1.02, -0.32, false],
];

function buildMesh(scene, team) {
  const paint = team === TEAMS.STRIKE ? PALETTE.strike : PALETTE.warden;
  const mats = {
    team: new THREE.MeshStandardMaterial({ color: new THREE.Color(paint), roughness: 0.6, metalness: 0.1 }),
    dark: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.85 }),
    skin: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ink), roughness: 0.7 }),
  };
  const group = new THREE.Group();
  const parts = [];
  for (const [shape, args, mat, x, y, z] of BODY) {
    const geo = shape === 'sphere' ? new THREE.SphereGeometry(...args) : new THREE.BoxGeometry(...args);
    const mesh = new THREE.Mesh(geo, mats[mat]);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    parts.push(mesh);
  }
  const ring = new THREE.Mesh(
    new THREE.CircleGeometry(0.46, 24),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(paint), transparent: true, opacity: 0.4, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  group.add(ring);
  scene.add(group);
  return { group, legL: parts[0], legR: parts[1], torso: parts[2], head: parts[3] };
}

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function createBots(scene, world, random) {
  const list = [];
  const hitMeshes = [];
  const plan = { site: 'A' };

  function makeBot(id, name, team, spawnIndex) {
    const mesh = buildMesh(scene, team);
    const bot = {
      id,
      name,
      team,
      spawnIndex,
      group: mesh.group,
      legL: mesh.legL,
      legR: mesh.legR,
      torso: mesh.torso,
      head: mesh.head,
      position: mesh.group.position,
      yaw: team === TEAMS.STRIKE ? 0 : Math.PI,
      health: 100,
      alive: true,
      fall: 0,
      mode: 'spawn',
      path: [],
      pathIndex: 0,
      holdNode: -1,
      holdYaw: 0,
      target: null,
      targetDesc: { kind: null, bot: null },
      targetPos: new THREE.Vector3(),
      reaction: 0,
      burstLeft: 0,
      nextShotAt: 0,
      burstPauseUntil: 0,
      strafeDir: 1,
      strafeUntil: 0,
      strafeAnchor: null,
      perceiveAt: random() * 0.1,
      modeAt: random() * 0.25,
      walkPhase: random() * 6,
      moving: false,
      investigate: null,
      stuckSince: 0,
      lastX: 0,
      lastZ: 0,
      unstickUntil: 0,
      unstickDir: 1,
      hasBomb: false,
      scanPhase: random() * 6,
    };
    mesh.torso.userData.bot = bot;
    mesh.torso.userData.part = 'torso';
    mesh.head.userData.bot = bot;
    mesh.head.userData.part = 'head';
    hitMeshes.push(mesh.torso, mesh.head);
    list.push(bot);
    return bot;
  }

  for (let i = 0; i < 2; i += 1) makeBot(`s${i}`, NAMES.strike[i], TEAMS.STRIKE, i + 1);
  for (let i = 0; i < 3; i += 1) makeBot(`w${i}`, NAMES.warden[i], TEAMS.WARDEN, i);

  function aliveCount(team) {
    return list.reduce((n, bot) => n + (bot.team === team && bot.alive ? 1 : 0), 0);
  }

  function route(bot, fromX, fromZ, toNode, viaNode = -1) {
    const from = world.nearestNode(fromX, fromZ);
    const direct = viaNode < 0 || viaNode === from || viaNode === toNode;
    const nodes = direct
      ? world.findPath(from, toNode)
      : world.findPath(from, viaNode).concat(world.findPath(viaNode, toNode).slice(1));
    bot.path = nodes.map((index) => world.nodes[index]);
    bot.pathIndex = 0;
  }

  function pathDone(bot) {
    return bot.path.length === 0 || bot.pathIndex >= bot.path.length;
  }

  function resetRound() {
    plan.site = random() < 0.55 ? 'A' : 'B';
    const siteNode = SITES[plan.site].node;
    const holds = [HOLD_NODES.A, HOLD_NODES.B, HOLD_NODES.MID];
    for (const bot of list) {
      const spawn = SPAWNS[bot.team === TEAMS.STRIKE ? 'strike' : 'warden'][bot.spawnIndex];
      bot.position.set(spawn[0], 0, spawn[1]);
      bot.group.rotation.set(0, 0, 0);
      bot.yaw = bot.team === TEAMS.STRIKE ? 0 : Math.PI;
      bot.group.rotation.y = bot.yaw;
      bot.health = 100;
      bot.alive = true;
      bot.fall = 0;
      bot.mode = 'spawn';
      bot.path = [];
      bot.pathIndex = 0;
      bot.target = null;
      bot.reaction = 0;
      bot.burstLeft = 0;
      bot.investigate = null;
      bot.hasBomb = false;
      bot.moving = false;
      bot.group.visible = true;
      if (bot.team === TEAMS.STRIKE) {
        const via = bot.id === 's0' ? (plan.site === 'A' ? 3 : 5) : 11;
        route(bot, spawn[0], spawn[1], siteNode, via);
        bot.mode = 'move';
      } else {
        bot.holdNode = holds[bot.spawnIndex];
        bot.holdYaw = Math.PI + (bot.spawnIndex === 0 ? 0.5 : bot.spawnIndex === 1 ? -0.5 : 0);
        route(bot, spawn[0], spawn[1], bot.holdNode);
        bot.mode = 'move';
      }
    }
  }

  // Vision: range, then the cone, then line of sight. Returns the distance
  // when the point is seen, 0 when it is not.
  function seeFrom(bot, x, y, z) {
    const dx = x - bot.position.x;
    const dy = y - (bot.position.y + EYE);
    const dz = z - bot.position.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > SIGHT) return 0;
    const bearing = Math.atan2(-dx, -dz);
    if (Math.abs(wrapAngle(bearing - bot.yaw)) > CONE) return 0;
    if (world.losBlocked(bot.position.x, bot.position.y + EYE, bot.position.z, x, y, z)) return 0;
    return dist;
  }

  function perceive(bot, ctx) {
    const seen = [];
    if (ctx.playerAlive) {
      const p = ctx.playerPos;
      const d = seeFrom(bot, p.x, p.y + (ctx.playerCrouching ? 0.7 : CHEST), p.z);
      if (d > 0) seen.push({ kind: 'player', bot: null, dist: d, at: p });
    }
    for (const other of list) {
      if (other === bot || !other.alive || other.team === bot.team) continue;
      const d = seeFrom(bot, other.position.x, other.position.y + CHEST, other.position.z);
      if (d > 0) seen.push({ kind: 'bot', bot: other, dist: d, at: other.position });
    }
    let nearest = null;
    for (const entry of seen) {
      if (!nearest || entry.dist < nearest.dist) nearest = entry;
    }
    if (nearest) {
      const changed = !bot.target || bot.target.kind !== nearest.kind || bot.target.bot !== nearest.bot;
      if (changed) bot.reaction = 0.35 + random() * 0.3;
      bot.targetDesc.kind = nearest.kind;
      bot.targetDesc.bot = nearest.bot;
      bot.target = bot.targetDesc;
      bot.targetPos.set(nearest.at.x, nearest.at.y, nearest.at.z);
      if (nearest.kind === 'bot') ctx.state.spotted.set(nearest.bot.id, ctx.elapsed);
      bot.investigate = null;
      return;
    }
    if (bot.target) {
      bot.target = null;
      bot.investigate = { x: bot.targetPos.x, z: bot.targetPos.z };
      return;
    }
    if (bot.investigate) return;
    for (const shot of ctx.state.shotsHeard) {
      if (shot.team === bot.team || ctx.elapsed - shot.at > 1.5) continue;
      const dx = shot.x - bot.position.x;
      const dz = shot.z - bot.position.z;
      if (dx * dx + dz * dz < HEARING * HEARING) {
        bot.investigate = { x: shot.x, z: shot.z };
        break;
      }
    }
  }

  // The brain: rules in priority order. Each rule returns true when it claims
  // the bot for this tick; the first claim wins. Rules that only set up a
  // later rule (taking the bomb) return false to fall through.
  const RULES = [
    {
      name: 'fight',
      run(bot) {
        if (!bot.target) return false;
        if (bot.mode !== 'engage') bot.strafeAnchor = { x: bot.position.x, z: bot.position.z };
        bot.mode = 'engage';
        return true;
      },
    },
    {
      name: 'planted',
      run(bot, ctx) {
        const bomb = ctx.state.bomb;
        if (bomb.state !== 'planted') return false;
        if (bot.team === TEAMS.WARDEN) {
          const near = Math.hypot(bomb.x - bot.position.x, bomb.z - bot.position.z) < 1.6;
          bot.mode = near ? 'defuse' : 'retake';
          if (!near && pathDone(bot)) route(bot, bot.position.x, bot.position.z, SITES[bomb.site].node);
        } else {
          if (pathDone(bot)) route(bot, bot.position.x, bot.position.z, SITES[bomb.site].node);
          bot.mode = 'move';
        }
        return true;
      },
    },
    {
      name: 'dropped',
      run(bot, ctx) {
        const bomb = ctx.state.bomb;
        if (bomb.state !== 'dropped' || bot.team !== TEAMS.STRIKE) return false;
        const near = Math.hypot(bomb.x - bot.position.x, bomb.z - bot.position.z) < 1.4;
        if (!near) {
          bot.mode = 'pickup';
          if (pathDone(bot)) route(bot, bot.position.x, bot.position.z, world.nearestNode(bomb.x, bomb.z));
          return true;
        }
        bot.hasBomb = true;
        bomb.state = 'carried';
        bomb.carrier = bot.id;
        ctx.onBombPickup(bot);
        return false;
      },
    },
    {
      name: 'carry',
      run(bot) {
        if (!bot.hasBomb) return false;
        if (world.isInSite(bot.position.x, bot.position.z, plan.site)) {
          bot.mode = 'plant';
        } else {
          bot.mode = 'move';
          if (pathDone(bot)) route(bot, bot.position.x, bot.position.z, SITES[plan.site].node);
        }
        return true;
      },
    },
    {
      name: 'defend',
      run(bot) {
        if (bot.team !== TEAMS.WARDEN) return false;
        if (bot.mode === 'move' && pathDone(bot)) {
          bot.mode = 'hold';
          bot.yaw = bot.holdYaw;
        } else if (bot.mode === 'hold' && bot.investigate) {
          route(bot, bot.position.x, bot.position.z, world.nearestNode(bot.investigate.x, bot.investigate.z));
          bot.mode = 'move';
        } else if (bot.mode === 'move' && bot.investigate && pathDone(bot)) {
          bot.investigate = null;
          route(bot, bot.position.x, bot.position.z, bot.holdNode);
        }
        return true;
      },
    },
    {
      name: 'push',
      run(bot) {
        if (bot.mode === 'move' && pathDone(bot)) {
          bot.mode = 'hold';
          bot.holdYaw = 0;
        } else if (bot.mode === 'hold' && bot.investigate) {
          route(bot, bot.position.x, bot.position.z, world.nearestNode(bot.investigate.x, bot.investigate.z));
          bot.mode = 'move';
        } else if (bot.mode === 'move' && bot.investigate && pathDone(bot)) {
          bot.investigate = null;
          route(bot, bot.position.x, bot.position.z, SITES[plan.site].node);
        }
        return true;
      },
    },
  ];

  function decide(bot, ctx) {
    if (!bot.target) bot.strafeAnchor = null;
    for (const rule of RULES) {
      if (rule.run(bot, ctx)) return;
    }
  }

  function turnTo(bot, x, z, dt, rate = 6) {
    const want = Math.atan2(-(x - bot.position.x), -(z - bot.position.z));
    const diff = wrapAngle(want - bot.yaw);
    const step = Math.max(-rate * dt, Math.min(rate * dt, diff));
    bot.yaw += step;
  }

  function walkPath(bot, dt, speed, now) {
    if (bot.pathIndex >= bot.path.length) {
      bot.moving = false;
      return;
    }
    const [wx, wz] = bot.path[bot.pathIndex];
    const dx = wx - bot.position.x;
    const dz = wz - bot.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.7) {
      bot.pathIndex += 1;
      return;
    }
    let mx = dx / dist;
    let mz = dz / dist;
    if (now < bot.unstickUntil) {
      const px = -mz * bot.unstickDir;
      const pz = mx * bot.unstickDir;
      mx = (mx + px) * 0.7071;
      mz = (mz + pz) * 0.7071;
    }
    bot.position.x += mx * speed * dt;
    bot.position.z += mz * speed * dt;
    turnTo(bot, wx, wz, dt, 8);
    bot.moving = true;
    const moved = Math.hypot(bot.position.x - bot.lastX, bot.position.z - bot.lastZ);
    if (moved < 0.05) {
      if (bot.stuckSince === 0) {
        bot.stuckSince = now;
      } else if (now - bot.stuckSince > 1.2) {
        bot.unstickUntil = now + 0.7;
        bot.unstickDir = random() < 0.5 ? -1 : 1;
        bot.stuckSince = 0;
        if (random() < 0.4) bot.pathIndex += 1;
      }
    } else {
      bot.stuckSince = 0;
    }
    bot.lastX = bot.position.x;
    bot.lastZ = bot.position.z;
  }

  function fight(bot, dt, ctx) {
    turnTo(bot, bot.targetPos.x, bot.targetPos.z, dt, 7);
    if (ctx.elapsed >= bot.strafeUntil) {
      bot.strafeDir = random() < 0.5 ? -1 : 1;
      bot.strafeUntil = ctx.elapsed + 0.5 + random() * 0.5;
    }
    const dx = bot.targetPos.x - bot.position.x;
    const dz = bot.targetPos.z - bot.position.z;
    const len = Math.hypot(dx, dz) || 1;
    if (bot.strafeAnchor) {
      const ax = bot.position.x - bot.strafeAnchor.x;
      const az = bot.position.z - bot.strafeAnchor.z;
      if (ax * ax + az * az > 4.8) {
        const px = (-dz / len) * bot.strafeDir;
        const pz = (dx / len) * bot.strafeDir;
        if (px * ax + pz * az > 0) bot.strafeDir *= -1;
      }
    }
    const px = (-dz / len) * bot.strafeDir;
    const pz = (dx / len) * bot.strafeDir;
    const nx = bot.position.x + px * STRAFE * dt;
    const nz = bot.position.z + pz * STRAFE * dt;
    if (!world.losBlocked(bot.position.x, 0.5, bot.position.z, nx, 0.5, nz)) {
      bot.position.x = nx;
      bot.position.z = nz;
    }
    bot.moving = true;
    bot.reaction = Math.max(0, bot.reaction - dt);
    if (bot.reaction !== 0 || ctx.elapsed < bot.burstPauseUntil) return;
    if (bot.burstLeft === 0) bot.burstLeft = 3 + Math.floor(random() * 3);
    if (ctx.elapsed < bot.nextShotAt) return;
    bot.nextShotAt = ctx.elapsed + SHOT_GAP;
    bot.burstLeft -= 1;
    if (bot.burstLeft === 0) bot.burstPauseUntil = ctx.elapsed + 0.45 + random() * 0.4;
    ctx.shootBot(bot, bot.target);
  }

  const STEER = {
    engage: (bot, dt, ctx) => fight(bot, dt, ctx),
    move: (bot, dt, ctx) => walkPath(bot, dt, WALK, ctx.elapsed),
    retake: (bot, dt, ctx) => walkPath(bot, dt, WALK, ctx.elapsed),
    pickup: (bot, dt, ctx) => walkPath(bot, dt, WALK, ctx.elapsed),
    hold: (bot, dt) => {
      bot.scanPhase += dt * 0.5;
      bot.yaw = bot.holdYaw + Math.sin(bot.scanPhase) * 0.7;
    },
  };

  function update(dt, ctx) {
    for (const bot of list) {
      if (!bot.alive) {
        if (bot.fall < 1) {
          bot.fall = Math.min(1, bot.fall + dt / 0.4);
          bot.group.rotation.x = -bot.fall * 1.5;
          bot.group.position.y = -bot.fall * 0.12;
        }
        continue;
      }
      bot.moving = false;
      if (ctx.elapsed >= bot.perceiveAt) {
        perceive(bot, ctx);
        bot.perceiveAt = ctx.elapsed + 0.1;
      }
      if (ctx.elapsed >= bot.modeAt) {
        decide(bot, ctx);
        bot.modeAt = ctx.elapsed + 0.25;
      }
      if (ctx.freeze) {
        bot.group.rotation.y = bot.yaw;
        continue;
      }
      const steer = bot.mode === 'engage' ? (bot.target ? STEER.engage : null) : STEER[bot.mode];
      if (steer) steer(bot, dt, ctx);
      if (bot.moving) {
        bot.walkPhase += dt * 9;
        bot.legL.rotation.x = Math.sin(bot.walkPhase) * 0.55;
        bot.legR.rotation.x = -Math.sin(bot.walkPhase) * 0.55;
      } else {
        bot.legL.rotation.x *= 0.8;
        bot.legR.rotation.x *= 0.8;
      }
      bot.group.rotation.y = bot.yaw;
    }
  }

  function damage(bot, amount) {
    if (!bot.alive) return false;
    bot.health -= amount;
    if (bot.health > 0) return false;
    bot.alive = false;
    bot.fall = 0;
    bot.target = null;
    bot.mode = 'dead';
    return true;
  }

  function alert(bot, x, z) {
    if (!bot.alive) return;
    if (!bot.target) bot.investigate = { x, z };
  }

  return {
    list,
    hitMeshes,
    resetRound,
    update,
    damage,
    alert,
    aliveCount,
  };
}

export { BOT_DAMAGE };
