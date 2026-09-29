/* SkyLift Crash — MVP
 * Single-page crash game. Everything (RNG, balance, bots) runs client-side for the demo.
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------ config
  const CFG = {
    houseEdge: 0.03,          // RTP 97%
    growthK: 0.10,            // m(t) = e^(k t)  → 2x ≈ 6.9s, 5x ≈ 16s, 10x ≈ 23s
    countdownSec: 5,
    crashAnimSec: 2.4,
    minBet: 10,
    maxBet: 10000,
    startBalance: 10000,
    speedBase: 80,            // px/s at 1.00x  (v = speedBase * m)
    speedCap: 1500,
    currency: '₴',
  };

  // ------------------------------------------------------------------ helpers
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOut = (t) => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  const fmtMoney = (v) => CFG.currency + ' ' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtMult = (m) => 'x' + m.toFixed(2);
  const hash2 = (a, b) => { // deterministic 0..1 from two ints
    let h = (a * 374761393 + b * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177 | 0;
    h = h ^ (h >>> 16);
    return ((h >>> 0) % 10000) / 10000;
  };
  const randHex = (bytes) => {
    const a = new Uint8Array(bytes); crypto.getRandomValues(a);
    return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
  };
  async function sha256(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function crashFromHash(hex) {
    // r ∈ [0,1) from the first 52 bits (13 hex chars)
    const r = parseInt(hex.slice(0, 13), 16) / 2 ** 52;
    const m = Math.floor(100 * (1 - CFG.houseEdge) / (1 - r)) / 100;
    return Math.max(1, m);
  }

  // ------------------------------------------------------------------ state
  const S = {
    phase: 'countdown',       // countdown | flying | crashed
    phaseT: 0,                // seconds in phase
    flightStart: 0,           // performance.now() ms at launch
    mult: 1,
    crashPoint: 2,
    worldY: 0,                // altitude in px
    roundId: 48213,
    seed: '', seedHash: '',
    balance: CFG.startBalance,
    betAmount: 100,
    bet: null,                // { amount, cashedAt|null, win }
    queuedBet: false,         // bet requested for next round
    autoBet: false,
    autoCash: false,
    autoCashVal: 2.0,
    history: [],
    passengers: [],           // boarding animation states
    doorOpen: 0,              // 0..1
    crash: null,              // crash animation state
    shake: 0,
    particles: [],
    bots: [],
  };

  // persistence
  try {
    const saved = JSON.parse(localStorage.getItem('skylift') || '{}');
    if (typeof saved.balance === 'number') S.balance = saved.balance;
    if (typeof saved.betAmount === 'number') S.betAmount = saved.betAmount;
    if (typeof saved.roundId === 'number') S.roundId = saved.roundId;
    if (Array.isArray(saved.history)) S.history = saved.history.slice(-20);
    if (typeof saved.autoCashVal === 'number') S.autoCashVal = saved.autoCashVal;
  } catch (e) { /* ignore */ }
  function save() {
    try {
      localStorage.setItem('skylift', JSON.stringify({
        balance: S.balance, betAmount: S.betAmount, roundId: S.roundId,
        history: S.history.slice(-20), autoCashVal: S.autoCashVal,
      }));
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ DOM
  const el = {
    balance: $('balance'), mult: $('mult'), crashText: $('crashText'),
    countdown: $('countdown'), cdFill: $('cdFill'), toast: $('toast'),
    history: $('history'), betAmount: $('betAmount'), mainBtn: $('mainBtn'),
    mainTop: $('mainTop'), mainSub: $('mainSub'), autoBet: $('autoBet'), autoCash: $('autoCash'),
    autoCashVal: $('autoCashVal'), autoCashLabel: $('autoCashLabel'), roundLabel: $('roundLabel'),
    cashPanel: $('cashPanel'), cashSwitch: $('cashSwitch'), cashPresets: $('cashPresets'),
    playersPanel: $('playersPanel'), fairPanel: $('fairPanel'), playersList: $('playersList'),
    onlineCount: $('onlineCount'), btnFair: $('btnFair'), btnPlayers: $('btnPlayers'),
    fairRound: $('fairRound'), fairHash: $('fairHash'), fairSeed: $('fairSeed'), fairResult: $('fairResult'),
    resetBalance: $('resetBalance'),
  };
  const canvas = $('cv');
  const ctx = canvas.getContext('2d');
  const sceneEl = $('scene');
  let W = 360, H = 600, DPR = 1;

  function resize() {
    const r = sceneEl.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    DPR = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = W * DPR; canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  new ResizeObserver(resize).observe(sceneEl);
  resize();

  // ------------------------------------------------------------------ UI updates
  function setMain(state, top, sub, disabled) {
    el.mainBtn.className = 'main-btn state-' + state;
    el.mainTop.textContent = top;
    el.mainSub.textContent = sub;
    el.mainBtn.disabled = !!disabled;
  }
  function updateMainBtn() {
    if (S.phase === 'countdown') {
      if (S.bet) setMain('cancel', 'CANCEL', 'BET ' + fmtMoney(S.bet.amount));
      else setMain('bet', 'BET', fmtMoney(S.betAmount));
    } else if (S.phase === 'flying') {
      if (S.bet && !S.bet.cashedAt) setMain('cashout', fmtMult(S.mult), 'CASH OUT ' + fmtMoney(S.bet.amount * S.mult));
      else if (S.bet && S.bet.cashedAt) setMain('won', fmtMult(S.bet.cashedAt), 'WON ' + fmtMoney(S.bet.win), true);
      else if (S.queuedBet) setMain('cancel', 'CANCEL', 'BET ' + fmtMoney(S.betAmount) + ' NEXT ROUND');
      else setMain('bet', 'BET', fmtMoney(S.betAmount) + ' · NEXT ROUND');
    } else { // crashed
      if (S.bet && S.bet.cashedAt) setMain('won', fmtMult(S.bet.cashedAt), 'WON ' + fmtMoney(S.bet.win), true);
      else if (S.bet) setMain('lost', 'CRASHED', 'LOST ' + fmtMoney(S.bet.amount), true);
      else if (S.queuedBet) setMain('cancel', 'CANCEL', 'BET ' + fmtMoney(S.betAmount) + ' NEXT ROUND');
      else setMain('bet', 'BET', fmtMoney(S.betAmount) + ' · NEXT ROUND');
    }
  }
  function updateBalance() { el.balance.textContent = fmtMoney(S.balance); }
  let lastMultKey = '';
  function setMultColor(m) {
    const c = multColor(m); const key = c.join(',');
    if (key === lastMultKey) return; lastMultKey = key;
    document.documentElement.style.setProperty('--mcol', key);
  }
  function updateBet() { el.betAmount.textContent = fmtMoney(S.betAmount); updateMainBtn(); }
  function renderHistory() {
    el.history.innerHTML = '';
    const items = S.history.slice(-8).reverse();
    for (const m of items) {
      const d = document.createElement('div');
      d.className = 'hchip ' + (m >= 10 ? 'high' : m >= 2 ? 'mid' : 'low');
      d.textContent = m.toFixed(2) + 'x';
      el.history.appendChild(d);
    }
  }
  let toastTimer = 0;
  function toast(text, lose) {
    el.toast.textContent = text;
    el.toast.className = 'toast' + (lose ? ' lose' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 2200);
  }
  function updateFairPanel() {
    el.fairRound.textContent = '#' + S.roundId;
    el.fairHash.textContent = S.seedHash || '—';
    el.fairSeed.textContent = S.phase === 'crashed' ? S.seed : '(hidden until crash)';
    el.fairResult.textContent = S.phase === 'crashed' ? fmtMult(S.crashPoint) : 'in progress';
  }

  // ------------------------------------------------------------------ bets
  function setBetAmount(v) {
    S.betAmount = clamp(Math.round(v * 100) / 100, CFG.minBet, CFG.maxBet);
    updateBet(); save();
  }
  function placeBet() {
    if (S.betAmount > S.balance) { toast('NOT ENOUGH BALANCE', true); return false; }
    S.balance -= S.betAmount;
    S.bet = { amount: S.betAmount, cashedAt: null, win: 0 };
    updateBalance(); updateMainBtn(); save();
    return true;
  }
  function cancelBet() {
    if (!S.bet) return;
    S.balance += S.bet.amount; S.bet = null;
    updateBalance(); updateMainBtn(); save();
  }
  function cashOut() {
    if (S.phase !== 'flying' || !S.bet || S.bet.cashedAt) return;
    S.bet.cashedAt = S.mult;
    S.bet.win = Math.round(S.bet.amount * S.mult * 100) / 100;
    S.balance += S.bet.win;
    updateBalance(); updateMainBtn(); save();
    toast('+ ' + fmtMoney(S.bet.win) + '  ·  ' + fmtMult(S.mult));
  }
  function onMainClick() {
    if (S.phase === 'countdown') { S.bet ? cancelBet() : placeBet(); }
    else if (S.phase === 'flying' && S.bet && !S.bet.cashedAt) cashOut();
    else if (!S.bet || S.phase !== 'flying') { S.queuedBet = !S.queuedBet; updateMainBtn(); }
  }

  // ------------------------------------------------------------------ bots (live bets panel)
  const NAMES = ['Oleh', 'Maria', 'Dmytro', 'Kate', 'Ivan', 'Sofia', 'Andrii', 'Olya', 'Max', 'Nina', 'Taras', 'Alina', 'Yura', 'Dasha', 'Roman', 'Lera', 'Vlad', 'Zhenya'];
  const AVCOL = ['#f6a83a', '#4ad07f', '#b48cff', '#5ab8ff', '#ff7ab6', '#ffd166'];
  function makeBots() {
    const n = 8 + Math.floor(Math.random() * 6);
    const pool = [...NAMES].sort(() => Math.random() - .5).slice(0, n);
    S.bots = pool.map((name, i) => {
      const u = Math.random();
      const target = u < .15 ? Infinity : Math.max(1.05, Math.round(100 * (1 / (1 - Math.random() * .93))) / 100);
      const bets = [20, 50, 100, 100, 200, 250, 500, 1000, 2000];
      return { name, bet: bets[Math.floor(Math.random() * bets.length)], target, status: 'bet', el: null, col: AVCOL[i % AVCOL.length] };
    });
    el.onlineCount.textContent = '· ' + (1100 + Math.floor(Math.random() * 400)).toLocaleString('en-US') + ' online';
    renderBots();
  }
  function renderBots() {
    el.playersList.innerHTML = '';
    for (const b of S.bots) {
      const row = document.createElement('div');
      row.className = 'prow';
      row.innerHTML = `<span class="pname"><span class="pav" style="background:${b.col}">${b.name[0]}</span>${b.name}</span><span class="pbet">${fmtMoney(b.bet)}</span><span class="pres">—</span>`;
      el.playersList.appendChild(row);
      b.el = row;
    }
  }
  function updateBots() {
    for (const b of S.bots) {
      if (b.status !== 'bet') continue;
      if (S.phase === 'flying' && S.mult >= b.target) {
        b.status = 'won'; b.el.classList.add('won');
        b.el.lastElementChild.textContent = b.target.toFixed(2) + 'x  +' + fmtMoney(b.bet * b.target);
      } else if (S.phase === 'crashed') {
        b.status = 'lost'; b.el.classList.add('lost');
        b.el.lastElementChild.textContent = '−' + fmtMoney(b.bet);
      }
    }
  }

  // ------------------------------------------------------------------ round flow
  async function startCountdown() {
    S.phase = 'countdown'; S.phaseT = 0; S.worldY = 0; S.mult = 1;
    S.crash = null; S.particles = []; S.shake = 0; S.doorOpen = 0;
    S.bet = null;
    S.roundId += 1;
    el.roundLabel.textContent = 'ROUND #' + S.roundId;
    // passengers: [left hat, middle (behind), right hat]
    S.passengers = [
      { slot: -1, type: 'hat', t0: 0.7, p: 0 },
      { slot: 1, type: 'hat', t0: 1.4, p: 0 },
      { slot: 0, type: 'lady', t0: 2.1, p: 0 },
    ];
    // provably-fair commitment
    S.seed = randHex(16);
    S.seedHash = await sha256(S.seed);
    S.crashPoint = crashFromHash(await sha256(S.seed + ':' + S.roundId));
    makeBots();
    if (S.queuedBet || S.autoBet) { S.queuedBet = false; placeBet(); }
    el.mult.classList.add('hidden'); el.mult.classList.remove('crashed');
    el.crashText.classList.add('hidden');
    el.countdown.classList.remove('hidden');
    updateMainBtn(); updateFairPanel(); save();
  }
  function launch() {
    S.phase = 'flying'; S.phaseT = 0; S.flightStart = performance.now(); S.mult = 1;
    setMultColor(1);
    el.countdown.classList.add('hidden');
    el.mult.classList.remove('hidden');
    updateMainBtn();
  }
  function doCrash() {
    S.phase = 'crashed'; S.phaseT = 0; S.mult = S.crashPoint;
    S.crash = { t: 0, fallY: 0, rot: 0, cableSnap: Math.random() < .5 ? 0 : 2 };
    S.shake = 1;
    for (let i = 0; i < 70; i++) {
      S.particles.push({ x: 0, y: 0, vx: (Math.random() - .5) * 520, vy: -Math.random() * 420 - 60, life: .6 + Math.random() * .9, r: 1 + Math.random() * 2.5, kind: Math.random() < .3 ? 'shard' : 'spark' });
    }
    S.history.push(S.crashPoint); if (S.history.length > 50) S.history.shift();
    renderHistory();
    el.mult.textContent = fmtMult(S.crashPoint); el.mult.classList.add('crashed');
    el.crashText.classList.remove('hidden');
    updateMainBtn(); updateBots(); updateFairPanel(); save();
  }

  // ------------------------------------------------------------------ update
  function update(dt, now) {
    S.phaseT += dt;
    if (S.phase === 'countdown') {
      const t = S.phaseT;
      // doors: open 0.2–0.8s, close 3.9–4.5s
      S.doorOpen = t < 0.2 ? 0 : t < 0.8 ? easeInOut((t - 0.2) / 0.6) : t < 3.9 ? 1 : t < 4.5 ? 1 - easeInOut((t - 3.9) / 0.6) : 0;
      for (const p of S.passengers) p.p = clamp((t - p.t0) / 1.0, 0, 1);
      const remain = Math.max(0, CFG.countdownSec - t);
      el.cdFill.style.width = (remain / CFG.countdownSec * 100) + '%';
      if (t >= CFG.countdownSec && S.seedHash) launch();
    } else if (S.phase === 'flying') {
      const tf = (now - S.flightStart) / 1000;
      S.mult = Math.exp(CFG.growthK * tf);
      if (S.mult >= S.crashPoint) { doCrash(); return; }
      const v = Math.min(CFG.speedCap, CFG.speedBase * S.mult);
      S.worldY += v * dt;
      el.mult.textContent = fmtMult(S.mult);
      setMultColor(S.mult);
      if (S.bet && !S.bet.cashedAt) {
        if (S.autoCash && S.mult >= S.autoCashVal) { S.mult = S.autoCashVal; cashOut(); S.mult = Math.exp(CFG.growthK * tf); }
        else { el.mainTop.textContent = fmtMult(S.mult); el.mainSub.textContent = 'CASH OUT ' + fmtMoney(S.bet.amount * S.mult); }
      }
      updateBots();
    } else if (S.phase === 'crashed') {
      const c = S.crash; c.t += dt;
      const fallT = Math.max(0, c.t - 0.35);
      c.fallY = 0.5 * 1700 * fallT * fallT;
      c.rot = Math.min(0.4, fallT * 0.45) * (c.cableSnap === 0 ? -1 : 1);
      S.shake = Math.max(0, 1 - c.t * 2.2);
      for (const p of S.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 900 * dt; p.life -= dt; }
      S.particles = S.particles.filter(p => p.life > 0);
      if (S.phaseT >= CFG.crashAnimSec) startCountdown();
    }
  }

  // ------------------------------------------------------------------ drawing
  const COL = {
    bg: '#0b0b0c',
    wall: ['#1a1b1f', '#1c1d22', '#191a1e'], wallEdge: '#26282e',
    slab: '#2a2c33', slabHi: '#3a3d46', ceiling: '#232529',
    furn: '#2e3138', furn2: '#3a3d45', furn3: '#474a53', dark: '#141517',
    glassNight: '#0f1420', cityDot: '#3d4a66', cityDotLit: '#7d8db3',
    lamp: '#4a4d55',
    plant: '#2f4a3a', plant2: '#3a5c47',
    shaft: '#0e0e10', shaftRail: '#2a2c33', shaftTick: '#3a3d46', floorNum: '#4a4e58',
    cable: '#a3122e',
    cabFrame: '#d5163c', cabFrameDark: '#8d0f26', cabBar: '#b5122f',
    glass: 'rgba(230,70,100,0.10)',
    cabBack: '#232429', door: '#3b3e47', doorDark: '#17181c', person: '#07080b',
    lobbyWall: '#1d1e23', lobbyTile: '#1f2126', lobbyTile2: '#25272d', lobbyDesk: '#2f3238', lobbyDeskTop: '#4a4d55',
  };
  const RGB = { blue: [52, 180, 255], purple: [145, 62, 248], magenta: [216, 30, 170] };
  function multColor(m) {
    // Aviator-like: blue (<2x) → purple (~10x) → magenta (>=50x); smooth over log scale
    const t = Math.log10(Math.max(1, m));
    if (t < 0.3) return RGB.blue;
    if (t < 1.0) { const k = (t - 0.3) / 0.7; return RGB.blue.map((v, i) => Math.round(lerp(v, RGB.purple[i], k))); }
    if (t < 1.7) { const k = (t - 1.0) / 0.7; return RGB.purple.map((v, i) => Math.round(lerp(v, RGB.magenta[i], k))); }
    return RGB.magenta;
  }

  function layout() {
    const cabW = clamp(W * 0.27, 90, 150);
    const cabH = cabW * 1.35;
    const cx = W / 2;
    const cabTop = H * 0.40;
    const shaftHalf = cabW * 0.66;
    const FH = Math.round(cabH * 1.18);          // room height
    const lobbyH = Math.round(FH * 1.35);        // lobby is taller
    return { cabW, cabH, cx, cabTop, cabBot: cabTop + cabH, shaftL: cx - shaftHalf, shaftR: cx + shaftHalf, FH, lobbyH };
  }
  const floorAlt = (L, f) => f <= 0 ? 0 : L.lobbyH + (f - 1) * L.FH;   // altitude of the slab (bottom) of floor f
  const floorH = (L, f) => f === 0 ? L.lobbyH : L.FH;

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }

  // --- room furniture (flat, minimal, dark grey)
  function drawWindow(x, y, w, h, seed) {
    ctx.fillStyle = COL.furn2; roundRect(x - 3, y - 3, w + 6, h + 6, 3); ctx.fill();
    ctx.fillStyle = COL.glassNight; ctx.fillRect(x, y, w, h);
    const cols = Math.max(2, Math.floor(w / 9)), rows = Math.max(3, Math.floor(h / 9));
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      const hsh = hash2(seed * 31 + i, j * 17 + 3);
      if (hsh < 0.28) { ctx.fillStyle = hsh < 0.09 ? COL.cityDotLit : COL.cityDot; ctx.fillRect(x + 3 + i * (w - 6) / cols, y + h * 0.35 + j * (h * 0.6) / rows, 3, 4); }
    }
    ctx.fillStyle = COL.furn2; ctx.fillRect(x + w / 2 - 1, y, 2, h); ctx.fillRect(x, y + h * 0.45, w, 2);
  }
  function drawLamp(x, floorY, h, on) {
    ctx.fillStyle = COL.lamp; ctx.fillRect(x - 1.5, floorY - h, 3, h);
    ctx.fillRect(x - 9, floorY - 3, 18, 3);
    ctx.beginPath(); ctx.moveTo(x - 11, floorY - h); ctx.lineTo(x + 11, floorY - h); ctx.lineTo(x + 7, floorY - h - 16); ctx.lineTo(x - 7, floorY - h - 16); ctx.closePath();
    ctx.fillStyle = on ? '#6a5f4e' : COL.furn3; ctx.fill();
    if (on) {
      const g = ctx.createRadialGradient(x, floorY - h + 6, 4, x, floorY - h + 6, h * 0.9);
      g.addColorStop(0, 'rgba(255,205,140,0.22)'); g.addColorStop(1, 'rgba(255,205,140,0)');
      ctx.fillStyle = g; ctx.fillRect(x - h, floorY - h - 20, h * 2, h + 20);
    }
  }
  function drawSofa(x, floorY, w) {
    const h = 22;
    ctx.fillStyle = COL.furn; roundRect(x, floorY - h, w, h, 5); ctx.fill();
    ctx.fillStyle = COL.furn2; roundRect(x + 4, floorY - h - 8, w - 8, 12, 4); ctx.fill();
    ctx.fillStyle = COL.furn3; roundRect(x + 6, floorY - h + 4, w / 2 - 8, 9, 3); ctx.fill(); roundRect(x + w / 2 + 2, floorY - h + 4, w / 2 - 8, 9, 3); ctx.fill();
    ctx.fillStyle = COL.furn; ctx.fillRect(x, floorY - h, 6, h + 3); ctx.fillRect(x + w - 6, floorY - h, 6, h + 3);
  }
  function drawPlant(x, floorY, s) {
    ctx.fillStyle = COL.furn2; ctx.beginPath(); ctx.moveTo(x - 7 * s, floorY - 14 * s); ctx.lineTo(x + 7 * s, floorY - 14 * s); ctx.lineTo(x + 5 * s, floorY); ctx.lineTo(x - 5 * s, floorY); ctx.closePath(); ctx.fill();
    ctx.fillStyle = COL.plant;
    for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.ellipse(x + i * 5 * s, floorY - 24 * s + Math.abs(i) * 3 * s, 4 * s, 11 * s, i * 0.35, 0, 6.283); ctx.fill(); }
    ctx.fillStyle = COL.plant2; ctx.beginPath(); ctx.ellipse(x, floorY - 30 * s, 3.5 * s, 10 * s, 0, 0, 6.283); ctx.fill();
  }
  function drawDesk(x, floorY, w, seed) {
    ctx.fillStyle = COL.furn2; ctx.fillRect(x, floorY - 26, w, 4); ctx.fillRect(x + 3, floorY - 22, 4, 22); ctx.fillRect(x + w - 7, floorY - 22, 4, 22);
    ctx.fillStyle = COL.dark; roundRect(x + w * 0.35, floorY - 46, w * 0.4, 16, 2); ctx.fill();
    ctx.fillStyle = hash2(seed, 5) < 0.6 ? '#20344f' : '#1c1e24'; ctx.fillRect(x + w * 0.35 + 2, floorY - 44, w * 0.4 - 4, 12);
    ctx.fillStyle = COL.furn2; ctx.fillRect(x + w * 0.55 - 1, floorY - 30, 2, 4);
    ctx.fillStyle = COL.furn; roundRect(x - 16, floorY - 32, 12, 20, 3); ctx.fill(); ctx.fillRect(x - 11, floorY - 12, 2, 12); ctx.fillRect(x - 17, floorY - 2, 14, 2);
  }
  function drawShelf(x, y, w, h, seed) {
    ctx.fillStyle = COL.furn; ctx.fillRect(x, y, w, h);
    const rows = Math.max(2, Math.floor(h / 16));
    for (let r = 0; r < rows; r++) {
      const ry = y + 3 + r * (h - 6) / rows, rh = (h - 6) / rows - 3;
      ctx.fillStyle = COL.dark; ctx.fillRect(x + 3, ry, w - 6, rh);
      let bx = x + 5;
      while (bx < x + w - 8) { const bw = 3 + Math.floor(hash2(seed + r * 7, Math.round(bx)) * 4); const t = hash2(seed + r, Math.round(bx) + 1); ctx.fillStyle = t < 0.3 ? '#5a3c3c' : t < 0.6 ? '#3e4a5c' : '#4a4d55'; ctx.fillRect(bx, ry + 2, bw, rh - 2); bx += bw + 2; }
    }
  }
  function drawPicture(x, y, w, h, seed) {
    ctx.fillStyle = COL.furn3; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = hash2(seed, 9) < 0.5 ? '#2b2530' : '#23292b'; ctx.fillRect(x + 3, y + 3, w - 6, h - 6);
    ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.beginPath(); ctx.arc(x + w * 0.6, y + h * 0.45, Math.min(w, h) * 0.18, 0, 6.283); ctx.fill();
  }
  function drawBed(x, floorY, w) {
    ctx.fillStyle = COL.furn; roundRect(x, floorY - 18, w, 18, 3); ctx.fill();
    ctx.fillStyle = COL.furn2; roundRect(x + 2, floorY - 26, w - 4, 10, 3); ctx.fill();
    ctx.fillStyle = COL.furn3; roundRect(x + 5, floorY - 30, 18, 7, 2); ctx.fill();
    ctx.fillStyle = COL.furn2; ctx.fillRect(x, floorY - 40, 5, 40);
  }
  function drawArmchair(x, floorY) {
    ctx.fillStyle = COL.furn; roundRect(x, floorY - 22, 26, 22, 4); ctx.fill();
    ctx.fillStyle = COL.furn2; roundRect(x + 3, floorY - 34, 20, 16, 4); ctx.fill();
    ctx.fillStyle = COL.furn3; roundRect(x + 5, floorY - 18, 16, 8, 3); ctx.fill();
  }

  function drawRoom(x0, x1, top, bottom, f, side) {
    const w = x1 - x0, h = bottom - top;
    const variant = (f + (side === 2 ? 1 : 0)) % 3;
    const seed = f * 11 + side * 101;
    ctx.fillStyle = COL.wall[variant]; ctx.fillRect(x0, top, w, h);
    ctx.fillStyle = COL.ceiling; ctx.fillRect(x0, top, w, 2);
    const floorY = bottom - 10;
    const pad = 12, inner = w - pad * 2;
    ctx.save(); ctx.beginPath(); ctx.rect(x0, top, w, h); ctx.clip();
    if (variant === 0) {            // living room
      drawWindow(x0 + pad + inner * 0.08, top + h * 0.16, inner * 0.55, h * 0.36, seed);
      drawSofa(x0 + pad + inner * 0.05, floorY, inner * 0.6);
      drawLamp(x0 + pad + inner * 0.86, floorY, h * 0.42, hash2(seed, 2) < 0.7);
    } else if (variant === 1) {     // office
      drawShelf(x0 + pad, top + h * 0.14, inner * 0.34, h * 0.5, seed);
      drawPicture(x0 + pad + inner * 0.55, top + h * 0.2, inner * 0.3, h * 0.22, seed);
      drawDesk(x0 + pad + inner * 0.5, floorY, inner * 0.48, seed);
      drawPlant(x0 + pad + inner * 0.2, floorY, 0.9);
    } else {                         // bedroom
      drawWindow(x0 + pad + inner * 0.4, top + h * 0.16, inner * 0.5, h * 0.34, seed);
      ctx.fillStyle = '#3a2a30'; ctx.fillRect(x0 + pad + inner * 0.36, top + h * 0.13, inner * 0.07, h * 0.42); ctx.fillRect(x0 + pad + inner * 0.87, top + h * 0.13, inner * 0.07, h * 0.42);
      drawBed(x0 + pad + inner * 0.38, floorY, inner * 0.6);
      drawArmchair(x0 + pad, floorY);
      drawLamp(x0 + pad + inner * 0.3, floorY, h * 0.36, hash2(seed, 4) < 0.6);
    }
    ctx.restore();
    ctx.fillStyle = COL.slab; ctx.fillRect(x0, floorY, w, 10);
    ctx.fillStyle = COL.slabHi; ctx.fillRect(x0, floorY, w, 2);
  }

  function drawLobby(x0, x1, top, bottom, side) {
    const w = x1 - x0, h = bottom - top;
    ctx.fillStyle = COL.lobbyWall; ctx.fillRect(x0, top, w, h);
    const floorY = bottom - 12;
    const ts = 14;
    for (let i = 0; i < Math.ceil(w / ts); i++) { ctx.fillStyle = (i % 2) ? COL.lobbyTile : COL.lobbyTile2; ctx.fillRect(x0 + i * ts, floorY, ts, 12); }
    ctx.fillStyle = COL.slabHi; ctx.fillRect(x0, floorY, w, 2);
    ctx.save(); ctx.beginPath(); ctx.rect(x0, top, w, h); ctx.clip();
    ctx.fillStyle = '#212227'; for (let px = x0 + 10; px < x1 - 10; px += 34) ctx.fillRect(px, top + h * 0.15, 22, h * 0.55);
    for (let px = x0 + w * 0.3; px < x1; px += w * 0.4) {
      ctx.fillStyle = COL.furn2; ctx.fillRect(px - 1, top, 2, h * 0.16);
      ctx.beginPath(); ctx.moveTo(px - 10, top + h * 0.22); ctx.lineTo(px + 10, top + h * 0.22); ctx.lineTo(px + 6, top + h * 0.16); ctx.lineTo(px - 6, top + h * 0.16); ctx.closePath(); ctx.fillStyle = '#5a5347'; ctx.fill();
      const g = ctx.createRadialGradient(px, top + h * 0.24, 2, px, top + h * 0.24, h * 0.5);
      g.addColorStop(0, 'rgba(255,215,150,0.14)'); g.addColorStop(1, 'rgba(255,215,150,0)');
      ctx.fillStyle = g; ctx.fillRect(px - h * 0.5, top + h * 0.2, h, h * 0.6);
    }
    if (side === 1) {
      ctx.fillStyle = COL.lobbyDesk; roundRect(x0 + w * 0.2, floorY - 34, w * 0.62, 34, 3); ctx.fill();
      ctx.fillStyle = COL.lobbyDeskTop; ctx.fillRect(x0 + w * 0.17, floorY - 38, w * 0.68, 5);
      ctx.fillStyle = '#d5163c'; ctx.fillRect(x0 + w * 0.2, floorY - 24, w * 0.62, 2);
      drawPlant(x0 + w * 0.92, floorY, 1.1);
    } else {
      drawSofa(x0 + w * 0.12, floorY, w * 0.5);
      drawPlant(x0 + w * 0.8, floorY, 1.1);
      ctx.fillStyle = COL.dark; roundRect(x0 + w * 0.3, top + h * 0.34, w * 0.4, 16, 3); ctx.fill();
      ctx.fillStyle = '#d5163c'; ctx.font = '800 9px Manrope, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('LOBBY', x0 + w * 0.5, top + h * 0.34 + 8.5);
    }
    ctx.restore();
  }

  function drawBuilding(L) {
    const groundSY = L.cabBot + S.worldY;         // screen y of altitude 0 (lobby floor)
    ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, W, H);
    const sides = [{ x0: 0, x1: L.shaftL, id: 1 }, { x0: L.shaftR, x1: W, id: 2 }];
    const altTop = S.worldY + L.cabBot + 10;
    const altBot = S.worldY - (H - L.cabBot) - 10;
    const fStart = altBot <= L.lobbyH ? 0 : 1 + Math.floor((altBot - L.lobbyH) / L.FH);
    for (const side of sides) {
      for (let f = fStart; ; f++) {
        const a0 = floorAlt(L, f), a1 = a0 + floorH(L, f);
        if (a0 > altTop) break;
        const bottom = groundSY - a0, top = groundSY - a1;
        if (f === 0) drawLobby(side.x0, side.x1, top, bottom, side.id);
        else drawRoom(side.x0, side.x1, top, bottom, f, side.id);
      }
      ctx.fillStyle = COL.wallEdge;
      if (side.id === 1) ctx.fillRect(side.x1 - 4, 0, 4, H); else ctx.fillRect(side.x0, 0, 4, H);
    }
    if (groundSY < H) {
      ctx.fillStyle = '#0a0a0b'; ctx.fillRect(0, groundSY, W, H - groundSY);
      ctx.fillStyle = '#121214';
      for (let y = groundSY + 14; y < H; y += 22) for (let x = ((y / 22) | 0) % 2 ? 0 : 20; x < W; x += 40) ctx.fillRect(x, y, 36, 10);
    }
  }

  function drawShaft(L) {
    const groundSY = L.cabBot + S.worldY;
    const bottom = Math.min(H, groundSY);
    ctx.fillStyle = COL.shaft; ctx.fillRect(L.shaftL, 0, L.shaftR - L.shaftL, bottom);
    ctx.fillStyle = COL.shaftRail; ctx.fillRect(L.shaftL + 4, 0, 3, bottom); ctx.fillRect(L.shaftR - 7, 0, 3, bottom);
    ctx.font = '800 10px Manrope, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    const altTop = S.worldY + L.cabBot + 10, altBot = S.worldY - (H - L.cabBot) - 10;
    const fStart = altBot <= L.lobbyH ? 0 : 1 + Math.floor((altBot - L.lobbyH) / L.FH);
    for (let f = fStart; ; f++) {
      const a0 = floorAlt(L, f); if (a0 > altTop) break;
      const y = groundSY - a0;
      ctx.fillStyle = COL.shaftTick; ctx.fillRect(L.shaftL + 4, y - 3, 16, 3); ctx.fillRect(L.shaftR - 20, y - 3, 16, 3);
      ctx.fillStyle = COL.floorNum; ctx.fillText(f === 0 ? 'L' : String(f + 1), L.shaftL + 9, y - 6);
    }
    const g = ctx.createRadialGradient(L.cx, L.cabTop + L.cabH * .5, 10, L.cx, L.cabTop + L.cabH * .5, L.cabW * 1.5);
    g.addColorStop(0, 'rgba(220,40,80,0.16)'); g.addColorStop(1, 'rgba(220,40,80,0)');
    ctx.fillStyle = g; ctx.fillRect(L.shaftL, L.cabTop - L.cabW, L.shaftR - L.shaftL, L.cabH + L.cabW * 2);
    const speed = S.phase === 'flying' ? Math.min(CFG.speedCap, CFG.speedBase * S.mult) : 0;
    if (speed > 450) {
      const a = clamp((speed - 450) / 900, 0, 0.5);
      ctx.strokeStyle = `rgba(255,255,255,${a * 0.25})`; ctx.lineWidth = 1;
      for (let i = 0; i < 6; i++) {
        const x = L.shaftL + 14 + hash2(i, 3) * (L.shaftR - L.shaftL - 28);
        const y = ((performance.now() * (0.6 + hash2(i, 5)) + i * 200) % (H + 200)) - 100;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 40 + a * 80); ctx.stroke();
      }
    }
  }

  function drawCables(L, cabTopY, snapped) {
    const xs = [L.cx - L.cabW * .42, L.cx, L.cx + L.cabW * .42];
    ctx.strokeStyle = COL.cable; ctx.lineWidth = 2;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      ctx.beginPath();
      if (!snapped) { ctx.moveTo(x, -10); ctx.lineTo(x, cabTopY); }
      else {
        const t = S.crash.t;
        const endY = L.cabTop - 40 - i * 25 + Math.sin(t * 6 + i) * 10;
        ctx.moveTo(x, -10);
        ctx.quadraticCurveTo(x + Math.sin(t * 5 + i * 2) * 26, endY - 30, x + Math.sin(t * 7 + i) * 40, endY);
      }
      ctx.stroke();
    }
  }

  function drawPerson(x, baseY, h, type) {
    ctx.fillStyle = COL.person;
    const headR = h * 0.11;
    const headY = baseY - h + headR;
    ctx.beginPath();
    const sw = h * 0.36;
    const shoulderY = baseY - h * 0.7;
    ctx.moveTo(x - sw / 2, baseY);
    ctx.lineTo(x - sw / 2, shoulderY + h * 0.08);
    ctx.quadraticCurveTo(x - sw / 2, shoulderY, x - sw / 2 + h * .06, shoulderY);
    ctx.lineTo(x - h * .06, shoulderY);
    ctx.lineTo(x - h * .06, shoulderY - h * .05);
    ctx.lineTo(x + h * .06, shoulderY - h * .05);
    ctx.lineTo(x + h * .06, shoulderY);
    ctx.lineTo(x + sw / 2 - h * .06, shoulderY);
    ctx.quadraticCurveTo(x + sw / 2, shoulderY, x + sw / 2, shoulderY + h * 0.08);
    ctx.lineTo(x + sw / 2, baseY);
    ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(x, headY, headR, 0, 6.283); ctx.fill();
    if (type === 'hat') {
      ctx.beginPath(); ctx.ellipse(x, headY - headR * .55, headR * 1.9, headR * .42, 0, 0, 6.283); ctx.fill();
      roundRect(x - headR * .95, headY - headR * 2.1, headR * 1.9, headR * 1.6, headR * .35); ctx.fill();
    } else {
      ctx.beginPath(); ctx.moveTo(x - headR * 1.15, shoulderY + h * .02);
      ctx.quadraticCurveTo(x - headR * 1.3, headY - headR * .4, x, headY - headR * 1.15);
      ctx.quadraticCurveTo(x + headR * 1.3, headY - headR * .4, x + headR * 1.15, shoulderY + h * .02);
      ctx.closePath(); ctx.fill();
    }
  }

  function drawCabin(L) {
    const { cabW, cabH, cx } = L;
    const x0 = cx - cabW / 2, y0 = L.cabTop;
    ctx.fillStyle = COL.cabBack; ctx.fillRect(x0, y0, cabW, cabH);
    const dW = cabW * 0.56, dH = cabH * 0.68, dx = cx - dW / 2, dy = y0 + cabH * 0.10;
    ctx.fillStyle = COL.doorDark; roundRect(dx - 3, dy - 3, dW + 6, dH + 3, 6); ctx.fill();
    ctx.save();
    ctx.beginPath(); ctx.rect(dx, dy, dW, dH); ctx.clip();
    const open = S.doorOpen * (dW / 2);
    ctx.fillStyle = COL.door;
    ctx.fillRect(dx - open, dy, dW / 2, dH);
    ctx.fillRect(dx + dW / 2 + open, dy, dW / 2, dH);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(dx - open + 6, dy + 6, dW / 2 - 12, dH * .45);
    ctx.fillRect(dx + dW / 2 + open + 6, dy + 6, dW / 2 - 12, dH * .45);
    ctx.fillStyle = COL.doorDark; ctx.fillRect(cx - 1 - open, dy, 2, dH); ctx.fillRect(cx - 1 + open, dy, 2, dH);
    if (S.doorOpen > 0.02) {
      const g = ctx.createLinearGradient(0, dy, 0, dy + dH);
      g.addColorStop(0, 'rgba(255,214,150,0.55)'); g.addColorStop(1, 'rgba(255,214,150,0.15)');
      ctx.fillStyle = g; ctx.fillRect(cx - open, dy, open * 2, dH);
    }
    ctx.restore();
    const floorY = y0 + cabH * 0.86;
    const ph = cabH * 0.52;
    const slotX = (slot) => cx + slot * cabW * 0.30;
    const order = [...S.passengers].sort((a, b) => (a.slot === 0 ? -1 : 1) - (b.slot === 0 ? -1 : 1));
    for (const p of order) {
      if (p.p <= 0) continue;
      const e = easeOut(p.p);
      const back = p.slot === 0 ? 1 : 0;
      const scale = lerp(0.72, back ? 0.9 : 1, e);
      const x = lerp(cx, slotX(p.slot), e);
      const y = lerp(floorY - cabH * .08, floorY - (back ? cabH * .05 : 0), e);
      const bob = S.phase === 'flying' ? Math.sin(performance.now() / 260 + p.slot * 2) * 1.2 : 0;
      ctx.globalAlpha = Math.min(1, p.p * 4);
      drawPerson(x, y + bob, ph * scale, p.type);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = '#d5163c'; roundRect(x0 + cabW * .80, y0 + cabH * .42, cabW * .07, cabW * .07, 2); ctx.fill();
    ctx.fillStyle = '#e8eef8'; roundRect(x0 + cabW * .80, y0 + cabH * .42 + cabW * .10, cabW * .07, cabW * .07, 2); ctx.fill();
    ctx.fillStyle = COL.glass; ctx.fillRect(x0, y0, cabW, cabH);
    const gh = ctx.createLinearGradient(x0, y0, x0 + cabW, y0 + cabH);
    gh.addColorStop(0, 'rgba(255,255,255,0.14)'); gh.addColorStop(.45, 'rgba(255,255,255,0.02)'); gh.addColorStop(1, 'rgba(255,255,255,0.08)');
    ctx.fillStyle = gh; ctx.fillRect(x0, y0, cabW, cabH);
    ctx.strokeStyle = COL.cabFrame; ctx.lineWidth = 5; ctx.lineJoin = 'round';
    ctx.strokeRect(x0, y0, cabW, cabH);
    ctx.strokeStyle = COL.cabBar; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x0, y0 + cabH * .78); ctx.lineTo(x0 + cabW, y0 + cabH * .78);
    ctx.moveTo(x0 + cabW * .25, y0); ctx.lineTo(x0 + cabW * .25, y0 + cabH);
    ctx.moveTo(x0 + cabW * .75, y0); ctx.lineTo(x0 + cabW * .75, y0 + cabH);
    ctx.stroke();
    ctx.fillStyle = COL.cabFrame;
    ctx.beginPath(); ctx.moveTo(x0 - 4, y0 - 2); ctx.lineTo(x0 + cabW + 4, y0 - 2); ctx.lineTo(x0 + cabW - 6, y0 - cabW * .11); ctx.lineTo(x0 + 6, y0 - cabW * .11); ctx.closePath(); ctx.fill();
    ctx.fillStyle = COL.cabFrameDark;
    ctx.beginPath(); ctx.moveTo(x0 - 4, y0 + cabH + 2); ctx.lineTo(x0 + cabW + 4, y0 + cabH + 2); ctx.lineTo(x0 + cabW - 12, y0 + cabH + cabW * .13); ctx.lineTo(x0 + 12, y0 + cabH + cabW * .13); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(x0 + 8, y0 - cabW * .11 + 1, cabW - 16, 2);
  }

  function drawParticles(L) {
    for (const p of S.particles) {
      const a = clamp(p.life, 0, 1);
      if (p.kind === 'spark') {
        ctx.fillStyle = `rgba(255,${90 + Math.floor(120 * a)},80,${a})`;
        ctx.beginPath(); ctx.arc(L.cx + p.x, L.cabTop + p.y, p.r, 0, 6.283); ctx.fill();
      } else {
        ctx.fillStyle = `rgba(213,22,60,${a})`;
        ctx.fillRect(L.cx + p.x, L.cabTop + p.y, p.r * 2.5, p.r * 1.2);
      }
    }
  }

  function draw() {
    const L = layout();
    ctx.save();
    if (S.shake > 0) {
      const s = S.shake * 9;
      ctx.translate((Math.random() - .5) * s, (Math.random() - .5) * s);
    }
    drawBuilding(L);
    drawShaft(L);
    const crashed = S.phase === 'crashed';
    drawCables(L, crashed ? L.cabTop : L.cabTop - L.cabW * .11, crashed);
    if (crashed) {
      const c = S.crash;
      ctx.save();
      ctx.translate(L.cx, L.cabTop + L.cabH / 2 + c.fallY);
      ctx.rotate(c.rot);
      ctx.translate(-L.cx, -(L.cabTop + L.cabH / 2));
      drawCabin(L);
      if (c.t < 0.35) { ctx.fillStyle = `rgba(255,80,80,${0.55 * (1 - c.t / 0.35)})`; ctx.fillRect(L.cx - L.cabW / 2, L.cabTop, L.cabW, L.cabH); }
      ctx.restore();
      drawParticles(L);
      if (c.t < 0.2) { ctx.fillStyle = `rgba(255,60,80,${0.35 * (1 - c.t / 0.2)})`; ctx.fillRect(-20, -20, W + 40, H + 40); }
    } else {
      drawCabin(L);
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ loop
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    update(dt, now);
    draw();
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ input
  el.mainBtn.addEventListener('click', onMainClick);
  $('betMinus').addEventListener('click', () => setBetAmount(S.betAmount - (S.betAmount <= 100 ? 10 : S.betAmount <= 1000 ? 50 : 500)));
  $('betPlus').addEventListener('click', () => setBetAmount(S.betAmount + (S.betAmount < 100 ? 10 : S.betAmount < 1000 ? 50 : 500)));
  $('betHalf').addEventListener('click', () => setBetAmount(S.betAmount / 2));
  $('betDouble').addEventListener('click', () => setBetAmount(S.betAmount * 2));
  el.autoBet.addEventListener('click', () => { S.autoBet = !S.autoBet; el.autoBet.classList.toggle('on', S.autoBet); if (S.autoBet && S.phase === 'countdown' && !S.bet) placeBet(); });
  // --- auto cashout panel (no inline input: keyboards would cover the controls on phones)
  function renderAutoCash() {
    el.autoCashLabel.textContent = S.autoCashVal.toFixed(2) + 'x';
    el.autoCash.classList.toggle('on', S.autoCash);
    el.cashSwitch.classList.toggle('on', S.autoCash);
    if (document.activeElement !== el.autoCashVal) el.autoCashVal.value = S.autoCashVal.toFixed(2);
    for (const b of el.cashPresets.children) b.classList.toggle('sel', parseFloat(b.dataset.v) === S.autoCashVal);
  }
  function setAutoCashVal(v) {
    S.autoCashVal = isFinite(v) && v >= 1.01 ? Math.round(clamp(v, 1.01, 1000) * 100) / 100 : 2;
    renderAutoCash(); save();
  }
  el.autoCash.addEventListener('click', () => openPanel(el.cashPanel, null));
  el.cashSwitch.addEventListener('click', () => { S.autoCash = !S.autoCash; renderAutoCash(); });
  $('cashMinus').addEventListener('click', () => setAutoCashVal(S.autoCashVal - (S.autoCashVal <= 2 ? 0.1 : S.autoCashVal <= 5 ? 0.5 : 1)));
  $('cashPlus').addEventListener('click', () => setAutoCashVal(S.autoCashVal + (S.autoCashVal < 2 ? 0.1 : S.autoCashVal < 5 ? 0.5 : 1)));
  el.cashPresets.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { setAutoCashVal(parseFloat(b.dataset.v)); S.autoCash = true; renderAutoCash(); } });
  el.autoCashVal.addEventListener('focus', () => el.autoCashVal.select());
  el.autoCashVal.addEventListener('change', () => { setAutoCashVal(parseFloat(String(el.autoCashVal.value).replace(',', '.'))); S.autoCash = true; renderAutoCash(); });
  el.autoCashVal.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.autoCashVal.blur(); });
  $('cashDone').addEventListener('click', () => { el.autoCashVal.blur(); closePanels(); });
  renderAutoCash();
  const PANELS = [[el.playersPanel, el.btnPlayers], [el.fairPanel, el.btnFair], [el.cashPanel, null]];
  function closePanels() { for (const [p, b] of PANELS) { p.classList.add('hidden'); if (b) b.classList.remove('active'); } }
  function openPanel(panel, btn) { closePanels(); panel.classList.remove('hidden'); if (btn) btn.classList.add('active'); }
  function togglePanel(panel, btn) { const show = panel.classList.contains('hidden'); closePanels(); if (show) openPanel(panel, btn); }
  el.btnPlayers.addEventListener('click', () => togglePanel(el.playersPanel, el.btnPlayers));
  el.btnFair.addEventListener('click', () => { updateFairPanel(); togglePanel(el.fairPanel, el.btnFair); });
  document.querySelectorAll('.panel-close').forEach(b => b.addEventListener('click', closePanels));
  el.resetBalance.addEventListener('click', () => { S.balance = CFG.startBalance; updateBalance(); save(); toast('BALANCE RESET'); });
  window.addEventListener('keydown', (e) => { if (e.code === 'Space' && document.activeElement !== el.autoCashVal) { e.preventDefault(); onMainClick(); } });

  // ------------------------------------------------------------------ boot
  if (location.search.includes('debug')) window.SKYLIFT = { S, CFG };
  updateBalance(); updateBet(); renderHistory();
  startCountdown();
  requestAnimationFrame(frame);
})();
