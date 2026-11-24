import { decodeSave, xpForLevel } from './save.js';
import { Engine, SKILL_ORDER, HOUR, fmtGp, fmtNum, fmtDuration, fmtMs } from './engine.js';

const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const tabsEl = $('#tabs');
const topRight = $('#topbar-right');
const STORE_KEY = 'melvor-ledger:save';
const PREF_KEY = 'melvor-ledger:prefs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = (f) => (f ? `icons/${f}` : 'icons/Icons_missing_artwork.webp');
const img = (f, alt = '', size = 24) => `<img src="${ICON(f)}" alt="${esc(alt)}" width="${size}" height="${size}" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'">`;

const svg = {
  search: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  chev: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  arrow: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  lock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  shield: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
  paste: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>',
  file: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  check: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  q: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/></svg>',
};

const MODES = {
  chain: { label: 'From scratch', desc: 'You gather every input yourself, or buy it from the shop when that is cheaper' },
  sell: { label: 'Value added', desc: 'Inputs are priced at what they would sell for, so this is pure processing profit' },
  bank: { label: 'From my bank', desc: 'Only what your current bank can fuel, and how long it lasts' },
};

const state = {
  game: null, engine: null, save: null, raw: null, explorer: false,
  tab: 'money', mode: 'chain', skill: '', q: '', passive: false, limit: 30, open: new Set(),
  bankSort: 'value', bankQ: '', bankSortTotal: true,
};
Object.assign(state, (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } })());
state.open = new Set();
const savePrefs = () => localStorage.setItem(PREF_KEY, JSON.stringify({ mode: state.mode, passive: state.passive, bankSort: state.bankSort, tab: state.tab }));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600);
}

// ---------------------------------------------------------------- boot
async function boot() {
  app.innerHTML = `<div class="loading">${img('Currencies_GoldPieces.webp', '', 56).replace('<img', '<img class="spinner-coin"')}<span>Opening the ledger…</span></div>`;
  const res = await fetch('data/game.json');
  state.game = await res.json();
  $('#game-version').textContent = state.game.gameVersion;
  state.engine = new Engine(state.game);
  const stored = localStorage.getItem(STORE_KEY);
  if (location.hash === '#explore') return startExplorer();
  if (stored) {
    try { await loadSave(stored, { quiet: true }); return; } catch { localStorage.removeItem(STORE_KEY); }
  }
  renderLanding();
}

async function loadSave(input, { quiet = false } = {}) {
  const save = await decodeSave(input);
  state.save = save; state.explorer = false;
  state.engine.setPlayer(save);
  if (typeof input === 'string') { try { localStorage.setItem(STORE_KEY, input.trim()); } catch { /* quota */ } }
  else {
    try {
      const bytes = new Uint8Array(input); let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      localStorage.setItem(STORE_KEY, btoa(s));
    } catch { /* ignore */ }
  }
  if (!quiet) toast(`Loaded ${save.header.name}'s save`);
  state.open.clear(); state.limit = 30;
  renderDashboard();
}

function startExplorer() {
  const skills = {};
  for (const m of state.game.methods) for (const r of m.r) if (r.t === 'lvl') skills[r.s] = { xp: xpForLevel(99), level: 99 };
  const shop = {};
  for (const id of Object.keys(state.game.shop)) shop[id] = 999;
  state.save = { header: { name: 'Explorer', gamemode: 'Every skill at 99', totalLevel: Object.keys(skills).length * 99, gp: 0, timestamp: new Date() }, skills, bank: {}, wallet: {}, shop, tools: {} };
  state.explorer = true;
  state.engine.setPlayer(state.save);
  if (state.mode === 'bank') state.mode = 'chain';
  if (state.tab === 'alchemy' || state.tab === 'bank') state.tab = 'money';
  renderDashboard();
}

// ---------------------------------------------------------------- landing
function renderLanding(error) {
  tabsEl.hidden = true; topRight.innerHTML = '';
  const g = state.game;
  const sk = (s) => g.skills[s]?.i;
  app.innerHTML = `
  <section class="landing fade-in">
    <div>
      <span class="eyebrow">Melvor Idle 2 · money planner</span>
      <h1 class="hero-title">Every coin your account can make, <span class="gild">ranked.</span></h1>
      <p class="hero-sub">Paste your save string and Melvor Ledger reads your levels, shop unlocks and bank. Then it ranks every money-making method you can do right now by gold per hour.</p>
      <ul class="hero-points">
        <li>${img(sk('Mining'), '', 28)}<span><b>Full production chains.</b> Ore to bar to gear, with the time to gather every input counted.</span></li>
        <li>${img(sk('Bank'), '', 28)}<span><b>Bank alchemy.</b> Find what to turn your idle stacks into before you sell them.</span></li>
        <li>${img(sk('Thieving'), '', 28)}<span><b>Real game formulas.</b> Success chances, stuns, steps and drop tables come straight from the game files.</span></li>
      </ul>
    </div>
    <div class="panel import-card">
      <h2>Import your save</h2>
      <p class="lead">Takes about ten seconds.</p>
      <ol class="steps">
        <li><span>Open Melvor Idle 2 and go to the <span class="kbd">Main menu</span></span></li>
        <li><span>On your character, choose <span class="kbd">Copy save string to clipboard</span></span></li>
        <li><span>Come back here and paste it</span></li>
      </ol>
      <div class="dropzone" id="drop">
        <label class="sr" for="save-input">Save string</label>
        <textarea id="save-input" spellcheck="false" placeholder="Paste your save string here (Ctrl+V), or drop a .sav file"></textarea>
      </div>
      <div class="import-actions">
        <button class="btn btn-gold btn-lg grow" id="paste-btn">${svg.paste} Paste from clipboard</button>
        <button class="btn btn-lg" id="load-btn">Load</button>
      </div>
      ${error ? `<div class="error" role="alert">${esc(error)}</div>` : ''}
      <div class="import-foot">
        <span class="privacy">${svg.shield} Decoded in your browser. Never uploaded.</span>
        <span>No save handy? <button class="linkish" id="explore-btn">Explore at level 99</button></span>
      </div>
      <input type="file" id="file-input" accept=".sav,.bak,.txt" hidden />
    </div>
  </section>`;

  const ta = $('#save-input');
  const go = async (input) => {
    const btn = $('#load-btn');
    btn.disabled = true; btn.textContent = 'Reading…';
    try { await loadSave(input); } catch (e) { renderLanding(e.message || String(e)); }
  };
  $('#paste-btn').onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t.trim()) throw new Error('empty');
      ta.value = t.slice(0, 200) + (t.length > 200 ? '…' : '');
      go(t);
    } catch {
      ta.focus();
      toast('Clipboard access was blocked. Press Ctrl+V in the box instead.');
    }
  };
  $('#load-btn').onclick = () => go(ta.value);
  ta.addEventListener('paste', (e) => {
    const t = e.clipboardData?.getData('text');
    if (t && t.length > 200) { e.preventDefault(); ta.value = t.slice(0, 200) + '…'; go(t); }
  });
  $('#explore-btn').onclick = () => { location.hash = 'explore'; startExplorer(); };
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('drag')));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) go(await f.arrayBuffer());
  });
  drop.addEventListener('dblclick', () => $('#file-input').click());
  $('#file-input').onchange = async (e) => { const f = e.target.files?.[0]; if (f) go(await f.arrayBuffer()); };
}

// ---------------------------------------------------------------- dashboard
function renderDashboard() {
  const e = state.engine;
  const s = state.save;
  const g = state.game;
  const tabs = state.explorer
    ? [['money', 'Money makers'], ['upcoming', 'All methods']]
    : [['money', 'Money makers'], ['alchemy', 'Bank alchemy'], ['bank', 'Your bank'], ['upcoming', 'Next unlocks']];
  if (!tabs.some(([k]) => k === state.tab)) state.tab = 'money';
  tabsEl.hidden = false;
  tabsEl.innerHTML = tabs.map(([k, l]) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="${state.tab === k}">${l}</button>`).join('');
  topRight.innerHTML = `
    <div class="char-chip">
      <div class="who"><b>${esc(s.header.name)}</b><span>${state.explorer ? 'Explorer mode' : `Total level ${fmtNum(s.header.totalLevel)}`}</span></div>
      <button class="btn btn-sm" id="reimport">${state.explorer ? 'Import save' : 'New save'}</button>
    </div>`;
  $('#reimport').onclick = () => { localStorage.removeItem(STORE_KEY); state.save = null; history.replaceState(null, '', location.pathname); renderLanding(); };

  const best = e.ranked('chain')[0];
  const bv = e.bankValue();
  const unlocked = e.unlockedMethods().length;
  const ago = s.header.timestamp ? relTime(s.header.timestamp) : '';
  const skillsShown = Object.entries(s.skills)
    .filter(([k]) => g.skills[k])
    .sort((a, b) => order(a[0]) - order(b[0]));

  app.innerHTML = `
  <section class="profile fade-in">
    <div>
      <span class="eyebrow">${state.explorer ? 'Sandbox' : 'Ledger of'}</span>
      <h1 class="profile-name">${esc(s.header.name)}</h1>
      <div class="profile-meta">
        <span class="pill">${esc(s.header.gamemode || 'Standard')}</span>
        ${state.explorer ? '<span class="pill gold">All skills 99 · all shop upgrades</span>' : `<span class="pill">Saved ${esc(ago)}</span><span class="pill">${s.header.activeAction ? `Last doing ${esc(s.header.activeAction)}` : 'Idle'}</span>`}
      </div>
    </div>
    <div class="stats stagger">
      <div class="panel stat hero"><div class="label">${img(g.skills[best?.m.s]?.i || g.currencies.GoldPieces, '', 16)}Best right now</div><div class="value num" data-count="${best ? Math.round(best.gph) : 0}">${best ? fmtGp(best.gph) : '—'}</div><div class="sub">${best ? `gp/hr · ${esc(best.m.n)}` : 'nothing unlocked yet'}</div></div>
      ${state.explorer ? explorerTiles() : `
      <div class="panel stat"><div class="label">${img(g.currencies.GoldPieces, '', 16)}Gold</div><div class="value num" data-count="${s.wallet?.GoldPieces ?? s.header.gp ?? 0}">${fmtGp(s.wallet?.GoldPieces ?? s.header.gp ?? 0)}</div><div class="sub">in your wallet</div></div>
      <div class="panel stat"><div class="label">${img(g.skills.Bank?.i, '', 16)}Bank value</div><div class="value num" data-count="${Math.round(bv.total)}">${fmtGp(bv.total)}</div><div class="sub">${fmtNum(bv.rows.length)} stacks if sold now</div></div>`}
      <div class="panel stat"><div class="label">${img(g.skills.CompletionLog?.i || g.skills.Quests?.i, '', 16)}Methods unlocked</div><div class="value num">${fmtNum(unlocked)}<span class="muted of"> / ${fmtNum(g.methods.length)}</span></div><div class="sub">across ${SKILL_ORDER.length} skills</div></div>
    </div>
  </section>
  <div class="skills-strip">
    ${skillsShown.map(([k, v]) => {
      const lo = xpForLevel(v.level), hi = xpForLevel(v.level + 1);
      const pct = v.level >= 99 ? 100 : Math.max(0, Math.min(100, ((v.xp - lo) / (hi - lo)) * 100));
      return `<div class="skill-chip" title="${esc(k)} · ${fmtNum(v.xp)} xp">${img(g.skills[k].i, k, 24)}<div><div class="lvl num">${v.level}</div><div class="nm">${esc(k)}</div></div><span class="bar" style="width:${pct}%"></span></div>`;
    }).join('')}
  </div>
  <div id="view"></div>`;

  countUp();
  tabsEl.onclick = (ev) => {
    const b = ev.target.closest('[data-tab]');
    if (!b) return;
    state.tab = b.dataset.tab; savePrefs();
    tabsEl.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', t.dataset.tab === state.tab));
    renderView();
  };
  renderView();
}

function explorerTiles() {
  const e = state.engine, g = state.game;
  const va = e.ranked('sell')[0];
  const gather = e.ranked('chain').find((x) => !x.m.in.length);
  const tile = (x, label) => `<div class="panel stat"><div class="label">${img(g.skills[x?.m.s]?.i, '', 16)}${label}</div><div class="value num" data-count="${x ? Math.round(x.gph) : 0}">${x ? fmtGp(x.gph) : '—'}</div><div class="sub">${x ? `gp/hr · ${esc(x.m.n)}` : ''}</div></div>`;
  return tile(va, 'Best value added') + tile(gather, 'Best gathering');
}

function renderView() {
  const v = $('#view');
  if (!v) return;
  if (state.tab === 'money') v.innerHTML = viewMoney();
  else if (state.tab === 'alchemy') v.innerHTML = viewAlchemy();
  else if (state.tab === 'bank') v.innerHTML = viewBank();
  else v.innerHTML = state.explorer ? viewAll() : viewUpcoming();
  bindView(v);
}

// ---------------------------------------------------------------- money makers
function rowsForMoney() {
  const e = state.engine;
  let rows = e.ranked(state.mode, { includePassive: state.passive, sortTotal: state.mode === 'bank' && state.bankSortTotal });
  if (state.skill) rows = rows.filter((x) => x.m.s === state.skill);
  if (state.q) {
    const q = state.q.toLowerCase();
    rows = rows.filter((x) => x.m.n.toLowerCase().includes(q) || x.m.s.toLowerCase().includes(q) || x.m.out.some(([it]) => e.name(it).toLowerCase().includes(q)) || x.m.in.some(([it]) => e.name(it).toLowerCase().includes(q)));
  }
  return rows;
}

function viewMoney() {
  const e = state.engine;
  const g = state.game;
  if (state.explorer && state.mode === 'bank') state.mode = 'chain';
  const all = rowsForMoney();
  const rows = all.filter((x) => x.gph > 0 || state.mode === 'bank');
  const top = rows[0];
  const max = Math.max(1, ...rows.slice(0, 50).map((x) => x.gph));
  const skills = SKILL_ORDER.filter((s) => e.ranked(state.mode, { includePassive: true }).some((x) => x.m.s === s));
  const modes = Object.entries(MODES).filter(([k]) => !(state.explorer && k === 'bank'));

  return `
  <div class="section-head"><div><h2>Money makers</h2><p>${esc(MODES[state.mode].desc)}. Base rates, before your tool and mastery bonuses.</p></div></div>
  <div class="controls">
    <div class="mode-switch" role="group" aria-label="Pricing mode" style="grid-template-columns:repeat(${modes.length},minmax(0,1fr))">
      ${modes.map(([k, m]) => `<button class="mode" data-mode="${k}" aria-pressed="${state.mode === k}"><b><span class="dot"></span>${m.label}</b><span>${m.desc}</span></button>`).join('')}
    </div>
    <div class="filter-row">
      <div class="chips" role="group" aria-label="Filter by skill">
        <button class="chip all" data-skill="" aria-pressed="${!state.skill}">All skills</button>
        ${skills.map((s) => `<button class="chip" data-skill="${s}" aria-pressed="${state.skill === s}">${img(g.skills[s]?.i, '', 18)}${s}</button>`).join('')}
      </div>
      ${state.mode === 'bank' ? `<div class="seg" role="group" aria-label="Sort"><button data-banksort="1" aria-pressed="${state.bankSortTotal}">Most total profit</button><button data-banksort="0" aria-pressed="${!state.bankSortTotal}">Fastest gp/hr</button></div>` : ''}
      ${state.mode === 'sell' ? `<label class="toggle"><input type="checkbox" id="passive" ${state.passive ? 'checked' : ''}/>Farming plots</label>` : ''}
      <div class="search">${svg.search}<input id="q" type="search" placeholder="Search item or method" value="${esc(state.q)}" aria-label="Search methods"/></div>
    </div>
  </div>
  ${state.mode === 'bank' && !rows.length ? '' : ''}
  ${top ? topPick(top) : ''}
  <div class="list" id="list">
    ${rows.length ? rows.slice(0, state.limit).map((x, i) => methodRow(x, i, max)).join('') : emptyState()}
  </div>
  ${rows.length > state.limit ? `<button class="btn more-btn" id="more">Show ${Math.min(30, rows.length - state.limit)} more <span class="muted">· ${rows.length - state.limit} left</span></button>` : ''}`;
}

function emptyState() {
  if (state.mode === 'bank') return `<div class="empty"><b>Nothing in your bank can be processed for profit right now.</b>Try <button class="linkish" data-mode="chain">From scratch</button> to see what to gather.</div>`;
  return `<div class="empty"><b>No matches.</b>Try a different skill or clear the search.</div>`;
}

function topPick(x) {
  const e = state.engine;
  const m = x.m;
  const out = m.out[0]?.[0];
  return `
  <div class="panel toppick fade-in">
    <div class="art">${img(m.i || e.items[out]?.i, m.n, 60)}</div>
    <div>
      <div class="kicker">${state.mode === 'bank' ? 'Best use of your bank' : 'Your best money maker'}</div>
      <h3>${esc(m.n)}</h3>
      <div class="meta">
        <span class="pill">${img(state.game.skills[m.s]?.i, '', 16)}${m.s} ${m.lv > 1 ? `· lvl ${m.lv}` : ''}</span>
        ${m.loc ? `<span class="pill">${esc(m.loc)}</span>` : ''}
        ${x.r.succ < 1 ? `<span class="pill warn">${Math.round(x.r.succ * 100)}% success</span>` : ''}
        ${x.bank ? `<span class="pill green">Your stock lasts ${fmtDuration(x.bank.hours)} · ${fmtGp(x.bank.total, { sign: true })} total</span>` : ''}
        ${x.chain && x.chain.steps.length ? `<span class="pill">${chainSummary(x.chain)}</span>` : ''}
        <span class="pill">${fmtNum(x.xph)} xp/hr</span>
      </div>
    </div>
    <div class="big"><div class="v num">${fmtGp(x.gph)}</div><div class="u">gold per hour</div></div>
  </div>`;
}

function chainSummary(c) {
  const made = c.steps.filter((s) => s.via.kind === 'make').length;
  const bought = c.steps.filter((s) => s.via.kind === 'buy').length;
  const parts = [];
  if (made) parts.push(`${made} input${made > 1 ? 's' : ''} self-made`);
  if (bought) parts.push(`${bought} bought`);
  return parts.join(' · ');
}

function methodRow(x, i, max) {
  const e = state.engine;
  const m = x.m;
  const id = m.id;
  const open = state.open.has(id);
  const ins = m.in.slice(0, 3);
  const outs = m.out.slice().sort((a, b) => b[1] * e.value(b[0]) - a[1] * e.value(a[0])).slice(0, 3);
  const tok = (it) => `<span class="tok" title="${esc(e.name(it))}">${img(e.items[it]?.i, e.name(it), 24)}</span>`;
  const flow = `${ins.map(([it]) => tok(it)).join('')}${m.in.length > 3 ? `<span class="more">+${m.in.length - 3}</span>` : ''}${m.in.length ? `<span class="arrow">${svg.arrow}</span>` : ''}${m.gp > 0 ? `<span class="tok gp" title="Gold">${img(state.game.currencies.GoldPieces, 'Gold', 22)}</span>` : ''}${outs.map(([it]) => tok(it)).join('')}${m.out.length > 3 ? `<span class="more">+${m.out.length - 3}</span>` : ''}`;
  const sub = [
    `${img(state.game.skills[m.s]?.i, '', 15)}${m.s}`,
    m.lv > 1 ? `lvl ${m.lv}` : '',
    m.loc ? esc(m.loc) : '',
    x.r.succ < 1 ? `${Math.round(x.r.succ * 100)}% success` : '',
    x.bank ? `lasts ${fmtDuration(x.bank.hours)}` : '',
    m.k === 'passive' ? 'per plot' : '',
  ].filter(Boolean).join('<span class="sep">·</span>');
  const pct = Math.max(2, Math.min(100, (x.gph / max) * 100));
  return `
  <div class="row ${open ? 'open' : ''}" data-id="${esc(id)}">
    <button class="row-main" aria-expanded="${open}" data-toggle="${esc(id)}">
      <span class="rank num">${i + 1}</span>
      <span class="ico">${img(m.i || e.items[m.out[0]?.[0]]?.i, '', 34)}</span>
      <span class="title"><b>${esc(m.n)}</b><span class="sub">${sub}</span></span>
      <span class="flow">${flow}</span>
      <span class="gph"><span class="v num ${x.gph < 0 ? 'neg' : ''}">${fmtGp(x.gph)}</span> <span class="u">gp/hr</span>${x.bank ? `<div class="u">${fmtGp(x.bank.total, { sign: true })} total</div>` : `<div class="meter"><i style="width:${pct}%"></i></div>`}</span>
      <span class="xph num">${fmtGp(x.xph)}<small>xp/hr</small></span>
      <span class="chev">${svg.chev}</span>
    </button>
    <div class="details"><div class="inner">${open ? details(x) : ''}</div></div>
  </div>`;
}

function details(x) {
  const e = state.engine;
  const m = x.m;
  const r = x.r;
  const line = (cls, it, q, sign, price = e.value(it), note = '') => {
    const val = q * price;
    return `<tr class="${cls}"><td class="it"><span>${img(e.items[it]?.i, '', 22)}<span>${esc(e.name(it))}${note ? ` <span class="muted">${note}</span>` : ''}</span></span></td><td class="q num">${fmtNum(q, q < 10 ? 2 : 0)}</td><td class="g num">${val > 0.5 ? sign + fmtGp(val) : '—'}</td></tr>`;
  };
  const gpLine = (gp) => (gp > 0.5 ? `<tr class="out"><td class="it"><span>${img(state.game.currencies.GoldPieces, '', 22)}<span>Gold coins</span></span></td><td class="q num"></td><td class="g num">+${fmtGp(gp)}</td></tr>` : '');
  const byValue = (a, b) => b[1] * e.value(b[0]) - a[1] * e.value(a[0]);
  let outRows, costRows, caption, split = '';
  const chained = x.chain && x.chain.steps.length;
  if (chained) {
    const bd = e.chainBreakdown(m, x.chain);
    caption = 'Per hour of play, whole chain';
    outRows = bd.outs.filter(([, q]) => q > 1e-6).sort(byValue).map(([it, q]) => line('out', it, q, '+')).join('') + gpLine(bd.gp);
    costRows = bd.bought.map((b) => line('in', b.item, b.qty, '−', b.qty ? b.gp / b.qty : 0, '· shop')).join('');
    const total = bd.split.reduce((a, s) => a + s.ms, 0) || 1;
    const hues = [42, 150, 205, 265, 12, 320, 95];
    split = `<div class="fact wide"><div class="k">Where your hour goes</div>
      <div class="split-bar">${bd.split.map((s, i) => `<i style="flex:${s.ms};--h:${hues[i % hues.length]}" title="${esc(s.m.s)}: ${esc(s.m.n)} · ${fmtMs(s.ms)}"></i>`).join('')}</div>
      <div class="split-legend">${bd.split.map((s, i) => `<span><b style="--h:${hues[i % hues.length]}"></b>${img(state.game.skills[s.m.s]?.i, '', 16)}${esc(s.m.n)} <span class="muted num">${Math.round((s.ms / total) * 60)}m</span></span>`).join('')}</div></div>`;
  } else {
    caption = 'Per hour';
    outRows = r.outs.filter(([, q]) => q > 1e-6).sort(byValue).map(([it, q]) => line('out', it, q, '+')).join('') + gpLine(r.gp);
    costRows = r.ins.map(([it, q]) => {
      if (x.sell || x.bank) {
        const have = e.bank[it] > 0;
        const b = e.buyPrice(it);
        const useShop = !have && Number.isFinite(b) && (x.bank || b < e.value(it) || !e.value(it));
        return line('in', it, q, '−', useShop ? b : e.value(it), useShop ? '· shop' : have ? '· from bank' : '');
      }
      return line('in', it, q, '−');
    }).join('');
  }
  const share = x.chain ? x.chain.share : 1;
  const totalLabel = 'Net gold per hour';

  const st = e.status(m);
  const reqs = m.r.map((q) => {
    const s = e.reqStatus(q);
    const cls = !s.known ? 'warn' : s.ok ? 'green' : 'red';
    return `<span class="pill ${cls}">${s.known ? (s.ok ? svg.check : svg.lock) : svg.q}${esc(s.text)}</span>`;
  }).join('');

  const chainLinks = x.chain && x.chain.steps.some((s) => s.via.kind === 'make')
    ? `<div class="fact wide"><div class="k">Production chain</div><div class="chain">${chainTree(x.chain)}</div></div>` : '';

  return `<div class="content">
    <table class="ledger">
      <caption>${caption}</caption>
      <thead><tr><th>Item</th><th class="q">Qty</th><th class="g">Value</th></tr></thead>
      <tbody>${outRows}${costRows}
      <tr class="total"><td colspan="2">${totalLabel}</td><td class="g num">${fmtGp(x.gph, { sign: true })}</td></tr></tbody>
    </table>
    <div class="facts">
      <div class="fact"><div class="k">Time per action</div><div class="v num">${fmtMs(r.ms)}${m.note ? ` <span class="muted" style="font-weight:400">· ${esc(m.note)}</span>` : ''}</div></div>
      <div class="fact"><div class="k">Actions / hour</div><div class="v num">${fmtNum(r.aph, 1)}</div></div>
      <div class="fact"><div class="k">${esc(m.s)} XP / hour</div><div class="v num">${fmtNum(r.xp * share)}</div></div>
      ${r.succ < 1 ? `<div class="fact"><div class="k">Success chance</div><div class="v num">${(r.succ * 100).toFixed(1)}%</div></div>`
        : chained ? `<div class="fact"><div class="k">Made per hour of play</div><div class="v num">${fmtNum((r.outs.find(([it]) => it === m.primary)?.[1] ?? 0) * share, 1)}</div></div>`
        : `<div class="fact"><div class="k">Gross value / hour</div><div class="v num">${fmtGp(r.outValue)}</div></div>`}
      ${x.bank ? `<div class="fact wide"><div class="k">Your bank</div><div class="v">Runs for <b class="gold">${fmtDuration(x.bank.hours)}</b>, ${fmtGp(x.bank.total, { sign: true })} profit total. Limited by ${x.bank.limiting.map((it) => esc(e.name(it))).join(', ')}.</div></div>` : ''}
      ${m.succ?.t === 'thieving' ? `<div class="fact wide"><div class="k">Heads up</div><div class="v" style="font-weight:400">A failed attempt stuns you for 2s and hits for up to ${m.dmg} HP, so bring food. ${m.stages > 1 ? `Takes ${m.stages} stages to finish.` : ''}</div></div>` : ''}
      ${split}
      ${chainLinks}
      <div class="fact wide"><div class="k">Requirements</div><div class="reqs">${reqs || '<span class="muted">None</span>'}</div>${st.unverified.length ? '<div class="muted" style="font-size:12px;margin-top:6px">Amber requirements cannot be read from the save yet, so they are assumed met.</div>' : ''}</div>
    </div>
  </div>`;
}

function chainTree(chain) {
  const e = state.engine;
  const costs = e.solveChains(e.unlockedMethods()).costs;
  const seen = new Set();
  const lines = [];
  const walk = (item, depth) => {
    if (depth > 5 || seen.has(item + depth)) return;
    seen.add(item + depth);
    const c = costs.get(item);
    if (!c) return;
    const pad = `style="padding-left:${depth * 18}px"`;
    if (c.via.kind === 'buy') { lines.push(`<div class="link" ${pad}>${img(e.items[item]?.i, '', 20)}${esc(e.name(item))} <span class="via">· buy for ${fmtGp(c.gp)} each</span></div>`); return; }
    const m = c.via.m;
    lines.push(`<div class="link" ${pad}>${img(e.items[item]?.i, '', 20)}${esc(e.name(item))} <span class="via">· ${esc(m.s)}: ${esc(m.n)} · ${fmtMs(c.t)} each</span></div>`);
    for (const [it] of m.in) walk(it, depth + 1);
  };
  for (const s of chain.steps) walk(s.item, 0);
  return lines.join('');
}

// ---------------------------------------------------------------- alchemy
function viewAlchemy() {
  const e = state.engine;
  const list = e.alchemy();
  return `
  <div class="section-head"><div><h2>Bank alchemy</h2><p>For every stack in your bank: sell it now, or process it into something worth more first. Inputs you would use up are counted at their sell value, so the green number is pure extra profit.</p></div></div>
  ${list.length ? `<div class="alch-grid stagger">${list.slice(0, 60).map((a) => {
    const m = a.m;
    const prim = m.out[0]?.[0];
    const ratio = a.sellNow > 0 ? (a.sellNow + a.uplift) / a.sellNow : 0;
    return `<article class="panel alch">
      <div class="alch-top"><span class="ico">${img(e.items[a.item]?.i, '', 40)}</span><div><b>${fmtNum(a.qty)} × ${esc(e.name(a.item))}</b><span>${fmtGp(e.value(a.item))} gp each</span></div></div>
      <div class="alch-vs">
        <div class="alch-opt"><div class="k">Sell now</div><div class="v num">${fmtGp(a.sellNow)}</div><div class="d">instant</div></div>
        <div class="alch-arrow">${svg.arrow}</div>
        <div class="alch-opt best"><div class="k">${esc(m.s)} first</div><div class="v num">${fmtGp(a.uplift, { sign: true })}</div><div class="d">${img(e.items[prim]?.i || m.i, '', 16)}${esc(m.n)}</div></div>
      </div>
      <div class="alch-foot"><span>${fmtDuration(a.b.hours)} of ${esc(m.s.toLowerCase())} · ${fmtGp(a.b.gpPerHour)}/hr</span>${ratio > 1.05 ? `<span class="mult">${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× the value</span>` : ''}</div>
    </article>`;
  }).join('')}</div>` : `<div class="empty"><b>No profitable processing for your current bank.</b>Your stacks are already worth the most as they are.</div>`}`;
}

// ---------------------------------------------------------------- bank
function viewBank() {
  const e = state.engine;
  const { total, rows } = e.bankValue();
  let list = rows.slice();
  if (state.bankQ) list = list.filter((r) => e.name(r.item).toLowerCase().includes(state.bankQ.toLowerCase()));
  if (state.bankSort === 'qty') list.sort((a, b) => b.qty - a.qty);
  if (state.bankSort === 'name') list.sort((a, b) => e.name(a.item).localeCompare(e.name(b.item)));
  if (state.bankSort === 'each') list.sort((a, b) => b.v - a.v);
  const top = rows[0]?.total || 1;
  return `
  <div class="section-head"><div><h2>Your bank</h2><p>${fmtNum(rows.length)} stacks worth <b class="gold">${fmtGp(total, { compact: false })} gp</b> if you sold everything now.</p></div></div>
  <div class="bank-head">
    <div class="seg" role="group" aria-label="Sort bank">
      ${[['value', 'Stack value'], ['each', 'Price each'], ['qty', 'Quantity'], ['name', 'Name']].map(([k, l]) => `<button data-bsort="${k}" aria-pressed="${state.bankSort === k}">${l}</button>`).join('')}
    </div>
    <div class="search">${svg.search}<input id="bq" type="search" placeholder="Search your bank" value="${esc(state.bankQ)}" aria-label="Search bank"/></div>
  </div>
  <div class="bank-grid" id="bank-grid">${list.map((r) => `
    <div class="tile" title="${esc(e.name(r.item))}">
      <div class="ti">${img(e.items[r.item]?.i, '', 40)}<span class="qty num">${fmtGp(r.qty)}</span></div>
      <div class="nm">${esc(e.name(r.item))}</div>
      <div class="val"><span>${fmtGp(r.v)} ea</span><b class="num">${fmtGp(r.total)}</b></div>
      <span class="share" style="width:${Math.max(1, (r.total / top) * 100)}%"></span>
    </div>`).join('')}</div>`;
}

// ---------------------------------------------------------------- upcoming
function viewUpcoming() {
  const e = state.engine;
  const list = e.upcoming(400);
  const groups = new Map();
  for (const x of list) {
    const k = x.gap <= 1 ? 'One level away' : x.gap <= 5 ? 'Within 5 levels' : x.gap <= 15 ? 'Within 15 levels' : 'Longer term';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  const g = state.game;
  return `
  <div class="section-head"><div><h2>Next unlocks</h2><p>The closest money makers you haven't unlocked yet, valued at the level where they open up, with inputs at their sell value.</p></div></div>
  ${[...groups.entries()].map(([k, xs]) => `<div class="up-group"><h3>${k}</h3>${xs.slice(0, 10).map((x) => {
    const lvReq = x.missing.find((s) => s.kind === 'lvl');
    const skill = lvReq ? lvReq.text.split(' ')[0] : x.m.s;
    const need = lvReq ? Number(lvReq.text.split(' ').pop()) : x.m.lv;
    const sv = state.save.skills[skill];
    const hi = xpForLevel(need);
    const xpLeft = sv ? Math.max(0, hi - sv.xp) : 0;
    const prog = sv ? Math.max(2, Math.min(100, (sv.xp / hi) * 100)) : 0;
    return `<div class="up-row">
      <span class="ico">${img(x.m.i || e.items[x.m.out[0]?.[0]]?.i, '', 34)}</span>
      <div class="title"><b>${esc(x.m.n)}</b><span class="sub">${img(g.skills[x.m.s]?.i, '', 15)}${x.m.s}<span class="sep">·</span><span class="need">needs ${x.missing.map((s) => esc(s.text)).join(', ')}</span></span></div>
      <div class="progress"><div class="track"><i style="width:${prog}%"></i></div><small class="num">${fmtGp(xpLeft)} xp to go</small></div>
      <div class="gph"><span class="v num">${fmtGp(x.gph)}</span> <span class="u">gp/hr</span></div>
    </div>`;
  }).join('')}</div>`).join('') || '<div class="empty"><b>Everything is unlocked.</b>Nothing left to chase.</div>'}`;
}

function viewAll() {
  // Explorer: show every method ranked by value added at 99
  const prevMode = state.mode;
  state.mode = 'sell';
  const html = viewMoney().replace('<h2>Money makers</h2>', '<h2>All methods at 99</h2>');
  state.mode = prevMode;
  return html;
}

// ---------------------------------------------------------------- events
function bindView(v) {
  v.onclick = (ev) => {
    const t = ev.target.closest('[data-toggle],[data-mode],[data-skill],[data-banksort],[data-bsort],#more');
    if (!t) return;
    if (t.dataset.toggle) {
      const id = t.dataset.toggle;
      const row = t.closest('.row');
      if (state.open.has(id)) { state.open.delete(id); row.classList.remove('open'); t.setAttribute('aria-expanded', 'false'); }
      else {
        state.open.add(id);
        const x = rowsForMoney().find((r) => r.m.id === id) || (state.tab === 'upcoming' ? null : null);
        if (x) row.querySelector('.inner').innerHTML = details(x);
        requestAnimationFrame(() => row.classList.add('open'));
        t.setAttribute('aria-expanded', 'true');
      }
      return;
    }
    if (t.dataset.mode) { state.mode = t.dataset.mode; state.limit = 30; state.open.clear(); savePrefs(); return rerender(); }
    if (t.dataset.skill !== undefined) { state.skill = t.dataset.skill; state.limit = 30; return rerender(); }
    if (t.dataset.banksort !== undefined) { state.bankSortTotal = t.dataset.banksort === '1'; return rerender(); }
    if (t.dataset.bsort) { state.bankSort = t.dataset.bsort; savePrefs(); return rerender(); }
    if (t.id === 'more') { state.limit += 30; return rerender(true); }
  };
  const q = $('#q', v);
  if (q) q.oninput = debounce(() => { state.q = q.value; state.limit = 30; rerender(false, '#q'); }, 140);
  const bq = $('#bq', v);
  if (bq) bq.oninput = debounce(() => { state.bankQ = bq.value; rerender(false, '#bq'); }, 120);
  const passive = $('#passive', v);
  if (passive) passive.onchange = () => { state.passive = passive.checked; savePrefs(); rerender(); };
}

function rerender(keepScroll = true, focusSel) {
  const y = window.scrollY;
  renderView();
  if (keepScroll) window.scrollTo({ top: y });
  if (focusSel) { const el = $(focusSel); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
}

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const order = (s) => { const i = SKILL_ORDER.indexOf(s); return i < 0 ? 99 : i; };

function relTime(d) {
  const s = (Date.now() - d.getTime()) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function countUp() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.querySelectorAll('[data-count]').forEach((el) => {
    const target = Number(el.dataset.count);
    if (!Number.isFinite(target) || target <= 0) return;
    const t0 = performance.now(), dur = 900;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 4);
      el.textContent = fmtGp(target * eased);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// global paste: paste a save string anywhere on the landing page
document.addEventListener('paste', (e) => {
  if (state.save || e.target.closest?.('textarea,input')) return;
  const t = e.clipboardData?.getData('text');
  if (t && t.length > 200) { e.preventDefault(); loadSave(t).catch((err) => renderLanding(err.message)); }
});
window.addEventListener('hashchange', () => { if (location.hash === '#explore' && state.game) startExplorer(); });

boot().catch((e) => { app.innerHTML = `<div class="empty"><b>Something went wrong loading the game data.</b>${esc(e.message)}</div>`; });
