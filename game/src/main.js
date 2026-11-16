// Wiring and the single loop: a fixed 60 Hz simulation under a render that
// follows the display. This file owns the match flow — rounds, the buy
// shop, the trigger, the pause — while every system lives in its own
// module. ?shot=start|play|buy|end with &seed=N stages one frozen frame
// for a capture: it renders twice, then sets window.__shotReady.
import * as THREE from 'three';
import { PALETTE as COLORS } from './palette.js';
import { mulberry32 as seeded } from './rng.js';
import {
  MATCH, TEAM_NAME, TEAMS, announce, createState, feed, resetMatch, resetRound,
} from './state.js';
import { SITES, SPAWNS, createWorld } from './world.js';
import { createInput } from './input.js';
import { createPlayer } from './player.js';
import { createWeapons } from './weapons.js';
import { createBots } from './bots.js';
import { createCombat } from './combat.js';
import { createBomb } from './bomb.js';
import { SHOP, createEconomy } from './economy.js';
import { createAudio } from './audio.js';
import { createHud } from './hud.js';

const STEP = 1 / 60;
const FOV = 74;
const query = new URLSearchParams(window.location.search);
const staged = query.get('shot');
const seedNo = Number.parseInt(query.get('seed') || '1', 10) || 1;
const entropy = staged ? seedNo : (Date.now() % 2147483647) || 1;
const random = seeded(entropy);

const gl = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
gl.setSize(window.innerWidth, window.innerHeight);
Object.assign(gl.shadowMap, { enabled: true, type: THREE.PCFShadowMap });
document.getElementById('game').appendChild(gl.domElement);

const stage = new THREE.Scene();
const sky = new THREE.Color(COLORS.sky);
stage.background = sky;
stage.fog = new THREE.Fog(COLORS.canvas, 30, 85);
const aspect = () => window.innerWidth / window.innerHeight;
const cam = new THREE.PerspectiveCamera(FOV, aspect(), 0.05, 160);
stage.add(cam);

const match = createState();
const yard = createWorld(stage);
const sfx = createAudio();
const you = createPlayer(yard.colliders);
const guns = createWeapons(cam);
const squad = createBots(stage, yard, random);
const fire = createCombat(stage, yard, random, sfx);
const device = createBomb(stage, sfx);
const shop = createEconomy(match, guns, you);
const targets = yard.shootables.concat(squad.hitMeshes);
const hero = you.state;

let shopOpen = false;
let held = false;
let iced = false;
let begun = false;
let wasFiring = false;
let shakeT = 0;
let shakeM = 0;
let mapClock = 0;
let seenAnnounce = 0;
let seenFeed = 0;
let bank = 0;
let prevNow = performance.now();

const ray = new THREE.Vector3();
const focus = new THREE.Vector3();
const look = { x: 0, y: 0 };
// The teammate strip only rebuilds when a health or alive flag moves; the
// last-seen values live in two small arrays.
const mates = squad.list.filter((b) => b.team === TEAMS.STRIKE);
const hpSeen = [-1, -1, -1];
const aliveSeen = [false, false, false];
let shopKey = '';

function playPressed() {
  sfx.unlock();
  sfx.click();
  if (match.phase === 'menu' || match.phase === 'matchEnd') beginMatch();
  else ctl.requestLock();
}

function buyPressed(id) {
  const outcome = shop.buy(id);
  if (outcome.ok) sfx.buy();
  else sfx.denied();
  ui.setBuyNote(outcome.reason);
  paintShop();
  paintHud();
}

function deployPressed() {
  sfx.unlock();
  sfx.click();
  hideShop();
  ctl.requestLock();
}

const ui = createHud({ onPlay: playPressed, onBuy: buyPressed, onDeploy: deployPressed });
const ctl = createInput(gl.domElement, lockFlipped);

function lockFlipped(locked) {
  if (staged) return;
  if (locked) {
    begun = true;
    held = false;
    ui.hideOverlay();
    return;
  }
  if (match.phase === 'live') {
    held = true;
    ui.showOverlay('paused');
  } else if (match.phase === 'buy') {
    showShop();
  }
}

function showShop() {
  if (match.phase !== 'buy') return;
  // The shop is clicked with a free mouse, so drop the pointer lock first:
  // a lock held over from the last round would make it unusable.
  ctl.releaseLock();
  shopOpen = true;
  ui.showBuy(true);
  paintShop();
}

function hideShop() {
  shopOpen = false;
  ui.showBuy(false);
}

function paintShop() {
  shopKey = `${match.money}|${guns.state.grenades}|${hero.armour}|${guns.state.owned.length}`;
  ui.refreshBuy(
    match.money,
    guns.state.owned.map((slot) => slot.def.id),
    guns.state.grenades,
    hero.armour,
  );
}

// ---- match / round flow -------------------------------------------------

function beginMatch() {
  resetMatch(match);
  beginRound();
}

function beginRound() {
  resetRound(match);
  shop.restoreLoadout();
  const [sx, sz] = SPAWNS.strike[0];
  you.reset(sx, sz, 0);
  squad.resetRound(match.round);
  fire.reset();
  device.reset();
  shakeT = 0;
  wasFiring = false;
  ui.setDead(false);
  hideShop();
  ui.hideOverlay();
  const sub = match.round === 1 ? 'Plant the bomb at A or B' : `First to ${MATCH.winsToTake} rounds`;
  announce(match, `ROUND ${match.round}`, sub);
  if (!staged) showShop();
}

function goLive() {
  match.phase = 'live';
  match.timer = MATCH.roundTime;
  match.freeze = false;
  hideShop();
  ui.setHint('');
  if (!staged && !ctl.state.locked) {
    held = true;
    ui.showOverlay('paused');
  }
}

const ROUND_WHY = {
  elimination: ['Enemy team eliminated', 'Your team was eliminated'],
  bomb: ['The bomb exploded', 'The bomb exploded'],
  defused: ['The bomb was defused', 'The bomb was defused'],
  time: ['Time expired — the defence holds', 'Time expired — the defence holds'],
};

function closeRound(winner, reason) {
  if (match.phase !== 'live') return;
  match.phase = 'roundEnd';
  match.roundWinner = winner;
  match.roundReason = reason;
  match.score[winner] += 1;
  match.roundEndAt = match.elapsed + MATCH.roundEndPause;
  shop.roundReward(winner);
  shop.keepLoadout();
  if (!hero.alive) guns.dropToPistol();
  const won = winner === TEAMS.STRIKE;
  announce(match, `${TEAM_NAME[winner]} WINS THE ROUND`, ROUND_WHY[reason][won ? 0 : 1]);
  if (won) sfx.roundWin();
  else sfx.roundLose();
}

function closeMatch() {
  match.phase = 'matchEnd';
  match.matchWinner = match.score[0] > match.score[1] ? 0 : 1;
  const won = match.matchWinner === TEAMS.STRIKE;
  ctl.releaseLock();
  ui.showOverlay('matchEnd', {
    title: won ? 'STRIKE TAKES DEPOT 9' : 'WARDEN HOLDS DEPOT 9',
    copy: `Final score ${match.score[0]}–${match.score[1]}. You scored ${match.kills} kills and fell ${match.deaths} times.`,
  });
}

function attackersUp() {
  return (hero.alive ? 1 : 0) + squad.aliveCount(TEAMS.STRIKE);
}

function defendersUp() {
  return squad.aliveCount(TEAMS.WARDEN);
}

function policeRound() {
  if (match.phase !== 'live') return;
  const planted = match.bomb.state === 'planted';
  if (match.timer <= 0) {
    if (planted) {
      blowDevice();
      closeRound(TEAMS.STRIKE, 'bomb');
    } else {
      closeRound(TEAMS.WARDEN, 'time');
    }
    return;
  }
  if (defendersUp() === 0) {
    closeRound(TEAMS.STRIKE, 'elimination');
    return;
  }
  // A planted bomb keeps the round alive with no attackers left: the
  // defence still has to defuse before the timer runs out.
  if (attackersUp() === 0 && !planted) closeRound(TEAMS.WARDEN, 'elimination');
}

function blowDevice() {
  match.bomb.state = 'exploded';
  device.detonate();
  focus.set(match.bomb.x, 0.5, match.bomb.z);
  fire.explosion(focus);
  const dist = Math.hypot(match.bomb.x - hero.position.x, match.bomb.z - hero.position.z);
  sfx.explosion(dist);
  if (dist < 14) {
    shakeT = 0.6;
    shakeM = 0.05 * (1 - dist / 14);
  }
}

// ---- damage and death ----------------------------------------------------

function spillDevice(x, z) {
  match.bomb.state = 'dropped';
  match.bomb.carrier = null;
  match.bomb.x = x;
  match.bomb.z = z;
  device.dropAt(x, z);
}

function heroDown(killerName) {
  match.deaths += 1;
  feed(match, `${killerName} ▸ YOU`, false);
  if (match.bomb.state === 'carried' && match.bomb.carrier === 'player') {
    spillDevice(hero.position.x, hero.position.z);
  }
  const watcher = squad.list.find((b) => b.team === TEAMS.STRIKE && b.alive);
  ui.setDead(true, watcher ? watcher.name : 'nobody');
}

function botDown(bot, killer, part) {
  const killerName = killer === 'player' ? 'YOU' : killer.name;
  const good = bot.team === TEAMS.WARDEN;
  const suffix = part === 'head' ? ' · HEADSHOT' : part === 'blast' ? ' · FRAG' : '';
  feed(match, `${killerName} ▸ ${bot.name}${suffix}`, good);
  if (killer === 'player') {
    match.kills += 1;
    shop.killReward();
  }
  // Only a carried bomb drops; once planted it stays in the ground.
  if (match.bomb.state === 'carried' && (bot.hasBomb || match.bomb.carrier === bot.id)) {
    bot.hasBomb = false;
    spillDevice(bot.position.x, bot.position.z);
  }
}

// Grenades and bot bullets both arrive here.
function hurtTarget(target, amount, part, attacker) {
  if (target !== 'player') {
    const killed = squad.damage(target, amount);
    if (attacker && attacker !== 'player') squad.alert(target, attacker.position.x, attacker.position.z);
    if (killed) botDown(target, attacker, part);
    return;
  }
  if (!hero.alive) return;
  if (staged) return; // staged frames keep the player standing
  you.damage(amount);
  sfx.hurt();
  const from = attacker === 'player' ? null : attacker.position;
  if (from) {
    const angle = Math.atan2(-(from.x - hero.position.x), -(from.z - hero.position.z)) - hero.yaw;
    ui.damageFrom(angle);
  } else {
    ui.damageFrom(0);
  }
  if (!hero.alive) heroDown(attacker === 'player' ? 'YOUR GRENADE' : attacker.name);
}

// ---- shooting -------------------------------------------------------------

function botFires(bot, target) {
  const result = fire.botShoot(bot, target, BOT_CTX);
  const dist = Math.hypot(bot.position.x - hero.position.x, bot.position.z - hero.position.z);
  sfx.shot('rifle', dist);
  match.shotsHeard.push({ x: bot.position.x, z: bot.position.z, at: match.elapsed, team: bot.team });
  if (!result) return;
  if (result.target.kind === 'player') {
    hurtTarget('player', result.amount, result.part, bot);
  } else {
    hurtTarget(result.target.bot, result.amount, result.part, bot);
  }
}

const BOT_CTX = {
  get playerPos() {
    return hero.position;
  },
  get playerAlive() {
    return hero.alive;
  },
  get playerCrouching() {
    return hero.crouching;
  },
  get playerSpeed() {
    return you.groundSpeed();
  },
  get elapsed() {
    return match.elapsed;
  },
  get freeze() {
    return match.freeze;
  },
  state: match,
  shootBot: botFires,
  onBombPickup(bot) {
    feed(match, `${bot.name} picked up the bomb`, true);
  },
};

const FIRE_CTX = {
  get playerPos() {
    return hero.position;
  },
  get playerAlive() {
    return hero.alive;
  },
  get bots() {
    return squad.list;
  },
  damageTarget: hurtTarget,
  onExplosion(point, playerDist) {
    if (playerDist < 10) {
      shakeT = 0.4;
      shakeM = 0.04 * (1 - playerDist / 10);
    }
  },
};

function fireRound(spread) {
  const def = guns.currentDef();
  if (!guns.takeRound()) return false;
  cam.getWorldDirection(ray);
  for (const axis of ['x', 'y', 'z']) ray[axis] += (random() * 2 - 1) * spread;
  ray.normalize();
  stage.updateMatrixWorld(true);
  const hit = fire.playerShoot(cam.position, ray, def, targets);
  guns.pullTrigger();
  you.recoil(def.recoil * (0.8 + random() * 0.4), (random() * 2 - 1) * def.recoil * 0.6);
  sfx.shot(def.kind, 0);
  match.shotsHeard.push({ x: hero.position.x, z: hero.position.z, at: match.elapsed, team: TEAMS.STRIKE });
  if (hit && hit.bot) {
    const killed = squad.damage(hit.bot, hit.amount);
    squad.alert(hit.bot, hero.position.x, hero.position.z);
    match.spotted.set(hit.bot.id, match.elapsed);
    sfx.hit(killed);
    ui.hitMarker(killed);
    if (killed) botDown(hit.bot, 'player', hit.part);
  }
  return true;
}

// ---- fixed-step simulation --------------------------------------------------

function advance(dt) {
  const phase = match.phase;
  if (phase === 'buy' || phase === 'live' || phase === 'roundEnd') match.elapsed += dt;
  // Gunfire older than two seconds is forgotten; bots only chase fresh sound.
  while (match.shotsHeard.length > 0 && match.elapsed - match.shotsHeard[0].at > 2) {
    match.shotsHeard.shift();
  }

  switch (phase) {
    case 'buy': {
      match.timer -= dt;
      squad.update(dt, BOT_CTX);
      guns.step(dt, 0, false);
      if (match.timer <= 0) goLive();
      return;
    }
    case 'roundEnd': {
      fire.update(dt, FIRE_CTX);
      if (match.elapsed < match.roundEndAt) return;
      const done =
        match.score[0] >= MATCH.winsToTake ||
        match.score[1] >= MATCH.winsToTake ||
        match.round >= MATCH.maxRounds;
      if (done) closeMatch();
      else {
        match.round += 1;
        beginRound();
      }
      return;
    }
    case 'live':
      break;
    default:
      return;
  }

  match.timer -= dt;
  const aiming = ctl.state.aiming && hero.alive;
  you.step(dt, ctl.state.keys, aiming);
  guns.step(dt, you.groundSpeed(), aiming);
  squad.update(dt, BOT_CTX);
  device.update(dt, {
    state: match,
    world: yard,
    bots: squad.list,
    playerPos: hero.position,
    playerAlive: hero.alive,
    plantHeld: ctl.state.keys.has('KeyE') && hero.alive,
    onPlanted(site) {
      announce(match, `BOMB PLANTED — SITE ${site}`, 'Guard it until it blows');
    },
    onDefused() {
      closeRound(TEAMS.WARDEN, 'defused');
    },
  });
  // The player picks a dropped bomb up by walking over it.
  if (match.bomb.state === 'dropped' && hero.alive) {
    const dx = match.bomb.x - hero.position.x;
    const dz = match.bomb.z - hero.position.z;
    if (dx * dx + dz * dz < 1.4 * 1.4) {
      match.bomb.state = 'carried';
      match.bomb.carrier = 'player';
      feed(match, 'You picked up the bomb', true);
    }
  }
  fire.update(dt, FIRE_CTX);
  policeRound();
}

// ---- per-frame input and HUD -------------------------------------------------

function readKeys() {
  const pressed = ctl.state.pressed;
  if (pressed.has('KeyR') && match.phase === 'live' && hero.alive && guns.reload()) {
    sfx.reload();
  }
  if (pressed.has('KeyG') && match.phase === 'live' && hero.alive && guns.state.grenades > 0) {
    guns.state.grenades -= 1;
    cam.getWorldDirection(ray);
    focus.copy(cam.position).addScaledVector(ray, 0.6);
    fire.throwGrenade(focus, ray, 'player');
  }
  if (pressed.has('KeyB') && match.phase === 'buy') {
    if (shopOpen) {
      hideShop();
      ctl.requestLock();
    } else {
      ctl.releaseLock();
      showShop();
    }
  }
  if (pressed.has('Enter') && shopOpen) {
    hideShop();
    ctl.requestLock();
  }
  SHOP.forEach((item, i) => {
    if (!pressed.has(`Digit${i + 1}`)) return;
    if (shopOpen && match.phase === 'buy') {
      const outcome = shop.buy(item.id);
      if (outcome.ok) sfx.buy();
      else sfx.denied();
      ui.setBuyNote(outcome.reason);
      paintShop();
    } else if (i < 4 && match.phase !== 'menu' && match.phase !== 'matchEnd') {
      guns.switchTo(i);
    }
  });
  if (ctl.state.wheel !== 0 && !shopOpen) guns.cycle(ctl.state.wheel > 0 ? 1 : -1);
}

function readTrigger() {
  const firingNow = ctl.state.firing;
  if (match.phase !== 'live' || !hero.alive || !ctl.state.locked || held) {
    wasFiring = firingNow;
    return;
  }
  const def = guns.currentDef();
  const wantFire = firingNow && (def.auto || !wasFiring);
  wasFiring = firingNow;
  if (!wantFire) return;
  if (guns.ready()) {
    fireRound(guns.spread(you.groundSpeed(), ctl.state.aiming, hero.crouching, hero.onGround));
  } else if (guns.currentSlot().mag === 0 && guns.state.reloadLeft === 0) {
    sfx.dryFire();
  }
}

function placeCamera() {
  let jx = 0;
  let jy = 0;
  if (shakeT > 0) {
    shakeT -= 1 / 60;
    jx = (random() - 0.5) * shakeM;
    jy = (random() - 0.5) * shakeM;
  }
  cam.position.set(hero.position.x, hero.position.y + hero.eye, hero.position.z);
  cam.rotation.set(hero.pitch + jx, hero.yaw + jy, 0, 'YXZ');
  const aiming = ctl.state.aiming && hero.alive && (match.phase === 'live' || match.phase === 'buy');
  const def = guns.currentDef();
  const wantFov = aiming && def.zoom > 1 ? FOV / def.zoom : FOV;
  if (Math.abs(cam.fov - wantFov) > 0.1) {
    cam.fov += (wantFov - cam.fov) * 0.25;
    cam.updateProjectionMatrix();
  }
}

function bombLine() {
  const b = match.bomb;
  if (b.state === 'planted') return `BOMB PLANTED — SITE ${b.site}`;
  if (b.state === 'dropped') return 'BOMB DROPPED';
  if (b.carrier === 'player') return 'YOU CARRY THE BOMB';
  if (!b.carrier) return '';
  const carrier = squad.list.find((bot) => bot.id === b.carrier);
  return `${carrier ? carrier.name : 'TEAMMATE'} CARRIES THE BOMB`;
}

function hintLine() {
  if (match.phase === 'buy') return 'Buy phase — B for shop · Deploy when ready';
  if (match.phase !== 'live' || !hero.alive) return '';
  if (match.bomb.state === 'carried' && match.bomb.carrier === 'player') {
    const site = yard.siteAt(hero.position.x, hero.position.z);
    return site ? `Hold E to plant at site ${site}` : 'Carry the bomb to site A or B';
  }
  if (match.bomb.state === 'planted') return 'Bomb planted — guard the site';
  return '';
}

function paintHud() {
  ui.setVisible(match.phase !== 'menu' && match.phase !== 'matchEnd');
  const slot = guns.currentSlot();
  ui.setHealth(hero.health, hero.armour);
  ui.setAmmo(slot.mag, slot.reserve, slot.def.name, guns.state.reloadLeft > 0);
  ui.setMoney(match.money);
  ui.setGrenades(guns.state.grenades);
  const clockLabel = match.phase === 'buy' ? 'BUY' : match.bomb.state === 'planted' ? 'BOMB' : 'ROUND';
  ui.setTimer(match.timer, clockLabel);
  ui.setScore(match.score[0], match.score[1], match.round, MATCH.maxRounds);
  ui.setPips(attackersUp(), defendersUp());
  const hpNow = [Math.ceil(hero.health), Math.ceil(mates[0].health), Math.ceil(mates[1].health)];
  const aliveNow = [hero.alive, mates[0].alive, mates[1].alive];
  const changed =
    hpNow[0] !== hpSeen[0] ||
    hpNow[1] !== hpSeen[1] ||
    hpNow[2] !== hpSeen[2] ||
    aliveNow[0] !== aliveSeen[0] ||
    aliveNow[1] !== aliveSeen[1] ||
    aliveNow[2] !== aliveSeen[2];
  if (changed) {
    hpSeen[0] = hpNow[0];
    hpSeen[1] = hpNow[1];
    hpSeen[2] = hpNow[2];
    aliveSeen[0] = aliveNow[0];
    aliveSeen[1] = aliveNow[1];
    aliveSeen[2] = aliveNow[2];
    ui.setTeammates([
      { name: 'YOU', health: hero.health, alive: hero.alive },
      { name: mates[0].name, health: mates[0].health, alive: mates[0].alive },
      { name: mates[1].name, health: mates[1].health, alive: mates[1].alive },
    ]);
  }
  ui.setBombStatus(bombLine());
  ui.setHint(hintLine());
  const aiming = ctl.state.aiming && hero.alive;
  const gap = guns.spread(you.groundSpeed(), aiming, hero.crouching, hero.onGround) * 900;
  ui.setCrosshair(gap, aiming, guns.currentDef().id === 'sniper');
  if (match.feedSeq !== seenFeed) {
    seenFeed = match.feedSeq;
    ui.renderFeed(match.feed);
  }
  if (match.announceSeq !== seenAnnounce) {
    seenAnnounce = match.announceSeq;
    const latest = match.announcements[match.announcements.length - 1];
    if (latest) ui.announce(latest.text, latest.sub);
  }
  if (match.bomb.plantProgress > 0) {
    ui.setProgress(match.bomb.planter === 'player' ? 'PLANTING THE BOMB' : 'TEAMMATE PLANTING', match.bomb.plantProgress);
  } else if (match.bomb.defuseProgress > 0) {
    ui.setProgress('WARDEN DEFUSING THE BOMB', match.bomb.defuseProgress);
  } else {
    ui.setProgress('', 0);
  }
  if (shopOpen) {
    const key = `${match.money}|${guns.state.grenades}|${hero.armour}|${guns.state.owned.length}`;
    if (key !== shopKey) paintShop();
  }
}

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min((now - prevNow) / 1000, 0.1);
  prevNow = now;
  if (iced) {
    gl.render(stage, cam);
    return;
  }
  ctl.takeLook(look);
  const aiming = ctl.state.aiming && hero.alive;
  const gain = aiming ? (guns.currentDef().id === 'sniper' ? 0.35 : 0.6) : 1;
  if (ctl.state.locked) you.look(look.x * gain, look.y * gain);
  readKeys();
  readTrigger();
  if (!held) {
    bank += dt;
    let n = 0;
    while (bank >= STEP && n < 5) {
      advance(STEP);
      bank -= STEP;
      n += 1;
    }
    if (bank > STEP * 5) bank = 0;
  }
  placeCamera();
  paintHud();
  mapClock += dt;
  if (mapClock > 0.1) {
    mapClock = 0;
    ui.drawMinimap(yard, hero, squad.list, match);
  }
  ctl.endFrame();
  gl.render(stage, cam);
}

// ---- deterministic screenshot staging -----------------------------------------

function simmer(n) {
  for (let i = 0; i < n; i += 1) advance(STEP);
}

function lookToward(point) {
  const dx = point.x - hero.position.x;
  const dy = point.y - (hero.position.y + hero.eye);
  const dz = point.z - hero.position.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  hero.yaw = Math.atan2(-dx, -dz);
  hero.pitch = Math.asin(Math.max(-1, Math.min(1, dy / len)));
  placeCamera();
}

function doublePaint() {
  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    placeCamera();
    paintHud();
    ui.drawMinimap(yard, hero, squad.list, match);
    gl.render(stage, cam);
    painted += 1;
    if (painted === 2) {
      window.__shotReady = true;
      iced = true;
    }
  }
  requestAnimationFrame(paint);
}

function stageShot(name) {
  ui.hideOverlay();
  switch (name) {
    case 'start': {
      // Menu over the yard: the player looks down mid from the spawn ridge.
      hero.position.set(-6, 0, 18);
      hero.yaw = -0.25;
      hero.pitch = -0.02;
      squad.resetRound(1);
      simmer(10);
      ui.showOverlay('start');
      break;
    }
    case 'buy': {
      beginMatch();
      simmer(5);
      showShop();
      hero.yaw = 0;
      break;
    }
    case 'end': {
      beginMatch();
      match.score = [5, 3];
      match.kills = 11;
      match.deaths = 6;
      match.round = 9;
      match.phase = 'live';
      match.timer = 12;
      match.bomb.state = 'planted';
      match.bomb.site = 'A';
      match.bomb.x = SITES.A.x;
      match.bomb.z = SITES.A.z;
      device.dropAt(SITES.A.x, SITES.A.z);
      hero.position.set(-13, 0, -3);
      simmer(20);
      focus.set(SITES.A.x, 1.2, SITES.A.z);
      lookToward(focus);
      closeMatch();
      break;
    }
    default: {
      // 'play': mid-round, rifle in hand, an enemy in the sights.
      beginMatch();
      match.score = [2, 1];
      match.round = 4;
      match.kills = 3;
      match.money = 3200;
      announce(match, 'ROUND 4', 'First to 5 rounds');
      match.phase = 'live';
      match.timer = 82;
      match.freeze = false;
      guns.buy('rifle');
      guns.state.grenades = 1;
      hero.position.set(0, 0, 5);
      hero.yaw = 0;
      simmer(360);
      const foes = squad.list.filter((b) => b.team === TEAMS.WARDEN && b.alive);
      const nearest = foes.reduce((best, b) => {
        if (!best) return b;
        const dBest = Math.hypot(best.position.x - hero.position.x, best.position.z - hero.position.z);
        const dB = Math.hypot(b.position.x - hero.position.x, b.position.z - hero.position.z);
        return dB < dBest ? b : best;
      }, null);
      if (nearest) {
        focus.set(nearest.position.x, nearest.position.y + 1.1, nearest.position.z);
        lookToward(focus);
        fireRound(0);
        simmer(2);
      }
      feed(match, 'YOU ▸ MIRA · HEADSHOT', true);
      feed(match, 'JUNO ▸ DRAKE', true);
      break;
    }
  }
  placeCamera();
  paintHud();
  ui.drawMinimap(yard, hero, squad.list, match);
  doublePaint();
}

function fitView() {
  cam.aspect = aspect();
  cam.updateProjectionMatrix();
  gl.setSize(window.innerWidth, window.innerHeight);
}

window.addEventListener('resize', fitView);

// Menu idle: bots stand at their spawns behind the start overlay.
squad.resetRound(1);
placeCamera();
paintHud();
// A read hook for automated playtests (and curious players): the live match
// state, the player and the bots. The game never reads it back.
window.__sandline = { state: match, player: you, bots: squad, weapons: guns, combat: fire, world: yard };
if (staged) stageShot(staged);
else requestAnimationFrame(loop);
