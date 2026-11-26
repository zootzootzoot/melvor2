import { decodeSave } from './save.js?v=20261126173718';
import { Engine, SKILL_ORDER, PASSIVE_SKILLS, NOT_TRAINABLE, COMBAT_SKILLS, HOUR, xpForLevel, levelFromXp, fmtGp, fmtNum, fmtDuration, fmtMs, fmtPct } from './engine.js?v=20261126173718';
import { drawCard } from './card.js?v=20261126173718';
import { $, $$, esc, img, svg, toast, relTime, debounce, bonusText, countUp } from './ui.js?v=20261126173718';

window.__fmtGp = fmtGp;
const app = $('#app');
const tabsEl = $('#tabs');
const topRight = $('#topbar-right');
const STORE_KEY = 'melvor-ledger:save';
const PREF_KEY = 'melvor-ledger:prefs';
const HIST_KEY = 'melvor-ledger:history:';
const CHARS_KEY = 'melvor-ledger:chars';

/** The game writes a placeholder "Test" game mode in every save header (Alpha 0.11.x). */
const modeName = (m) => (!m || m === 'Test' ? 'Standard' : m);

/** Every character you've imported on this device: uuid -> { name, mode, t, tl, gp, s (save string) }. */
function loadChars() { try { return JSON.parse(localStorage.getItem(CHARS_KEY)) || {}; } catch { return {}; } }
function storeChars(c) {
  try { localStorage.setItem(CHARS_KEY, JSON.stringify(c)); return true; } catch {
    // quota: drop the oldest other characters' save strings until it fits
    const keys = Object.keys(c).sort((a, b) => (c[a].t || 0) - (c[b].t || 0));
    for (const k of keys) { if (c[k].s && k !== state.save?.header?.uuid) { delete c[k].s; try { localStorage.setItem(CHARS_KEY, JSON.stringify(c)); return true; } catch { /* keep trimming */ } } }
    return false;
  }
}

const MODES = {
  best: { label: 'Best now', desc: 'Whichever pays more: making it from scratch, or using what is already in your bank' },
  chain: { label: 'From scratch', desc: 'Sustainable: you gather every input yourself, or buy it when the shop is cheaper' },
  afk: { label: 'Leave it running', desc: 'One action left going while you are away: gathering, or working through your bank' },
  next: { label: 'Coming up', desc: 'What you unlock in the next levels, and the best money makers in the game' },
};
// older views still reachable from links (bank-limited rates, value added)
const HIDDEN_MODES = { bank: { label: 'From your bank' }, sell: { label: 'Value added' } };
const TABS = {
  overview: 'Overview', plan: 'Plan', money: 'Money', train: 'Skills', quests: 'Quests', farm: 'Farm', upgrades: 'Upgrades', bank: 'Bank', unlocks: 'Next unlocks', items: 'Items',
};

const state = {
  game: null, engine: null, base: null, save: null, explorer: false,
  tab: 'overview', mode: 'best', skill: '', q: '', passive: false, limit: 30, open: new Set(),
  planView: 'route', bankView: 'use', bankSort: 'value', bankQ: '', bankSortTotal: true,
  db: { view: 'items', q: '', cat: '', skill: '', owned: false, sort: 'value', limit: 60 },
  mods: true, trainSkill: '', trainTarget: null, trainPrefer: 'xp', trainLevel: null,
  upSort: 'payback', upFilter: 'all', history: null, window: 8, horizon: 96, goal: null,
};
const PREF_FIELDS = ['goal', 'horizon', 'window', 'mode', 'passive', 'bankSort', 'tab', 'mods', 'trainSkill', 'trainPrefer', 'upSort', 'bankView', 'bankSortTotal'];
Object.assign(state, (() => {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY)) || {};
    if (!p.v2) { delete p.mode; delete p.tab; } // v2 introduced "Best overall" as the default view
    return Object.fromEntries(PREF_FIELDS.filter((k) => k in p).map((k) => [k, p[k]]));
  } catch { return {}; }
})());
if (!MODES[state.mode]) state.mode = 'best';
if (state.tab === 'alchemy') { state.tab = 'bank'; state.bankView = 'process'; }
if (state.tab === 'upcoming') state.tab = 'unlocks';
const savePrefs = () => localStorage.setItem(PREF_KEY, JSON.stringify({ v2: 1, ...Object.fromEntries(PREF_FIELDS.map((k) => [k, state[k]])) }));

const E = () => state.engine;
const G = () => state.game;
const skillIcon = (s) => G().skills[s]?.i;
const itemIcon = (it) => G().items[it]?.i;
const methodIcon = (m) => m.i || itemIcon(m.primary) || itemIcon(m.out[0]?.[0]);
const lookup = {
  item: (id) => G().items[id]?.n || id,
  cat: (id) => G().recipeCats?.[id] || id.replace(/([a-z])([A-Z])/g, '$1 $2'),
  recipe: (rid, s) => E().methods.find((m) => m.rid === rid && (!s || m.s === s))?.n || rid,
};

// ---------------------------------------------------------------- boot
async function boot() {
  app.innerHTML = `<div class="loading">${img('Currencies_GoldPieces.webp', '', 56).replace('<img', '<img class="spinner-coin"')}<span>Opening the ledger…</span></div>`;
  const res = await fetch('data/game.json?v=' + (new URL(import.meta.url).searchParams.get('v') || '1'));
  state.game = await res.json();
  $('#game-version').textContent = state.game.gameVersion;
  state.engine = new Engine(state.game);
  state.base = new Engine(state.game);
  const stored = localStorage.getItem(STORE_KEY);
  const h = parseHash();
  if (h.explore) return startExplorer();
  if (stored) {
    try { await loadSave(stored, { quiet: true }); return; } catch { localStorage.removeItem(STORE_KEY); }
  }
  renderLanding();
}

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  if (h === 'explore') return { explore: true };
  const [tab, arg] = h.split('/');
  return { tab: TABS[tab] ? tab : null, arg: arg ? decodeURIComponent(arg) : null };
}
function setHash() {
  const h = state.explorer ? '#explore' : `#${state.tab}${state.tab === 'train' && state.trainSkill ? '/' + state.trainSkill : ''}`;
  if (location.hash !== h) history.replaceState(null, '', h);
}

function applyPlayer() {
  state.planCache = new Map();
  state.reach = null;
  E().setPlayer(state.save, { useMods: state.mods });
  state.base.setPlayer(state.save, { useMods: false });
}

async function loadSave(input, { quiet = false } = {}) {
  const save = await decodeSave(input);
  state.save = save; state.explorer = false;
  applyPlayer();
  let str = null;
  if (typeof input === 'string') str = input.trim();
  else {
    try {
      const bytes = new Uint8Array(input); let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      str = btoa(s);
    } catch { /* ignore */ }
  }
  if (str) {
    try { localStorage.setItem(STORE_KEY, str); } catch { /* quota */ }
    const chars = loadChars();
    const h = save.header;
    const t = h.timestamp?.getTime?.() || Date.now();
    // keep the newest save per character
    if (!chars[h.uuid] || (chars[h.uuid].t || 0) <= t || !chars[h.uuid].s) {
      chars[h.uuid] = { name: h.name, mode: h.gamemode, t, tl: h.totalLevel, gp: save.wallet?.GoldPieces ?? h.gp ?? 0, s: str };
      storeChars(chars);
    }
  }
  state.history = recordHistory(save);
  if (!quiet) toast(save.problems?.length ? `Loaded ${save.header.name}'s save, but couldn't read: ${save.problems.join(', ')}. The game may have updated; those parts are left empty.` : `Loaded ${save.header.name}'s save`);
  state.open.clear(); state.limit = 30;
  const h = parseHash();
  if (h.tab) { state.tab = h.tab; if (h.tab === 'train' && h.arg) state.trainSkill = h.arg; }
  renderDashboard();
}

/** Keep a small per-character history of imports to show progress between them. */
function recordHistory(save) {
  const key = HIST_KEY + save.header.uuid;
  let list = [];
  try { list = JSON.parse(localStorage.getItem(key)) || []; } catch { list = []; }
  const t = save.header.timestamp?.getTime?.() || Date.now();
  const snap = {
    t, gp: save.wallet?.GoldPieces ?? save.header.gp ?? 0, tl: save.header.totalLevel,
    xp: Object.fromEntries(Object.entries(save.skills).map(([k, v]) => [k, Math.round(v.xp)])),
    bank: Math.round(E().bankValue().total),
  };
  if (!list.length || list[list.length - 1].t !== t) list.push(snap);
  list = list.slice(-60);
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* ignore */ }
  const prev = list.length > 1 ? list[list.length - 2] : null;
  return { list, prev, cur: snap };
}

function explorerSave() {
  const skills = {};
  for (const m of state.game.methods) for (const r of m.r) if (r.t === 'lvl') skills[r.s] = { xp: xpForLevel(99), level: 99 };
  const shop = {};
  for (const id of Object.keys(state.game.shop)) shop[id] = 1;
  return { header: { name: 'Explorer', gamemode: 'Every skill at 99', totalLevel: Object.keys(skills).length * 99, gp: 0, timestamp: new Date() }, skills, bank: {}, wallet: {}, shop, tools: {}, allGuild: true };
}

function startExplorer() {
  state.save = explorerSave();
  state.explorer = true;
  state.history = null;
  applyPlayer();
  if (state.mode === 'bank' || state.mode === 'best') state.mode = 'chain';
  if (!['money', 'train'].includes(state.tab)) state.tab = 'money';
  renderDashboard();
}

// ---------------------------------------------------------------- landing
function renderLanding(error) {
  tabsEl.hidden = true; topRight.innerHTML = '';
  const sk = skillIcon;
  app.innerHTML = `
  <section class="landing fade-in">
    <div>
      <span class="eyebrow">Melvor Idle 2 · companion</span>
      <h1 class="hero-title">Know exactly what to do <span class="gild">next.</span></h1>
      <p class="hero-sub">Paste your save string. Melvor Ledger reads everything in it (levels, gear, bank, quests, farm, astrology, guild ranks) and tells you where your account stands and what to do next, with every chain behind it worked out.</p>
      <ul class="hero-points">
        <li>${img(G().skills.Quests?.i || sk('Mining'), '', 28)}<span><b>Your account, read.</b> Its stage, what it leans on, the levels that open the most, and what your quests are waiting on.</span></li>
        <li>${img(sk('Smithing'), '', 28)}<span><b>One route to anything.</b> Any item, level, quest or fight: the materials from other skills, the levels they need, the gear and food, your leftovers used first.</span></li>
        <li>${img(sk('Fishing'), '', 28)}<span><b>Money and upgrades.</b> What pays most now, what to leave running, and which purchase pays for itself first.</span></li>
        <li>${img(sk('Thieving'), '', 28)}<span><b>Real game formulas.</b> Success chances, yields, combat and your bonuses, straight from the game files.</span></li>
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
  </section>
  <section class="teaser" id="teaser" aria-label="Preview"></section>`;
  setTimeout(renderTeaser, 60);

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

function renderTeaser() {
  const el = $('#teaser');
  if (!el) return;
  const e = new Engine(G());
  e.setPlayer(explorerSave());
  const money = e.ranked('chain').slice(0, 5);
  const afk = e.ranked('afk', { window: 8 }).slice(0, 3);
  const max = money[0]?.gph || 1;
  const train = ['Woodcutting', 'Mining', 'Smithing', 'Cooking'].map((k) => ({ k, o: e.trainOptions(k)[0] })).filter((x) => x.o);
  el.innerHTML = `
    <div class="teaser-head"><span class="eyebrow">A taste, with every skill at 99</span><p>Import your save and these become <em>your</em> numbers, from your own levels, upgrades and bank.</p></div>
    <div class="teaser-grid stagger">
      <div class="panel tz"><h4>Top money makers</h4>${money.map((x) => `<div class="tz-row">${img(methodIcon(x.m), '', 26)}<span><b>${esc(x.m.n)}</b><small>${img(skillIcon(x.m.s), '', 12)}${x.m.s}</small></span><span class="tz-v"><b class="num">${fmtGp(x.gph)}</b><i style="width:${(x.gph / max) * 100}%"></i></span></div>`).join('')}</div>
      <div class="panel tz"><h4>Leave running for 8 hours</h4>${afk.map((x) => `<div class="tz-row">${img(methodIcon(x.m), '', 26)}<span><b>${esc(x.m.n)}</b><small>${img(skillIcon(x.m.s), '', 12)}${x.m.s}</small></span><span class="tz-v"><b class="num">${fmtGp(x.total)}</b></span></div>`).join('')}
        <h4 style="margin-top:14px">Fastest XP</h4>${train.slice(0, 2).map((x) => `<div class="tz-row">${img(methodIcon(x.o.m), '', 26)}<span><b>${esc(x.o.m.n)}</b><small>${img(skillIcon(x.k), '', 12)}${x.k}</small></span><span class="tz-v"><b class="num blue">${fmtGp(x.o.xph)}</b><small>xp/hr</small></span></div>`).join('')}</div>
    </div>`;
}

// ---------------------------------------------------------------- dashboard
function tabList() {
  return state.explorer ? ['money', 'train', 'items'] : ['overview', 'plan', 'money', 'train', 'quests', 'farm', 'bank', 'items'];
}

function renderDashboard() {
  const e = E();
  const s = state.save;
  const g = G();
  if (state.tab === 'upgrades') { state.tab = 'plan'; state.planView = 'upgrades'; }
  if (!tabList().includes(state.tab)) state.tab = state.explorer ? 'money' : 'overview';
  tabsEl.hidden = false;
  tabsEl.innerHTML = tabList().map((k) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="${state.tab === k}">${TABS[k]}</button>`).join('');
  topRight.innerHTML = `
    <button class="btn btn-ghost btn-sm search-btn" id="open-search" aria-label="Search items (Ctrl+K)">${svg.search}<span>Search items</span><span class="kbd">Ctrl K</span></button>
    <div class="char-chip">
      <div class="who"><b>${esc(s.header.name)}</b><span>${state.explorer ? 'Explorer mode' : `Total level ${fmtNum(s.header.totalLevel)}`}</span></div>
      ${state.explorer ? '' : `<button class="btn btn-ghost btn-sm" id="open-chars" title="Switch or compare characters">${Object.keys(loadChars()).length > 1 ? `${Object.keys(loadChars()).length} characters` : 'Characters'}</button>`}
      <button class="btn btn-sm" id="reimport">${state.explorer ? 'Import save' : 'New save'}</button>
    </div>`;
  const oc = $('#open-chars'); if (oc) oc.onclick = () => openChars();
  $('#reimport').onclick = () => { localStorage.removeItem(STORE_KEY); state.save = null; history.replaceState(null, '', location.pathname); renderLanding(); };
  $('#open-search').onclick = () => openPalette();

  const best = e.ranked(state.explorer ? 'chain' : 'best')[0];
  const bv = e.bankValue();
  const ago = s.header.timestamp ? relTime(s.header.timestamp) : '';
  const skillsShown = Object.entries(s.skills).filter(([k]) => g.skills[k] && SKILL_ORDER.includes(k)).sort((a, b) => order(a[0]) - order(b[0]));
  const others = Object.entries(s.skills).filter(([k]) => g.skills[k] && !SKILL_ORDER.includes(k) && k !== 'Combat');
  const adv = state.explorer ? null : e.upgradeAdvice().find((a) => a.dGp > 0 && !a.gap);
  const hist = state.history;
  const prev = hist?.prev;
  const delta = prev ? {
    gp: hist.cur.gp - prev.gp, bank: hist.cur.bank - prev.bank, tl: (hist.cur.tl ?? 0) - (prev.tl ?? 0),
    xp: Object.entries(hist.cur.xp).reduce((a, [k, v]) => a + Math.max(0, v - (prev.xp[k] ?? v)), 0),
  } : null;
  const lvlDelta = (k) => {
    if (!prev?.xp?.[k] && prev?.xp?.[k] !== 0) return 0;
    return s.skills[k].level - levelFromXp(prev.xp[k]);
  };

  state.headSlim = state.explorer ? '' : `<div class="slimbar fade-in">
    <b class="sb-name">${esc(s.header.name)}</b>
    <span>Total level <b class="num">${fmtNum(s.header.totalLevel)}</b></span>
    ${best ? `<span>${img(skillIcon(best.m.s), '', 16)}<b class="num gold">${fmtGp(best.gph)}</b>/hr · ${esc(best.m.n)}</span>` : ''}
    <span>${img(g.currencies.GoldPieces, '', 16)}<b class="num">${fmtGp(s.wallet?.GoldPieces ?? s.header.gp ?? 0)}</b></span>
    <span>${img(g.skills.Bank?.i, '', 16)}<b class="num">${fmtGp(bv.total)}</b> in bank</span>
    <button class="linkish" data-go="overview">Overview</button>
  </div>`;
  state.headFull = `
  <section class="profile fade-in">
    <div>
      <span class="eyebrow">${state.explorer ? 'Sandbox' : 'Ledger of'}</span>
      <h1 class="profile-name">${esc(s.header.name)}</h1>
      <div class="profile-meta">
        <span class="pill">${esc(modeName(s.header.gamemode))}</span>
        ${state.explorer ? '<span class="pill gold">All skills 99 · every shop upgrade</span>' : `<span class="pill">Saved ${esc(ago)}</span>`}
        ${state.explorer ? '' : `<button class="pill btn-pill" id="copy-sum" title="Copy a short summary to paste into Discord">${svg.paste} Copy summary</button><button class="pill btn-pill" id="share-card" title="A picture of your profile to post in Discord">${svg.up} Share card</button>`}
        ${delta ? `<span class="pill green" title="Compared with your previous import (${esc(relTime(prev.t))})">${svg.up} Since ${esc(relTime(prev.t))}: ${delta.tl > 0 ? `+${delta.tl} levels · ` : ''}${fmtGp(delta.xp)} xp · ${fmtGp(delta.gp + delta.bank, { sign: true })} worth</span>` : ''}
      </div>
    </div>
    <div class="stats stagger ${state.explorer ? 'four' : ''}">
      <button class="panel stat hero" data-go="money"><div class="label">${img(skillIcon(best?.m.s) || g.currencies.GoldPieces, '', 16)}Best right now</div><div class="value num" data-count="${best ? Math.round(best.gph) : 0}">${best ? fmtGp(best.gph) : '—'}</div><div class="sub">${best ? `gp/hr · ${esc(best.m.n)}` : 'nothing unlocked yet'}</div></button>
      ${state.explorer ? explorerTiles() : `
      <div class="panel stat"><div class="label">${img(g.currencies.GoldPieces, '', 16)}Gold</div><div class="value num" data-count="${s.wallet?.GoldPieces ?? s.header.gp ?? 0}">${fmtGp(s.wallet?.GoldPieces ?? s.header.gp ?? 0)}</div><div class="sub">in your wallet</div></div>
      <button class="panel stat" data-go="bank"><div class="label">${img(g.skills.Bank?.i, '', 16)}Bank value</div><div class="value num" data-count="${Math.round(bv.total)}">${fmtGp(bv.total)}</div><div class="sub">${fmtNum(bv.rows.length)} stacks if sold now</div></button>
`}
    </div>
  </section>
  <div class="skills-strip">
    ${skillsShown.map(([k, v]) => {
      const lo = xpForLevel(v.level), hi = xpForLevel(v.level + 1);
      const pct = v.level >= 99 ? 100 : Math.max(0, Math.min(100, ((v.xp - lo) / (hi - lo)) * 100));
      const d = lvlDelta(k);
      if (PASSIVE_SKILLS.has(k)) return `<span class="skill-chip" title="${esc(k)} · ${fmtNum(v.xp)} xp">${img(g.skills[k].i, k, 24)}<div><div class="lvl num">${v.level}${d > 0 ? `<em class="up">+${d}</em>` : ''}</div><div class="nm">${esc(k)}</div></div><span class="bar" style="width:${pct}%"></span></span>`;
      return `<button class="skill-chip" data-train="${esc(k)}" title="${esc(k)} · ${fmtNum(v.xp)} xp · open in Training">${img(g.skills[k].i, k, 24)}<div><div class="lvl num">${v.level}${d > 0 ? `<em class="up">+${d}</em>` : ''}</div><div class="nm">${esc(k)}</div></div><span class="bar" style="width:${pct}%"></span></button>`;
    }).join('')}
    ${others.length ? `<span class="strip-sep"></span>` + others.map(([k, v]) => `<span class="skill-chip dim" title="${esc(k)} · not modelled yet">${img(g.skills[k].i, k, 24)}<div><div class="lvl num">${v.level}</div><div class="nm">${esc(k)}</div></div></span>`).join('') : ''}
  </div>`;
  app.innerHTML = '<div id="head"></div><div id="view"></div>';
  state.bindHead = (root) => {
  countUp(root);
  const cs = $('#copy-sum', root);
  if (cs) cs.onclick = async () => {
    const top = e.ranked('best')[0], scratch = e.ranked('chain')[0], afk = e.ranked('afk', { window: 8 })[0];
    const lines = [
      `${s.header.name} · total level ${s.header.totalLevel} · bank ${fmtGp(bv.total)}`,
      top ? `Best money maker: ${top.m.n} ${fmtGp(top.gph)} gp/hr${top.src === 'bank' ? ` (from bank, ${fmtDuration(top.bank.hours)})` : ''}` : '',
      scratch && scratch !== top ? `Best from scratch: ${scratch.m.n} ${fmtGp(scratch.gph)} gp/hr` : '',
      afk ? `Best to leave running 8h: ${afk.m.n} ${fmtGp(afk.total)}` : '',
      adv ? `Next upgrade: ${adv.s.n} (+${fmtGp(adv.dGp)} gp/hr, pays back in ${fmtDuration(adv.payback)})` : '',
      location.origin + location.pathname,
    ].filter(Boolean);
    try { await navigator.clipboard.writeText(lines.join('\n')); toast('Summary copied'); } catch { toast('Could not copy to the clipboard'); }
  };
  const sc = $('#share-card', root);
  if (sc) sc.onclick = () => openCard();
  root.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => go(b.dataset.go)));
  root.querySelectorAll('[data-train]').forEach((b) => (b.onclick = () => { state.trainSkill = b.dataset.train; state.trainTarget = null; state.trainLevel = null; go('train'); }));
  };
  tabsEl.onclick = (ev) => {
    const b = ev.target.closest('[data-tab]');
    if (!b) return;
    go(b.dataset.tab);
  };
  renderView();
}

function go(tab) {
  if (tab === 'upgrades') { tab = 'plan'; state.planView = 'upgrades'; }
  else if (tab === 'plan' && state.tab !== 'plan') state.planView = 'route';
  if (tab === 'unlocks') tab = 'overview';
  if (tab === 'bank' && !['use', 'process', 'collection', 'all'].includes(state.bankView)) state.bankView = 'use';
  state.tab = tab; savePrefs();
  tabsEl.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', t.dataset.tab === state.tab));
  renderView();
  const v = $('#view');
  if (v && v.getBoundingClientRect().top < 0) v.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function explorerTiles() {
  const e = E(), g = G();
  const va = e.ranked('sell')[0];
  const gather = e.ranked('chain').find((x) => !x.m.in.length);
  const tile = (x, label) => `<div class="panel stat"><div class="label">${img(skillIcon(x?.m.s), '', 16)}${label}</div><div class="value num" data-count="${x ? Math.round(x.gph) : 0}">${x ? fmtGp(x.gph) : '—'}</div><div class="sub">${x ? `gp/hr · ${esc(x.m.n)}` : ''}</div></div>`;
  const unlocked = e.unlockedMethods().length;
  return tile(va, 'Best value added') + tile(gather, 'Best gathering') + `<div class="panel stat"><div class="label">${img(g.skills.CompletionLog?.i, '', 16)}Methods</div><div class="value num">${fmtNum(unlocked)}</div><div class="sub">across ${SKILL_ORDER.length} skills</div></div>`;
}

function renderView() {
  const v = $('#view');
  if (!v) return;
  setHash();
  // the full profile header lives on Overview; other tabs get a slim bar
  const head = $('#head');
  const mode = state.explorer || state.tab === 'overview' ? 'full' : 'slim';
  if (head && head.dataset.mode !== mode) { head.innerHTML = mode === 'full' ? state.headFull : state.headSlim; head.dataset.mode = mode; state.bindHead?.(head); }
  const views = { overview: viewOverview, plan: viewPlan, money: viewMoney, train: viewTrain, quests: viewQuests, farm: viewFarm, items: viewItems, upgrades: viewUpgrades, bank: viewBank, unlocks: viewUnlocks };
  v.innerHTML = `<div class="view fade-in">${(views[state.tab] || viewMoney)()}</div>`;
  bindView(v);
}

function modsToggle() {
  if (state.explorer) return '';
  const count = countSources();
  return `<label class="toggle mods-toggle" title="Apply the bonuses from your shop upgrades and equipped tools"><input type="checkbox" id="mods" ${state.mods ? 'checked' : ''}/><span>Your upgrades <b class="num">${count}</b></span></label>`;
}
function countSources() {
  const s = state.save; let n = 0;
  for (const [id, c] of Object.entries(s.shop || {})) if (c > 0 && G().shop[id]?.b) n++;
  for (const id of Object.keys(s.tools || {})) if (G().items[id]?.tb) n++;
  return n;
}

// ---------------------------------------------------------------- money makers
function rowsForMoney() {
  const e = E();
  let rows = e.ranked(state.mode, { includePassive: state.passive, sortTotal: state.mode === 'bank' && state.bankSortTotal, window: state.mode === 'afk' ? state.window : 0 });
  if (state.skill) rows = rows.filter((x) => x.m.s === state.skill);
  if (state.q) {
    const q = state.q.toLowerCase();
    rows = rows.filter((x) => x.m.n.toLowerCase().includes(q) || x.m.s.toLowerCase().includes(q) || x.m.out.some(([it]) => e.name(it).toLowerCase().includes(q)) || x.m.in.some(([it]) => e.name(it).toLowerCase().includes(q)));
  }
  return rows;
}

function moneySwitch() {
  const modes = Object.entries(MODES).filter(([k]) => !(state.explorer && (k === 'bank' || k === 'best' || k === 'next')));
  return `<div class="mode-switch" role="tablist" aria-label="Pricing" style="--n:${modes.length}">
      ${modes.map(([k, m]) => `<button class="mode" role="tab" data-mode="${k}" aria-selected="${state.mode === k}"><b><span class="dot"></span>${m.label}</b><span>${m.desc}</span></button>`).join('')}
    </div>`;
}

function viewMoney() {
  const e = E();
  if (state.explorer && (state.mode === 'bank' || state.mode === 'best' || state.mode === 'next')) state.mode = 'chain';
  if (state.mode === 'next') return `<div class="controls" style="margin-top:18px">${moneySwitch()}</div>${viewUnlocks()}`;
  const afk = state.mode === 'afk';
  const rows = rowsForMoney().filter((x) => (afk ? x.total > 0 : x.gph > 0) || state.mode === 'bank');
  const top = rows[0];
  const max = Math.max(1, ...rows.slice(0, 50).map((x) => (afk ? x.total : x.gph)));
  const all = e.ranked(state.mode, { includePassive: true });
  const skills = SKILL_ORDER.filter((s) => all.some((x) => x.m.s === s));
  const modes = Object.entries(MODES).filter(([k]) => !(state.explorer && (k === 'bank' || k === 'best')));
  const bankCount = state.mode === 'best' ? rows.filter((x) => x.src === 'bank').length : 0;

  return `
  <div class="section-head">
    <div><h2>Money makers</h2><p>Ranked by gold per hour for ${state.explorer ? 'a maxed account' : 'your levels, upgrades and bank'}.${state.mode === 'best' && bankCount ? ` <span class="gold">${bankCount}</span> of them run on items already in your bank.` : ''} Open any row for the full breakdown; click an item icon to look it up.</p></div>
    ${modsToggle()}
  </div>
  <div class="controls">
    <div class="mode-switch" role="tablist" aria-label="Pricing" style="--n:${modes.length}">
      ${modes.map(([k, m]) => `<button class="mode" role="tab" data-mode="${k}" aria-selected="${state.mode === k}"><b><span class="dot"></span>${m.label}</b><span>${m.desc}</span></button>`).join('')}
    </div>
    <div class="filter-row">
      <div class="chips" role="group" aria-label="Filter by skill">
        <button class="chip all" data-skill="" aria-pressed="${!state.skill}">All skills</button>
        ${skills.map((s) => `<button class="chip" data-skill="${s}" aria-pressed="${state.skill === s}">${img(skillIcon(s), '', 18)}${s}</button>`).join('')}
      </div>
      ${state.mode === 'bank' ? `<div class="seg" role="group" aria-label="Sort"><button data-banksort="1" aria-pressed="${state.bankSortTotal}">Most total profit</button><button data-banksort="0" aria-pressed="${!state.bankSortTotal}">Fastest gp/hr</button></div>` : ''}
      ${afk ? `<div class="seg" role="group" aria-label="Time away">${[1, 4, 8, 12, 24].map((h) => `<button data-window="${h}" aria-pressed="${state.window === h}">${h}h</button>`).join('')}</div>` : ''}
      ${state.mode === 'sell' ? `<label class="toggle"><input type="checkbox" id="passive" ${state.passive ? 'checked' : ''}/>Farming plots</label>` : ''}
      <div class="search">${svg.search}<input id="q" type="search" placeholder="Search item or method" value="${esc(state.q)}" aria-label="Search methods"/></div>
    </div>
  </div>
  ${!state.explorer && (state.mode === 'best' || state.mode === 'chain') && !state.skill && !state.q ? reachBanner() : ''}
  ${state.skill === 'Combat' ? fighterBanner() + slayerPanel() + reachPanel() : ''}
  ${top ? topPick(top) : ''}
  <div class="list" id="list">
    ${rows.length ? rows.slice(0, state.limit).map((x, i) => methodRow(x, i, max)).join('') : emptyMoney()}
  </div>
  ${rows.length > state.limit ? `<button class="btn more-btn" id="more">Show ${Math.min(30, rows.length - state.limit)} more <span class="muted">· ${rows.length - state.limit} left</span></button>` : ''}`;
}

function reachBanner() {
  const b = E().betterUnlocks();
  const x = b.list.filter((y) => y.beatsAll).sort((p, q) => p.hours - q.hours)[0];
  if (!x) return '';
  const n = x.needs[0];
  return `<button class="reach panel" data-tskill-go="${esc(n?.skill || x.m.s)}" data-target-go="${n?.level || x.m.lv}">
    <span class="reach-k">${svg.spark} Within reach</span>
    ${img(methodIcon(x.m), '', 30)}
    <span><b>${esc(x.m.n)}</b> pays <b class="gold">${fmtGp(x.gph)}/hr</b>, <span class="green">+${fmtGp(x.gain)}</span> over your best today. Needs ${[...x.needs.map((k) => `${esc(k.skill)} ${k.level}`), ...(x.kills || []).map((k) => `${fmtNum(k.left)} ${esc(k.name)} kills`)].join(' + ')}, about <b>${fmtDuration(x.hours)}</b>${x.kills?.length && !x.needs.length ? '' : ' of training'}.</span>
    <span class="reach-go">Plan it ${svg.arrow}</span>
  </button>`;
}

function emptyMoney() {
  if (state.q || state.skill) return `<div class="empty"><b>No matches.</b>Try a different skill or clear the search.</div>`;
  if (state.mode === 'bank') return `<div class="empty"><b>Nothing in your bank can be processed for profit right now.</b>Try <button class="linkish" data-mode="chain">From scratch</button> to see what to gather.</div>`;
  return `<div class="empty"><b>Nothing profitable is unlocked yet.</b>The <button class="linkish" data-gotab="overview">Overview</button> shows which levels open the most.</div>`;
}

function srcTag(x) {
  if (x.src === 'bank' && state.mode !== 'bank') return `<span class="tag green" title="Uses items already in your bank">From bank · ${fmtDuration(x.bank.hours)}</span>`;
  if (state.mode === 'best' && x.src === 'chain') return `<span class="tag">${x.m.in.length ? 'From scratch' : 'Gathering'}</span>`;
  return '';
}

function topPick(x) {
  const m = x.m;
  const afk = state.mode === 'afk';
  const kicker = state.mode === 'bank' ? 'Best use of your bank' : state.mode === 'sell' ? 'Best value added' : afk ? `Best to leave running for ${state.window}h` : 'Your best money maker';
  return `
  <div class="panel toppick fade-in" data-open-row="${esc(m.id)}">
    <div class="art">${img(methodIcon(m), m.n, 60)}</div>
    <div>
      <div class="kicker">${kicker}</div>
      <h3>${esc(m.n)}</h3>
      <div class="meta">
        <span class="pill">${img(skillIcon(m.s), '', 16)}${m.s} ${m.lv > 1 ? `· lvl ${m.lv}` : ''}</span>
        ${m.loc ? `<span class="pill">${esc(m.loc)}</span>` : ''}
        ${x.r.succ < 1 ? `<span class="pill warn">${Math.round(x.r.succ * 100)}% success</span>` : ''}
        ${x.bank && !afk ? `<span class="pill green">Your stock lasts ${fmtDuration(x.bank.hours)} · ${fmtGp(x.bank.total, { sign: true })} total</span>` : ''}
        ${afk ? `<span class="pill">${fmtGp(x.gph)} gp/hr</span>` : ''}
        ${x.src === 'chain' && x.chain.steps.length ? `<span class="pill">${chainSummary(x.chain)}</span>` : ''}
        <span class="pill">${fmtNum(x.xph)} xp/hr</span>
      </div>
    </div>
    <div class="big"><div class="v num">${fmtGp(afk ? x.total : x.gph)}</div><div class="u">${afk ? `gold over ${state.window}h${x.hours < state.window ? ` · stock lasts ${fmtDuration(x.hours)}` : ''}` : 'gold per hour'}</div></div>
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

const tok = (it, size = 24) => `<span class="tok" title="${esc(E().name(it))}" data-item="${esc(it)}">${img(itemIcon(it), E().name(it), size)}</span>`;

function methodRow(x, i, max) {
  const e = E();
  const m = x.m;
  const id = m.id;
  const open = state.open.has(id);
  const ins = m.in.slice(0, 3);
  const outs = x.r.outs.slice().sort((a, b) => b[1] * e.value(b[0]) - a[1] * e.value(a[0])).slice(0, 3);
  const flow = `${ins.map(([it]) => tok(it)).join('')}${m.in.length > 3 ? `<span class="more">+${m.in.length - 3}</span>` : ''}${m.in.length ? `<span class="arrow">${svg.arrow}</span>` : ''}${x.r.gp > 0 ? `<span class="tok gp" title="Gold">${img(G().currencies.GoldPieces, 'Gold', 22)}</span>` : ''}${outs.map(([it]) => tok(it)).join('')}${x.r.outs.length > 3 ? `<span class="more">+${x.r.outs.length - 3}</span>` : ''}`;
  const sub = [
    `${img(skillIcon(m.s), '', 15)}${m.s}`,
    m.lv > 1 ? `lvl ${m.lv}` : '',
    m.loc ? esc(m.loc) : '',
    x.r.succ < 1 ? `${Math.round(x.r.succ * 100)}% success` : '',
    state.mode === 'bank' ? `lasts ${fmtDuration(x.bank.hours)}` : '',
    state.mode === 'afk' && x.hours < state.window ? `<span class="warn-t">stock runs out after ${fmtDuration(x.hours)}</span>` : '',
    state.mode === 'afk' && x.shopOnly ? 'buys its inputs' : '',
    m.k === 'passive' ? 'per plot' : '',
    x.r.extra?.loadout ? `${esc(x.r.extra.loadout.style)}${x.r.extra.loadout.gear.Weapon ? ` · ${esc(G().items[x.r.extra.loadout.gear.Weapon]?.n || '')}` : ''}${x.r.extra.loadout.spell ? ` · ${esc(G().combat.spells[x.r.extra.loadout.spell].n)}` : ''}` : '',
  ].filter(Boolean).join('<span class="sep">·</span>');
  const afk = state.mode === 'afk';
  const pct = Math.max(2, Math.min(100, ((afk ? x.total : x.gph) / max) * 100));
  return `
  <div class="row ${open ? 'open' : ''}" data-id="${esc(id)}">
    <button class="row-main" aria-expanded="${open}" data-toggle="${esc(id)}">
      <span class="rank num">${i + 1}</span>
      <span class="ico">${img(methodIcon(m), '', 34)}</span>
      <span class="title"><b>${esc(m.n)} ${srcTag(x)}</b><span class="sub">${sub}</span></span>
      <span class="flow">${flow}</span>
      <span class="gph"><span class="v num ${x.gph < 0 ? 'neg' : ''}">${fmtGp(afk ? x.total : x.gph)}</span> <span class="u">${afk ? `in ${state.window}h` : 'gp/hr'}</span>${x.bank && state.mode === 'bank' ? `<div class="u">${fmtGp(x.bank.total, { sign: true })} total</div>` : `<div class="meter"><i style="width:${pct}%"></i></div>`}</span>
      <span class="xph num">${fmtGp(x.xph)}<small>xp/hr</small></span>
      <span class="chev">${svg.chev}</span>
    </button>
    <div class="details"><div class="inner">${open ? details(x) : ''}</div></div>
  </div>`;
}

function upgradesFact(m, r) {
  if (state.explorer || !state.mods) return '';
  const srcs = E().modSources(m);
  if (!srcs.length) return '';
  const b = state.base.rate(m);
  const speed = b.ms / r.ms - 1;
  const outGain = b.outValue > 0 ? r.outValue / b.outValue - 1 : 0;
  const xpGain = b.xp > 0 ? r.xp / b.xp - 1 : 0;
  const parts = [];
  if (Math.abs(speed) > 0.005) parts.push(`${speed > 0 ? '+' : ''}${fmtPct(speed)} speed`);
  if (Math.abs(outGain) > 0.005) parts.push(`${outGain > 0 ? '+' : ''}${fmtPct(outGain)} output value`);
  if (Math.abs(xpGain) > 0.005) parts.push(`${xpGain > 0 ? '+' : ''}${fmtPct(xpGain)} xp`);
  return `<div class="fact wide"><div class="k">Your upgrades on this ${parts.length ? `<span class="gain">${parts.join(' · ')}</span>` : ''}</div>
    <div class="srcs">${srcs.map(({ src, fx }) => `<span class="src" title="${esc(fx.map((f) => { const t = bonusText([null, f.name, f.v, {}]); return `${t.val} ${t.label}`; }).join(', '))}">${img(src.i || itemIcon(src.id), '', 18)}${esc(src.n)}</span>`).join('')}</div></div>`;
}

function details(x) {
  const e = E();
  const m = x.m;
  const r = x.r;
  const line = (cls, it, q, sign, price = e.value(it), note = '') => {
    const val = q * price;
    return `<tr class="${cls}"><td class="it"><span data-item="${esc(it)}">${img(itemIcon(it), '', 22)}<span>${esc(e.name(it))}${note ? ` <span class="muted">${note}</span>` : ''}</span></span></td><td class="q num">${fmtQty(q)}</td><td class="g num">${val > 0.5 ? sign + fmtGp(val) : '—'}</td></tr>`;
  };
  const gpLine = (gp) => (gp > 0.5 ? `<tr class="out"><td class="it"><span>${img(G().currencies.GoldPieces, '', 22)}<span>Gold coins</span></span></td><td class="q num"></td><td class="g num">+${fmtGp(gp)}</td></tr>` : '');
  const byValue = (a, b) => b[1] * e.value(b[0]) - a[1] * e.value(a[0]);
  let outRows, costRows, caption, split = '';
  const chained = x.src === 'chain' && x.chain && x.chain.steps.length;
  if (chained) {
    const bd = e.chainBreakdown(m, x.chain);
    caption = 'Per hour of play, whole chain';
    outRows = bd.outs.filter(([, q]) => q > 1e-6).sort(byValue).map(([it, q]) => line('out', it, q, '+')).join('') + gpLine(bd.gp);
    costRows = bd.bought.map((b) => line('in', b.item, b.qty, '−', b.qty ? b.gp / b.qty : 0, '· shop')).join('');
    const total = bd.split.reduce((a, s) => a + s.ms, 0) || 1;
    const hues = [42, 150, 205, 265, 12, 320, 95];
    const xpBy = new Map();
    for (const sp of bd.split) { const rr = e.rate(sp.m); if (rr.xp > 0) xpBy.set(sp.m.s, (xpBy.get(sp.m.s) || 0) + rr.xp * sp.ms / HOUR); }
    const xpLine = [...xpBy.entries()].sort((a, b) => b[1] - a[1]).map(([sk, v]) => `${img(skillIcon(sk), '', 14)}<b class="num">${fmtGp(v)}</b> ${esc(sk)}`).join('<span class="sep">·</span>');
    split = `<div class="fact wide"><div class="k">XP per hour of play, whole chain</div><div class="v xpline">${xpLine || '<span class="muted">none</span>'}</div></div><div class="fact wide"><div class="k">Where your hour goes</div>
      <div class="split-bar">${bd.split.map((s, i) => `<i style="flex:${s.ms};--h:${hues[i % hues.length]}" title="${esc(s.m.s)}: ${esc(s.m.n)} · ${fmtMs(s.ms)}"></i>`).join('')}</div>
      <div class="split-legend">${bd.split.map((s, i) => `<span><b style="--h:${hues[i % hues.length]}"></b>${img(skillIcon(s.m.s), '', 16)}${esc(s.m.n)} <span class="muted num">${Math.round((s.ms / total) * 60)}m</span></span>`).join('')}</div></div>`;
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
  const share = x.src === 'chain' && x.chain ? x.chain.share : 1;

  const st = e.status(m);
  const reqs = m.r.map((q) => {
    const s = e.reqStatus(q);
    const cls = !s.known ? 'warn' : s.ok ? 'green' : 'red';
    return `<span class="pill ${cls}">${s.known ? (s.ok ? svg.check : svg.lock) : svg.q}${esc(s.text)}</span>`;
  }).join('');
  const chainLinks = x.src === 'chain' && x.chain && x.chain.steps.some((s) => s.via.kind === 'make')
    ? `<div class="fact wide"><div class="k">Production chain</div><div class="chain">${chainTree(x.chain)}</div></div>` : '';
  const compare = state.mode === 'best' && (x.bankAlt || (x.src === 'bank' && x.chain))
    ? `<div class="fact wide"><div class="k">Both ways</div><div class="v both">
        <span>From scratch <b class="num">${fmtGp(x.src === 'bank' ? x.chain.gpPerHour : x.gph)}</b>/hr</span>
        <span>From your bank <b class="num green">${fmtGp(x.src === 'bank' ? x.gph : x.bankAlt.gpPerHour)}</b>/hr for ${fmtDuration((x.src === 'bank' ? x.bank : x.bankAlt).hours)}</span></div></div>` : '';
  const ex = r.extra || {};
  const timeNote = m.x?.t === 'fight' ? 'per kill, including the 3s respawn' : m.x?.t === 'hunt' ? `${fmtNum(ex.surveys, 1)} surveys, ${fmtNum(ex.steps, 1)} steps, ${fmtNum(ex.attempts, 1)} trap tries` : m.x?.t === 'herb' ? `${fmtMs(ex.batch)} per brew of ${ex.bottles}` : m.x?.t === 'wc' ? `${fmtNum(ex.hits, 1)} swings` : m.x?.t === 'mine' ? `~${fmtNum(ex.hits, 1)} swings` : m.x?.t === 'art' && ex.steps > 1 ? `${fmtNum(ex.stepsTaken, 1)} of ${ex.steps} steps` : (m.note || '');

  return `<div class="content">
    <table class="ledger">
      <caption>${caption}</caption>
      <thead><tr><th>Item</th><th class="q">Qty</th><th class="g">Value</th></tr></thead>
      <tbody>${outRows}${costRows}
      <tr class="total"><td colspan="2">Net gold per hour</td><td class="g num">${fmtGp(x.gph, { sign: true })}</td></tr></tbody>
    </table>
    <div class="facts">
      <div class="fact"><div class="k">Time per action</div><div class="v num">${fmtMs(r.ms)}${timeNote ? ` <span class="muted" style="font-weight:400">· ${esc(timeNote)}</span>` : ''}</div></div>
      <div class="fact"><div class="k">Actions / hour</div><div class="v num">${fmtNum(r.aph, 1)}</div></div>
      <div class="fact"><div class="k">${esc(m.s)} XP / hour</div><div class="v num">${fmtNum(r.xp * share)}</div></div>
      ${r.succ < 1 ? `<div class="fact"><div class="k">Success chance</div><div class="v num">${(r.succ * 100).toFixed(1)}%</div></div>`
        : ex.preserve > 0 ? `<div class="fact"><div class="k">Ingredients kept</div><div class="v num">${fmtPct(ex.preserve, 1)}</div></div>`
        : chained ? `<div class="fact"><div class="k">Made per hour of play</div><div class="v num">${fmtNum((r.outs.find(([it]) => it === m.primary)?.[1] ?? 0) * share, 1)}</div></div>`
        : `<div class="fact"><div class="k">Gross value / hour</div><div class="v num">${fmtGp(r.outValue)}</div></div>`}
      ${compare}
      ${x.bank && !compare ? `<div class="fact wide"><div class="k">Your bank</div><div class="v">Runs for <b class="gold">${fmtDuration(x.bank.hours)}</b>, ${fmtGp(x.bank.total, { sign: true })} profit total. Limited by ${x.bank.limiting.map((it) => esc(e.name(it))).join(', ')}.</div></div>` : ''}
      ${m.x?.t === 'fight' ? fightFacts(x, r) : ''}
      ${m.x?.t === 'dungeon' ? dungeonFacts(r) : ''}
      ${m.x?.t === 'thv' ? `<div class="fact wide"><div class="k">Heads up</div><div class="v" style="font-weight:400">A failed attempt stuns you for ${fmtMs(ex.stun || 2000)} and hits for up to ${m.dmg} HP, so bring food. ${ex.stages > 1 ? `Takes ${ex.stages} stages to finish.` : ''}</div></div>` : ''}
      ${upgradesFact(m, r)}
      ${split}
      ${chainLinks}
      <div class="fact wide"><div class="k">Requirements</div><div class="reqs">${reqs || '<span class="muted">None</span>'}</div>${st.unverified.length ? '<div class="muted" style="font-size:12px;margin-top:6px">Amber requirements cannot be read from the save yet, so they are assumed met.</div>' : ''}</div>
    </div>
  </div>`;
}

const STYLE_SKILL = { Melee: 'Attack', Ranged: 'Ranged', Magic: 'Magic' };
function loadoutIcons(l, size = 22) {
  if (!l) return '';
  const g = G();
  const order = ['Weapon', 'Ammo', 'Offhand', 'Helmet', 'Torso', 'Legs', 'Gloves', 'Boots', 'Amulet', 'Cape', 'RingSlot1', 'RingSlot2'];
  const items = order.map((s) => l.gear[s]).filter(Boolean);
  const spell = l.spell ? g.combat.spells[l.spell] : null;
  return `<span class="loadout">${items.map((it) => `<span class="lo" data-item="${esc(it)}" title="${esc(g.items[it]?.n || it)}">${img(g.items[it]?.i, '', size)}</span>`).join('')}${spell ? `<span class="lo spell" title="${esc(spell.n)}">${img(spell.i, '', size)}</span>` : ''}</span>`;
}
function styleTag(style) {
  return `<span class="tag style-${(style || '').toLowerCase()}">${img(skillIcon(STYLE_SKILL[style]), '', 12)}${esc(style || '')}</span>`;
}

function fightFacts(x, r) {
  const f = r.extra?.fight;
  if (!f) return '';
  const e = E();
  const st = G().combat.stances[f.stance];
  const foodHr = r.ins.find(([it]) => it === r.extra.food)?.[1] || 0;
  const danger = f.danger >= 0.5 ? 'red' : f.danger >= 0.25 ? 'warn' : 'green';
  const l = r.extra?.loadout;
  const notes = [];
  if (f.triangle) notes.push(`${f.triangle > 0 ? '+' : ''}${fmtPct(f.triangle, 0)} max hit from the combat triangle (${esc(l?.style || '')} vs ${esc(f.enemyStyle)})`);
  if (f.element) notes.push(`${f.element > 0 ? '+' : ''}${fmtPct(f.element, 0)} max hit from elements`);
  const en = G().combat.enemies[x.m.x?.e];
  if (en?.atk?.length) notes.push(`special attacks counted (${en.atk.map(([c, a]) => `${esc(a.n)} ${Math.round(c * 100)}%`).join(', ')}): ${fmtPct(f.specialShare || 0, 0)} of the damage you take`);
  if (en?.pas?.length) notes.push(`passives not modelled: ${en.pas.map(esc).join(', ')}`);
  return `<div class="fact wide"><div class="k">Best loadout from your gear ${l ? styleTag(l.style) : ''}</div>${loadoutIcons(l, 26)}${notes.length ? `<div class="muted" style="font-size:12px;margin-top:6px">${notes.join(' · ')}</div>` : ''}</div>
  <div class="fact wide"><div class="k">The fight</div><div class="fight">
    <span><small>Your stance</small><b>${esc(st?.n || f.stance)}</b></span>
    <span><small>Hit chance</small><b class="num">${fmtPct(f.hc, 0)}</b></span>
    <span><small>Your max hit</small><b class="num">${fmtNum(f.mh)}</b></span>
    <span><small>Per kill</small><b class="num">${fmtMs(r.ms)}</b></span>
    <span><small>Enemy max hit</small><b class="num ${danger}">${fmtNum(f.enemyMax)}</b><small>${fmtPct(f.danger, 0)} of your HP</small></span>
    <span><small>Damage taken</small><b class="num">${fmtNum(f.takenPerKill * r.aph)}/hr</b>${foodHr > 0 ? `<small>~${fmtNum(foodHr, 1)} ${esc(e.name(r.extra.food))}/hr</small>` : ''}</span>
  </div>${G().combat.enemies[x.m.rid]?.special ? '<div class="muted" style="font-size:12px;margin-top:6px">This enemy has special attacks or passives that are not modelled, so expect more damage taken than shown.</div>' : ''}</div>`;
}

function dungeonFacts(r) {
  const d = r.extra?.dungeon;
  if (!d) return '';
  const C = G().combat;
  return `<div class="fact wide"><div class="k">The run · ${fmtMs(d.runMs)} · loot only at the end</div><div class="waves">${d.waves.map((w) => {
    const en = C.enemies[w.eid];
    return `<div class="wave">${img(en?.i, '', 26)}<span><b>${w.n > 1 ? `${fmtNum(w.n, 1)} × ` : ''}${esc(en?.n || w.eid)}</b><small>${esc(w.plan.style)} · ${fmtMs(w.plan.f.aliveMs)} each · enemy max hit ${fmtPct(w.plan.f.danger, 0)} of HP</small></span></div>`;
  }).join('')}</div><div class="muted" style="font-size:12px;margin-top:6px">Each enemy uses its best loadout from your gear. Switching gear between waves is up to you.</div></div>`;
}

// fights you can't farm yet: what it takes (training + gear) and what they'd pay, computed on demand
function reachPanel() {
  if (state.explorer) return '';
  const rows = state.reach?.rows || [];
  const busy = state.reach && !state.reach.done;
  return `<div class="panel reach-panel" id="reach">
    <div class="sl-h">${svg.target}<b>Fights within reach</b><span class="muted">enemies you can't farm safely yet, and the training and gear that would change that</span>
      ${state.reach ? '' : '<button class="btn btn-sm btn-gold" id="reach-go">Find them</button>'}</div>
    ${rows.length ? `<div class="rch-list">${rows.map((x) => `<div class="rch-row ${x.rd?.reached && x.gph > 0 ? '' : 'far'}">${img(x.m.i, '', 30)}
      <span class="rch-main"><b>${esc(x.m.n)}</b><small>${esc(x.m.loc || '')}${x.rd?.reached ? ' · ' + [...(x.area || []).map(([sk, l]) => `${sk} ${l} to enter`), ...x.rd.steps.map((s) => s.kind === 'train' ? `${s.skill} ${s.level}` : esc(E().name(s.id)))].join(', ') : x.rd ? ' · ' + esc(x.rd.why || 'out of reach') : ''}</small></span>
      <span class="fm-v"><b class="num">${x.rd?.reached ? fmtDuration(x.rd.total + (x.areaHours || 0)) : '—'}</b><small>to get ready</small></span>
      <span class="fm-v"><b class="num ${x.gph > 0 ? 'gold' : 'red'}">${x.rd?.reached ? fmtGp(x.gph) : '—'}</b><small>${x.rd?.reached && x.gph <= 0 ? 'eats more than it drops' : 'gp/hr then'}</small></span>
      ${x.rd?.reached ? `<button class="btn btn-sm" data-ready-go="${esc(x.eid)}">Plan it</button>` : '<span></span>'}</div>`).join('')}</div>` : ''}
    ${busy ? `<div class="muted" style="font-size:12px">Working through enemy ${rows.length + 1} of ${state.reach.todo.length + rows.length}…</div>` : ''}
  </div>`;
}

function findReach() {
  const e = E();
  const todo = e.unsafeEnemies(8);
  state.reach = { rows: [], todo, done: false };
  const paint = () => { const el = $('#reach'); if (el) el.outerHTML = reachPanel(); };
  paint();
  const step = () => {
    const x = state.reach.todo.shift();
    if (!x) { const rank = (r) => (r.rd?.reached ? (r.gph > 0 ? 2 : 1) : 0); state.reach.done = true; state.reach.rows.sort((a, b) => rank(b) - rank(a) || b.gph - a.gph); paint(); return; }
    let rd = null;
    try { rd = e.readiness(x.eid); } catch { rd = null; }
    state.reach.rows.push({ ...x, rd, gph: rd?.reached && rd.after ? e.readyGph(x.m, rd.after) : 0 });
    paint();
    setTimeout(step, 20);
  };
  setTimeout(step, 30);
}

function slayerPanel() {
  const e = E();
  const opts = e.slayerOptions();
  if (!opts.length || state.explorer) return '';
  const C = G().combat;
  const tasks = opts.filter((o) => o.task);
  return `<div class="panel slayer">
    <div class="sl-h">${img(skillIcon('Slayer'), '', 22)}<b>Slayer</b><span class="muted">level ${e.level('Slayer')} · task kills pay coins and Slayer XP on top of normal loot</span></div>
    ${tasks.map((o) => {
      const en = C.enemies[o.task.enemy];
      const row = o.enemies.find((x) => x.eid === o.task.enemy);
      const left = Math.max(0, o.task.length - o.task.progress);
      return `<div class="sl-task">${img(en?.i, '', 30)}<span><small>Current task · ${esc(o.sm.n)}</small><b>${esc(en?.n || o.task.enemy)} · ${o.task.progress}/${o.task.length}</b></span><span class="num">${row?.ok ? `~${fmtDuration(left / row.kph)} left` : `<span class="red">not safe with your gear</span> <button class="linkish" data-ready-go="${esc(o.task.enemy)}">how to get ready</button>`}</span></div>`;
    }).join('')}
    <div class="sl-grid">${opts.map((o) => `<div class="sl-m ${o.ok ? '' : 'locked'}">${img(o.sm.i, '', 28)}<span><b>${esc(o.sm.n)}</b><small>${o.ok ? `${o.viable}/${o.total} enemies farmable` : esc(o.reqs.filter((r) => !r.ok).map((r) => r.text).join(', '))}</small></span>
      <span class="sl-v"><b class="num">${o.coinsHr > 0 ? fmtGp(o.coinsHr) : '—'}</b><small>coins/hr</small></span><span class="sl-v"><b class="num">${o.xph > 0 ? fmtGp(o.xph) : '—'}</b><small>xp/hr</small></span><span class="sl-v"><b class="num ${o.gph < 0 ? 'red' : 'gold'}">${o.viable ? fmtGp(o.gph) : '—'}</b><small>gp/hr</small></span></div>`).join('')}</div>
    <p class="muted" style="font-size:12px;margin:0">Coins per task kill are ⌊0.1 × enemy HP^1.15⌋ and Slayer XP is HP/8 + 4. Enemies you can't farm safely are counted as rerolls. Gold/hr is the normal loot, after food.</p>
  </div>`;
}

function fighterBanner() {
  const e = E();
  const P = e.gearPool;
  if (!P || state.explorer) return '';
  const g = G();
  const F = e.fighter;
  const col = (style) => {
    const ws = (P.weapons[style] || []).filter(Boolean);
    const extra = style === 'Magic' ? (P.spells.length ? `${P.spells.length} spell${P.spells.length === 1 ? '' : 's'}` : 'no spells') : style === 'Ranged' ? `${(P.byType.Ammo || []).length} ammo` : '';
    return `<div class="fg-col"><div class="fg-h">${img(skillIcon(STYLE_SKILL[style]), '', 18)}<b>${style}</b><span class="muted">${ws.length} weapon${ws.length === 1 ? '' : 's'}${extra ? ' · ' + extra : ''}</span></div>
      <div class="fg-gear">${ws.slice(0, 8).map((it) => `<span data-item="${esc(it)}" title="${esc(g.items[it].n)}">${img(g.items[it].i, '', 26)}</span>`).join('') || '<span class="muted" style="font-size:12px">none</span>'}</div></div>`;
  };
  const armour = Object.entries(P.byType).filter(([t]) => t !== 'Ammo').reduce((a, [, v]) => a + v.length, 0);
  return `<div class="panel fighter">
    <div class="fg-s"><span><small>HP</small><b class="num">${fmtNum(F?.hp || 0)}</b></span><span><small>Armour pieces</small><b class="num">${fmtNum(armour)}</b></span><span><small>Food</small><b>${e.food ? esc(e.name(e.food)) : 'none'}</b></span></div>
    <div class="fg-cols">${['Melee', 'Ranged', 'Magic'].map(col).join('')}</div>
    <p class="muted fg-note">Each enemy is fought with the best loadout from the gear you own, equipped or in your bank: melee, ranged or magic, picked against that enemy's defences, attack style and element. Ammo, runes and food count as costs. Fights where the enemy can hit you for 90% of your HP, or that take over 20 minutes per kill, are left out. Special attacks, prayers and slayer tasks are not modelled yet.</p>
  </div>`;
}

function chainTree(chain) {
  const e = E();
  const costs = e.solveChains().costs;
  const seen = new Set();
  const lines = [];
  const walk = (item, depth) => {
    if (depth > 5 || seen.has(item + depth)) return;
    seen.add(item + depth);
    const c = costs.get(item);
    if (!c) return;
    const pad = `style="padding-left:${depth * 18}px"`;
    if (c.via.kind === 'buy') { lines.push(`<div class="link" ${pad} data-item="${esc(item)}">${img(itemIcon(item), '', 20)}${esc(e.name(item))} <span class="via">· buy for ${fmtGp(c.gp)} each</span></div>`); return; }
    const m = c.via.m;
    lines.push(`<div class="link" ${pad} data-item="${esc(item)}">${img(itemIcon(item), '', 20)}${esc(e.name(item))} <span class="via">· ${esc(m.s)}: ${esc(m.n)} · ${fmtMs(c.t)} each</span></div>`);
    for (const [it] of m.in) walk(it, depth + 1);
  };
  for (const s of chain.steps) walk(s.item, 0);
  return lines.join('');
}

// ---------------------------------------------------------------- training
function viewTrain() {
  const e = E(), g = G(), s = state.save;
  const skills = [...SKILL_ORDER.filter((k) => !NOT_TRAINABLE.has(k) && e.methods.some((m) => m.s === k)), ...(e.methods.some((m) => m.s === 'Astrology') ? ['Astrology'] : []), ...(state.explorer ? [] : [...COMBAT_SKILLS, 'Slayer'])];
  if (!skills.includes(state.trainSkill)) {
    // default: the skill closest to its next level by time
    state.trainSkill = skills.map((k) => ({ k, o: e.trainOptions(k)[0] })).filter((x) => x.o).sort((a, b) => {
      const need = (k) => xpForLevel((s.skills[k]?.level ?? 1) + 1) - (s.skills[k]?.xp ?? 0);
      return need(a.k) / a.o.xph - need(b.k) / b.o.xph;
    })[0]?.k || skills[0];
  }
  const sk = state.trainSkill;
  const cur = s.skills[sk] || { xp: 0, level: 1 };
  const lo = xpForLevel(cur.level), hi = xpForLevel(cur.level + 1);
  const pct = cur.level >= 99 ? 100 : ((cur.xp - lo) / (hi - lo)) * 100;
  const target = Math.min(99, Math.max(cur.level + 1, state.trainTarget ?? Math.min(99, Math.ceil((cur.level + 1) / 5) * 5 + (cur.level % 5 === 4 ? 5 : 0))));
  state.trainTarget = target;
  const atLevel = state.trainLevel ?? cur.level;
  const opts = e.trainOptions(sk, atLevel);
  const plan = cur.level < 99 && !state.explorer ? e.planLevel(sk, target, { prefer: state.trainPrefer }) : null;
  const maxH = plan ? Math.max(...plan.segs.map((x) => x.hours), 0.001) : 1;
  const quick = [...new Set([cur.level + 1, Math.min(99, cur.level + 5), Math.min(99, cur.level + 10), 50, 70, 99].filter((l) => l > cur.level && l <= 99))].sort((a, b) => a - b).slice(0, 6);
  const short = plan ? plan.supplies.filter((x) => x.qty >= 1).sort((a, b) => (b.qty - b.have) * e.value(b.item) - (a.qty - a.have) * e.value(a.item)) : [];

  return `
  <div class="section-head"><div><h2>Training</h2><p>The fastest way to level each skill with what you have unlocked, including when to switch methods and the supplies you will burn through.</p></div>${modsToggle()}</div>
  <div class="train">
    <nav class="skill-pick" aria-label="Skill">
      ${skills.map((k) => {
        const v = s.skills[k] || { level: 1, xp: 0 };
        const b = e.trainOptions(k)[0];
        return `<button class="sp ${k === sk ? 'on' : ''}" data-tskill="${k}" aria-pressed="${k === sk}">${img(skillIcon(k), '', 26)}<span class="spn"><b>${k}</b><small>${b ? `${fmtGp(b.xph)} xp/hr` : 'nothing to train'}</small></span><span class="spl num">${v.level}</span></button>`;
      }).join('')}
    </nav>
    <div class="train-main">
      <div class="panel train-head">
        <div class="th-skill">${img(skillIcon(sk), '', 52)}<div><h3>${sk}</h3><div class="muted">Level <b class="text">${cur.level}</b> · ${fmtNum(cur.xp)} xp${cur.level < 99 ? ` · ${fmtNum(hi - cur.xp)} to ${cur.level + 1}` : ''}</div></div>${guildBadge(sk)}</div>
        <div class="xpbar"><i style="width:${pct}%"></i></div>
        ${state.explorer ? '' : petLine(sk)}
        ${plan ? `
        <div class="goal">
          <span class="muted">Goal</span>
          <div class="seg goal-seg">${quick.map((l) => `<button data-target="${l}" aria-pressed="${l === target}">${l}</button>`).join('')}</div>
          <label class="lvl-in"><span class="sr">Target level</span><input type="number" min="${cur.level + 1}" max="99" value="${target}" id="target"/></label>
          <div class="seg"><button data-prefer="xp" aria-pressed="${state.trainPrefer === 'xp'}">${svg.bolt} Fastest</button><button data-prefer="gp" aria-pressed="${state.trainPrefer === 'gp'}">${img(g.currencies.GoldPieces, '', 14)} Most gold</button></div>
        </div>` : ''}
      </div>
      ${plan ? `
      <div class="plan-sum stagger">
        <div class="panel stat"><div class="label">${svg.clock}Time to ${target}</div><div class="value num">${Number.isFinite(plan.hours) ? fmtDuration(plan.hours) : '—'}</div><div class="sub">${fmtNum(xpForLevel(target) - cur.xp)} xp to go</div></div>
        <div class="panel stat"><div class="label">${img(g.currencies.GoldPieces, '', 16)}Gold along the way</div><div class="value num ${plan.gp < 0 ? 'red' : 'gold'}">${fmtGp(plan.gp, { sign: true })}</div><div class="sub">${plan.gp < 0 ? 'cost of supplies, net of what you make' : 'from selling what you make'}</div></div>
        <div class="panel stat"><div class="label">${svg.target}Methods</div><div class="value num">${plan.segs.length}</div><div class="sub">${plan.segs.length > 1 ? 'switch as new ones unlock' : 'one method all the way'}</div></div>
      </div>
      ${plan.stuck ? `<div class="note">${svg.info}<span>${COMBAT_SKILLS.includes(sk) ? `None of the gear you own can train ${sk} on an enemy you can safely farm.${sk === 'Ranged' ? ' You need a ranged weapon and matching ammo.' : sk === 'Magic' ? ' You need a staff or wand and a spell you can cast (with its runes).' : sk === 'Defence' ? ' Defence comes from the Block stance (swords and daggers) or the Long Range and Defensive stances.' : ''} Gear in your bank counts, not just what you have equipped.` : `Nothing you can train is unlocked at level ${plan.stuck}. Check the requirements in Money.`}</span></div>` : ''}
      <div class="panel plan">
        <h4>Route</h4>
        ${plan.segs.map((x) => `
          <div class="seg-row">
            <span class="ico">${img(methodIcon(x.m), '', 30)}</span>
            <div class="title"><b>${esc(x.m.n)}</b><span class="sub">lvl ${x.fromLevel} → ${x.toLevel}<span class="sep">·</span>${fmtGp(x.xph)} xp/hr<span class="sep">·</span><span class="${x.gph < 0 ? 'red' : 'green'}">${fmtGp(x.gph, { sign: true })} gp/hr</span></span>${routeNote(x)}</div>
            <div class="seg-bar"><i style="width:${Math.max(3, (x.hours / maxH) * 100)}%"></i></div>
            <span class="seg-h num">${fmtDuration(x.hours)}</span>
          </div>`).join('')}
        ${short.length ? `<h4 style="margin-top:18px">Supplies</h4>
        <div class="supplies">${short.slice(0, 12).map((x) => {
          const miss = Math.max(0, x.qty - x.have);
          const made = x.made >= 1;
          return `<div class="sup" data-item="${esc(x.item)}">${img(itemIcon(x.item), '', 26)}<div><b>${esc(e.name(x.item))}</b><span class="num">${fmtNum(x.qty)} needed · you have ${fmtNum(x.have)}${made ? ` · route makes ${fmtNum(x.made)}` : ''}</span></div>${made ? `<span class="pill">${svg.check}made</span>` : miss > 0 ? `<span class="pill red num">−${fmtGp(miss)}</span>` : `<span class="pill green">${svg.check}</span>`}</div>`;
        }).join('')}</div>` : ''}
      </div>` : ''}
      ${sk === 'Astrology' && !state.explorer ? astroPanel() : ''}
      ${state.explorer ? '' : guildSection(sk)}
      <div class="section-sub">
        <h4>Every way to train ${sk}</h4>
        <label class="lvl-in inline">at level <input type="number" min="1" max="99" value="${atLevel}" id="atlevel"/></label>
      </div>
      <div class="tlist">
        <p class="bu-p" style="margin:0 0 6px">XP/hr is per hour of play. If your bank holds the inputs for at least an hour, it uses those. Otherwise it includes the time to gather or make them, plus the XP you earn doing so in this skill.</p>
        <div class="thead"><span></span><span>Method</span><span class="r">XP / hr</span><span class="r">Gold / hr</span><span class="r">Next level</span></div>
        ${opts.slice(0, 40).map((o, i) => {
          const need = atLevel < 99 ? xpForLevel(atLevel + 1) - (atLevel === cur.level ? cur.xp : xpForLevel(atLevel)) : 0;
          return `<div class="trow ${i === 0 ? 'top' : ''}" data-item="${esc(o.m.primary || '')}">
            <span class="ico">${img(methodIcon(o.m), '', 28)}</span>
            <span class="title"><b>${esc(o.m.n)} ${o.src === 'bank' ? `<span class="tag green">from bank · ${fmtDuration(o.bankHours)}</span>` : o.src === 'scratch' ? '<span class="tag">makes inputs</span>' : ''}</b><span class="sub">${o.slayer ? `${o.slayer.viable}/${o.slayer.total} task enemies you can farm<span class="sep">·</span>${fmtGp(o.slayer.coinsHr)} coins/hr<span class="sep">·</span>~${fmtDuration(o.slayer.perTaskHours)} per task` : o.stance ? `${esc(o.loadout?.style || '')} · ${esc(G().combat.stances[o.stance]?.n || o.stance)}${o.loadout?.gear.Weapon ? ` · ${esc(G().items[o.loadout.gear.Weapon]?.n || '')}` : ''}${o.loadout?.spell ? ` · ${esc(G().combat.spells[o.loadout.spell].n)}` : ''}<span class="sep">·</span>${fmtMs(o.killMs)} per kill<span class="sep">·</span>${esc(o.m.loc || '')}` : `lvl ${o.m.lv}`}${o.r.succ < 1 ? `<span class="sep">·</span>${Math.round(o.r.succ * 100)}% success` : ''}${o.src === 'scratch' && o.scratch.steps.length ? `<span class="sep">·</span>${o.scratch.steps.slice(0, 3).map((st) => `${img(methodIcon(st.m), '', 14)}${Math.round(st.share * 60)}m`).join(' ')}` : o.m.in.length ? `<span class="sep">·</span>${o.m.in.slice(0, 3).map(([it]) => img(itemIcon(it), '', 14)).join('')}` : ''}</span></span>
            <span class="r num xpv" title="${esc(o.m.in.length ? `With inputs on hand: ${fmtGp(o.direct.xph)} xp/hr · making them yourself: ${o.scratch.feasible ? fmtGp(o.scratch.xph) : 'not possible yet'} xp/hr` : 'Gathering: no inputs needed')}">${fmtGp(o.xph)}</span>
            <span class="r num ${o.gph < 0 ? 'red' : 'green'}">${fmtGp(o.gph, { sign: true })}</span>
            <span class="r num muted">${atLevel < 99 ? fmtDuration(need / o.xph) : '—'}</span>
          </div>`;
        }).join('') || '<div class="empty"><b>Nothing to train at this level.</b></div>'}
      </div>
    </div>
  </div>`;
}

function petLine(sk) {
  const pets = E().skillPets(sk);
  if (!pets.length) return '';
  return `<div class="pets"><span class="muted">Pets</span>${pets.map((p) => {
    const fx = (p.b || []).map((b) => { const t = bonusText(b, lookup); return `${t.val} ${t.label}${t.where ? ` (${t.where})` : ''}`; }).join(', ');
    return `<span class="pet ${p.have ? 'have' : ''}" title="${esc(fx || 'No bonus')}${p.hours && !p.have ? esc(` · expected after about ${fmtDuration(p.hours)} of ${p.via?.n || 'training'}`) : ''}">${img(p.i, '', 22)}<b>${esc(p.n)}</b>${p.have ? `<em class="green">${svg.check} found</em>` : p.hours ? `<em>~${fmtDuration(p.hours)}</em>` : ''}</span>`;
  }).join('')}</div>`;
}

/** Under a route step: how much comes from the bank, what the rest has you make, and XP in other skills. */
function routeNote(x) {
  const parts = [];
  if (x.bankHours > 0.01 && x.scratchHours > 0.01) parts.push(`${fmtDuration(x.bankHours)} from your bank, then ${fmtDuration(x.scratchHours)} making inputs`);
  else if (x.bankHours > 0.01 && x.m.in.length) parts.push('uses inputs from your bank');
  if (x.scratchHours > 0.01 && x.steps?.length) parts.push(`each hour: ${x.steps.slice(0, 4).map((st) => `${esc(st.m.n)} ${Math.round(st.share * 60)}m`).join(', ')}`);
  if (x.scratchHours > 0.01 && x.otherXp?.length) parts.push(`also ${x.otherXp.filter(([, v]) => v > 1).map(([sk, v]) => `${fmtGp(v)} ${esc(sk)} xp/hr`).join(', ')}`);
  return parts.length ? `<span class="route-note">${parts.join(' · ')}</span>` : '';
}

function guildSection(sk) {
  const e = E();
  const gs = e.guild?.[sk];
  if (!gs) return '';
  const plan = e.guildPlan(sk);
  const tasks = e.guildTasks(sk);
  const doneN = tasks.filter((t) => t.done).length;
  const taskRow = (t) => {
    const pct = t.max > 0 ? Math.min(100, (t.prog / t.max) * 100) : 0;
    const est = t.done ? `<span class="pill green">${svg.check}done</span>`
      : t.est ? `<span class="num">${fmtDuration(t.est.hours)}</span>${t.est.m ? `<small>${esc(t.est.m.n)}</small>` : ''}`
      : t.done === null ? '<small class="muted">not readable</small>' : '<small class="muted">no estimate</small>';
    return `<div class="gt ${t.done ? 'is-done' : ''}">
      <span class="gpts num" title="Guild points">${t.pts}</span>
      <div class="gt-main"><b>${esc(t.text)}</b>${t.max > 1 && !t.done ? `<div class="gt-bar"><i style="width:${pct}%"></i></div><small class="num">${fmtNum(t.prog)} / ${fmtNum(t.max)}</small>` : ''}</div>
      <div class="gt-est">${est}</div>
    </div>`;
  };
  const open = tasks.filter((t) => !t.done).sort((a, b) => (a.est ? a.est.hours / a.pts : Infinity) - (b.est ? b.est.hours / b.pts : Infinity));
  return `<div class="panel guild-plan">
    <div class="gp-head">
      <div><h4>Mastery guild</h4><div class="gp-title">${plan ? `Fastest route to <b>${esc(e.guildName(sk, gs.next))}</b>` : `<b>${esc(e.guildName(sk, gs.rank))}</b> · top rank`}</div></div>
      ${plan ? `<div class="gp-sum"><span class="num">${plan.reachable ? fmtDuration(plan.hours) : '—'}</span><small>${fmtNum(plan.need)} points · ${plan.pick.length} task${plan.pick.length === 1 ? '' : 's'}</small></div>` : ''}
    </div>
    ${plan && plan.pick.length ? `<div class="gt-list">${plan.pick.map(taskRow).join('')}</div>` : plan ? `<p class="muted">Not enough tasks can be estimated to reach the next rank with what you have unlocked.</p>` : ''}
    <details class="gt-all"><summary>All tasks <span class="muted">${doneN} of ${tasks.length} done · ${fmtNum(gs.lo)} of ${fmtNum(gs.total)} points</span></summary>
      <div class="gt-list">${open.map(taskRow).join('')}${tasks.filter((t) => t.done).map(taskRow).join('')}</div>
    </details>
  </div>`;
}

function guildBadge(sk) {
  const e = E();
  const gs = e.guild?.[sk];
  if (!gs || state.explorer) return '';
  const nextNeed = gs.next ? gs.need(gs.next) : gs.total;
  const prevNeed = gs.need(gs.rank);
  const pct = gs.next ? Math.max(0, Math.min(100, ((gs.lo - prevNeed) / Math.max(1, nextNeed - prevNeed)) * 100)) : 100;
  const bonuses = (G().guild[sk]?.bonuses || []).filter((b) => b.rank === gs.next).flatMap((b) => b.b.map((x) => bonusText(x, lookup)));
  return `<div class="guild" title="${esc(`${fmtNum(gs.lo)} of ${fmtNum(gs.total)} guild points from tasks${gs.hi > gs.lo ? ` (up to ${fmtNum(gs.hi)} counting tasks the save can't confirm)` : ''}`)}">
    <span class="k">Mastery guild</span>
    <b>${esc(e.guildName(sk, gs.rank))}</b>
    ${gs.next ? `<div class="gbar"><i style="width:${pct}%"></i></div><small>${fmtNum(nextNeed - gs.lo)} points to ${esc(e.guildName(sk, gs.next))}${bonuses.length ? ` · unlocks ${bonuses.map((t) => `${t.val} ${esc(t.label)}`).join(', ')}` : ''}</small>` : '<small>Top rank reached</small>'}
  </div>`;
}

// ---------------------------------------------------------------- plan
const KIND = {
  unlock: { label: 'Unlock', cls: 'k-unlock' }, shop: { label: 'Upgrade', cls: 'k-shop' },
  gear: { label: 'Gear', cls: 'k-gear' }, quest: { label: 'Quest', cls: 'k-quest' },
  train: { label: 'Train', cls: 'k-unlock' }, guild: { label: 'Guild', cls: 'k-quest' }, kill: { label: 'Kill', cls: 'k-gear' }, astro: { label: 'Astrology', cls: 'k-quest' },
  make: { label: 'Gather / make', cls: 'k-unlock' }, seg: { label: 'Train', cls: 'k-unlock' }, buy: { label: 'Buy', cls: 'k-shop' }, have: { label: 'From your bank', cls: 'k-quest' },
};

function goalPicker() {
  const e = E();
  const g = state.goal || { type: 'gold' };
  const quests = e.questList().filter((q) => !q.done);
  const skills = [...SKILL_ORDER.filter((k) => !NOT_TRAINABLE.has(k)), ...COMBAT_SKILLS];
  const locked = e.methods.filter((m) => !m.quest && m.k === 'active' && !e.status(m).unlocked && (m.s !== 'Combat' || m.id.startsWith('Dungeon:')))
    .sort((a, b) => a.s.localeCompare(b.s) || a.lv - b.lv);
  const bySkill = new Map();
  for (const m of locked) { const k = m.s === 'Combat' ? 'Dungeons' : m.s; if (!bySkill.has(k)) bySkill.set(k, []); bySkill.get(k).push(m); }
  return `<div class="goal-pick panel">
    <span class="muted">Goal</span>
    <div class="seg">${[['gold', 'Earn more gold'], ['quest', 'A quest'], ['level', 'A level'], ['unlock', 'An unlock'], ['item', 'An item'], ['ready', 'A fight']].map(([k, l]) => `<button data-goaltype="${k}" aria-pressed="${g.type === k}">${l}</button>`).join('')}</div>
    ${g.type === 'quest' ? `<select id="goal-quest">${quests.map((q) => `<option value="${esc(q.id)}" ${g.id === q.id ? 'selected' : ''}>${esc(q.Q.n)} (${esc(q.Q.cat)})</option>`).join('')}</select>` : ''}
    ${g.type === 'level' ? `<select id="goal-skill">${skills.map((k) => `<option ${g.skill === k ? 'selected' : ''}>${k}</option>`).join('')}</select><label class="lvl-in"><input type="number" id="goal-level" min="2" max="99" value="${g.level || Math.min(99, e.level(g.skill || skills[0]) + 10)}"/></label>` : ''}
    ${g.type === 'item' ? `<input id="goal-item" list="goal-items" placeholder="Type an item, e.g. Rune Platebody" value="${esc(g.id ? E().name(g.id) : '')}" autocomplete="off"/><datalist id="goal-items">${Object.values(G().items).map((it) => `<option value="${esc(it.n)}"></option>`).join('')}</datalist><label class="lvl-in"><span class="sr">Quantity</span><input type="number" id="goal-qty" min="1" value="${g.qty || 1}"/></label>` : ''}
    ${g.type === 'ready' ? `<select id="goal-ready">${Object.entries(G().combat.enemies).filter(([id]) => E().byId.get('Combat:' + id) && !E().byId.get('Combat:' + id).quest).sort((a, b) => a[1].n.localeCompare(b[1].n)).map(([id, en]) => `<option value="${esc(id)}" ${g.id === id ? 'selected' : ''}>${esc(en.n)}</option>`).join('')}</select>` : ''}
    ${g.type === 'unlock' ? `<select id="goal-unlock">${[...bySkill.entries()].map(([sk, ms]) => `<optgroup label="${esc(sk)}">${ms.map((m) => `<option value="${esc(m.id)}" ${g.id === m.id ? 'selected' : ''}>${esc(m.n)}${m.s === 'Combat' ? '' : ` (lvl ${m.lv})`}</option>`).join('')}</optgroup>`).join('')}</select>` : ''}
  </div>`;
}

function goalView() {
  const e = E();
  const g = state.goal;
  if (g.type === 'item' && !g.id) return `<div class="note">${svg.info}<span>Type the item you want. The route resolves everything behind it: which skill, enemy, chest or shop it comes from, the levels, quests and kills those need, every material along the way (from your bank first), and the gold to buy what's cheaper to buy.</span></div>`;
  const r = e.goalRoute(g);
  const step = (st, i) => {
    const k = KIND[st.kind] || KIND.unlock;
    const icon = st.kind === 'seg' ? methodIcon(st.m) : st.kind === 'train' || st.kind === 'guild' ? skillIcon(st.skill) : st.kind === 'quest' ? G().skills.Quests?.i : st.kind === 'unlock' || st.kind === 'make' ? (st.m.i || itemIcon(st.item)) : st.kind === 'kill' ? G().combat.enemies[st.enemy]?.i : st.kind === 'buy' || st.kind === 'have' ? itemIcon(st.items?.[0]?.[0]) : st.id === 'gold' ? G().currencies.GoldPieces : (G().shop[st.id.slice(2)]?.i || skillIcon(st.skill) || G().skills._Shop?.i);
    const target = st.kind === 'seg' ? `data-tskill-go="${esc(st.skill)}" data-target-go="${st.level}"` : st.kind === 'kill' ? 'data-gotab="money"' : st.kind === 'make' ? `data-item="${esc(st.item || '')}"` : st.kind === 'buy' || st.kind === 'have' ? `data-item="${esc(st.items?.[0]?.[0] || '')}"` : st.kind === 'train' ? `data-tskill-go="${esc(st.skill)}" data-target-go="${st.level}"` : st.kind === 'quest' ? `data-quest-go="${esc(st.q.id)}"` : st.kind === 'guild' ? `data-tskill-go="${esc(st.skill)}" data-target-go="${e.level(st.skill) + 1}"` : st.kind === 'shop' ? 'data-gotab="upgrades"' : `data-item="${esc(st.m?.primary || '')}"`;
    return `<li class="ps ${k.cls}"><span class="ps-n num">${i + 1}</span>
      <div class="ps-card panel" role="button" tabindex="0" ${target}>
        <span class="ps-ico">${img(icon, '', 30)}</span>
        <span class="ps-main"><span class="ps-kind">${k.label}</span><b>${esc(st.title)}${st.kind === 'train' ? ` <span class="muted" style="font-weight:500">from ${st.from}</span>` : ''}</b><span class="ps-why">${esc(st.why || '')}${st.unknown ? ' · some parts not modelled' : ''}</span>${st.seg ? routeNote(st.seg) : ''}${st.earn > 0.005 ? `<span class="ps-pre"><span class="pre">${img(G().currencies.GoldPieces, '', 14)}Save up ${fmtGp(st.gp)} gold<span class="muted"> · ${fmtDuration(st.earn)}</span></span></span>` : ''}</span>
        <span class="ps-side"><b class="num">${Number.isFinite(st.hours) ? fmtDuration(st.hours) : '—'}</b><small class="num">at ${fmtDuration(st.time)}</small></span>
      </div></li>`;
  };
  return `<div class="panel plan-hero goal-hero">
      <div class="ph-k"><small>Goal</small><b>${esc(r.title)}</b></div>
      <div class="ph-arrow">${svg.clock}</div>
      <div class="ph-k"><small>Total play time</small><b class="num gold">${Number.isFinite(r.hours) ? fmtDuration(r.hours) : '—'}${r.unknown ? '+' : ''}</b><span class="muted">${r.steps.length} steps</span></div>
    </div>
    ${r.notes?.length ? `<div class="note warn">${svg.info}<span>${r.notes.map(esc).join('<br>')}</span></div>` : ''}
    ${r.steps.length ? `<ol class="psteps stagger">${r.steps.map(step).join('')}</ol>` : r.notes?.length ? '' : `<div class="empty"><b>Already done.</b>Pick another goal.</div>`}`;
}

function rateChart(plan) {
  const pts = [[0, plan.startRate]];
  for (const st of plan.steps) { pts.push([st.time - st.hours, st.rateBefore]); pts.push([st.time, st.rateAfter]); }
  const T = Math.max(plan.time, 0.01), R = Math.max(...pts.map((p) => p[1]), 1);
  const W = 640, Hh = 120, X = (t) => 8 + (t / T) * (W - 16), Y = (r) => Hh - 8 - (r / R) * (Hh - 24);
  let d = `M${X(0)},${Y(plan.startRate)}`;
  let cur = plan.startRate;
  for (const st of plan.steps) { d += ` L${X(st.time)},${Y(cur)}`; if (st.rateAfter !== cur) { d += ` L${X(st.time)},${Y(st.rateAfter)}`; cur = st.rateAfter; } }
  const area = d + ` L${X(T)},${Y(0) + 8} L${X(0)},${Y(0) + 8} Z`;
  return `<svg class="rate-chart" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" role="img" aria-label="Gold per hour over play time">
    <defs><linearGradient id="rg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="rgba(243,196,99,.35)"/><stop offset="1" stop-color="rgba(243,196,99,0)"/></linearGradient></defs>
    <path d="${area}" fill="url(#rg)"/><path d="${d}" fill="none" stroke="#f3c463" stroke-width="2.2" vector-effect="non-scaling-stroke"/>
    ${plan.steps.filter((st) => st.rateAfter > st.rateBefore).map((st) => `<circle cx="${X(st.time)}" cy="${Y(st.rateAfter)}" r="3.2" fill="#ffe3a1"/>`).join('')}
  </svg>`;
}

/** Progress across imports: total level and wealth over time, and XP/day pace per skill. */
function paceSection() {
  const list = state.history?.list || [];
  if (list.length < 2) {
    return `<h3 class="bu-h3">Your pace</h3><div class="note">${svg.info}<span>Import your save again after you've played a while. Each import is kept on this device, and with two or more the site shows your real pace: XP per day for each skill, when you'll hit your next milestones, and how your wealth is growing.</span></div>`;
  }
  const first = list[0], last = list[list.length - 1];
  const days = Math.max((last.t - first.t) / 86400000, 1 / 24);
  const lv = (xp) => levelFromXp(xp || 0);
  const rows = Object.keys(last.xp).filter((k) => SKILL_ORDER.includes(k) || COMBAT_SKILLS.includes(k)).map((k) => {
    const d = (last.xp[k] || 0) - (first.xp[k] ?? last.xp[k] ?? 0);
    const perDay = d / days;
    const cur = lv(last.xp[k]);
    const next = cur >= 99 ? null : Math.min(99, Math.ceil((cur + 1) / 10) * 10);
    const eta = next && perDay > 0 ? (xpForLevel(next) - last.xp[k]) / perDay : Infinity;
    return { k, perDay, cur, next, eta };
  }).filter((r) => r.perDay > 0).sort((a, b) => b.perDay - a.perDay);
  const W = 640, Hh = 110;
  const T0 = first.t, T1 = last.t || T0 + 1;
  const worth = list.map((x) => (x.gp || 0) + (x.bank || 0)), tls = list.map((x) => x.tl || 0);
  const line = (vals, color) => {
    const mx = Math.max(...vals), mn = Math.min(...vals) - (Math.max(...vals) - Math.min(...vals)) * 0.1 - 1e-9;
    return `<path d="${list.map((x, i) => `${i ? 'L' : 'M'}${8 + ((x.t - T0) / Math.max(T1 - T0, 1)) * (W - 16)},${Hh - 10 - ((vals[i] - mn) / Math.max(mx - mn, 1)) * (Hh - 24)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2.2" vector-effect="non-scaling-stroke"/>`;
  };
  return `<h3 class="bu-h3">Your pace <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:500">· ${list.length} imports over ${fmtDuration(days * 24)}</span></h3>
  <div class="panel pace">
    <div class="pace-k"><span><small>Total level</small><b class="num">${fmtNum(last.tl)}</b><em class="green">+${fmtNum((last.tl || 0) - (first.tl || 0))}</em></span>
      <span><small>Gold + bank</small><b class="num">${fmtGp(worth[worth.length - 1])}</b><em class="${worth[worth.length - 1] >= worth[0] ? 'green' : 'red'}">${fmtGp(worth[worth.length - 1] - worth[0], { sign: true })}</em></span></div>
    <svg class="rate-chart" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none">${line(tls, '#8fb8ff')}${line(worth, '#f3c463')}</svg>
    <div class="pace-legend"><span><b style="background:#8fb8ff"></b>Total level</span><span><b style="background:#f3c463"></b>Gold + bank value</span></div>
  </div>
  ${rows.length ? `<div class="pace-list">${rows.slice(0, 12).map((r) => `<div class="pace-row">${img(skillIcon(r.k), '', 20)}<b>${esc(r.k)}</b><span class="num">${fmtGp(r.perDay)} xp/day</span><span class="muted">${r.next ? `${r.next} in ${Number.isFinite(r.eta) ? fmtDuration(r.eta * 24) : '—'}` : 'maxed'}</span></div>`).join('')}</div>` : ''}`;
}

function planSwitch() {
  return `<div class="seg plan-switch" role="tablist"><button data-planview="route" aria-pressed="${state.planView !== 'upgrades'}">Route &amp; goals</button><button data-planview="upgrades" aria-pressed="${state.planView === 'upgrades'}">Upgrades to buy</button></div>`;
}

function viewPlan() {
  if (state.planView === 'upgrades') return planSwitch() + viewUpgrades();
  return planSwitch() + viewRoute();
}

function viewRoute() {
  const e = E();
  const plan = e.speedPlan({ horizon: state.horizon, maxSteps: state.horizon > 100 ? 22 : 16 });
  const bankXp = new Map(e.leftovers().skills.map((x) => [x.skill, x]));
  const step = (st, i) => {
    const k = KIND[st.kind] || KIND.unlock;
    const pre = [];
    for (const t of st.trainSteps || []) {
      const lo = bankXp.get(t.skill);
      const note = lo && lo.to > e.level(t.skill) ? (lo.to >= t.level ? ' · your bank covers it' : ` · your bank gets you to ${lo.to}`) : '';
      pre.push(`<button class="pre linkish-plain" data-tskill-go="${esc(t.skill)}" data-target-go="${t.level}">${img(skillIcon(t.skill), '', 14)}Train ${esc(t.skill)} to ${t.level}<span class="muted"> · ${fmtDuration(t.hours)}</span>${note ? `<span class="green">${note}</span>` : ''}</button>`);
    }
    if (st.guild) pre.push(`<button class="pre linkish-plain" data-tskill-go="${esc(st.guild.skill)}" data-target-go="${(E().level(st.guild.skill) || 1) + 1}">${img(skillIcon(st.guild.skill), '', 14)}Reach ${esc(st.guild.name)} (guild tasks)<span class="muted"> · ${fmtDuration(st.guild.hours)}</span></button>`);
    for (const k of st.kills || []) pre.push(`<span class="pre">${img(G().combat.enemies[k.enemy]?.i, '', 14)}Kill ${fmtNum(k.left)} ${esc(k.name)}<span class="muted"> · ${fmtDuration(k.hours)}${k.style ? ' ' + esc(k.style.toLowerCase()) : ''}</span></span>`);
    if (st.earn > 0.005) pre.push(`<span class="pre">${img(G().currencies.GoldPieces, '', 14)}Save up ${fmtGp(st.gp)} gold<span class="muted"> · ${fmtDuration(st.earn)} of ${esc(plan.steps[i - 1]?.bestName || plan.startName)}</span></span>`);
    if (st.items?.length) pre.push(...st.items.filter(([it, q]) => (e.bank[it] || 0) < q).map(([it, q]) => `<span class="pre" data-item="${esc(it)}">${img(itemIcon(it), '', 14)}Get ${fmtNum(q - (e.bank[it] || 0))} ${esc(e.name(it))}</span>`));
    const icon = st.kind === 'unlock' ? methodIcon(st.m) : st.kind === 'quest' ? G().skills.Quests?.i || G().skills.CompletionLog?.i : st.kind === 'gear' ? itemIcon(st.id.slice(2)) : st.kind === 'astro' ? G().astro.cons.find((c) => c.id === st.cons)?.i : (G().shop[st.id.slice(2)]?.i || skillIcon(st.skill) || G().skills._Shop?.i);
    const target = st.kind === 'astro' ? `data-tskill-go="Astrology" data-target-go="${E().level('Astrology') + 1}"` : st.kind === 'quest' ? `data-quest-go="${esc(st.q.id)}"` : st.kind === 'unlock' ? `data-tskill-go="${esc(st.needs[0]?.skill || st.m.s)}" data-target-go="${st.needs[0]?.level || st.m.lv}"` : st.kind === 'gear' ? `data-item="${esc(st.id.slice(2))}"` : 'data-gotab="upgrades"';
    return `<li class="ps ${k.cls}">
      <span class="ps-n num">${i + 1}</span>
      <div class="ps-card panel" role="button" tabindex="0" ${target}>
        <span class="ps-ico">${img(icon, '', 30)}</span>
        <span class="ps-main"><span class="ps-kind">${k.label}</span><b>${esc(st.title)}</b><span class="ps-why">${esc(st.why)}${st.unknown ? ' · some parts not modelled' : ''}</span>${pre.length ? `<span class="ps-pre">${pre.join('')}</span>` : ''}</span>
        <span class="ps-side"><b class="num">${fmtDuration(st.hours)}</b><small class="num">at ${fmtDuration(st.time)}</small>${st.rateAfter > st.rateBefore + 1 ? `<span class="ps-rate num">${fmtGp(st.rateBefore)} → <b>${fmtGp(st.rateAfter)}</b>/hr</span>` : ''}</span>
      </div>
    </li>`;
  };
  const goalMode = state.goal && state.goal.type !== 'gold';
  if (goalMode) {
    return `<div class="section-head"><div><h2>Your route</h2><p>Everything your goal depends on, in order: earlier quests, the training each step needs (levels carry forward), guild ranks and gold. Upgrades are added on the way when they save more time than they cost.</p></div></div>
    ${goalPicker()}${goalView()}`;
  }
  return `
  ${goalPicker()}
  <div class="section-head"><div><h2>Your route</h2><p>A step-by-step plan from where your save is now. Each step is picked by how quickly it pays back the time it costs. The training, gold and earlier quests it depends on are worked out for you, and training done for one step counts toward the next. Rates are from scratch, so they're sustainable.</p></div>
    <div class="seg" role="group" aria-label="Horizon">${[[24, '1 day'], [96, '4 days'], [336, '2 weeks']].map(([h, l]) => `<button data-horizon="${h}" aria-pressed="${state.horizon === h}">${l}</button>`).join('')}</div></div>
  <div class="panel plan-hero">
    <div class="ph-k"><small>Now</small><b class="num">${fmtGp(plan.startRate)}</b><span class="muted">gp/hr · ${esc(plan.startName)}</span></div>
    <div class="ph-arrow">${svg.arrow}</div>
    <div class="ph-k"><small>After ${fmtDuration(plan.time)} of play</small><b class="num gold">${fmtGp(plan.endRate)}</b><span class="muted">gp/hr${plan.startRate > 0 ? ` · ${(plan.endRate / plan.startRate).toFixed(1)}×` : ''}</span></div>
    <div class="ph-chart">${plan.steps.length ? rateChart(plan) : ''}</div>
  </div>
  ${plan.steps.length ? `<ol class="psteps stagger">${plan.steps.map(step).join('')}</ol>` : `<div class="empty"><b>Nothing to plan yet.</b>No upgrade, unlock or quest pays back within this horizon.</div>`}
  <p class="muted plan-note">Between steps, keep running your best money maker. Times are estimates at your current rates. Quests with parts the site can't model yet (agility, astrology, dungeons) are marked, and those parts aren't counted in their time.</p>`;
}

// ---------------------------------------------------------------- overview
const listWords = (a) => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);

function viewOverview() {
  const e = E(), g = G();
  const r = e.accountRead();
  const cl = r.styles;
  const lowStyles = Object.entries(cl).filter(([k, v]) => k !== r.mainStyle && v < 10).map(([k]) => k);
  const strong = r.top.map((x) => `${x.skill} ${x.level}`);
  const weak = r.lowest.filter((x) => x.level <= 5).map((x) => x.skill);
  const plan = e.speedPlan({ horizon: 96, maxSteps: 8 });
  // consecutive upgrades read as one step ("buy these three")
  const groups = [];
  for (const st of plan.steps) {
    const last = groups[groups.length - 1];
    if (st.kind === 'shop' && last?.kind === 'shop') { last.list.push(st); last.hours += st.hours; last.rateAfter = st.rateAfter; continue; }
    groups.push({ ...st, list: [st] });
  }
  for (const gp of groups) if (gp.kind === 'shop' && gp.list.length > 1) { gp.title = `Buy ${gp.list.length} upgrades`; gp.why = gp.list.map((x) => x.title.replace(/^Buy /, '')).join(', '); }
  const kindLabel = { unlock: 'Unlock', shop: 'Upgrade', gear: 'Gear', quest: 'Quest', astro: 'Astrology' };
  const stepIcon = (st) => (st.kind === 'unlock' ? methodIcon(st.m) : st.kind === 'quest' ? g.skills.Quests?.i : st.kind === 'gear' ? itemIcon(st.id.slice(2)) : st.kind === 'astro' ? g.astro.cons.find((c) => c.id === st.cons)?.i : g.shop[st.id.slice(2)]?.i || skillIcon(st.skill) || g.skills._Shop?.i);
  const alertIcon = { astro: skillIcon('Astrology'), farm: skillIcon('Farming'), shop: g.skills._Shop?.i, quest: g.skills.Quests?.i, slayer: skillIcon('Slayer'), bank: g.skills.Bank?.i };
  const alertTarget = (a) => (a.kind === 'astro' ? 'data-tskill-go="Astrology" data-target-go="' + (e.level('Astrology') + 1) + '"' : a.kind === 'quest' ? `data-quest-go="${esc(a.id)}"` : a.kind === 'slayer' ? `data-ready-go="${esc(a.enemy)}"` : a.kind === 'shop' ? 'data-gotab="upgrades"' : `data-gotab="${esc(a.go)}"`);
  const opens = (gt) => {
    const names = gt.opened.filter((t) => t.kind !== 'recipe');
    const recipes = gt.opened.filter((t) => t.kind === 'recipe').length;
    const label = { quest: 'quest', area: 'area', dungeon: 'dungeon', money: 'better money', plot: 'farm plot', shop: 'upgrade', gear: 'wear your' };
    const chips = names.slice(0, 4).map((t) => `<span class="ov-chip k-${t.kind}">${t.kind === 'gear' ? 'wear ' : ''}${esc(t.name)}<small>${t.kind === 'gear' ? '' : label[t.kind]}${t.gph ? ' · ' + fmtGp(t.gph) + '/hr' : ''}</small></span>`);
    if (names.length > 4) chips.push(`<span class="ov-chip">+${names.length - 4} more</span>`);
    if (recipes) chips.push(`<span class="ov-chip">${recipes} new recipe${recipes === 1 ? '' : 's'}</span>`);
    return chips.join('');
  };
  return `
  <section class="panel ov-read">
    <span class="eyebrow">Your account at a glance</span>
    <p class="ov-lead"><b>${esc(r.stage)}</b> · ${Math.round(r.pct * 100)}% of the way to 99 everywhere · ${r.qDone} of ${r.qTotal} quests done</p>
    <p class="ov-text">You fight with <b>${r.mainStyle}</b> (${r.mainStyle === 'Melee' ? `Attack ${e.level('Attack')}, Strength ${e.level('Strength')}` : `${r.mainStyle} ${cl[r.mainStyle]}`}, Defence ${e.level('Defence')})${lowStyles.length ? `; ${listWords(lowStyles)} ${lowStyles.length === 1 ? 'is' : 'are'} untrained` : ''}.
      Your strongest skills are ${listWords(strong)}${weak.length ? `, while ${listWords(weak)} ${weak.length === 1 ? 'is' : 'are'} barely started` : ''}.
      ${r.best ? `Right now <b>${esc(r.best.m.n)}</b> pays the most (<b class="gold">${fmtGp(r.best.gph)}/hr</b>${r.best.src === 'bank' ? ', from your bank' : ''})` : ''}${r.afk ? `; left alone for 8 hours, ${esc(r.afk.m.n)} makes ${fmtGp(r.afk.total)}` : ''}${r.farmGph > 0 ? `; your farm adds ${fmtGp(r.farmGph)}/hr on top` : ''}.</p>
  </section>

  ${r.alerts.length ? `<section class="ov-sec"><h3>Right now</h3><div class="ov-alerts">${r.alerts.map((a) => `<button class="ov-alert" ${alertTarget(a)}>${img(alertIcon[a.kind], '', 22)}<span>${esc(a.text)}</span>${svg.arrow || '→'}</button>`).join('')}</div></section>` : ''}

  <section class="ov-sec">
    <div class="ov-h"><h3>Do this next</h3><button class="linkish" data-gotab="plan">Full route →</button></div>
    ${groups.length ? `<div class="ov-steps">${groups.slice(0, 3).map((st, i) => `<button class="panel ov-step" data-gotab="plan">
      <span class="ov-n num">${i + 1}</span>${img(stepIcon(st), '', 30)}
      <span class="ov-main"><small>${kindLabel[st.kind] || 'Step'}</small><b>${esc(st.title)}</b><span class="muted">${esc(st.why || '')}</span></span>
      <span class="ov-side"><b class="num">${fmtDuration(st.hours)}</b>${st.rateAfter > st.rateBefore + 1 ? `<small class="green">${fmtGp(st.rateBefore)} → ${fmtGp(st.rateAfter)}/hr</small>` : ''}</span>
    </button>`).join('')}</div>` : '<div class="empty">Nothing pays back within a few days. Keep running your best money maker.</div>'}
  </section>

  ${r.afk || r.overnight ? `<section class="ov-sec"><h3>Leaving it overnight?</h3><div class="ov-night">
    ${r.afk ? `<div class="panel ov-n8"><small>For gold</small>${img(methodIcon(r.afk.m), '', 28)}<b>${esc(r.afk.m.n)}</b><span class="muted">${esc(r.afk.m.s)} · about <b class="gold">${fmtGp(r.afk.total)}</b> in 8 hours</span></div>` : ''}
    ${r.overnight ? `<button class="panel ov-n8" data-tskill-go="${esc(r.overnight.skill)}" data-target-go="${r.overnight.need}"><small>For progress</small>${img(methodIcon(r.overnight.m), '', 28)}<b>${esc(r.overnight.skill)} ${r.overnight.from} → ${r.overnight.to}</b><span class="muted">${esc(r.overnight.m.n)}${r.overnight.fromBank ? ' from your bank' : ''} · toward ${r.overnight.need}${r.overnight.why ? ` for ${esc(r.overnight.why)}` : ''}</span></button>` : ''}
  </div></section>` : ''}
  <div class="ov-two">
    <section class="panel ov-box">
      <h4>Levels that open the most</h4>
      <p class="muted ov-sub">The cheapest levels to reach for what they open: quests, areas, better money makers, plots, upgrades, and gear you already own but can't wear.</p>
      ${r.gates.length ? r.gates.map((gt) => `<div class="ov-gate" role="button" tabindex="0" data-tskill-go="${esc(gt.skill)}" data-target-go="${gt.level}">
        <div class="ov-gh">${img(skillIcon(gt.skill), '', 22)}<b>${esc(gt.skill)} ${gt.from} → ${gt.level}</b><span class="num muted">${fmtDuration(gt.hours)}</span></div>
        <div class="ov-chips">${opens(gt)}</div></div>`).join('') : '<div class="muted">Nothing big is a few levels away.</div>'}
    </section>
    <section class="panel ov-box">
      <h4>Your quests are waiting on</h4>
      <p class="muted ov-sub">Skills the quests you haven't finished need. These are the ones holding your story back.</p>
      ${r.questWait.length ? r.questWait.map((w) => `<div class="ov-gate" role="button" tabindex="0" data-tskill-go="${esc(w.skill)}" data-target-go="${w.first}">
        <div class="ov-gh">${img(skillIcon(w.skill), '', 22)}<b>${esc(w.skill)} <span class="muted">(${e.level(w.skill)})</span></b><span class="num muted">${w.first === w.level ? `needs ${w.level}` : `${w.first} → ${w.level}`}</span></div>
        <div class="ov-chips">${w.quests.slice(0, 4).map((q) => `<span class="ov-chip k-quest">${esc(q)}</span>`).join('')}${w.quests.length > 4 ? `<span class="ov-chip">+${w.quests.length - 4} more</span>` : ''}</div></div>`).join('') : '<div class="muted">No quest is waiting on a level.</div>'}
    </section>
  </div>
  ${paceSection()}`;
}

// ---------------------------------------------------------------- quests
function unlockChip(u) {
  const g = G();
  const [kind, id, name] = u;
  if (kind === 'shop') {
    const sp = g.shop[id];
    const fx = (sp?.b || []).map((b) => bonusText(b, lookup)).map((t) => `${t.val} ${t.label}`).join(', ');
    return `<span class="qchip" title="${esc(fx)}">${img(sp?.i, '', 16)}Shop: ${esc(name)}</span>`;
  }
  if (kind === 'area') return `<span class="qchip">${img(g.skills.Combat?.i, '', 16)}Area: ${esc(name)}</span>`;
  if (kind === 'enemy') return '';
  return `<span class="qchip">${svg.arrow}Next: ${esc(name)}</span>`;
}

function questDetail(q) {
  const e = E();
  const goalRow = (gl) => {
    const pct = gl.q.n > 0 ? Math.min(100, (gl.prog / gl.q.n) * 100) : 0;
    const est = gl.complete ? `<span class="pill green">${svg.check}done</span>`
      : gl.est ? `<span class="num">${fmtDuration(gl.est.hours)}</span><small>${esc(gl.est.m?.n || '')}${gl.est.train?.length ? ` · after ${gl.est.train.map((t) => `${esc(t.skill)} ${t.level}`).join(', ')}` : ''}</small>`
      : `<small class="muted">${esc(gl.why || 'not modelled yet')}</small>`;
    return `<div class="gt ${gl.complete ? 'is-done' : ''}"><span class="gpts">${svg.target}</span><div class="gt-main"><b>${esc(gl.text)}</b>${gl.q.n > 1 && !gl.complete ? `<div class="gt-bar"><i style="width:${pct}%"></i></div><small class="num">${fmtNum(gl.prog)} / ${fmtNum(gl.q.n)}</small>` : ''}</div><div class="gt-est">${est}</div></div>`;
  };
  const costRow = (c) => `<div class="gt ${c.have ? 'is-done' : ''}" data-item="${esc(c.item)}"><span class="gpts">${img(itemIcon(c.item), '', 18)}</span><div class="gt-main"><b>Hand in ${fmtNum(c.qty)} ${esc(e.name(c.item))}</b><small>you have ${fmtNum(e.bank[c.item] || 0)}</small></div><div class="gt-est">${c.have ? `<span class="pill green">${svg.check}ready</span>` : Number.isFinite(c.hours) ? `<span class="num">${fmtDuration(c.hours)}</span><small>${c.via?.kind === 'make' ? 'make: ' + esc(c.via.m.n) : 'buy'}</small>` : '<small class="muted">no known source yet</small>'}</div></div>`;
  return `<div class="q-detail">
    ${q.Q.desc ? `<p class="q-desc">${esc(q.Q.desc)}</p>` : ''}
    ${q.training?.length ? `<div class="q-train">${svg.bolt}<span>Training first: ${q.training.map((t) => `<button class="linkish" data-tskill-go="${esc(t.skill)}" data-target-go="${t.level}">${esc(t.skill)} ${t.level}</button> <span class="muted">(~${fmtDuration(t.hours)})</span>`).join(', ')}</span></div>` : ''}
    ${q.steps.map((st, i) => `<div class="q-step ${st.done ? 'done' : st.id === q.current ? 'current' : ''}">
      <div class="q-step-h"><span class="q-n">${st.done ? svg.check : i + 1}</span><span>${esc(st.desc || `Step ${i + 1}`)}</span></div>
      ${st.done ? '' : `<div class="gt-list">${st.tasks.map((t) => t.goals.map(goalRow).join('') + t.cost.map(costRow).join('') + (t.cond || []).map((c) => `<div class="gt"><span class="gpts">${svg.q}</span><div class="gt-main"><b>${esc(c)}</b></div><div class="gt-est"><small class="muted">not modelled yet</small></div></div>`).join('')).join('')}</div>`}
    </div>`).join('')}
    <div class="q-rewards"><span class="muted">Rewards</span>${q.Q.rw.gp ? `<span class="qchip">${img(G().currencies.GoldPieces, '', 16)}${fmtNum(q.Q.rw.gp)}</span>` : ''}${q.Q.rw.items.map(([it, n]) => `<span class="qchip" data-item="${esc(it)}">${img(itemIcon(it), '', 16)}${fmtNum(n)} ${esc(e.name(it))}</span>`).join('')}${q.Q.rw.text ? `<span class="qchip">${esc(q.Q.rw.text)}</span>` : ''}${q.unlocks.map(unlockChip).join('')}</div>
  </div>`;
}

function viewQuests() {
  const e = E();
  const list = e.questList();
  const doneN = list.filter((q) => q.done).length;
  const next = list.find((q) => !q.done && q.available) || null;
  let cum = 0, unknownAhead = false;
  const rows = list.map((q) => {
    if (!q.done) { cum += q.hours; unknownAhead ||= q.unknown; }
    return { q, cum, unknownAhead };
  });
  const open = state.openQuest || next?.id;
  return `
  <div class="section-head"><div><h2>Quests</h2><p>The quest line from your save, with every remaining task: its progress, the fastest way to do it at your rates, the training it needs first, and the items to hand in. ${doneN} of ${list.length} done.</p></div></div>
  ${next ? `<div class="panel q-next">
    <div class="q-next-h"><div><span class="kicker">${next.started ? 'In progress' : 'Up next'}</span><h3>${esc(next.Q.n)}</h3><span class="muted">${esc(next.Q.cat)}</span></div>
      <div class="gp-sum"><span class="num">${fmtDuration(next.hours)}${next.unknown ? '+' : ''}</span><small>${next.unknown ? 'plus parts not modelled' : 'estimated play time'}</small></div></div>
    ${questDetail(next)}
  </div>` : `<div class="note">${svg.info}<span>No quest is available right now.</span></div>`}
  <h3 class="bu-h3">The whole quest line</h3>
  <div class="q-list">${rows.map(({ q, cum, unknownAhead }) => `
    <div class="q-row ${q.done ? 'done' : q.available ? 'ready' : 'locked'} ${open === q.id && q !== next ? 'open' : ''}">
      <button class="q-main" data-quest="${esc(q.id)}">
        <span class="q-dot">${q.done ? svg.check : q.available ? svg.spark : svg.lock}</span>
        <span class="title"><b>${esc(q.Q.n)}</b><span class="sub">${esc(q.Q.cat)}${q.unlocks.filter((u) => u[0] !== 'enemy' && u[0] !== 'quest').length ? `<span class="sep">·</span>unlocks ${q.unlocks.filter((u) => u[0] === 'shop' || u[0] === 'area').map((u) => esc(u[2])).join(', ')}` : ''}</span></span>
        <span class="q-t num">${q.done ? '<span class="muted">done</span>' : `${fmtDuration(q.hours)}${q.unknown ? '+' : ''}`}</span>
        <span class="q-c num muted">${q.done ? '' : `~${fmtDuration(cum)}${unknownAhead ? '+' : ''} total`}</span>
      </button>
      ${open === q.id && q !== next && !q.done ? `<div class="q-body">${questDetail(q)}</div>` : ''}
    </div>`).join('')}</div>`;
}

// ---------------------------------------------------------------- upgrades
function viewUpgrades() {
  const e = E(), g = G();
  let list = e.upgradeAdvice();
  const wallet = state.save.wallet?.GoldPieces ?? state.save.header.gp ?? 0;
  if (state.upFilter === 'now') list = list.filter((a) => a.affordable && !a.gap);
  if (state.upSort === 'gain') list = list.slice().sort((a, b) => b.dGp - a.dGp || b.dXp - a.dXp);
  if (state.upSort === 'xp') list = list.slice().sort((a, b) => b.dXp - a.dXp);
  const owned = e.sources;
  const earner = e.ranked('chain')[0];
  const card = (a) => {
    const shortGp = Math.max(0, a.gpCost - wallet);
    const afford = shortGp > 0 && earner?.gph > 0 ? `<div class="uc-afford">${svg.clock} About <b>${fmtDuration(shortGp / earner.gph)}</b> of ${esc(earner.m.n)} to afford it</div>` : '';
    const fx = a.s.b.map((b) => bonusText(b, lookup));
    const status = a.gap ? `<span class="pill warn">${svg.lock}Needs ${a.missing.map((m) => esc(m.text)).join(', ')}</span>`
      : a.affordable ? `<span class="pill green">${svg.check}Can buy now</span>`
      : `<span class="pill">Need ${[a.gpCost > wallet ? `${fmtGp(a.gpCost - wallet)} more gold` : '', ...a.s.ci.filter(([it, q]) => (e.bank[it] || 0) < q).map(([it, q]) => `${fmtNum(q - (e.bank[it] || 0))} ${esc(e.name(it))}`)].filter(Boolean).join(' + ')}</span>`;
    return `<article class="panel up-card ${a.dGp > 0 && !a.gap ? 'good' : ''}">
      <div class="uc-top">
        <span class="ico">${img(a.s.i || skillIcon(a.skill), '', 36)}</span>
        <div><b>${esc(a.s.n)}</b><span class="muted">${a.skills.map((k) => `${img(skillIcon(k), '', 14)}${k}`).join(' ')}</span></div>
        ${status}
      </div>
      <ul class="fx">${fx.map((f) => `<li class="${f.good ? 'good' : 'bad'}"><b>${f.val}</b> ${esc(f.label)}${f.where ? ` <span class="muted">· ${esc(f.where)}</span>` : ''}</li>`).join('')}</ul>
      <div class="uc-impact">
        <div><div class="k">Gold / hr</div><div class="v num ${a.dGp > 0 ? 'green' : 'muted'}">${a.dGp > 0 ? '+' + fmtGp(a.dGp) : '—'}</div></div>
        <div><div class="k">XP / hr</div><div class="v num ${a.dXp > 0.0005 ? 'green' : 'muted'}">${a.dXp > 0.0005 ? '+' + fmtPct(a.dXp, 1) : '—'}</div></div>
        <div><div class="k">Pays back</div><div class="v num">${Number.isFinite(a.payback) ? fmtDuration(a.payback) : '—'}</div></div>
      </div>
      <div class="uc-cost"><span class="muted">Cost</span>${a.gpCost ? `<span>${img(g.currencies.GoldPieces, '', 16)}<b class="num">${fmtNum(a.gpCost)}</b></span>` : ''}${a.s.ci.map(([it, q]) => `<span data-item="${esc(it)}" class="${(e.bank[it] || 0) >= q ? '' : 'short'}">${img(itemIcon(it), '', 16)}<b class="num">${fmtNum(q)}</b></span>`).join('')}${a.otherCur.map(([c, q]) => `<span>${img(g.currencies[c], '', 16)}<b class="num">${fmtNum(q)}</b></span>`).join('')}</div>
      ${afford}
      ${a.after?.money && a.dGp > 0 ? `<div class="uc-foot">Measured on <b>${esc(a.after.money.m.n)}</b>: ${fmtGp(a.before.gph)} → <b class="gold">${fmtGp(a.after.gph)}</b> gp/hr</div>` : ''}
    </article>`;
  };
  return `
  <div class="section-head"><div><h2>Upgrades</h2><p>Shop upgrades you can buy next, priced against what they earn you. Each gain is measured on your best method for that skill, with every upgrade you already own.</p></div></div>
  <div class="filter-row up-controls">
    <div class="seg" role="group" aria-label="Sort"><button data-upsort="payback" aria-pressed="${state.upSort === 'payback'}">Pays back fastest</button><button data-upsort="gain" aria-pressed="${state.upSort === 'gain'}">Most gold</button><button data-upsort="xp" aria-pressed="${state.upSort === 'xp'}">Most XP</button></div>
    <div class="seg" role="group" aria-label="Filter"><button data-upfilter="all" aria-pressed="${state.upFilter === 'all'}">All</button><button data-upfilter="now" aria-pressed="${state.upFilter === 'now'}">Can buy now</button></div>
  </div>
  ${list.length ? `<div class="up-grid stagger">${list.map(card).join('')}</div>` : `<div class="empty"><b>Nothing new within reach.</b>You own every skilling upgrade you currently qualify for.</div>`}
  ${gearSection()}
  ${potionSection()}
  ${astroSection()}
  <details class="owned">
    <summary><b>Upgrades you own</b> <span class="muted">${owned.length} active · already counted in every rate</span></summary>
    <div class="owned-grid">${owned.map((o) => `<div class="owned-item">${img(o.i || itemIcon(o.id), '', 24)}<div><b>${esc(o.n)}</b><span>${o.b.map((b) => { const t = bonusText(b, lookup); return `${t.val} ${esc(t.label)}${t.where ? ` (${esc(t.where)})` : ''}`; }).join(' · ')}</span></div>${o.kind === 'tool' ? '<span class="pill">equipped</span>' : ''}</div>`).join('')}</div>
  </details>`;
}

function gearSection() {
  const e = E();
  const list = e.gearAdvice();
  if (!list.length) return '';
  const g = G();
  return `<div class="section-sub" style="margin-top:26px"><h4>Combat gear worth getting</h4><span class="muted" style="font-size:13px">Gear you can equip but don't own yet, and can craft or buy. Each piece is tested in the best loadout against your top combat targets, and shown for the enemy it helps most.</span></div>
  <div class="pot-list stagger">${list.map((x) => {
    const src = x.src === 'bank' ? '<span class="pill green">in your bank</span>' : x.src === 'make' ? `<span class="pill">make: ${esc(x.via?.s || '')} · ${esc(x.via?.n || '')}</span>` : `<span class="pill">shop · ${fmtGp(x.price)}</span>`;
    return `<div class="pot-row gear-row" data-item="${esc(x.id)}">
      ${img(x.it.i, '', 32)}
      <div class="title"><b>${esc(x.it.n)}</b><span class="sub">${esc((x.slot || '').replace(/Slot\d/, ''))}${x.cur ? `<span class="sep">·</span>replaces ${esc(g.items[x.cur]?.n || x.cur)}` : '<span class="sep">·</span>empty slot'}<span class="sep">·</span>for ${esc(x.enemy.n)} (${esc(x.style)}${x.style !== x.styleBefore ? `, instead of ${esc(x.styleBefore)}` : ''})</span></div>
      ${src}
      <div class="pot-k"><small>kill time</small><b class="num">${fmtMs(x.killAfter)}</b></div>
      <div class="pot-k"><small>damage taken</small><b class="num ${x.takenAfter < x.takenBefore ? 'green' : ''}">${x.takenBefore > 0 ? fmtPct(x.takenAfter / x.takenBefore - 1, 0) : '—'}</b></div>
      <div class="pot-k"><small>gold / hr</small><b class="num gold">+${fmtGp(x.dGp)}</b></div>
    </div>`;
  }).join('')}</div>`;
}

/** What a node does, in words. */
function nodeText(nd) {
  const fx = (nd.b || []).map((b) => bonusText(b, lookup)).filter((f) => !/knowledge/i.test(f.label) || nd.b.length === 1);
  return fx.length ? fx.map((f) => `${f.val} ${f.label}${f.skill && !/^(Combat|Astrology)$/.test(f.skill) ? ' (' + f.skill + ')' : f.where ? ' (' + f.where + ')' : ''}`).join(', ') : (nd.d || '');
}

function pickGain(x) {
  return x.dGp > 0.5 ? `<b class="num green">+${fmtGp(x.dGp)}</b><small>gp/hr</small>` : x.dXp > 0.0005 ? `<b class="num green">+${fmtPct(x.dXp, 1)}</b><small>xp/hr</small>` : '<b class="muted">—</b><small>not modelled</small>';
}

/** Nodes with the same bonus (e.g. B1 and B2) shown as one choice. */
function groupPicks(picks) {
  const out = new Map();
  for (const x of picks) {
    const k = (x.major ? 'M' : 'm') + JSON.stringify(x.nd.b) + (x.nd.d || '');
    if (out.has(k)) out.get(k).names.push(x.nd.n); else out.set(k, { ...x, names: [x.nd.n] });
  }
  return [...out.values()];
}

function astroPanel() {
  const e = E();
  const list = e.astroAdvice();
  if (!list.length) return '';
  const N = G().astro.nodes;
  const card = (a) => {
    const thrPrev = a.c.thr[a.avail - 1] || 0;
    const pct = a.next ? Math.min(100, ((a.knowledge - thrPrev) / (a.next.need - thrPrev)) * 100) : 100;
    const wait = a.freeMinor + a.freeMajor;
    return `<div class="as-card ${a.unlocked ? '' : 'locked'}">
      <div class="as-h">${img(a.c.i, '', 34)}<span><b>${esc(a.c.n)}</b><small>${a.unlocked ? `${fmtNum(a.knowledge)} knowledge · ${a.have}/${a.c.minor.length} minor · ${a.major}/${a.c.major.length} major` : esc(a.missing.map((r) => r.text).join(', '))}</small></span>
        ${wait ? `<span class="pill gold">${wait} pick${wait === 1 ? '' : 's'} waiting</span>` : a.unlocked && a.next ? `<span class="as-next num">next pick in ${fmtDuration(a.next.hours)}</span>` : ''}</div>
      ${a.unlocked ? `<div class="xpbar"><i style="width:${pct}%"></i></div>` : ''}
      ${a.nodes.length ? `<div class="as-have">${a.nodes.map((id) => `<span title="${esc(nodeText(N[id]))}">${esc(N[id].n)}</span>`).join('')}</div>` : ''}
      ${a.picks.length ? `<div class="as-picks">${groupPicks(a.picks).slice(0, 4).map((x, i) => `<div class="as-pick ${i === 0 && (x.dGp > 0.5 || x.dXp > 0.0005) ? 'best' : ''}"><span class="as-node">${x.major ? 'Major' : 'Minor'} ${esc(x.names.join(' / '))}</span><span class="as-fx">${esc(nodeText(x.nd))}</span><span class="as-gain">${pickGain(x)}</span></div>`).join('')}</div>` : ''}
    </div>`;
  };
  const open = list.filter((a) => a.unlocked), shut = list.filter((a) => !a.unlocked);
  return `<div class="section-sub" style="margin-top:22px"><h4>Constellations</h4><span class="muted" style="font-size:13px">Studying builds knowledge. Each threshold gives a minor node pick, and every ${list[0].c.per} minor nodes a major pick. Picks are ranked by what they add to your best method in the skill they boost. Read from your save.</span></div>
  <div class="as-grid">${open.map(card).join('')}</div>
  ${shut.length ? `<div class="as-locked">${shut.map((a) => `<span>${img(a.c.i, '', 20)}${esc(a.c.n)} <small class="muted">${esc(a.missing.map((r) => r.text).join(', '))}</small></span>`).join('')}</div>` : ''}`;
}

function astroSection() {
  const e = E();
  const rows = e.astroAdvice().filter((a) => a.unlocked).flatMap((a) => groupPicks(a.picks.filter((x) => x.dGp > 0.5 || x.dXp > 0.0005)).slice(0, 2).map((x) => ({ a, x })))
    .sort((p, q) => q.x.dGp - p.x.dGp || q.x.dXp - p.x.dXp).slice(0, 8);
  if (!rows.length) return '';
  return `<div class="section-sub" style="margin-top:26px"><h4>Astrology nodes worth picking</h4><span class="muted" style="font-size:13px">The best next node in each constellation you can study, measured on your best method. Picks need knowledge from studying that constellation.</span></div>
  <div class="pot-list stagger">${rows.map(({ a, x }) => `<div class="pot-row" data-tskill-go="Astrology" data-target-go="${e.level('Astrology') + 1}">
      ${img(a.c.i, '', 32)}
      <div class="title"><b>${esc(a.c.n)} ${esc(x.names.join(' / '))}</b><span class="sub">${x.skill ? img(skillIcon(x.skill), '', 14) + x.skill + '<span class="sep">·</span>' : ''}${esc(nodeText(x.nd))}</span></div>
      <div class="pot-k"><small>gold / hr</small><b class="num ${x.dGp > 0.5 ? 'green' : 'muted'}">${x.dGp > 0.5 ? '+' + fmtGp(x.dGp) : '—'}</b></div>
      <div class="pot-k"><small>xp / hr</small><b class="num ${x.dXp > 0.0005 ? 'green' : 'muted'}">${x.dXp > 0.0005 ? '+' + fmtPct(x.dXp, 1) : '—'}</b></div>
      <div class="pot-k"><small>when</small><b class="num">${a.freeMinor > 0 || (x.major && a.freeMajor > 0) ? 'now' : a.next ? fmtDuration(a.next.hours) : '—'}</b></div>
    </div>`).join('')}</div>`;
}

function potionSection() {
  const e = E();
  const list = e.potionAdvice();
  if (!list.length) return '';
  return `<div class="section-sub" style="margin-top:26px"><h4>Potions worth drinking</h4><span class="muted" style="font-size:13px">Potions you can brew or already own, measured on your best method. Their cost is what each one costs you to make, times how many you use.</span></div>
  <div class="pot-list stagger">${list.map((x) => {
    const fx = x.it.tb.map((b) => bonusText(b, lookup));
    return `<div class="pot-row" data-item="${esc(x.id)}">
      ${img(x.it.i, '', 32)}
      <div class="title"><b>${esc(x.it.n)}</b><span class="sub">${img(skillIcon(x.skill), '', 14)}${x.skill}<span class="sep">·</span>${fx.map((f) => `${f.val} ${esc(f.label)}`).join(', ')}</span></div>
      <div class="pot-k"><small>gold / hr</small><b class="num ${x.dGp > 0 ? 'green' : 'muted'}">${x.dGp > 0 ? '+' + fmtGp(x.dGp) : '—'}</b></div>
      <div class="pot-k"><small>xp / hr</small><b class="num ${x.dXp > 0.0005 ? 'green' : 'muted'}">${x.dXp > 0.0005 ? '+' + fmtPct(x.dXp, 1) : '—'}</b></div>
      <div class="pot-k"><small>uses ${fmtNum(x.perHour)}/hr</small><b class="num red">−${fmtGp(x.costHr)}</b></div>
      <div class="pot-k"><small>net gold</small><b class="num ${x.net > 0 ? 'gold' : 'red'}">${fmtGp(x.net, { sign: true })}</b></div>
    </div>`;
  }).join('')}</div>`;
}

// ---------------------------------------------------------------- share card
async function openCard() {
  const e = E(), g = G(), s = state.save;
  const d = $('#card');
  d.innerHTML = `<div class="ch-head"><h3>Share card</h3><button class="btn btn-ghost btn-sm" data-close aria-label="Close">✕</button></div>
    <p class="muted" style="margin:0 0 10px;font-size:13px">A picture of your profile, drawn in your browser. Download it or copy it, then paste it into Discord.</p>
    <canvas id="card-canvas" class="card-canvas" width="1200" height="630"></canvas>
    <div class="ch-actions"><button class="btn btn-sm btn-gold" id="card-copy">Copy image</button><button class="btn btn-sm" id="card-dl">Download PNG</button></div>`;
  d.showModal();
  const best = e.ranked('best')[0];
  let next = '';
  try {
    const plan = e.speedPlan({ horizon: 24, maxSteps: 3 });
    const st = plan.steps[0];
    if (st) next = `${st.title}${st.rateAfter > st.rateBefore ? ` → ${fmtGp(st.rateAfter)} gp/hr` : ''}`;
  } catch { /* no plan */ }
  const skills = Object.entries(s.skills).filter(([k]) => g.skills[k] && k !== 'Combat').map(([k, v]) => ({ k, level: v.level, icon: g.skills[k]?.i }))
    .sort((a, b) => b.level - a.level || order(a.k) - order(b.k)).slice(0, 20);
  const canvas = $('#card-canvas');
  await drawCard(canvas, {
    name: s.header.name, mode: s.header.gamemode && !/^(Standard|Test)$/.test(s.header.gamemode) ? s.header.gamemode : '', totalLevel: s.header.totalLevel,
    bank: e.bankValue().total, gold: s.wallet?.GoldPieces ?? s.header.gp ?? 0,
    best: best ? { name: best.m.n, gph: best.gph, icon: methodIcon(best.m) } : null,
    farm: e.farmPlan?.()?.gph || 0, quests: Object.values(s.quests || {}).filter((q) => q.state >= 2).length,
    skills, next, url: location.origin + location.pathname, saved: s.header.timestamp ? relTime(s.header.timestamp) : '', fmtGp, goldIcon: g.currencies.GoldPieces,
  });
  const blob = () => new Promise((res) => canvas.toBlob(res, 'image/png'));
  d.onclick = async (ev) => {
    if (ev.target === d || ev.target.closest('[data-close]')) { d.close(); return; }
    if (ev.target.closest('#card-dl')) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await blob());
      a.download = `${s.header.name.replace(/[^\w-]+/g, '_')}-melvor-ledger.png`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
    if (ev.target.closest('#card-copy')) {
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob() })]); toast('Card copied: paste it into Discord'); }
      catch { toast('Your browser blocked copying images. Use Download instead.'); }
    }
  };
}

// ---------------------------------------------------------------- characters
function openChars() {
  const d = $('#chars');
  const chars = loadChars();
  const cur = state.save?.header?.uuid;
  const list = Object.entries(chars).sort((a, b) => (b[1].t || 0) - (a[1].t || 0));
  d.innerHTML = `<div class="ch-head"><h3>Characters</h3><button class="btn btn-ghost btn-sm" data-close aria-label="Close">${svg.close || '✕'}</button></div>
    <p class="muted" style="margin:0 0 10px;font-size:13px">Every save you import is kept on this device, one per character (the newest wins). Nothing is uploaded.</p>
    <div class="ch-list">${list.map(([id, c]) => `<div class="ch-row ${id === cur ? 'on' : ''}">
      <span class="ch-main"><b>${esc(c.name)}</b><small>${esc(modeName(c.mode))} · total level ${fmtNum(c.tl || 0)} · ${fmtGp(c.gp || 0)} gold · saved ${esc(relTime(new Date(c.t)))}</small></span>
      ${id === cur ? '<span class="pill green">open</span>' : c.s ? `<button class="btn btn-sm" data-ch-open="${esc(id)}">Open</button>` : '<span class="pill">re-import to open</span>'}
      <button class="btn btn-ghost btn-sm" data-ch-del="${esc(id)}" title="Forget this character on this device">Remove</button>
    </div>`).join('') || '<div class="muted">No characters yet.</div>'}</div>
    <div class="ch-actions"><button class="btn btn-sm" id="ch-add">Import another character</button>${list.filter(([, c]) => c.s).length > 1 ? '<button class="btn btn-sm btn-gold" id="ch-compare">Compare</button>' : ''}</div>
    <div id="ch-cmp"></div>`;
  d.showModal();
  d.onclick = async (ev) => {
    if (ev.target === d || ev.target.closest('[data-close]')) { d.close(); return; }
    const o = ev.target.closest('[data-ch-open]'), del = ev.target.closest('[data-ch-del]');
    if (o) { const c = loadChars()[o.dataset.chOpen]; d.close(); if (c?.s) { try { await loadSave(c.s); } catch (err) { toast(err.message); } } return; }
    if (del) {
      const all = loadChars(); delete all[del.dataset.chDel]; storeChars(all);
      try { localStorage.removeItem(HIST_KEY + del.dataset.chDel); } catch { /* ignore */ }
      if (del.dataset.chDel === cur) { d.close(); localStorage.removeItem(STORE_KEY); state.save = null; renderLanding(); return; }
      return openChars();
    }
    if (ev.target.closest('#ch-add')) { d.close(); localStorage.removeItem(STORE_KEY); state.save = null; history.replaceState(null, '', location.pathname); renderLanding(); return; }
    if (ev.target.closest('#ch-compare')) { $('#ch-cmp').innerHTML = '<div class="muted" style="padding:10px 0">Working out each character…</div>'; setTimeout(() => compareChars(), 30); }
  };
}

async function compareChars() {
  const chars = Object.entries(loadChars()).filter(([, c]) => c.s).sort((a, b) => (b[1].tl || 0) - (a[1].tl || 0)).slice(0, 6);
  const cols = [];
  for (const [id, c] of chars) {
    try {
      const sv = id === state.save?.header?.uuid ? state.save : await decodeSave(c.s);
      const eng = id === state.save?.header?.uuid ? E() : new Engine(state.game);
      if (eng !== E()) eng.setPlayer(sv, { useMods: true });
      const best = eng.ranked('best')[0];
      const xpBest = Object.fromEntries([...SKILL_ORDER.filter((k) => !NOT_TRAINABLE.has(k)), ...COMBAT_SKILLS].map((k) => [k, sv.skills[k]?.level ?? 1]));
      cols.push({ id, c, sv, best, bank: eng.bankValue().total, lv: xpBest, quests: Object.values(sv.quests || {}).filter((q) => q.state >= 2).length, farm: eng.farmPlan?.()?.gph || 0 });
    } catch { /* skip unreadable */ }
  }
  if (!cols.length) { $('#ch-cmp').innerHTML = ''; return; }
  const maxOf = (f) => Math.max(...cols.map(f));
  const cell = (v, best, fmt) => `<td class="num ${cols.length > 1 && v === best && v > 0 ? 'gold' : ''}">${fmt(v)}</td>`;
  const row = (label, f, fmt = fmtGp) => { const b = maxOf(f); return `<tr><th>${label}</th>${cols.map((x) => cell(f(x), b, fmt)).join('')}</tr>`; };
  const skills = Object.keys(cols[0].lv);
  $('#ch-cmp').innerHTML = `<div class="ch-cmp"><table>
    <thead><tr><th></th>${cols.map((x) => `<th>${esc(x.c.name)}</th>`).join('')}</tr></thead>
    <tbody>
      ${row('Total level', (x) => x.sv.header.totalLevel, fmtNum)}
      ${row('Gold', (x) => x.sv.wallet?.GoldPieces ?? x.sv.header.gp ?? 0)}
      ${row('Bank value', (x) => x.bank)}
      ${row('Best gp/hr', (x) => x.best?.gph || 0)}
      <tr><th>Best method</th>${cols.map((x) => `<td>${esc(x.best?.m.n || '—')}</td>`).join('')}</tr>
      ${row('Farm gp/hr', (x) => x.farm)}
      ${row('Quests done', (x) => x.quests, fmtNum)}
      ${skills.map((k) => row(`${img(skillIcon(k), '', 14)} ${k}`, (x) => x.lv[k], fmtNum)).join('')}
    </tbody></table></div>`;
}

// ---------------------------------------------------------------- item & recipe browser
const DB_CATS = [['', 'All'], ['Equipment', 'Equipment'], ['Weapon', 'Weapons'], ['Toolbelt', 'Toolbelt'], ['Food', 'Food'], ['Openable', 'Chests'], ['HuntingTrap', 'Traps'], ['Compost', 'Compost'], ['Bury', 'Bones']];

function dbItemRows() {
  const e = E(), g = G();
  const db = state.db;
  const { costs } = e.solveChains();
  const q = db.q.trim().toLowerCase();
  let rows = Object.entries(g.items).map(([id, it]) => ({ id, it, have: e.bank[id] || 0 }));
  if (db.cat) rows = rows.filter((x) => x.it.c.includes(db.cat));
  if (db.skill) rows = rows.filter((x) => x.it.t.includes(db.skill));
  if (db.owned) rows = rows.filter((x) => x.have > 0);
  if (q) rows = rows.filter((x) => x.it.n.toLowerCase().includes(q) || x.id.toLowerCase().includes(q));
  for (const x of rows) {
    x.cost = costs.get(x.id) || null;
    x.buy = e.buyPrice(x.id);
    x.src = e.producers.get(x.id) || [];
    x.use = e.consumers.get(x.id) || [];
  }
  const by = {
    value: (a, b) => b.it.v - a.it.v,
    name: (a, b) => a.it.n.localeCompare(b.it.n),
    owned: (a, b) => b.have * b.it.v - a.have * a.it.v,
    margin: (a, b) => ((b.cost ? b.it.v - b.cost.gp : -Infinity) - (a.cost ? a.it.v - a.cost.gp : -Infinity)),
    uses: (a, b) => b.use.length - a.use.length,
  };
  return rows.sort(by[db.sort] || by.value);
}

function dbRecipeRows() {
  const e = E();
  const db = state.db;
  const q = db.q.trim().toLowerCase();
  let ms = e.methods.filter((m) => !m.quest && !(m.x?.t === 'fight' || m.id.startsWith('Dungeon:')));
  if (db.skill) ms = ms.filter((m) => m.s === db.skill);
  if (q) ms = ms.filter((m) => m.n.toLowerCase().includes(q) || m.in.some(([it]) => e.name(it).toLowerCase().includes(q)) || m.out.some(([it]) => e.name(it).toLowerCase().includes(q)));
  const rows = ms.map((m) => {
    const st = e.status(m);
    if (db.owned && !st.unlocked) return null;
    const lv = {};
    for (const r of m.r) if (r.t === 'lvl') lv[r.s] = Math.max(e.level(r.s), r.l);
    let s = null;
    try { s = e.sellRate(m, st.unlocked ? undefined : { ...e.levels, ...lv }); } catch { s = null; }
    return { m, st, gph: s?.gpPerHour ?? 0, xph: s?.r?.xp ?? 0 };
  }).filter(Boolean);
  const by = {
    value: (a, b) => b.gph - a.gph,
    name: (a, b) => a.m.n.localeCompare(b.m.n),
    owned: (a, b) => (b.st.unlocked - a.st.unlocked) || b.gph - a.gph,
    margin: (a, b) => b.xph - a.xph,
    uses: (a, b) => a.m.lv - b.m.lv || a.m.n.localeCompare(b.m.n),
  };
  return rows.sort(by[db.sort] || by.value);
}

/** Missing requirements in words, one level per skill (the highest). */
function missingText(missing) {
  const lv = new Map(), other = [];
  for (const r of missing) if (r.kind === 'lvl') lv.set(r.skill, Math.max(lv.get(r.skill) || 0, r.need)); else other.push(r.text);
  return [...[...lv].map(([k, n]) => `${k} ${n}`), ...new Set(other)].join(', ');
}

function viewItems() {
  const e = E(), g = G();
  const db = state.db;
  const isItems = db.view === 'items';
  const rows = isItems ? dbItemRows() : dbRecipeRows();
  const skills = isItems ? [...SKILL_ORDER, 'Shop', 'Quests', 'Upgrade', 'Astrology'] : [...SKILL_ORDER.filter((k) => k !== 'Combat'), 'Astrology'];
  const sorts = isItems ? [['value', 'Value'], ['margin', 'Profit to make'], ['owned', 'Bank value'], ['uses', 'Most used'], ['name', 'A–Z']]
    : [['value', 'Gold / hr'], ['margin', 'XP / hr'], ['uses', 'Level'], ['owned', 'Unlocked first'], ['name', 'A–Z']];
  const icons = (list, n = 3) => list.slice(0, n).map(([it, q]) => `<span class="db-ic" data-item="${esc(it)}" title="${esc(e.name(it))}">${img(itemIcon(it), '', 20)}${q !== 1 ? `<small>${fmtQty(q)}</small>` : ''}</span>`).join('') + (list.length > n ? `<small class="muted">+${list.length - n}</small>` : '');
  const itemRow = (x) => {
    const srcSk = [...new Set(x.src.map((m) => m.s))];
    const make = x.cost && x.cost.via?.kind === 'make';
    return `<div class="db-row" data-item="${esc(x.id)}">
      ${img(x.it.i, '', 32)}
      <span class="db-main"><b>${esc(x.it.n)}</b><small>${x.it.c.filter((c) => c !== 'Toolbelt' || !x.it.c.includes('Equipment')).map(esc).join(' · ') || 'Resource'}${x.it.eq?.slot ? ' · ' + esc(x.it.eq.slot) : x.it.slot ? ' · ' + esc(String(x.it.slot).replace(/([a-z])([A-Z])/g, '$1 $2')) : ''}${x.it.heal ? ` · heals ${fmtNum(x.it.heal)}` : ''}</small></span>
      <span class="db-sk">${srcSk.slice(0, 4).map((s) => img(skillIcon(s) || G().skills['_' + s]?.i, s, 18)).join('')}${Number.isFinite(x.buy) ? `<span class="pill">shop ${fmtGp(x.buy)}</span>` : ''}</span>
      <span class="db-v"><b class="num gold">${fmtGp(x.it.v)}</b><small>sells for</small></span>
      <span class="db-v"><b class="num">${make ? fmtGp(x.cost.gp) : Number.isFinite(x.buy) ? fmtGp(x.buy) : '—'}</b><small>${make ? `to make · ${fmtMs(x.cost.t)}` : Number.isFinite(x.buy) ? 'to buy' : 'cost'}</small></span>
      <span class="db-v"><b class="num">${x.use.length || '—'}</b><small>uses</small></span>
      <span class="db-v"><b class="num ${x.have ? '' : 'muted'}">${x.have ? fmtNum(x.have) : '—'}</b><small>you have</small></span>
    </div>`;
  };
  const recipeRow = (x) => `<div class="db-row db-rec ${x.st.unlocked ? '' : 'locked'}" data-item="${esc(x.m.primary || x.m.out[0]?.[0] || '')}">
      ${img(methodIcon(x.m), '', 32)}
      <span class="db-main"><b>${esc(x.m.n)}</b><small>${img(skillIcon(x.m.s), '', 14)} ${esc(x.m.s)} ${x.m.lv}${x.m.loc ? ' · ' + esc(x.m.loc) : ''}${x.st.unlocked ? '' : ` · <span class="red">${esc(missingText(x.st.missing))}</span>`}</small></span>
      <span class="db-flow">${x.m.in.length ? icons(x.m.in) + '<span class="arr">→</span>' : ''}${icons(x.m.out)}</span>
      <span class="db-v"><b class="num ${x.gph < 0 ? 'red' : 'gold'}">${fmtGp(x.gph)}</b><small>gp/hr${x.st.unlocked ? '' : ' at unlock'}</small></span>
      <span class="db-v"><b class="num">${fmtGp(x.xph)}</b><small>xp/hr</small></span>
    </div>`;
  const shown = rows.slice(0, db.limit);
  return `
  <div class="section-head"><div><h2>Items &amp; recipes</h2><p>Every item and recipe in the game, with values, sources and uses. Item costs are the cheapest of making it yourself (your time valued at your best rate) or buying it. Click any row for the full item card.</p></div>${state.explorer ? '' : modsToggle()}</div>
  <div class="controls">
    <div class="filter-row">
      <div class="seg" role="tablist"><button data-db="view:items" aria-pressed="${isItems}">Items</button><button data-db="view:recipes" aria-pressed="${!isItems}">Recipes</button></div>
      <div class="search">${svg.search}<input id="dbq" type="search" placeholder="Search ${isItems ? 'items' : 'recipes, inputs or products'}" value="${esc(db.q)}" aria-label="Search"/></div>
      <label class="toggle"><input type="checkbox" id="dbowned" ${db.owned ? 'checked' : ''}/>${isItems ? 'In my bank' : 'Unlocked only'}</label>
      <div class="seg" role="group" aria-label="Sort">${sorts.map(([k, l]) => `<button data-db="sort:${k}" aria-pressed="${db.sort === k}">${l}</button>`).join('')}</div>
    </div>
    ${isItems ? `<div class="chips" role="group" aria-label="Category">${DB_CATS.map(([k, l]) => `<button class="chip ${k ? '' : 'all'}" data-db="cat:${k}" aria-pressed="${db.cat === k}">${l}</button>`).join('')}</div>` : ''}
    <div class="chips" role="group" aria-label="Skill"><button class="chip all" data-db="skill:" aria-pressed="${!db.skill}">${isItems ? 'Any source' : 'All skills'}</button>${skills.map((s) => `<button class="chip" data-db="skill:${s}" aria-pressed="${db.skill === s}">${img(skillIcon(s) || G().skills['_' + s]?.i, '', 18)}${s}</button>`).join('')}</div>
  </div>
  <div class="muted db-count">${fmtNum(rows.length)} ${isItems ? 'item' : 'recipe'}${rows.length === 1 ? '' : 's'}</div>
  <div class="db-list">${shown.map(isItems ? itemRow : recipeRow).join('') || '<div class="empty">Nothing matches.</div>'}</div>
  ${rows.length > db.limit ? `<button class="btn more-btn" data-db="more:1">Show ${Math.min(60, rows.length - db.limit)} more <span class="muted">· ${rows.length - db.limit} left</span></button>` : ''}`;
}

// ---------------------------------------------------------------- farm
function viewFarm() {
  const e = E();
  const f = e.farmPlan();
  const g = G();
  if (!f) return '<div class="empty">No farming data.</div>';
  const FD = g.farm;
  const since = f.savedAt ? Date.now() - new Date(f.savedAt).getTime() : 0;
  const cropName = (x) => `${esc(x.m.n)}${x.compost ? ` <span class="muted">+ ${esc(g.items[x.compost]?.n || x.compost)}</span>` : ''}`;
  const catIcon = (c) => FD.cats[c]?.i;
  // your plots, soonest first
  const plots = f.plots.map((p) => ({ ...p, now: p.s.state >= 2 && !p.ready ? p.leftMs - since : 0 })).sort((a, b) => (a.empty ? -1 : a.now) - (b.empty ? -1 : b.now));
  const plotRow = (p) => {
    const cat = FD.cats[p.pl.c];
    const isBin = p.pl.c === 'CompostBins', isFlower = p.pl.c === 'Flowers';
    const advice = p.empty ? (isBin ? (f.bins.find((b) => b.ok) ? `Start ${f.bins.find((b) => b.ok).m.n}` : 'nothing to make yet') : isFlower ? (f.flowers[0] ? `Plant ${f.flowers[0].m.n}` : 'no flowers unlocked') : p.best ? `Plant ${p.best.m.n}${p.best.compost ? ' with ' + (g.items[p.best.compost]?.n || p.best.compost) : ''}` : 'nothing unlocked')
      : p.cur && p.best && p.best.gph > p.cur.gph * 1.02 ? `Next: ${p.best.m.n}${p.best.compost ? ' + ' + (g.items[p.best.compost]?.n || '') : ''} (+${fmtGp(p.best.gph - p.cur.gph)}/hr)` : p.cur ? 'Replant the same' : '';
    const when = p.empty ? '<span class="pill gold">empty</span>' : p.ready || p.now <= 0 ? `<span class="pill green">${svg.check}ready</span>` : `<span class="num">${fmtDuration(p.now / HOUR)}</span>`;
    return `<div class="fm-plot ${p.empty ? 'is-empty' : ''}">${img(p.m?.i || cat?.i, '', 30)}
      <span class="fm-main"><b>${esc(p.pl.n)}</b><small>${p.m ? esc(p.m.n) : 'nothing planted'}${p.s.watered ? ' · watered' : ''}${p.s.compost ? ' · ' + esc(g.items[p.s.compost]?.n || p.s.compost) : ''}</small></span>
      <span class="fm-adv">${esc(advice)}</span>
      <span class="fm-when">${when}</span></div>`;
  };
  const cats = f.crops.filter((c) => f.byCat[c].list.length || f.byCat[c].owned);
  const catCard = (c) => {
    const b = f.byCat[c];
    return `<div class="panel fm-cat">
      <div class="fm-cat-h">${img(catIcon(c), '', 26)}<b>${esc(FD.cats[c]?.n || c)}</b><span class="muted">${b.owned} plot${b.owned === 1 ? '' : 's'}</span></div>
      ${b.list.slice(0, 5).map((x, i) => `<div class="fm-crop ${i === 0 ? 'best' : ''}" data-item="${esc(x.m.x.p)}">${img(x.m.i, '', 22)}<span class="fm-cn">${cropName(x)}<small>${fmtNum(Math.round(x.perHarvest))} per harvest${x.harvests > 1 ? ` × ${x.harvests}` : ''} · every ${fmtDuration(x.cycleMs / HOUR / x.harvests)}${x.adj < 0.995 ? ` · −${Math.round((1 - x.adj) * 100)}% pests/disease` : ''}</small></span><span class="fm-v"><b class="num ${x.gph < 0 ? 'red' : 'gold'}">${fmtGp(x.gph)}</b><small>gp/hr</small></span><span class="fm-v"><b class="num">${fmtGp(x.xph)}</b><small>xp/hr</small></span></div>`).join('') || '<div class="muted" style="font-size:13px">No crops unlocked yet.</div>'}
    </div>`;
  };
  const bestBin = f.bins.find((b) => b.ok);
  return `
  <div class="section-head"><div><h2>Farm</h2><p>Your plots from the save and when each is ready, the best crop for each plot type with your bonuses, what compost and flowers are worth to you, and which plot to buy next. Rates are per plot per real hour, if you replant as soon as a crop is ready.</p></div>${modsToggle()}</div>
  <div class="plan-sum stagger">
    <div class="panel stat"><div class="label">${img(g.currencies.GoldPieces, '', 16)}Your farm</div><div class="value num gold">${fmtGp(f.gph)}<small>/hr</small></div><div class="sub">${f.plots.length} plots on the best crops</div></div>
    <div class="panel stat"><div class="label">${svg.clock}Next ready</div><div class="value num">${(() => { const n = plots.find((p) => !p.empty && p.now > 0); const r = plots.filter((p) => !p.empty && (p.ready || p.now <= 0)).length; return r ? `${r} ready` : n ? fmtDuration(n.now / HOUR) : '—'; })()}</div><div class="sub">as of your last import${since > 0 ? `, ${fmtDuration(since / HOUR)} ago` : ''}</div></div>
    <div class="panel stat"><div class="label">${img(g.items.Compost?.i, '', 16)}Compost is worth</div><div class="value num">${fmtGp(f.compostWorth.Compost || 0)}<small> gp each</small></div><div class="sub">extra harvest on your best plot · sells for ${fmtGp(g.items.Compost?.v || 0)}</div></div>
  </div>
  ${f.known ? `<div class="section-sub"><h4>Your plots</h4><span class="muted" style="font-size:13px">Times count down from when you imported the save.</span></div>
  <div class="fm-plots">${plots.map(plotRow).join('')}</div>` : '<div class="note">' + svg.info + '<span>Import a save to see your plots.</span></div>'}
  <div class="section-sub" style="margin-top:22px"><h4>Best crops by plot type</h4><span class="muted" style="font-size:13px">Each crop with its best compost (compost is priced at the shop, or its sell value). Yield uses the game's formula: pests and disease above your protection cut the harvest; watering adds disease protection.</span></div>
  <div class="fm-cats">${cats.map(catCard).join('')}</div>
  <div class="fm-two">
    <div class="panel fm-side"><h4>Plots to buy next</h4>
      ${f.buy.map((b) => `<div class="fm-buy">${img(catIcon(b.cat), '', 24)}<span class="fm-main"><b>${esc(b.pl.n)}</b><small>${b.best?.m ? 'grows ' + esc(b.best.m.n) : ''}${b.missing.length ? ` · needs ${esc(b.missing.map((m) => m.text).join(', '))}` : ''}</small></span><span class="fm-v"><b class="num">${fmtGp(b.pl.gp)}</b><small>cost</small></span><span class="fm-v"><b class="num ${b.gain > 0 ? 'green' : 'muted'}">${b.gain > 0 ? '+' + fmtGp(b.gain) : '—'}</b><small>gp/hr</small></span><span class="fm-v"><b class="num">${Number.isFinite(b.payback) ? fmtDuration(b.payback) : '—'}</b><small>pays back</small></span></div>`).join('')}
    </div>
    <div class="panel fm-side"><h4>Compost &amp; flowers</h4>
      ${bestBin ? `<p class="fm-p">A compost bin making <b>${esc(bestBin.m.n)}</b> turns ${bestBin.m.in.map(([it, q]) => `${fmtNum(q)} ${esc(e.name(it))}`).join(' + ')} into ${fmtNum(bestBin.out)} compost a day, worth <b class="green">${fmtGp(bestBin.gph)}/hr</b> in extra harvest. Your best crops use about ${fmtNum(Math.round(f.compostPerDay))} compost a day.</p>` : ''}
      ${f.flowers.length ? f.flowers.slice(0, 6).map((x) => `<div class="fm-buy fm-fl">${img(x.m.i, '', 24)}<span class="fm-main"><b>${esc(x.m.n)}${x.active ? ' <span class="pill green">growing</span>' : ''}</b><small>${(x.m.x.fb || []).map((b) => { const t = bonusText(b, lookup); return `${t.val} ${t.label}`; }).join(', ')} on every plot</small></span><span class="fm-v"><b class="num ${x.net > 0 ? 'green' : 'muted'}">${x.net > 0.5 ? '+' + fmtGp(x.net) : '—'}</b><small>gp/hr net</small></span></div>`).join('') : `<p class="fm-p muted">Flowers unlock at Farming 30 (Flower plot). Each one boosts every plot while it grows: more harvest, protection from pests or disease, or Farming XP.</p>`}
    </div>
  </div>`;
}

// ---------------------------------------------------------------- bank
function viewBank() {
  const sub = `<div class="seg bank-switch" role="tablist"><button data-bankview="use" aria-pressed="${state.bankView === 'use'}">Put to use</button><button data-bankview="process" aria-pressed="${state.bankView === 'process' || state.bankView === 'sell'}">Process &amp; sell</button><button data-bankview="collection" aria-pressed="${state.bankView === 'collection'}">Collection</button><button data-bankview="all" aria-pressed="${state.bankView === 'all'}">Everything</button></div>`;
  if (state.bankView === 'use') return viewLeftovers(sub);
  if (state.bankView === 'process' || state.bankView === 'sell') return viewAlchemy(sub) + viewSafeSell(null);
  return state.bankView === 'all' ? viewBankAll(sub) : viewCollection(sub);
}

function viewLeftovers(sub) {
  const e = E(), g = G();
  const L = e.leftovers();
  const keepRows = L.keep.sort((a, b) => b.qty * e.value(b.item) - a.qty * e.value(a.item));
  const skillCard = (x) => `<div class="panel lo-skill ${x.need > x.from ? 'needed' : ''}">
      <div class="lo-h">${img(skillIcon(x.skill), '', 28)}<span><b>${esc(x.skill)}</b><small>${x.to > x.from ? `level ${x.from} → <b class="green">${x.to}</b>` : `level ${x.from}`} · ${fmtGp(x.xp)} XP in ${fmtDuration(x.hours)}</small></span>
        ${x.need > x.from ? (x.to >= x.need ? `<span class="pill green">${svg.check}covers the ${x.need} your route needs</span>` : `<span class="pill gold">route needs ${x.need}</span>`) : ''}
        <span class="lo-v"><b class="num ${x.saved > 0 ? 'green' : 'muted'}">${x.saved > 0.01 ? fmtDuration(x.saved) : '—'}</b><small>training saved</small></span></div>
      <div class="lo-runs">${x.runs.slice(0, 4).map((r) => `<div class="lo-run" data-item="${esc(r.m.primary || '')}">${img(methodIcon(r.m), '', 20)}<span>${esc(r.m.n)}</span><span class="muted">${[...r.used].slice(0, 3).map(([it, q]) => `${fmtNum(q)} ${esc(e.name(it))}`).join(', ')}</span><span class="num">${fmtGp(r.xp)} xp</span></div>`).join('')}${x.runs.length > 4 ? `<small class="muted">+${x.runs.length - 4} more</small>` : ''}</div>
      <div class="lo-foot muted">${x.gp >= 0 ? `and the products are worth <b class="green">${fmtGp(x.gp)}</b> more than the materials` : `costs <b class="red">${fmtGp(-x.gp)}</b> of sell value`}</div>
    </div>`;
  return `
  <div class="section-head"><div><h2>Bank</h2><p>Your leftovers, put to work. First what to keep for the quests you haven't finished, then how much XP your stock is worth in each skill if you process it, chains included (ore into bars into armour). Skills your route needs next come first.</p></div>${modsToggle()}</div>
  ${sub}
  ${keepRows.length ? `<div class="section-sub"><h4>Keep for quests</h4><span class="muted" style="font-size:13px">Hand-ins for quests you haven't finished. These are left out of everything below.</span></div>
  <div class="lo-keep">${keepRows.map((k) => `<div class="lo-k" data-item="${esc(k.item)}">${img(itemIcon(k.item), '', 26)}<span><b>${fmtNum(Math.min(k.qty, k.have))} ${esc(e.name(k.item))}</b><small>${esc(k.why.join(', '))}${k.have < k.qty ? ` · need ${fmtNum(k.qty - k.have)} more` : ''}</small></span></div>`).join('')}</div>` : ''}
  <div class="section-sub" style="margin-top:18px"><h4>Train from your bank</h4><span class="muted" style="font-size:13px">Processing what you already own, greedily by XP, each product feeding the next step. "Training saved" is the time your best method would take for the same XP, minus the time processing takes.</span></div>
  ${L.skills.length ? `<div class="lo-grid">${L.skills.map(skillCard).join('')}</div>` : '<div class="empty">Nothing in your bank can be processed for XP right now.</div>'}`;
}

function viewAlchemy(sub) {
  const e = E();
  const list = e.alchemy();
  const total = list.reduce((a, x) => a + x.uplift, 0);
  return `
  <div class="section-head"><div><h2>Bank</h2><p>For every stack: sell it now, or process it into something worth more first. Inputs you use up are counted at their sell value, so the green number is pure extra profit.${total > 0 ? ` Processing everything below adds <b class="green">${fmtGp(total)}</b>.` : ''}</p></div>${sub}</div>
  ${list.length ? `<div class="alch-grid stagger">${list.slice(0, 60).map((a) => {
    const m = a.m;
    const prim = m.primary;
    const ratio = a.sellNow > 0 ? (a.sellNow + a.uplift) / a.sellNow : 0;
    return `<article class="panel alch" data-item="${esc(a.item)}">
      <div class="alch-top"><span class="ico">${img(itemIcon(a.item), '', 40)}</span><div><b>${fmtNum(a.qty)} × ${esc(e.name(a.item))}</b><span>${fmtGp(e.value(a.item))} gp each</span></div></div>
      <div class="alch-vs">
        <div class="alch-opt"><div class="k">Sell now</div><div class="v num">${fmtGp(a.sellNow)}</div><div class="d">instant</div></div>
        <div class="alch-arrow">${svg.arrow}</div>
        <div class="alch-opt best"><div class="k">${esc(m.s)} first</div><div class="v num">${fmtGp(a.uplift, { sign: true })}</div><div class="d">${img(itemIcon(prim) || m.i, '', 16)}${esc(m.n)}</div></div>
      </div>
      <div class="alch-foot"><span>${fmtDuration(a.b.hours)} of ${esc(m.s.toLowerCase())} · ${fmtGp(a.b.gpPerHour)}/hr</span>${ratio > 1.05 ? `<span class="mult">${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× the value</span>` : ''}</div>
    </article>`;
  }).join('')}</div>` : `<div class="empty"><b>No profitable processing for your current bank.</b>Your stacks are already worth the most as they are.</div>`}`;
}

function viewCollection(sub) {
  const e = E();
  const c = e.collection();
  const pct = c.total ? c.have / c.total : 0;
  const quick = c.missing.filter((x) => x.best).slice(0, 40);
  const locked = c.missing.filter((x) => !x.best && x.lock).slice(0, 20);
  const R = 34, C = 2 * Math.PI * R;
  return `
  <div class="section-head"><div><h2>Bank</h2><p>Every item you have ever found, from your save's statistics, against everything the game has. Quickest finds are the missing items you can get soonest at your current rates.</p></div>${sub}</div>
  <div class="panel coll-hero">
    <svg class="ring" viewBox="0 0 80 80" width="96" height="96"><circle cx="40" cy="40" r="${R}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="8"/><circle cx="40" cy="40" r="${R}" fill="none" stroke="#f3c463" stroke-width="8" stroke-linecap="round" stroke-dasharray="${(C * pct).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 40 40)"/><text x="40" y="45" text-anchor="middle" fill="#ffe3a1" font-size="15" font-weight="700">${Math.round(pct * 100)}%</text></svg>
    <div><b class="num coll-n">${fmtNum(c.have)} <span class="muted">/ ${fmtNum(c.total)}</span></b><span class="muted">items found</span></div>
    <div class="coll-groups">${c.groups.map((g) => `<div class="cg">${img(skillIcon(g.skill) || G().skills._Shop?.i, '', 16)}<span>${esc(g.skill)}</span><div class="cg-bar"><i style="width:${(g.have / g.total) * 100}%"></i></div><span class="num muted">${g.have}/${g.total}</span></div>`).join('')}</div>
  </div>
  <h3 class="bu-h3">Quickest finds</h3>
  <div class="sell-list">${quick.map((x) => `<button class="sell-row" data-item="${esc(x.id)}">${img(x.it.i, '', 30)}<span class="title"><b>${esc(x.it.n)}</b><span class="sub">${x.best.buy != null ? `buy for ${fmtGp(x.best.buy)}` : `${img(skillIcon(x.best.m.s), '', 13)}${esc(x.best.m.n)}`}</span></span><span class="num muted">${esc(x.src)}</span><span class="num gold">${x.best.hours < 1 / 60 ? '<1m' : fmtDuration(x.best.hours)}</span></button>`).join('') || '<div class="empty"><b>Nothing quick left.</b></div>'}</div>
  ${locked.length ? `<h3 class="bu-h3">Locked for now</h3><div class="sell-list">${locked.map((x) => `<button class="sell-row" data-item="${esc(x.id)}">${img(x.it.i, '', 30)}<span class="title"><b>${esc(x.it.n)}</b><span class="sub">${esc(x.lock.m.n)}<span class="sep">·</span>${esc(x.lock.text)}</span></span><span class="num muted">${esc(x.src)}</span><span class="muted">${svg.lock}</span></button>`).join('')}</div>` : ''}`;
}

/** Items no skill uses (now or soon), that aren't gear, food or tools: free bank slots. */
function viewSafeSell(sub) {
  const e = E();
  const keepCaps = new Set(['Equipment', 'Weapon', 'Food', 'Toolbelt', 'Openable', 'HuntingTrap', 'FishingBait', 'Compost', 'Bury']);
  const shopNeeds = new Set(Object.entries(G().shop).filter(([id]) => !(e.shopOwned[id] > 0)).flatMap(([, s]) => s.ci.map(([i]) => i)));
  const rows = [];
  for (const [it, qty] of Object.entries(e.bank)) {
    const item = e.items[it];
    if (!item || item.c?.some((c) => keepCaps.has(c))) continue;
    const uses = e.consumers.get(it) || [];
    if (shopNeeds.has(it)) continue;
    const soon = uses.filter((m) => { const st = e.status(m); return st.unlocked || (st.onlyLevelLocked && st.levelGap <= 15); });
    if (soon.length) continue;
    const later = uses.length ? uses.reduce((a, m) => Math.min(a, m.lv), 99) : null;
    rows.push({ it, qty, total: qty * e.value(it), later, uses: uses.length });
  }
  rows.sort((a, b) => b.total - a.total);
  const total = rows.reduce((a, r) => a + r.total, 0);
  return `
  ${sub === null ? `<div class="section-sub" style="margin-top:28px"><h4>Safe to sell</h4><span class="muted" style="font-size:13px">Stacks nothing you can do (now or within 15 levels) uses and no shop upgrade needs: ${fmtNum(rows.length)} bank slots for <b class="gold">${fmtGp(total)}</b>. Combat drops and quest items aren't checked, so look before you sell those.</span></div>` : `<div class="section-head"><div><h2>Bank</h2><p>Stacks that no skill you have (or will have within 15 levels) uses, and no shop upgrade needs. Selling them frees ${fmtNum(rows.length)} bank slots for <b class="gold">${fmtGp(total)}</b>.</p></div>${sub}</div>`}
  ${rows.length ? `<div class="sell-list stagger">${rows.map((r) => `
    <button class="sell-row" data-item="${esc(r.it)}">
      ${img(itemIcon(r.it), '', 30)}
      <span class="title"><b>${esc(e.name(r.it))}</b><span class="sub">${r.uses ? `only used from level ${r.later}` : 'no known use'}</span></span>
      <span class="num muted">${fmtNum(r.qty)} × ${fmtGp(e.value(r.it))}</span>
      <span class="num gold">${fmtGp(r.total)}</span>
    </button>`).join('')}</div>` : `<div class="empty"><b>Nothing to clear out.</b>Everything in your bank has a use.</div>`}`;
}

function viewBankAll(sub) {
  const e = E();
  const { total, rows } = e.bankValue();
  let list = rows.slice();
  if (state.bankQ) list = list.filter((r) => e.name(r.item).toLowerCase().includes(state.bankQ.toLowerCase()));
  if (state.bankSort === 'qty') list.sort((a, b) => b.qty - a.qty);
  if (state.bankSort === 'name') list.sort((a, b) => e.name(a.item).localeCompare(e.name(b.item)));
  if (state.bankSort === 'each') list.sort((a, b) => b.v - a.v);
  const top = rows[0]?.total || 1;
  return `
  <div class="section-head"><div><h2>Bank</h2><p>${fmtNum(rows.length)} stacks worth <b class="gold">${fmtGp(total, { compact: false })} gp</b> if you sold everything now. Click any item to see where it comes from and what it makes.</p></div>${sub}</div>
  <div class="bank-head">
    <div class="seg" role="group" aria-label="Sort bank">
      ${[['value', 'Stack value'], ['each', 'Price each'], ['qty', 'Quantity'], ['name', 'Name']].map(([k, l]) => `<button data-bsort="${k}" aria-pressed="${state.bankSort === k}">${l}</button>`).join('')}
    </div>
    <div class="search">${svg.search}<input id="bq" type="search" placeholder="Search your bank" value="${esc(state.bankQ)}" aria-label="Search bank"/></div>
  </div>
  <div class="bank-grid" id="bank-grid">${list.map((r) => `
    <button class="tile" data-item="${esc(r.item)}" title="${esc(e.name(r.item))}">
      <div class="ti">${img(itemIcon(r.item), '', 40)}<span class="qty num">${fmtGp(r.qty)}</span></div>
      <div class="nm">${esc(e.name(r.item))}</div>
      <div class="val"><span>${fmtGp(r.v)} ea</span><b class="num">${fmtGp(r.total)}</b></div>
      <span class="share" style="width:${Math.max(1, (r.total / top) * 100)}%"></span>
    </button>`).join('')}</div>`;
}

// ---------------------------------------------------------------- unlocks
function viewUnlocks() {
  const e = E();
  const list = e.upcoming(400);
  const groups = new Map();
  for (const x of list) {
    const k = x.gap <= 1 ? 'One level away' : x.gap <= 5 ? 'Within 5 levels' : x.gap <= 15 ? 'Within 15 levels' : 'Longer term';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  const better = e.betterUnlocks();
  const all = better.list.filter((x) => x.beatsAll);
  const perSkill = new Map();
  for (const x of better.list.filter((x) => !x.beatsAll)) { if (!perSkill.has(x.m.s)) perSkill.set(x.m.s, []); if (perSkill.get(x.m.s).length < 3) perSkill.get(x.m.s).push(x); }
  const goBtn = (x) => `data-tskill-go="${esc(x.needs[0]?.skill || x.m.s)}" data-target-go="${x.needs[0]?.level || x.m.lv}"`;
  const card = (x) => `<button class="bu-card panel" ${goBtn(x)}>
      <div class="bu-top">${img(methodIcon(x.m), '', 40)}<div><b>${esc(x.m.n)}</b><span class="muted">${img(skillIcon(x.m.s), '', 14)}${x.m.s}${x.m.loc ? ` · ${esc(x.m.loc)}` : ''}</span></div></div>
      <div class="bu-v"><span class="num gold">${fmtGp(x.gph)}</span><small>gp/hr from scratch</small></div>
      <div class="bu-gain"><b class="green num">+${fmtGp(x.gain)}</b> over your best today (${esc(better.best?.m.n || '')}, ${fmtGp(better.nowBest)}/hr)</div>
      <div class="bu-need">${svg.target} ${[...x.needs.map((n) => `${esc(n.skill)} ${n.level} <span class="muted">(${n.gap} level${n.gap === 1 ? '' : 's'})</span>`), ...(x.kills || []).map((k) => `kill ${fmtNum(k.left)} ${esc(k.name)}`)].join(' + ')}<span class="bu-h">${svg.clock} ~${fmtDuration(x.hours)} of training</span></div>
    </button>`;
  const row = (x) => `<button class="bu-row" ${goBtn(x)}>
      ${img(methodIcon(x.m), '', 30)}
      <span class="title"><b>${esc(x.m.n)}</b><span class="sub">${[...x.needs.map((n) => `${esc(n.skill)} ${n.level}`), ...(x.kills || []).map((k) => `kill ${fmtNum(k.left)} ${esc(k.name)}`)].join(' + ')}<span class="sep">·</span>~${fmtDuration(x.hours)}</span></span>
      <span class="num muted">${fmtGp(x.skillBest?.gph ?? 0)} →</span>
      <span class="num gold">${fmtGp(x.gph)}<small> gp/hr</small></span>
    </button>`;
  return `
  <div class="section-head"><div><h2>Coming up</h2><p>Grouped by how many levels away. Money makers you are close to unlocking that pay more than what you can do now. Each is valued from scratch at its unlock level, using today's input costs, and compared with your best sustainable rate (bank stock runs out). Click one to open its training route.</p></div></div>
  ${all.length ? `<h3 class="bu-h3">Beats everything you can do now</h3><div class="bu-grid stagger">${all.slice(0, 6).map(card).join('')}</div>` : `<div class="note">${svg.info}<span>Nothing within 25 levels beats your current best of ${fmtGp(better.nowBest)}/hr from scratch.</span></div>`}
  <h3 class="bu-h3">Coming up next</h3>
  <p class="bu-p">Every money maker you are close to, grouped by how many levels away it is. These are valued at the level where they open, with inputs at their sell value.</p>
  <div class="upcoming">
  ${[...groups.entries()].map(([k, xs]) => `<div class="up-group"><h3>${k}</h3>${xs.slice(0, 10).map((x) => {
    const lvReq = x.missing.find((s) => s.kind === 'lvl');
    const skill = lvReq?.skill || x.m.s;
    const need = lvReq?.need || x.m.lv;
    const sv = state.save.skills[skill];
    const hi = xpForLevel(need);
    const xpLeft = sv ? Math.max(0, hi - sv.xp) : 0;
    const prog = sv ? Math.max(2, Math.min(100, (sv.xp / hi) * 100)) : 0;
    const best = e.trainOptions(skill)[0];
    return `<button class="up-row" data-tskill-go="${esc(skill)}" data-target-go="${need}">
      <span class="ico">${img(methodIcon(x.m), '', 34)}</span>
      <div class="title"><b>${esc(x.m.n)}</b><span class="sub">${img(skillIcon(x.m.s), '', 15)}${x.m.s}<span class="sep">·</span><span class="need">needs ${x.missing.map((s) => esc(s.text)).join(', ')}</span></span></div>
      <div class="progress"><div class="track"><i style="width:${prog}%"></i></div><small class="num">${fmtGp(xpLeft)} xp${best && xpLeft > 0 ? ` · ~${fmtDuration(planHours(skill, need))}` : ''}</small></div>
      <div class="gph"><span class="v num">${fmtGp(x.gph)}</span> <span class="u">gp/hr</span></div>
    </button>`;
  }).join('')}</div>`).join('') || '<div class="empty"><b>Everything is unlocked.</b>Nothing left to chase.</div>'}</div>
  ${gameBestSection()}
  ${perSkill.size ? `<h3 class="bu-h3">Beats your best in that skill</h3><div class="bu-skills">${[...perSkill.entries()].sort((a, b) => a[1][0].hours - b[1][0].hours).map(([sk, xs]) => `<div class="bu-skill"><div class="bu-sk">${img(skillIcon(sk), '', 20)}<b>${sk}</b><span class="muted">now ${fmtGp(xs[0].skillBest?.gph ?? 0)}/hr</span></div>${xs.map(row).join('')}</div>`).join('')}</div>` : ''}
`;
}

/** Hours to reach a level with the full training planner (bank stock first, inputs made from scratch), cached per save. */
function planHours(sk, lvl) {
  state.planCache ||= new Map();
  const k = sk + lvl;
  if (!state.planCache.has(k)) state.planCache.set(k, E().planLevel(sk, lvl).hours);
  return state.planCache.get(k);
}

/** The top money makers for a maxed account, and how far you are from each. */
function gameBestSection() {
  const e = E();
  if (!state.gameBest) {
    const eng = new Engine(G());
    eng.setPlayer(explorerSave());
    state.gameBest = eng.ranked('chain').filter((x) => x.m.s !== 'Combat').slice(0, 15).map((x) => ({ m: x.m, gph: x.gph }));
  }
  const mine = new Map(e.ranked('chain').map((x) => [x.m.id, x.gph]));
  state.planCache ||= new Map();
  const timeTo = (sk, lvl) => {
    const k = sk + lvl;
    if (!state.planCache.has(k)) state.planCache.set(k, e.planLevel(sk, lvl).hours);
    return state.planCache.get(k);
  };
  const max = state.gameBest[0]?.gph || 1;
  return `<h3 class="bu-h3">Best money makers in the game</h3>
  <p class="bu-p">The highest-paying methods for a maxed account (every skill 99, every upgrade), from scratch, and how far you are from each. Combat is left out because it depends on gear.</p>
  <div class="gb-list">${state.gameBest.map((x, i) => {
    const st = e.status(x.m);
    const lv = new Map();
    for (const q of st.missing) if (q.kind === 'lvl') lv.set(q.skill, Math.max(lv.get(q.skill) || 0, q.need));
    const other = st.missing.filter((q) => q.kind !== 'lvl');
    const hours = [...lv.entries()].reduce((a, [sk, l]) => a + (NOT_TRAINABLE.has(sk) ? 0 : timeTo(sk, l)), 0);
    const first = [...lv.entries()][0];
    const status = st.unlocked
      ? `<span class="pill green">${svg.check}Unlocked${mine.has(x.m.id) ? ` · ${fmtGp(mine.get(x.m.id))}/hr for you` : ''}</span>`
      : `<span class="gb-need">${[...lv.entries()].map(([sk, l]) => `${esc(sk)} ${l} <span class="muted">(+${l - e.level(sk)})</span>`).concat(other.map((q) => esc(q.text))).join(' · ')}${hours > 0 && Number.isFinite(hours) ? `<small>~${fmtDuration(hours)} of training</small>` : ''}</span>`;
    return `<button class="gb-row ${st.unlocked ? 'have' : ''}" ${first ? `data-tskill-go="${esc(first[0])}" data-target-go="${first[1]}"` : `data-item="${esc(x.m.primary || '')}"`}>
      <span class="rank num">${i + 1}</span>
      ${img(methodIcon(x.m), '', 32)}
      <span class="title"><b>${esc(x.m.n)}</b><span class="sub">${img(skillIcon(x.m.s), '', 14)}${x.m.s}${x.m.loc ? `<span class="sep">·</span>${esc(x.m.loc)}` : ''}</span></span>
      ${status}
      <span class="gb-v"><b class="num gold">${fmtGp(x.gph)}</b><small>gp/hr maxed</small><i style="width:${(x.gph / max) * 100}%"></i></span>
    </button>`;
  }).join('')}</div>`;
}

// ---------------------------------------------------------------- item drawer
/** Quantities that never round a real amount down to 0 (rare drops keep two significant digits). */
function fmtQty(q) {
  if (!Number.isFinite(q)) return '—';
  const a = Math.abs(q);
  if (a >= 100) return fmtNum(q);
  if (a >= 1) return fmtNum(q, a < 10 ? 2 : 1);
  if (a === 0) return '0';
  return Number(q.toPrecision(2)).toString();
}

/** A drop or product rate that stays readable: rare drops as "1 per 3h", unsafe fights as such. */
function rateCell(s) {
  const fight = s.m.x?.t === 'fight' || s.m.x?.t === 'dungeon';
  const per = fight && s.perAction > 0 ? `<small>${s.perAction >= 1 ? fmtNum(s.perAction, 1) + ' per kill' : '1 in ' + fmtNum(Math.round(1 / s.perAction)) + ' kills'}</small>` : '';
  if (s.blocked) return `<span class="num dr-rate"><button class="linkish" data-ready-go="${esc(s.m.x?.e || '')}">not safe yet</button>${per}</span>`;
  if (!(s.perHour > 0)) return `<span class="num dr-rate muted">—${per}</span>`;
  const main = s.perHour >= 1 ? `${fmtNum(s.perHour, s.perHour < 10 ? 1 : 0)}<small>/hr</small>` : `1 per ${fmtDuration(1 / s.perHour)}`;
  return `<span class="num dr-rate">${main}${per}</span>`;
}

function openItem(id) {
  const e = E(), g = G();
  const info = e.itemInfo(id);
  if (!info) return;
  const d = $('#drawer');
  const it = info.it;
  const toolFx = info.tool ? info.tool.map((b) => bonusText(b, lookup)) : [];
  const srcRows = info.sources.slice(0, 10).map((s) => `
    <div class="dr-row ${s.unlocked ? '' : 'locked'}">
      ${img(methodIcon(s.m), '', 28)}
      <div><b>${esc(s.m.n)}</b><span>${img(skillIcon(s.m.s), '', 13)}${s.m.s} ${s.m.lv}${s.unlocked ? '' : ` · ${svg.lock} locked`}${s.m.in.length ? ` · from ${s.m.in.map(([i, q]) => `<i class="dr-in" data-item="${esc(i)}" title="${esc(e.name(i))}">${fmtQty(q)}×${img(itemIcon(i), '', 13)}</i>`).join(' ')}` : ''}</span></div>
      ${rateCell(s)}
    </div>`).join('');
  const useRows = info.uses.slice(0, 10).map((u) => `
    <div class="dr-row link ${u.unlocked ? '' : 'locked'}" data-item="${esc(u.m.primary || '')}">
      ${img(methodIcon(u.m), '', 28)}
      <div><b>${esc(u.m.n)}</b><span>${img(skillIcon(u.m.s), '', 13)}${u.m.s} ${u.m.lv}${u.unlocked ? '' : ` · ${svg.lock} locked`}</span></div>
      <span class="num ${u.s.gpPerHour < 0 ? 'red' : 'green'}">${fmtGp(u.s.gpPerHour, { sign: true })}<small>/hr</small></span>
    </div>`).join('');
  const make = info.cost && info.cost.via.kind === 'make' ? `<div class="dr-fact"><span class="k">Make it yourself</span><span>${fmtMs(info.cost.t)} of play${info.cost.gp > 0.5 ? ` + ${fmtGp(info.cost.gp)} gold` : ''} each, via ${esc(info.cost.via.m.n)}</span></div>` : '';
  d.innerHTML = `
    <div class="dr-head">
      <span class="dr-art">${img(it.i, it.n, 56)}</span>
      <div><h3>${esc(it.n)}</h3><div class="muted">${it.v ? `Sells for <b class="gold">${fmtNum(it.v)}</b> gold` : 'Cannot be sold'}${it.slot ? ` · ${esc(it.slot.replace(/([a-z])([A-Z])/g, '$1 $2'))}` : ''}</div></div>
      <button class="btn btn-ghost dr-close" aria-label="Close" data-close>${svg.x}</button>
    </div>
    <div class="dr-body">
      ${state.explorer ? '' : `<div class="dr-facts">
        <div class="dr-fact"><span class="k">In your bank</span><span><b class="num">${fmtNum(info.have)}</b>${info.have && it.v ? ` · worth ${fmtGp(info.have * it.v)}` : ''}${info.equipped ? ' · <span class="green">equipped</span>' : ''}</span></div>
        ${info.buy ? `<div class="dr-fact"><span class="k">Shop</span><span>${fmtGp(info.buy.price)} gold each (${esc(info.buy.shop?.n || '')})</span></div>` : ''}
        ${make}
      </div>
      <button class="btn btn-sm btn-gold dr-plan" data-plan-item="${esc(id)}">${svg.target} Plan how to get ${info.have ? 'more' : 'it'}</button>`}
      ${toolFx.length ? `<h4>When equipped</h4><ul class="fx">${toolFx.map((f) => `<li class="${f.good ? 'good' : 'bad'}"><b>${f.val}</b> ${esc(f.label)}${f.where ? ` <span class="muted">· ${esc(f.where)}</span>` : ''}${f.skill ? ` <span class="muted">· ${esc(f.skill)}</span>` : ''}${f.cond ? ' <span class="muted">(conditional)</span>' : ''}</li>`).join('')}</ul>` : ''}
      ${srcRows ? `<h4>How to get it</h4><div class="dr-list">${srcRows}</div>` : ''}
      ${useRows ? `<h4>What it's used for <span class="muted">· value added per hour</span></h4><div class="dr-list">${useRows}</div>` : ''}
      ${!srcRows && !useRows && !info.buy ? '<p class="muted">Not produced or used by anything this site models yet (events and special drops).</p>' : ''}
    </div>`;
  if (!d.open) d.showModal();
  d.focus({ preventScroll: true }); // not the close button, so a held Enter key can't close it
  d.scrollTop = 0;
}

// ---------------------------------------------------------------- search palette
let palIdx = 0;
function openPalette() {
  const p = $('#palette');
  p.innerHTML = `<div class="pal-box"><div class="pal-in">${svg.search}<input id="pal-q" placeholder="Search any item…" autocomplete="off" spellcheck="false"/><span class="kbd">Esc</span></div><div class="pal-list" id="pal-list"></div></div>`;
  p.showModal();
  const q = $('#pal-q');
  const render = () => {
    const s = q.value.trim().toLowerCase();
    const items = Object.entries(G().items).filter(([, v]) => v.n && v.i);
    let res;
    if (!s) res = Object.keys(E().bank).map((id) => [id, G().items[id]]).filter(([, v]) => v).sort((a, b) => (E().bank[b[0]] * b[1].v) - (E().bank[a[0]] * a[1].v));
    else {
      res = items.filter(([, v]) => v.n.toLowerCase().includes(s));
      res.sort((a, b) => (b[1].n.toLowerCase().startsWith(s) - a[1].n.toLowerCase().startsWith(s)) || ((E().bank[b[0]] || 0) > 0) - ((E().bank[a[0]] || 0) > 0) || a[1].n.length - b[1].n.length);
    }
    res = res.slice(0, 40);
    palIdx = Math.min(palIdx, Math.max(0, res.length - 1));
    $('#pal-list').innerHTML = res.length ? (s ? '' : '<div class="pal-h">In your bank</div>') + res.map(([id, v], i) => `<button class="pal-row ${i === palIdx ? 'on' : ''}" data-pal="${esc(id)}">${img(v.i, '', 26)}<span>${esc(v.n)}</span><span class="muted num">${E().bank[id] ? fmtGp(E().bank[id]) + ' in bank · ' : ''}${v.v ? fmtGp(v.v) + ' gp' : ''}</span></button>`).join('') : '<div class="pal-h">No items match.</div>';
  };
  q.oninput = () => { palIdx = 0; render(); };
  q.onkeydown = (ev) => {
    const rows = $$('.pal-row', p);
    if (ev.key === 'ArrowDown') { palIdx = Math.min(rows.length - 1, palIdx + 1); ev.preventDefault(); }
    else if (ev.key === 'ArrowUp') { palIdx = Math.max(0, palIdx - 1); ev.preventDefault(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); const r = rows[palIdx]; if (r) { p.close(); openItem(r.dataset.pal); } return; }
    else return;
    rows.forEach((r, i) => r.classList.toggle('on', i === palIdx));
    rows[palIdx]?.scrollIntoView({ block: 'nearest' });
  };
  p.onclick = (ev) => {
    const r = ev.target.closest('[data-pal]');
    if (r) { p.close(); openItem(r.dataset.pal); return; }
    if (ev.target === p) p.close();
  };
  render();
  q.focus();
}

// ---------------------------------------------------------------- events
function bindView(v) {
  v.onclick = (ev) => {
    const itemEl = ev.target.closest('[data-item]');
    const t = ev.target.closest('[data-toggle],[data-mode],[data-skill],[data-banksort],[data-window],[data-quest],[data-quest-go],[data-horizon],[data-goaltype],[data-bsort],#more,[data-tskill],[data-target],[data-prefer],[data-upsort],[data-upfilter],[data-bankview],[data-gotab],[data-open-row],[data-tskill-go],[data-db],[data-ready-go],#reach-go,[data-planview]');
    // Item icons open the item drawer, even inside a clickable row.
    if (itemEl?.dataset.item && (!t || (t !== itemEl && t.contains(itemEl)))) { ev.stopPropagation(); openItem(itemEl.dataset.item); return; }
    if (!t) return;
    if (t.dataset.toggle) {
      const id = t.dataset.toggle;
      const row = t.closest('.row');
      if (state.open.has(id)) { state.open.delete(id); row.classList.remove('open'); t.setAttribute('aria-expanded', 'false'); }
      else {
        state.open.add(id);
        const x = rowsForMoney().find((r) => r.m.id === id);
        if (x) row.querySelector('.inner').innerHTML = details(x);
        requestAnimationFrame(() => row.classList.add('open'));
        t.setAttribute('aria-expanded', 'true');
      }
      return;
    }
    if (t.dataset.openRow) {
      const row = v.querySelector(`.row[data-id="${CSS.escape(t.dataset.openRow)}"] .row-main`);
      if (row) { if (!row.closest('.row').classList.contains('open')) row.click(); row.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      return;
    }
    if (t.dataset.mode) { state.mode = t.dataset.mode; state.limit = 30; state.open.clear(); savePrefs(); return rerender(); }
    if (t.dataset.skill !== undefined) { state.skill = t.dataset.skill; state.limit = 30; return rerender(); }
    if (t.dataset.goaltype) {
      const ty = t.dataset.goaltype;
      const e = E();
      if (ty === 'gold') state.goal = null;
      else if (ty === 'quest') state.goal = { type: 'quest', id: e.questList().find((q) => !q.done && q.available)?.id || e.questList().find((q) => !q.done)?.id };
      else if (ty === 'level') { const sk = state.trainSkill && !NOT_TRAINABLE.has(state.trainSkill) ? state.trainSkill : 'Fishing'; state.goal = { type: 'level', skill: sk, level: Math.min(99, e.level(sk) + 10) }; }
      else if (ty === 'item') state.goal = { type: 'item', id: state.goal?.type === 'item' ? state.goal.id : null, qty: state.goal?.qty || 1 };
      else if (ty === 'ready') state.goal = { type: 'ready', id: e.unsafeEnemies(1)[0]?.eid || 'GreenDragon' };
      else state.goal = { type: 'unlock', id: e.betterUnlocks().list[0]?.m.id || e.methods.find((m) => !m.quest && !e.status(m).unlocked)?.id };
      if (state.goal && !state.goal.id && ty !== 'level' && ty !== 'item') state.goal = null;
      savePrefs();
      return rerender();
    }
    if (t.dataset.horizon) { state.horizon = Number(t.dataset.horizon); savePrefs(); return rerender(); }
    if (t.dataset.questGo) { state.openQuest = t.dataset.questGo; return go('quests'); }
    if (t.dataset.quest) { state.openQuest = state.openQuest === t.dataset.quest ? null : t.dataset.quest; return rerender(); }
    if (t.dataset.window) { state.window = Number(t.dataset.window); savePrefs(); return rerender(); }
    if (t.dataset.banksort !== undefined) { state.bankSortTotal = t.dataset.banksort === '1'; savePrefs(); return rerender(); }
    if (t.dataset.bsort) { state.bankSort = t.dataset.bsort; savePrefs(); return rerender(); }
    if (t.dataset.bankview) { state.bankView = t.dataset.bankview; savePrefs(); return rerender(); }
    if (t.dataset.tskill) { state.trainSkill = t.dataset.tskill; state.trainTarget = null; state.trainLevel = null; savePrefs(); return rerender(); }
    if (t.dataset.tskillGo) { state.trainSkill = t.dataset.tskillGo; state.trainTarget = Number(t.dataset.targetGo); state.trainLevel = null; return go('train'); }
    if (t.dataset.target) { state.trainTarget = Number(t.dataset.target); return rerender(); }
    if (t.dataset.prefer) { state.trainPrefer = t.dataset.prefer; savePrefs(); return rerender(); }
    if (t.dataset.upsort) { state.upSort = t.dataset.upsort; savePrefs(); return rerender(); }
    if (t.dataset.upfilter) { state.upFilter = t.dataset.upfilter; return rerender(); }
    if (t.dataset.gotab) return go(t.dataset.gotab);
    if (t.id === 'more') { state.limit += 30; return rerender(); }
    if (t.dataset.planview) { state.planView = t.dataset.planview; return rerender(); }
    if (t.dataset.readyGo) { state.goal = { type: 'ready', id: t.dataset.readyGo }; savePrefs(); return go('plan'); }
    if (t.id === 'reach-go') { findReach(); return; }
    if (t.dataset.db) {
      const [k, v] = t.dataset.db.split(':');
      if (k === 'more') state.db.limit += 60;
      else { state.db[k] = v; state.db.limit = 60; if (k === 'view') { state.db.sort = 'value'; state.db.skill = ''; state.db.cat = ''; } }
      return rerender();
    }
  };
  const q = $('#q', v);
  if (q) q.oninput = debounce(() => { state.q = q.value; state.limit = 30; rerender(false, '#q'); }, 140);
  const dbq = $('#dbq', v);
  if (dbq) dbq.oninput = debounce(() => { state.db.q = dbq.value; state.db.limit = 60; rerender(false, '#dbq'); }, 140);
  const dbo = $('#dbowned', v);
  if (dbo) dbo.onchange = () => { state.db.owned = dbo.checked; state.db.limit = 60; rerender(); };
  const bq = $('#bq', v);
  if (bq) bq.oninput = debounce(() => { state.bankQ = bq.value; rerender(false, '#bq'); }, 120);
  const passive = $('#passive', v);
  if (passive) passive.onchange = () => { state.passive = passive.checked; savePrefs(); rerender(); };
  const mods = $('#mods', v);
  if (mods) mods.onchange = () => { state.mods = mods.checked; savePrefs(); applyPlayer(); const y = scrollY; renderDashboard(); scrollTo({ top: y }); toast(state.mods ? 'Rates include your upgrades' : 'Showing base rates, without upgrades'); };
  const gq = $('#goal-quest', v); if (gq) gq.onchange = () => { state.goal = { type: 'quest', id: gq.value }; savePrefs(); rerender(); };
  const gu = $('#goal-unlock', v); if (gu) gu.onchange = () => { state.goal = { type: 'unlock', id: gu.value }; savePrefs(); rerender(); };
  const gr = $('#goal-ready', v); if (gr) gr.onchange = () => { state.goal = { type: 'ready', id: gr.value }; savePrefs(); rerender(); };
  const gi = $('#goal-item', v), gqty = $('#goal-qty', v);
  if (gi) {
    const byName = new Map(Object.entries(G().items).map(([id, it]) => [it.n.toLowerCase(), id]));
    const setItem = () => { const id = byName.get(gi.value.trim().toLowerCase()); if (!id) return; state.goal = { type: 'item', id, qty: Math.max(1, Math.round(Number(gqty?.value) || 1)) }; savePrefs(); rerender(); };
    gi.onchange = setItem; gi.oninput = () => { if (byName.has(gi.value.trim().toLowerCase())) setItem(); };
    if (gqty) gqty.onchange = setItem;
  }
  const gs = $('#goal-skill', v), gl = $('#goal-level', v);
  const setLvl = () => { const lvl = Math.max(2, Math.min(99, Math.round(Number(gl.value)) || 2)); state.goal = { type: 'level', skill: gs.value, level: lvl }; savePrefs(); rerender(); };
  if (gs) gs.onchange = () => { gl.value = Math.min(99, E().level(gs.value) + 10); setLvl(); };
  if (gl) gl.onchange = setLvl;
  const target = $('#target', v);
  if (target) target.onchange = () => { const n = Math.round(Number(target.value)); if (n >= 2 && n <= 99) { state.trainTarget = n; rerender(); } };
  const atl = $('#atlevel', v);
  if (atl) atl.onchange = () => { const n = Math.round(Number(atl.value)); if (n >= 1 && n <= 99) { state.trainLevel = n; rerender(false, '#atlevel'); } };
}

function rerender(keepScroll = true, focusSel) {
  const y = window.scrollY;
  renderView();
  if (keepScroll) window.scrollTo({ top: y });
  if (focusSel) { const el = $(focusSel); if (el) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* number inputs */ } } }
}

const order = (s) => { const i = SKILL_ORDER.indexOf(s); return i < 0 ? 99 : i; };

// ---------------------------------------------------------------- global
document.addEventListener('paste', (e) => {
  if (state.save || e.target.closest?.('textarea,input')) return;
  const t = e.clipboardData?.getData('text');
  if (t && t.length > 200) { e.preventDefault(); loadSave(t).catch((err) => renderLanding(err.message)); }
});
document.addEventListener('keydown', (e) => {
  if (!state.save) return;
  const typing = e.target.closest?.('input,textarea');
  if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) { e.preventDefault(); if (!$('#palette').open) openPalette(); }
});
$('#drawer').addEventListener('click', (e) => {
  if (e.target === e.currentTarget || e.target.closest('[data-close]')) { $('#drawer').close(); return; }
  const rg = e.target.closest('[data-ready-go]');
  if (rg) { state.goal = { type: 'ready', id: rg.dataset.readyGo }; savePrefs(); $('#drawer').close(); go('plan'); return; }
  const pl = e.target.closest('[data-plan-item]');
  if (pl) { state.goal = { type: 'item', id: pl.dataset.planItem, qty: Math.max(1, (E().bank[pl.dataset.planItem] || 0) > 0 ? 1 : 1) }; savePrefs(); $('#drawer').close(); go('plan'); return; }
  const it = e.target.closest('[data-item]');
  if (it) openItem(it.dataset.item);
});
window.addEventListener('hashchange', () => {
  const h = parseHash();
  if (h.explore && state.game) return startExplorer();
  if (h.tab && state.save && (h.tab !== state.tab || (h.tab === 'train' && h.arg && h.arg !== state.trainSkill))) { if (h.tab === 'train' && h.arg) state.trainSkill = h.arg; go(h.tab); }
});

boot().catch((e) => { app.innerHTML = `<div class="empty"><b>Something went wrong loading the game data.</b>${esc(e.message)}</div>`; console.error(e); });
