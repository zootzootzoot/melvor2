// Melvor Idle 2 save decoder.
// Save string = Base64( Brotli( SaveWriter stream ) ). The game flushes the Brotli
// stream without closing it, so the stream is "truncated" by design: we decode
// with a streaming decoder and accept NeedsMoreInput at the end.
import initBrotli, { initSync, DecompressStream, BrotliStreamResultCode as RC } from './vendor/brotli_dec_wasm.js?v=202611260423';

let brotliReady = null;
/** For Node tests: initialise the decoder from wasm bytes instead of fetching it. */
export function initBrotliSync(wasmBytes) { initSync({ module: wasmBytes }); brotliReady = Promise.resolve(); }
const ensureBrotli = () => (brotliReady ??= initBrotli({ module_or_path: new URL('./vendor/brotli_dec_wasm_bg.wasm', import.meta.url) }));

export const MIN_SUPPORTED_VERSION = 25; // Alpha 0.11.0+
const NS = 'MelvorBase:';
const short = (s) => (s && s.startsWith(NS) ? s.slice(NS.length) : s);

function base64ToBytes(text) {
  const clean = text.replace(/[^A-Za-z0-9+/=_-]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function brotliDecode(bytes) {
  await ensureBrotli();
  const s = new DecompressStream();
  const parts = [];
  let off = 0;
  for (let guard = 0; guard < 1e6; guard++) {
    const r = s.decompress(bytes.subarray(off), 1 << 18);
    off += r.input_offset;
    const buf = r.buf;
    if (buf.length) parts.push(buf);
    if (r.code === RC.ResultSuccess) break;
    if (r.code === RC.NeedsMoreInput && buf.length === 0) break;
  }
  s.free?.();
  const total = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const b of parts) { out.set(b, p); p += b.length; }
  return out;
}

class Reader {
  constructor(bytes, pos = 0) {
    this.b = bytes; this.p = pos;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.td = new TextDecoder();
  }
  i32() { const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  i64() { const v = this.dv.getBigInt64(this.p, true); this.p += 8; return Number(v); }
  f64() { const v = this.dv.getFloat64(this.p, true); this.p += 8; return v; }
  u8() { return this.b[this.p++]; }
  bool() { return this.u8() !== 0; }
  v7() { let r = 0, sh = 0, c; do { c = this.u8(); r |= (c & 0x7f) << sh; sh += 7; } while (c & 0x80); return r; }
  str() { const n = this.v7(); const s = this.td.decode(this.b.subarray(this.p, this.p + n)); this.p += n; return s; }
  bytes(n) { const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
}

function readHeader(r) {
  const version = r.i32();
  const u = r.bytes(16);
  const hex = [...u].map((x) => x.toString(16).padStart(2, '0'));
  const uuid = [hex.slice(0, 4).reverse(), hex.slice(4, 6).reverse(), hex.slice(6, 8).reverse(), hex.slice(8, 10), hex.slice(10)].map((x) => x.join('')).join('-');
  const name = r.str();
  const gamemode = r.str();
  const tsBin = r.dv.getBigInt64(r.p, true); r.p += 8;
  let active = [];
  if (version < 9) r.str(); else active = [r.str(), r.str(), r.str(), r.str()];
  const totalLevel = r.i32();
  const gp = r.i64();
  const slayerCoins = r.i64();
  const isDemo = version >= 24 ? r.bool() : false;
  // DateTime.ToBinary: low 62 bits are ticks (100ns since 0001-01-01)
  const ticks = tsBin & 0x3fffffffffffffffn;
  const ms = Number(ticks / 10000n) - 62135596800000;
  return { version, uuid, name, gamemode, timestamp: new Date(ms), activeEntity: active[0], activeAction: active[2], totalLevel, gp, slayerCoins, isDemo };
}

function readEntities(bytes, r) {
  const n = r.i32();
  const ents = {};
  for (let i = 0; i < n; i++) {
    const id = r.str();
    const len = r.i32();
    const start = r.p;
    const sub = new Reader(bytes, start);
    const nc = sub.i32();
    const comps = {};
    for (let j = 0; j < nc; j++) {
      const cid = sub.str();
      const cl = sub.i32();
      comps[cid] = { pos: sub.p, len: cl };
      sub.p += cl;
    }
    ents[short(id)] = comps;
    r.p = start + len;
  }
  return ents;
}

function readBank(bytes, comp, version) {
  const r = new Reader(bytes, comp.pos);
  r.i32(); // default tab
  const tabs = r.i32();
  const items = {};
  for (let t = 0; t < tabs; t++) {
    r.i32(); r.i32(); r.i32(); r.bool(); r.bool();
    const c = r.i32();
    for (let k = 0; k < c; k++) {
      const q = r.i32();
      const placeholder = r.bool();
      if (version >= 1) r.bool();
      const it = short(r.str());
      if (!placeholder && q > 0) items[it] = (items[it] || 0) + q;
    }
    r.str();
    if (version >= 13) {
      const tc = r.i32();
      for (let k = 0; k < tc; k++) { r.bool(); r.bool(); r.str(); }
    }
    if (version >= 32 && r.bool()) r.str(); // Alpha 0.11.7: optional tab icon item
  }
  return items;
}

function readWallet(bytes, comp) {
  const r = new Reader(bytes, comp.pos);
  const n = r.i32();
  const out = {};
  for (let i = 0; i < n; i++) { const q = r.i64(); out[short(r.str())] = q; }
  return out;
}

function readShop(bytes, comp) {
  const r = new Reader(bytes, comp.pos);
  r.bool(); r.bool(); r.bool(); r.i32(); r.i32();
  const n = r.i32();
  const out = {};
  for (let i = 0; i < n; i++) { const c = r.i32(); out[short(r.str())] = c; }
  return out;
}

function readToolbelt(bytes, comp, into) {
  const r = new Reader(bytes, comp.pos);
  const n = r.i32();
  for (let i = 0; i < n; i++) {
    r.str();
    const len = r.i32();
    const end = r.p + len;
    if (len >= 5) {
      const q = r.i32();
      if (r.bool()) { const it = short(r.str()); into[it] = (into[it] || 0) + Math.max(1, q); }
    }
    r.p = end;
  }
}

/** MasteryGuildComponent: per task, saved goal progress and whether its trigger fired. */
function readGuild(bytes, comp) {
  const r = new Reader(bytes, comp.pos);
  if (r.bool()) r.str(); // selected category
  const n = r.i32();
  const done = [];
  const trig_ = [];
  const progress = {};
  for (let i = 0; i < n; i++) {
    const id = short(r.str());
    const len = r.i32();
    const end = r.p + len;
    let complete = false;
    if (r.bool()) {
      r.str(); // goal id
      const l2 = r.i32();
      const e2 = r.p + l2;
      const p = r.f64();
      complete = r.bool();
      if (p > 0) progress[id] = p;
      r.p = e2;
    }
    const trig = r.bool();
    if (complete) done.push(id);
    if (trig) trig_.push(id);
    r.p = end;
  }
  return { done, trig: trig_, progress };
}

/** StatisticsComponent: simple values, then per-item and per-currency dictionaries. */
function readStatistics(bytes, comp, into) {
  const r = new Reader(bytes, comp.pos);
  const end = comp.pos + comp.len;
  const n = r.i32();
  for (let i = 0; i < n; i++) {
    const id = short(r.str());
    const len = r.i32();
    const e = r.p + len;
    if (len >= 8) into.simple[id] = r.f64();
    r.p = e;
  }
  // base tables, then (Combat) enemies, dungeons, combat styles, effects and prayers, all (double value, string id)
  for (const kind of ['items', 'currencies', 'enemies', 'dungeons', 'styles', 'effects', 'prayers']) {
    if (r.p >= end) break;
    const m = r.i32();
    for (let i = 0; i < m; i++) {
      const id = short(r.str());
      const len = r.i32();
      const e = r.p + len;
      const cnt = r.i32();
      const map = (into[kind][id] ||= {});
      for (let k = 0; k < cnt; k++) { const v = r.f64(); map[short(r.str())] = v; }
      r.p = e;
    }
  }
}

// StandardExperienceTable.Default: scaling .25, exponentScaling 300, base 2^(1/7)
const XP_TABLE = (() => {
  const t = [0];
  let sum = 0;
  const base = Math.pow(2, 1 / 7);
  for (let i = 1; i < 200; i++) { sum += Math.floor(i + 300 * Math.pow(base, i)); t.push(Math.floor(0.25 * sum)); }
  return t; // t[level-1] = xp needed for level
})();
export const xpForLevel = (lvl) => (lvl < 1 ? 0 : XP_TABLE[lvl - 1]);
export function levelFromXp(xp, cap = 99) {
  let l = 1;
  while (l < cap && xp >= XP_TABLE[l]) l++;
  return l;
}

export async function decodeSave(input) {
  let bytes;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) throw new Error('That looks empty — copy your save string from the main menu and paste it here.');
    try { bytes = base64ToBytes(trimmed); } catch { throw new Error("That doesn't look like a Melvor Idle 2 save string."); }
  } else {
    bytes = new Uint8Array(input);
    // A .sav file is raw bytes; a text file may hold a base64 string.
    const head = new TextDecoder().decode(bytes.subarray(0, 64));
    if (/^[A-Za-z0-9+/=\s]+$/.test(head)) bytes = base64ToBytes(new TextDecoder().decode(bytes));
  }
  let raw;
  try { raw = await brotliDecode(bytes); } catch (e) { throw new Error('Could not decompress this save (' + (e.message || e) + ').'); }
  if (raw.length < 64) throw new Error("That doesn't look like a Melvor Idle 2 save string.");
  const r = new Reader(raw);
  const header = readHeader(r);
  if (header.version < MIN_SUPPORTED_VERSION || header.version > 200) throw new Error(`Unsupported save version ${header.version}.`);
  const ents = readEntities(raw, r);

  const skills = {};
  for (const [id, comps] of Object.entries(ents)) {
    if (comps.Experience) {
      const xp = new Reader(raw, comps.Experience.pos).f64();
      skills[id] = { xp, level: levelFromXp(xp) };
    }
  }
  // each section is read on its own, so a format change in one doesn't block the whole import
  const problems = [];
  const safe = (what, fn, fallback) => { try { return fn(); } catch (e) { problems.push(what); console.warn('save: could not read ' + what, e); return fallback; } };
  const bank = ents.Bank?.Inventory ? safe('bank', () => readBank(raw, ents.Bank.Inventory, header.version), {}) : {};
  const wallet = ents.Bank?.Wallet ? safe('wallet', () => readWallet(raw, ents.Bank.Wallet), {}) : {};
  const shop = ents.Shop?.Shop ? safe('shop', () => readShop(raw, ents.Shop.Shop), {}) : {};
  const tools = {};
  for (const comps of Object.values(ents)) {
    if (comps.Toolbelt) { try { readToolbelt(raw, comps.Toolbelt, tools); } catch { /* tolerate */ } }
  }
  const guild = {};
  const pets = {};
  const stats = { simple: {}, items: {}, currencies: {}, enemies: {}, dungeons: {}, styles: {}, effects: {}, prayers: {} };
  for (const [id, comps] of Object.entries(ents)) {
    if (comps.MasteryGuild) { try { guild[id] = readGuild(raw, comps.MasteryGuild); } catch { /* tolerate */ } }
    if (comps.Pets) {
      try {
        const r = new Reader(raw, comps.Pets.pos);
        const n = r.i32();
        for (let i = 0; i < n; i++) { const pid = short(r.str()); const len = r.i32(); const e = r.p + len; if (r.bool()) pets[pid] = true; r.p = e; }
      } catch { /* tolerate */ }
    }
    for (const [cid, c] of Object.entries(comps)) {
      if (/Statistics$/.test(cid)) { try { readStatistics(raw, c, stats); } catch { /* tolerate */ } }
    }
  }
  // Combat/Equipment: n slots of (string slot, region{int qty, bool occupied, bool has, [string item]})
  const equipment = {};
  const eqc = ents.Combat?.Equipment;
  if (eqc) {
    try {
      const r = new Reader(raw, eqc.pos);
      const n = r.i32();
      for (let i = 0; i < n; i++) {
        const slot = short(r.str());
        const len = r.i32();
        const e = r.p + len;
        const qty = r.i32(); r.bool();
        if (r.bool()) equipment[slot] = { item: short(r.str()), qty };
        r.p = e;
      }
    } catch { /* tolerate */ }
  }
  // Quests/Quests: per quest {int state, steps{ tasks{ goals{double progress, bool complete, bool active}, bool visible, bool costsMet, bool conditions, int state }, bool visible, int state }}
  const quests = {};
  const qc = ents.Quests?.Quests;
  if (qc) {
    try {
      const r = new Reader(raw, qc.pos);
      const regions = (fn) => { const n = r.i32(); const out = {}; for (let i = 0; i < n; i++) { const id = short(r.str()); const len = r.i32(); const e = r.p + len; try { out[id] = fn(); } catch { /* skip */ } r.p = e; } return out; };
      Object.assign(quests, regions(() => {
        const state = r.i32();
        const steps = regions(() => {
          const tasks = regions(() => {
            const goals = regions(() => { const progress = r.f64(); const complete = r.bool(); return { progress, complete }; });
            r.bool(); const costsMet = r.bool(); r.bool(); const st = r.i32();
            return { goals, costsMet, state: st };
          });
          r.bool(); const st = r.i32();
          return { tasks, state: st };
        });
        return { state, steps };
      }));
    } catch { /* tolerate */ }
  }
  // Slayer/Tasks: per master {bool hasTask, [string enemy], int length, int progress, bool extended, ...}
  const slayer = {};
  const st = ents.Slayer?.Tasks;
  if (st) {
    try {
      const r = new Reader(raw, st.pos);
      const n = r.i32();
      for (let i = 0; i < n; i++) {
        const id = short(r.str()); const len = r.i32(); const e = r.p + len;
        try { const has = r.bool(); const enemy = has ? short(r.str()) : null; const length = r.i32(); const progress = r.i32(); if (enemy) slayer[id] = { enemy, length, progress }; } catch { /* skip */ }
        r.p = e;
      }
    } catch { /* tolerate */ }
  }
  // Astrology/Action: action timer, 2 bools, then per constellation (string id, region{double knowledge, int n, n x string minor, int m, m x string major})
  const astro = {};
  const ac = ents.Astrology?.Action;
  if (ac) {
    try {
      // skip the action-timer state: find the constellation count followed by a namespaced id
      let p = ac.pos;
      const end = ac.pos + ac.len;
      const looksLikeId = (q) => raw[q] > 11 && raw[q] < 64 && String.fromCharCode(...raw.subarray(q + 1, q + 12)) === 'MelvorBase:';
      while (p < end - 16 && !(raw[p] > 0 && raw[p] < 64 && raw[p + 1] === 0 && raw[p + 2] === 0 && raw[p + 3] === 0 && looksLikeId(p + 4))) p++;
      const r = new Reader(raw, p);
      const n = r.i32();
      for (let i = 0; i < n; i++) {
        const id = short(r.str()); const len = r.i32(); const e = r.p + len;
        try {
          const knowledge = r.f64();
          const minor = []; const nm = r.i32(); for (let k = 0; k < nm; k++) minor.push(short(r.str()));
          const major = []; const nM = r.i32(); for (let k = 0; k < nM; k++) major.push(short(r.str()));
          astro[id] = { knowledge, minor, major };
        } catch { /* skip */ }
        r.p = e;
      }
    } catch { /* tolerate */ }
  }
  // Farming/Passive: [bool hasCat [string]], int64 currentTick, int n plots × (string id, region{bool watered, 4 bools auto,
  // bool [string selectedRecipe], bool [string selectedCompost], bool [string currentCompost], int state, state data})
  // state: 0 locked, 1 empty, 2 growing (recipe, timer), 3 grown (recipe, int qty, item, int regrows), 4 regrowing (recipe, timer, int regrows), 5 providing bonus (recipe, timer)
  // timer: bool autoRestart, int state, int waitTicks, int64 scheduledTick, int pausedTicksLeft
  const farm = { tick: null, plots: {} };
  const fc = ents.Farming?.Passive;
  if (fc) {
    safe('farming', () => {
      const r = new Reader(raw, fc.pos);
      if (r.bool()) r.str();
      farm.tick = Number(r.i64());
      const n = r.i32();
      for (let i = 0; i < n; i++) {
        const id = short(r.str()); const len = r.i32(); const e = r.p + len;
        try {
          const watered = r.bool(); r.bool(); r.bool(); r.bool(); r.bool();
          const selected = r.bool() ? short(r.str()) : null;
          const selCompost = r.bool() ? short(r.str()) : null;
          const compost = r.bool() ? short(r.str()) : null;
          const state = r.i32();
          const pl = { watered, selected, selCompost, compost, state };
          const timer = () => { r.bool(); const st = r.i32(); const wait = r.i32(); const at = Number(r.i64()); const paused = r.i32(); return { st, wait, left: st === 1 ? paused : st === 0 ? 0 : at - farm.tick }; };
          if (state >= 2) pl.recipe = short(r.str());
          if (state === 2 || state === 5) pl.timer = timer();
          else if (state === 3) { pl.qty = r.i32(); pl.item = short(r.str()); pl.regrows = r.i32(); }
          else if (state === 4) { pl.timer = timer(); pl.regrows = r.i32(); }
          farm.plots[id] = pl;
        } catch { /* skip */ }
        r.p = e;
      }
    }, null);
  }
  // one lookup across every statistics table: stats.all[statistic][id] = value
  stats.all = {};
  for (const kind of ['items', 'currencies', 'enemies', 'dungeons', 'styles', 'effects', 'prayers']) for (const [k, v] of Object.entries(stats[kind])) stats.all[k] = { ...(stats.all[k] || {}), ...v };
  const components = Object.fromEntries(Object.entries(ents).map(([k, v]) => [k, Object.keys(v)]));
  return { header, skills, bank, wallet, shop, tools, guild, stats, pets, equipment, quests, slayer, astro, farm, problems, entities: Object.keys(ents), components };
}
export { brotliDecode as _brotliDecode, Reader as _Reader, readHeader as _readHeader, readEntities as _readEntities };
