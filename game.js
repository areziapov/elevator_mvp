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
    floorH: 78,               // px per floor (css px)
    speedBase: 70,            // px/s at 1.00x  (v = speedBase * m)
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
    stars: [],
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
    countdown: $('countdown'), cdNum: $('cdNum'), cdFill: $('cdFill'), toast: $('toast'),
    history: $('history'), betAmount: $('betAmount'), mainBtn: $('mainBtn'),
    mainTop: $('mainTop'), mainSub: $('mainSub'), autoBet: $('autoBet'), autoCash: $('autoCash'),
    autoCashVal: $('autoCashVal'), roundLabel: $('roundLabel'),
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
    S.stars = [];
    for (let i = 0; i < 60; i++) S.stars.push({ x: Math.random() * W, y: Math.random() * H * 3, r: Math.random() * 1.2 + .3, a: Math.random() });
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
      el.cdNum.textContent = remain.toFixed(2);
      el.cdFill.style.width = (remain / CFG.countdownSec * 100) + '%';
      if (t >= CFG.countdownSec && S.seedHash) launch();
    } else if (S.phase === 'flying') {
      const tf = (now - S.flightStart) / 1000;
      S.mult = Math.exp(CFG.growthK * tf);
      if (S.mult >= S.crashPoint) { doCrash(); return; }
      const v = Math.min(CFG.speedCap, CFG.speedBase * S.mult);
      S.worldY += v * dt;
      el.mult.textContent = fmtMult(S.mult);
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
    sky1: '#0a0f1f', sky2: '#0f1730', far: '#0d1428', farWin: '#161e36',
    bldgL: '#121a2f', bldgR: '#121a2f', bldgEdge: '#1b2540', floorLine: 'rgba(255,255,255,0.035)',
    winDark: '#1f2942', winLit1: '#f4c97a', winLit2: '#ffd89a', winLit3: '#e7b25f',
    shaft: 'rgba(30,40,66,0.55)', rail: '#3b4a6c', cable: '#8a97b4',
    cabFrame: '#cfd9ea', cabFrameDark: '#9fadc7', glass: 'rgba(150,175,215,0.35)', glassHi: 'rgba(220,235,255,0.28)',
    cabBack: '#2f3f63', door: '#4c628f', doorDark: '#1c2740', person: '#0a0e19',
    ground: '#151d33', road: '#0b101d', curb: '#26314d',
  };

  function layout() {
    const cabW = clamp(W * 0.27, 90, 150);
    const cabH = cabW * 1.35;
    const cx = W / 2;
    const cabTop = H * 0.40;
    const shaftHalf = cabW * 0.62;
    return { cabW, cabH, cx, cabTop, cabBot: cabTop + cabH, shaftL: cx - shaftHalf, shaftR: cx + shaftHalf };
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }

  function drawSky(L) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, COL.sky1); g.addColorStop(1, COL.sky2);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // stars (slow parallax)
    const off = (S.worldY * 0.15) % (H * 3);
    ctx.fillStyle = '#ffffff';
    for (const s of S.stars) {
      let y = (s.y + off) % (H * 3); if (y > H) continue;
      ctx.globalAlpha = 0.25 + 0.5 * s.a; ctx.beginPath(); ctx.arc(s.x, y, s.r, 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // far towers (parallax 0.35), endless tiling inside the shaft gap + above ground
    const p = 0.35;
    const groundSY = L.cabBot + S.worldY;
    const tileH = 260;
    const yoff = S.worldY * p;
    ctx.fillStyle = COL.far;
    const cols = [[L.shaftL - 20, 34], [L.shaftL + 10, 26], [L.shaftR - 40, 30], [L.shaftR + 4, 24]];
    for (let i = 0; i < cols.length; i++) {
      const [x, w] = cols[i];
      // endless far columns with dim window dots
      const top = -H; const bottom = Math.min(H, groundSY + 40);
      ctx.fillStyle = COL.far; ctx.fillRect(x, top, w, bottom - top);
      ctx.fillStyle = COL.farWin;
      const step = 22; const start = -((yoff + i * 37) % step);
      for (let y = start; y < bottom; y += step) {
        if (y > groundSY) break;
        if (hash2(i * 97 + 1, Math.round((y + yoff) / step)) < 0.5) ctx.fillRect(x + 6, y, w - 12, 8);
      }
    }
    // red antenna light on the left far tower (blinks)
    if (S.worldY < H) {
      const blink = (Math.sin(performance.now() / 300) + 1) / 2;
      const ax = L.shaftL - 3, ayy = L.cabBot - 130;
      ctx.strokeStyle = '#3a2830'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(ax, groundSY); ctx.lineTo(ax, ayy); ctx.stroke();
      ctx.fillStyle = `rgba(255,70,70,${0.5 + 0.5 * blink})`;
      ctx.beginPath(); ctx.arc(ax, ayy, 4, 0, 6.283); ctx.fill();
      ctx.fillStyle = `rgba(255,70,70,${0.15 * blink})`;
      ctx.beginPath(); ctx.arc(ax, ayy, 12, 0, 6.283); ctx.fill();
    }
  }

  function drawBuildings(L) {
    const FH = CFG.floorH;
    const groundSY = L.cabBot + S.worldY;         // screen y of altitude 0
    const speed = S.phase === 'flying' ? Math.min(CFG.speedCap, CFG.speedBase * S.mult) : 0;
    const blur = clamp((speed - 500) / 1000, 0, 1); // 0..1 motion blur factor
    const sides = [
      { x0: 0, x1: L.shaftL, id: 1 },
      { x0: L.shaftR, x1: W, id: 2 },
    ];
    for (const side of sides) {
      const bw = side.x1 - side.x0;
      if (bw <= 0) continue;
      // facade
      ctx.fillStyle = COL.bldgL;
      const topY = 0, botY = Math.min(H, groundSY);
      if (botY > topY) ctx.fillRect(side.x0, topY, bw, botY - topY);
      // edge highlight near the shaft
      ctx.fillStyle = COL.bldgEdge;
      if (side.id === 1) ctx.fillRect(side.x1 - 3, topY, 3, botY - topY); else ctx.fillRect(side.x0, topY, 3, botY - topY);
      // windows grid
      const winW = clamp(bw / 7, 14, 24), winH = winW * 1.9;
      const cols = Math.max(1, Math.floor((bw - 24) / (winW * 2.6)));
      const gap = (bw - cols * winW) / (cols + 1);
      const fMin = Math.max(0, Math.floor((S.worldY - (H - L.cabBot)) / FH) - 1);
      const fMax = Math.floor((S.worldY + L.cabBot) / FH) + 1;
      for (let f = fMin; f <= fMax; f++) {
        const floorBottomSY = groundSY - f * FH;
        const floorTopSY = floorBottomSY - FH;
        if (floorBottomSY < 0 || floorTopSY > H) continue;
        // floor separator
        ctx.fillStyle = COL.floorLine; ctx.fillRect(side.x0, floorTopSY, bw, 1);
        const wy = floorTopSY + (FH - winH) / 2;
        for (let c = 0; c < cols; c++) {
          const h = hash2(f * 7 + side.id * 1000003, c * 13 + 7);
          const lit = h < 0.42;
          const wx = side.x0 + gap + c * (winW + gap);
          if (lit) {
            ctx.fillStyle = h < 0.14 ? COL.winLit2 : h < 0.28 ? COL.winLit1 : COL.winLit3;
            if (blur > 0) { ctx.globalAlpha = 1 - blur * 0.45; roundRect(wx, wy - blur * 26, winW, winH + blur * 52, 3); ctx.fill(); ctx.globalAlpha = 1; }
            else { roundRect(wx, wy, winW, winH, 3); ctx.fill(); }
          } else {
            ctx.fillStyle = COL.winDark; roundRect(wx, wy, winW, winH, 3); ctx.fill();
          }
        }
      }
    }
    // ground / street (visible only at the start)
    if (groundSY < H + 80) {
      ctx.fillStyle = COL.ground; ctx.fillRect(0, groundSY, W, H - groundSY + 80);
      ctx.fillStyle = COL.curb; ctx.fillRect(0, groundSY, W, 4);
      ctx.fillStyle = COL.road; ctx.fillRect(0, groundSY + 26, W, H);
      ctx.fillStyle = '#2a3552';
      for (let x = 10; x < W; x += 44) ctx.fillRect(x, groundSY + 60, 22, 3);
      // lamp posts on the sidewalk
      for (const lx of [L.shaftL - 28, L.shaftR + 28]) {
        ctx.fillStyle = '#2c3855'; ctx.fillRect(lx - 2, groundSY - 70, 4, 70);
        ctx.fillRect(lx - 10, groundSY - 74, 20, 5);
        const lg = ctx.createRadialGradient(lx, groundSY - 66, 2, lx, groundSY - 66, 46);
        lg.addColorStop(0, 'rgba(255,220,150,0.55)'); lg.addColorStop(1, 'rgba(255,220,150,0)');
        ctx.fillStyle = lg; ctx.fillRect(lx - 46, groundSY - 112, 92, 92);
        ctx.fillStyle = '#ffe2a8'; roundRect(lx - 7, groundSY - 72, 14, 6, 2); ctx.fill();
      }
      // building entrances at ground level
      for (const [ex, ew] of [[L.shaftL * 0.5 - 22, 44], [L.shaftR + (W - L.shaftR) * 0.5 - 22, 44]]) {
        ctx.fillStyle = '#0d1424'; roundRect(ex, groundSY - 58, ew, 58, 4); ctx.fill();
        ctx.fillStyle = 'rgba(255,214,150,0.18)'; ctx.fillRect(ex + 4, groundSY - 54, ew - 8, 52);
        ctx.fillStyle = '#26314d'; ctx.fillRect(ex - 6, groundSY - 64, ew + 12, 6);
      }
    }
  }

  function drawShaft(L) {
    const FH = CFG.floorH;
    const groundSY = L.cabBot + S.worldY;
    const bottom = Math.min(H, groundSY);
    // translucent shaft strip
    ctx.fillStyle = COL.shaft; ctx.fillRect(L.shaftL, 0, L.shaftR - L.shaftL, bottom);
    // guide rails
    ctx.strokeStyle = COL.rail; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(L.shaftL + 1, 0); ctx.lineTo(L.shaftL + 1, bottom); ctx.moveTo(L.shaftR - 1, 0); ctx.lineTo(L.shaftR - 1, bottom); ctx.stroke();
    // floor ticks on rails
    ctx.strokeStyle = '#4a5a80'; ctx.lineWidth = 2;
    const fMin = Math.max(0, Math.floor((S.worldY - (H - L.cabBot)) / FH) - 1);
    const fMax = Math.floor((S.worldY + L.cabBot) / FH) + 1;
    ctx.beginPath();
    for (let f = fMin; f <= fMax; f++) {
      const y = groundSY - f * FH;
      if (y < 0 || y > bottom) continue;
      ctx.moveTo(L.shaftL + 1, y); ctx.lineTo(L.shaftL + 12, y);
      ctx.moveTo(L.shaftR - 12, y); ctx.lineTo(L.shaftR - 1, y);
    }
    ctx.stroke();
    // cabin light glow on the shaft
    const g = ctx.createRadialGradient(L.cx, L.cabTop + L.cabH * .5, 10, L.cx, L.cabTop + L.cabH * .5, L.cabW * 1.6);
    g.addColorStop(0, 'rgba(140,170,230,0.22)'); g.addColorStop(1, 'rgba(140,170,230,0)');
    ctx.fillStyle = g; ctx.fillRect(L.shaftL - 40, L.cabTop - L.cabW, L.shaftR - L.shaftL + 80, L.cabH + L.cabW * 2);
  }

  function drawCables(L, cabTopY, snapped) {
    const xs = [L.cx - L.cabW * .42, L.cx, L.cx + L.cabW * .42];
    ctx.strokeStyle = COL.cable; ctx.lineWidth = 1.6;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      ctx.beginPath();
      if (!snapped) { ctx.moveTo(x, -10); ctx.lineTo(x, cabTopY); }
      else {
        // broken cables curl and swing
        const t = S.crash.t;
        const endY = L.cabTop - 40 - i * 25 + Math.sin(t * 6 + i) * 10;
        ctx.moveTo(x, -10);
        ctx.quadraticCurveTo(x + Math.sin(t * 5 + i * 2) * 26, endY - 30, x + Math.sin(t * 7 + i) * 40, endY);
      }
      ctx.stroke();
    }
  }

  function drawPerson(x, baseY, h, type) {
    // simple black silhouette; x = center, baseY = feet, h = height
    ctx.fillStyle = COL.person;
    const headR = h * 0.11;
    const headY = baseY - h + headR;
    // body (torso + legs)
    ctx.beginPath();
    const sw = h * 0.36; // shoulders width
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
    // head
    ctx.beginPath(); ctx.arc(x, headY, headR, 0, 6.283); ctx.fill();
    if (type === 'hat') {
      // fedora
      ctx.beginPath(); ctx.ellipse(x, headY - headR * .55, headR * 1.9, headR * .42, 0, 0, 6.283); ctx.fill();
      roundRect(x - headR * .95, headY - headR * 2.1, headR * 1.9, headR * 1.6, headR * .35); ctx.fill();
    } else {
      // hair
      ctx.beginPath(); ctx.moveTo(x - headR * 1.15, shoulderY + h * .02);
      ctx.quadraticCurveTo(x - headR * 1.3, headY - headR * .4, x, headY - headR * 1.15);
      ctx.quadraticCurveTo(x + headR * 1.3, headY - headR * .4, x + headR * 1.15, shoulderY + h * .02);
      ctx.closePath(); ctx.fill();
    }
  }

  function drawCabin(L) {
    const { cabW, cabH, cx } = L;
    const x0 = cx - cabW / 2, y0 = L.cabTop;
    // --- interior (back wall)
    ctx.fillStyle = COL.cabBack; ctx.fillRect(x0, y0, cabW, cabH);
    // back door frame + sliding panels
    const dW = cabW * 0.56, dH = cabH * 0.68, dx = cx - dW / 2, dy = y0 + cabH * 0.10;
    ctx.fillStyle = COL.doorDark; roundRect(dx - 3, dy - 3, dW + 6, dH + 3, 6); ctx.fill();
    ctx.save();
    ctx.beginPath(); ctx.rect(dx, dy, dW, dH); ctx.clip();
    const open = S.doorOpen * (dW / 2);
    ctx.fillStyle = COL.door;
    ctx.fillRect(dx - open, dy, dW / 2, dH);
    ctx.fillRect(dx + dW / 2 + open, dy, dW / 2, dH);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(dx - open + 6, dy + 6, dW / 2 - 12, dH * .45);
    ctx.fillRect(dx + dW / 2 + open + 6, dy + 6, dW / 2 - 12, dH * .45);
    ctx.fillStyle = COL.doorDark; ctx.fillRect(cx - 1 - open, dy, 2, dH); ctx.fillRect(cx - 1 + open, dy, 2, dH);
    // lit hallway visible when open
    if (S.doorOpen > 0.02) {
      const g = ctx.createLinearGradient(0, dy, 0, dy + dH);
      g.addColorStop(0, 'rgba(255,214,150,0.55)'); g.addColorStop(1, 'rgba(255,214,150,0.15)');
      ctx.fillStyle = g; ctx.fillRect(cx - open, dy, open * 2, dH);
    }
    ctx.restore();
    // --- passengers (walk in from the door to their slots)
    const floorY = y0 + cabH * 0.86;
    const ph = cabH * 0.52;
    const slotX = (slot) => cx + slot * cabW * 0.30;
    const order = [...S.passengers].sort((a, b) => (a.slot === 0 ? -1 : 1) - (b.slot === 0 ? -1 : 1)); // middle first (behind)
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
    // control panel (orange + white buttons)
    ctx.fillStyle = '#f2a23a'; roundRect(x0 + cabW * .80, y0 + cabH * .42, cabW * .07, cabW * .07, 2); ctx.fill();
    ctx.fillStyle = '#e8eef8'; roundRect(x0 + cabW * .80, y0 + cabH * .42 + cabW * .10, cabW * .07, cabW * .07, 2); ctx.fill();
    // --- glass
    ctx.fillStyle = COL.glass; ctx.fillRect(x0, y0, cabW, cabH);
    const gh = ctx.createLinearGradient(x0, y0, x0 + cabW, y0 + cabH);
    gh.addColorStop(0, 'rgba(255,255,255,0.18)'); gh.addColorStop(.45, 'rgba(255,255,255,0.02)'); gh.addColorStop(1, 'rgba(255,255,255,0.10)');
    ctx.fillStyle = gh; ctx.fillRect(x0, y0, cabW, cabH);
    // --- frame
    ctx.strokeStyle = COL.cabFrame; ctx.lineWidth = 5; ctx.lineJoin = 'round';
    ctx.strokeRect(x0, y0, cabW, cabH);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x0, y0 + cabH * .78); ctx.lineTo(x0 + cabW, y0 + cabH * .78); // horizontal bar
    ctx.moveTo(x0 + cabW * .25, y0); ctx.lineTo(x0 + cabW * .25, y0 + cabH);
    ctx.moveTo(x0 + cabW * .75, y0); ctx.lineTo(x0 + cabW * .75, y0 + cabH);
    ctx.stroke();
    // roof (trapezoid) and base
    ctx.fillStyle = COL.cabFrame;
    ctx.beginPath(); ctx.moveTo(x0 - 4, y0 - 2); ctx.lineTo(x0 + cabW + 4, y0 - 2); ctx.lineTo(x0 + cabW - 6, y0 - cabW * .11); ctx.lineTo(x0 + 6, y0 - cabW * .11); ctx.closePath(); ctx.fill();
    ctx.fillStyle = COL.cabFrameDark;
    ctx.beginPath(); ctx.moveTo(x0 - 4, y0 + cabH + 2); ctx.lineTo(x0 + cabW + 4, y0 + cabH + 2); ctx.lineTo(x0 + cabW - 12, y0 + cabH + cabW * .13); ctx.lineTo(x0 + 12, y0 + cabH + cabW * .13); ctx.closePath(); ctx.fill();
  }

  function drawParticles(L) {
    for (const p of S.particles) {
      const a = clamp(p.life, 0, 1);
      if (p.kind === 'spark') {
        ctx.fillStyle = `rgba(255,${160 + Math.floor(80 * a)},60,${a})`;
        ctx.beginPath(); ctx.arc(L.cx + p.x, L.cabTop + p.y, p.r, 0, 6.283); ctx.fill();
      } else {
        ctx.fillStyle = `rgba(207,217,234,${a})`;
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
    drawSky(L);
    drawBuildings(L);
    drawShaft(L);
    const crashed = S.phase === 'crashed';
    drawCables(L, crashed ? L.cabTop : L.cabTop - L.cabW * .11, crashed);
    if (crashed) {
      const c = S.crash;
      ctx.save();
      ctx.translate(L.cx, L.cabTop + L.cabH / 2 + c.fallY);
      ctx.rotate(c.rot);
      ctx.translate(-L.cx, -(L.cabTop + L.cabH / 2));
      // flash the cabin red at the moment of impact
      drawCabin(L);
      if (c.t < 0.35) { ctx.fillStyle = `rgba(255,80,80,${0.55 * (1 - c.t / 0.35)})`; ctx.fillRect(L.cx - L.cabW / 2, L.cabTop, L.cabW, L.cabH); }
      ctx.restore();
      drawParticles(L);
      if (c.t < 0.2) { ctx.fillStyle = `rgba(255,120,80,${0.35 * (1 - c.t / 0.2)})`; ctx.fillRect(-20, -20, W + 40, H + 40); }
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
  el.autoCash.addEventListener('click', (e) => {
    if (e.target === el.autoCashVal) return;
    S.autoCash = !S.autoCash; el.autoCash.classList.toggle('on', S.autoCash);
  });
  el.autoCashVal.value = S.autoCashVal.toFixed(2);
  el.autoCashVal.addEventListener('focus', () => el.autoCashVal.select());
  el.autoCashVal.addEventListener('change', () => {
    const v = parseFloat(String(el.autoCashVal.value).replace(',', '.'));
    S.autoCashVal = isFinite(v) && v >= 1.01 ? Math.round(v * 100) / 100 : 2;
    el.autoCashVal.value = S.autoCashVal.toFixed(2);
    if (!S.autoCash) { S.autoCash = true; el.autoCash.classList.add('on'); }
    save();
  });
  el.autoCashVal.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.autoCashVal.blur(); });
  function togglePanel(panel, btn) {
    const other = panel === el.playersPanel ? el.fairPanel : el.playersPanel;
    const otherBtn = panel === el.playersPanel ? el.btnFair : el.btnPlayers;
    other.classList.add('hidden'); otherBtn.classList.remove('active');
    const show = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !show); btn.classList.toggle('active', show);
  }
  el.btnPlayers.addEventListener('click', () => togglePanel(el.playersPanel, el.btnPlayers));
  el.btnFair.addEventListener('click', () => { updateFairPanel(); togglePanel(el.fairPanel, el.btnFair); });
  document.querySelectorAll('.panel-close').forEach(b => b.addEventListener('click', () => {
    $(b.dataset.close).classList.add('hidden'); el.btnFair.classList.remove('active'); el.btnPlayers.classList.remove('active');
  }));
  el.resetBalance.addEventListener('click', () => { S.balance = CFG.startBalance; updateBalance(); save(); toast('BALANCE RESET'); });
  window.addEventListener('keydown', (e) => { if (e.code === 'Space' && document.activeElement !== el.autoCashVal) { e.preventDefault(); onMainClick(); } });

  // ------------------------------------------------------------------ boot
  updateBalance(); updateBet(); renderHistory();
  startCountdown();
  requestAnimationFrame(frame);
})();
