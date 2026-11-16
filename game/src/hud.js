// The DOM layer: every number the match produces, shown once and only when it
// changes. Elements are grabbed from one id table into a single object, text
// writes go through a memo so the DOM is touched only on change, and the
// minimap redraws on a 2D canvas at 10 Hz from the same world data.
import { SHOP } from './economy.js';

// Screen copy as [title, body, button] triples.
const SCREENS = {
  start: [
    'SANDLINE',
    'Depot 9, dusk. STRIKE attacks, WARDEN defends. Plant the bomb at A or B, or wipe the defence out — first to 5 rounds takes the match.',
    'Deploy',
  ],
  paused: ['SANDLINE', 'Paused. Your team holds position.', 'Resume'],
  matchEnd: ['', '', 'Play again'],
};

const IDS = [
  'overlay', 'overlay-title', 'overlay-copy', 'play', 'crosshair', 'hitmarker',
  'health-value', 'health-bar', 'armour-value', 'ammo', 'ammo-mag', 'ammo-reserve',
  'weapon-name', 'reload-hint', 'money-value', 'grenade-value', 'timer-value',
  'timer-label', 'score-strike', 'score-warden', 'round-value', 'pips-strike',
  'pips-warden', 'teammates', 'feed', 'announce', 'announce-title', 'announce-sub',
  'progress-wrap', 'progress-label', 'progress-bar', 'bomb-status', 'vignette',
  'damage-dir', 'death-notice', 'death-text', 'scope', 'buy-menu', 'buy-money',
  'buy-rows', 'buy-note', 'hint-bar', 'minimap', 'hud', 'deploy',
];

const SITE_MARKS = [
  ['A', -24, -14],
  ['B', 24, -14],
];

export function createHud(callbacks) {
  const E = {};
  for (const id of IDS) E[id] = document.getElementById(id);
  const mapCtx = E.minimap.getContext('2d');
  const memo = new Map();
  let hitTimer = 0;
  let announceTimer = 0;
  let vignetteTimer = 0;

  function writeText(node, value, key) {
    if (memo.get(key) === value) return;
    memo.set(key, value);
    node.textContent = value;
  }

  function writeFlag(key, value, apply) {
    if (memo.get(key) === value) return;
    memo.set(key, value);
    apply(value);
  }

  for (const item of SHOP) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'buy-row';
    row.dataset.item = item.id;
    const key = document.createElement('span');
    key.className = 'buy-key';
    key.textContent = item.key;
    const label = document.createElement('span');
    label.className = 'buy-item';
    const name = document.createElement('b');
    name.textContent = item.name;
    const detail = document.createElement('i');
    detail.textContent = item.detail;
    label.append(name, detail);
    const price = document.createElement('span');
    price.className = 'buy-price';
    price.textContent = `$${item.price}`;
    row.append(key, label, price);
    row.addEventListener('click', () => callbacks.onBuy(item.id));
    E['buy-rows'].appendChild(row);
  }
  E.deploy.addEventListener('click', () => callbacks.onDeploy());
  E.play.addEventListener('click', () => callbacks.onPlay());

  function refreshBuy(money, ownedIds, grenades, armour) {
    writeText(E['buy-money'], `$${money}`, 'buyMoney');
    for (const row of E['buy-rows'].children) {
      const item = SHOP.find((entry) => entry.id === row.dataset.item);
      let blocked = money < item.price;
      let tag = '';
      if (item.id === 'grenade' && grenades >= 2) {
        blocked = true;
        tag = 'MAX';
      } else if (item.id === 'armour' && armour >= 100) {
        blocked = true;
        tag = 'FULL';
      } else if (ownedIds.includes(item.id)) {
        blocked = true;
        tag = 'OWNED';
      }
      row.classList.toggle('disabled', blocked);
      row.querySelector('.buy-price').textContent = tag || `$${item.price}`;
    }
  }

  function paintPips(node, alive, total, key) {
    writeFlag(key, `${alive}/${total}`, () => {
      node.innerHTML = '';
      for (let i = 0; i < total; i += 1) {
        const pip = document.createElement('i');
        if (i < alive) pip.className = 'alive';
        node.appendChild(pip);
      }
    });
  }

  return {
    setVisible(visible) {
      writeFlag('visible', visible, (on) => {
        E.hud.style.visibility = on ? 'visible' : 'hidden';
      });
    },
    setHealth(health, armour) {
      writeText(E['health-value'], String(Math.ceil(health)), 'health');
      writeFlag('healthBar', health, (value) => {
        E['health-bar'].style.width = `${Math.max(0, value)}%`;
        E['health-bar'].classList.toggle('low', value <= 30);
      });
      writeText(E['armour-value'], armour > 0 ? `+${armour}` : '', 'armour');
    },
    setAmmo(mag, reserve, name, reloading) {
      writeText(E['ammo-mag'], String(mag), 'mag');
      writeText(E['ammo-reserve'], `/ ${reserve}`, 'reserve');
      writeText(E['weapon-name'], name, 'weaponName');
      const showHint = mag === 0 && reserve > 0;
      writeFlag('reloadHint', showHint, (show) => {
        E['reload-hint'].hidden = !show;
      });
      E.ammo.classList.toggle('empty', mag === 0);
      E.ammo.classList.toggle('reloading', reloading);
    },
    setMoney(money) {
      writeText(E['money-value'], `$${money}`, 'money');
    },
    setGrenades(count) {
      writeText(E['grenade-value'], count > 0 ? `◉ ${count}` : '', 'grenades');
    },
    setTimer(seconds, label) {
      const total = Math.max(0, Math.ceil(seconds));
      const mins = Math.floor(total / 60);
      const secs = String(total % 60).padStart(2, '0');
      writeText(E['timer-value'], `${mins}:${secs}`, 'timer');
      writeText(E['timer-label'], label, 'timerLabel');
      E['timer-value'].classList.toggle('urgent', label === 'BOMB' || total <= 10);
    },
    setScore(strike, warden, round, maxRounds) {
      writeText(E['score-strike'], String(strike), 'scoreS');
      writeText(E['score-warden'], String(warden), 'scoreW');
      writeText(E['round-value'], `ROUND ${round}/${maxRounds}`, 'round');
    },
    setPips(strikeAlive, wardenAlive) {
      paintPips(E['pips-strike'], strikeAlive, 3, 'pipsS');
      paintPips(E['pips-warden'], wardenAlive, 3, 'pipsW');
    },
    setTeammates(members) {
      const key = members.map((m) => `${m.name}:${Math.ceil(m.health)}:${m.alive ? 1 : 0}`).join('|');
      writeFlag('teammates', key, () => {
        E.teammates.innerHTML = '';
        for (const m of members) {
          const row = document.createElement('div');
          row.className = m.alive ? 'mate' : 'mate dead';
          const name = document.createElement('span');
          name.textContent = m.name;
          const bar = document.createElement('span');
          bar.className = 'mate-bar';
          const fill = document.createElement('i');
          fill.style.width = `${Math.max(0, m.health)}%`;
          bar.appendChild(fill);
          const value = document.createElement('b');
          value.textContent = m.alive ? String(Math.ceil(m.health)) : '✕';
          row.append(name, bar, value);
          E.teammates.appendChild(row);
        }
      });
    },
    setBombStatus(text) {
      writeText(E['bomb-status'], text, 'bombStatus');
    },
    setHint(text) {
      writeText(E['hint-bar'], text, 'hint');
    },
    setCrosshair(spreadPx, aiming, sniper) {
      const gap = Math.round(Math.min(42, Math.max(5, 5 + spreadPx)));
      writeFlag('gap', gap, (value) => {
        E.crosshair.style.setProperty('--gap', `${value}px`);
      });
      E.crosshair.classList.toggle('hidden', aiming && sniper);
      E.scope.hidden = !(aiming && sniper);
    },
    hitMarker(killed, holdMs = 90) {
      E.hitmarker.classList.add('on');
      E.hitmarker.classList.toggle('kill', killed);
      clearTimeout(hitTimer);
      hitTimer = setTimeout(() => E.hitmarker.classList.remove('on', 'kill'), holdMs);
    },
    damageFrom(angleRad) {
      E.vignette.classList.add('on');
      clearTimeout(vignetteTimer);
      vignetteTimer = setTimeout(() => E.vignette.classList.remove('on'), 220);
      E['damage-dir'].style.transform = `translate(-50%, -50%) rotate(${angleRad}rad)`;
      E['damage-dir'].classList.add('on');
      setTimeout(() => E['damage-dir'].classList.remove('on'), 500);
    },
    setDead(dead, spectatorName) {
      E['death-notice'].hidden = !dead;
      if (dead) writeText(E['death-text'], `You are down — ${spectatorName} still fights.`, 'deathText');
    },
    announce(text, sub) {
      E['announce-title'].textContent = text;
      E['announce-sub'].textContent = sub;
      E.announce.classList.add('on');
      clearTimeout(announceTimer);
      announceTimer = setTimeout(() => E.announce.classList.remove('on'), 3200);
    },
    renderFeed(feed) {
      E.feed.innerHTML = '';
      for (let i = feed.length - 1; i >= 0; i -= 1) {
        const entry = document.createElement('div');
        entry.className = feed[i].good ? 'good' : 'bad';
        entry.textContent = feed[i].text;
        E.feed.appendChild(entry);
      }
    },
    setProgress(label, fraction) {
      if (fraction <= 0) {
        E['progress-wrap'].hidden = true;
        return;
      }
      E['progress-wrap'].hidden = false;
      writeText(E['progress-label'], label, 'progressLabel');
      E['progress-bar'].style.width = `${Math.round(fraction * 100)}%`;
    },
    showBuy(show) {
      E['buy-menu'].hidden = !show;
    },
    refreshBuy,
    setBuyNote(text) {
      writeText(E['buy-note'], text, 'buyNote');
    },
    showOverlay(mode, data = {}) {
      const [title, copy, action] = SCREENS[mode];
      E['overlay-title'].textContent = mode === 'matchEnd' ? data.title : title;
      E['overlay-copy'].textContent = mode === 'matchEnd' ? data.copy : copy;
      E.play.textContent = action;
      E.overlay.hidden = false;
      E.play.focus();
    },
    hideOverlay() {
      E.overlay.hidden = true;
    },
    drawMinimap(world, player, bots, state) {
      const W = E.minimap.width;
      const H = E.minimap.height;
      const sx = W / 64;
      const sy = H / 48;
      const toX = (x) => (x + 32) * sx;
      const toY = (z) => (z + 24) * sy;
      const dot = (x, z, color, radius = 3) => {
        mapCtx.fillStyle = color;
        mapCtx.beginPath();
        mapCtx.arc(toX(x), toY(z), radius, 0, Math.PI * 2);
        mapCtx.fill();
      };
      mapCtx.fillStyle = 'rgba(20, 18, 14, 0.85)';
      mapCtx.fillRect(0, 0, W, H);
      mapCtx.fillStyle = '#6b5d45';
      for (const [x, z, w, d] of world.minimapWalls) {
        mapCtx.fillRect(toX(x - w / 2), toY(z - d / 2), Math.max(1, w * sx), Math.max(1, d * sy));
      }
      mapCtx.font = 'bold 11px system-ui, sans-serif';
      mapCtx.textAlign = 'center';
      mapCtx.textBaseline = 'middle';
      for (const [letter, x, z] of SITE_MARKS) {
        const hot = state.bomb.state === 'planted' && state.bomb.site === letter;
        mapCtx.fillStyle = hot ? '#ff3b30' : '#e8862e';
        mapCtx.fillText(letter, toX(x), toY(z));
      }
      for (const [id, at] of state.spotted) {
        if (state.elapsed - at > 3) continue;
        const seen = bots.find((b) => b.id === id);
        if (seen && seen.alive) dot(seen.position.x, seen.position.z, '#ff5a4d', 3);
      }
      for (const bot of bots) {
        if (bot.alive && bot.team === 0) dot(bot.position.x, bot.position.z, '#37b6a0', 3);
      }
      if (state.bomb.state === 'dropped' || state.bomb.state === 'planted') {
        mapCtx.fillStyle = '#ffd23c';
        mapCtx.save();
        mapCtx.translate(toX(state.bomb.x), toY(state.bomb.z));
        mapCtx.rotate(Math.PI / 4);
        mapCtx.fillRect(-3, -3, 6, 6);
        mapCtx.restore();
      }
      mapCtx.save();
      mapCtx.translate(toX(player.position.x), toY(player.position.z));
      mapCtx.rotate(-player.yaw + Math.PI);
      mapCtx.fillStyle = '#ffffff';
      mapCtx.beginPath();
      mapCtx.moveTo(0, -6);
      mapCtx.lineTo(4.5, 5);
      mapCtx.lineTo(-4.5, 5);
      mapCtx.closePath();
      mapCtx.fill();
      mapCtx.restore();
    },
  };
}
