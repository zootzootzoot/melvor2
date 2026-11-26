import { SPAWN_MS, playerFighter, enemyFighter, fight, dropsPerKill, SLOT_OF, gearPool, bestLoadout, combatLevels, makeFighter } from './combat.js?v=202611260425';

// Melvor Ledger engine: game data + a decoded save -> rates, rankings and plans.
// Every formula mirrors the game's own stat computers and action handlers
// (decompiled from GamesByMalcs.Melvor2.dll); see README "How the numbers are computed".

export const HOUR = 3_600_000;
export const BASE_STUN_MS = 2000; // ThievingActionComponent.BaseStunInterval

export const SKILL_ORDER = [
  'Woodcutting', 'Fishing', 'Mining', 'Thieving', 'Cooking', 'Smithing', 'Crafting', 'Fletching',
  'Runecrafting', 'Herblore', 'Beastcrafting', 'Firemaking', 'Hunting', 'Combat', 'Farming', 'Ranching',
];
/** "Skills" in SKILL_ORDER that have no level of their own to train. */
export const NOT_TRAINABLE = new Set(['Combat', 'Farming', 'Ranching']);
/** Combat skills trained by fighting (XP per damage dealt, by stance). */
export const COMBAT_SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic'];
/** Skills whose methods run passively (per plot / per animal), so they aren't trained or ranked as actions. */
export const PASSIVE_SKILLS = new Set(['Farming', 'Ranching']);

const STATS_TYPE = {
  Woodcutting: 'WoodcuttingAction', Mining: 'MiningAction', Fishing: 'FishingAction', Thieving: 'ThievingAction',
  Cooking: 'CookingAction', Herblore: 'HerbloreAction', Firemaking: 'FiremakingAction', Farming: 'FarmingAction',
  Hunting: 'HuntingAction', Ranching: 'RanchingAction', Astrology: 'AstrologyAction',
};
const statsTypeOf = (skill) => STATS_TYPE[skill] || 'ArtisanAction';
const STAT_GROUPS = { PercentInterval: 'GlobalPercentActionInterval', FlatInterval: 'GlobalFlatActionInterval' };
const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** Expected value of floor(q * mult) for q uniform on the integers [lo, hi]. */
function avgFloor(lo, hi, mult) {
  if (mult === 1) return (lo + hi) / 2;
  let s = 0;
  for (let q = lo; q <= hi; q++) s += Math.floor(q * mult);
  return s / (hi - lo + 1);
}

/** Expected actions to clear `n` steps when each action has chance k of doing 2 (only while > 1 remain). */
function stepsWithSkip(n, k, guard = true) {
  if (k <= 0) return n;
  const E = [0, 1];
  for (let h = 2; h <= n; h++) E[h] = 1 + k * E[h - 2] + (1 - k) * E[h - 1];
  if (!guard && n >= 1) E[1] = 1;
  return E[n];
}

/** Woodcutting: expected hits to fell a tree of health H (instant-cut, weak-spot, double-damage). */
function treeHits(H, instant, weak, dbl) {
  if (!instant && !weak && !dbl) return H;
  const weakDmg = 3 + Math.floor(0.1 * H);
  const E = new Float64Array(H + 1);
  for (let h = 1; h <= H; h++) {
    if (h === 1) { E[1] = 1; continue; }
    const f = (d) => E[Math.max(0, h - d)];
    const rest = weak * (dbl * f(2 * weakDmg) + (1 - dbl) * f(weakDmg)) + (1 - weak) * (dbl * f(2) + (1 - dbl) * f(1));
    E[h] = 1 + (1 - instant) * rest;
  }
  return E[H];
}

/** Mining: progress += p per hit or an early break with chance p; guaranteed break at >= 0.9999. */
function rockHits(p, start = 0) {
  if (p >= 1) return 1;
  if (p <= 0) return Infinity;
  let n = 1;
  while (start + n * p < 0.9999) n++;
  let e = 0;
  for (let i = 1; i < n; i++) e += i * Math.pow(1 - p, i - 1) * p;
  return e + n * Math.pow(1 - p, n - 1);
}

function tableEV(rows, mult = 1, fortune = 1) {
  // rows: [item, weight, min, max] -> Map item -> expected qty per roll
  const tot = rows.reduce((a, r) => a + r[1], 0) || 1;
  const out = new Map();
  for (const [it, w, lo, hi] of rows) out.set(it, (out.get(it) || 0) + (w / tot) * avgFloor(lo, hi, fortune) * mult);
  return out;
}

export class Engine {
  constructor(game) {
    this.g = game;
    this.items = game.items;
    this.methods = [...game.methods, ...Engine.combatMethods(game)];
    this.byId = new Map(this.methods.map((m) => [m.id, m]));
    this.producers = new Map();
    this.consumers = new Map();
    for (const m of this.methods) {
      m.primary = m.x?.p ?? m.out.slice().sort((a, b) => b[1] * this.value(b[0]) - a[1] * this.value(a[0]))[0]?.[0] ?? null;
      if (m.x && ['cook', 'art', 'herb'].includes(m.x.t)) m.primary = m.x.pr.slice().sort((a, b) => a[2] - b[2])[0]?.[0] ?? m.primary;
      for (const [it] of m.out) {
        if (!this.producers.has(it)) this.producers.set(it, []);
        this.producers.get(it).push(m);
      }
      for (const [it] of m.in) {
        if (!this.consumers.has(it)) this.consumers.set(it, []);
        this.consumers.get(it).push(m);
      }
    }
    this.sourceable = new Set(Object.keys(game.buy));
    let changed = true;
    while (changed) {
      changed = false;
      for (const m of this.methods) {
        if (m.in.every(([it]) => this.sourceable.has(it))) {
          for (const [it, q] of m.out) if (q >= 0.05 && !this.sourceable.has(it)) { this.sourceable.add(it); changed = true; }
        }
      }
    }
    for (const m of this.methods) m.rareInputs = m.in.filter(([it]) => !this.sourceable.has(it)).map(([it]) => it);
    this.useMods = true;
    this.setPlayer({ skills: {}, bank: {}, shop: {}, tools: {} });
  }

  /** One money-making "method" per enemy (first non-quest area it appears in), valued per kill. */
  static combatMethods(game) {
    const C = game.combat;
    if (!C) return [];
    const out = [];
    const seen = new Set();
    for (const [aid, a] of Object.entries(C.areas)) {
      const questArea = a.cat === 'Quests';
      for (const eid of a.enemies) {
        const e = C.enemies[eid];
        if (!e || seen.has(eid)) continue;
        seen.add(eid);
        const d = dropsPerKill(e);
        const r = [...a.r, ...e.r];
        out.push({
          id: 'Combat:' + eid, s: 'Combat', n: e.n, i: e.i, k: 'active', ms: 10000, xp: 0, in: [], out: d.items, gp: d.gp,
          lv: Math.max(1, ...r.filter((q) => q.t === 'lvl').map((q) => q.l)), r, cat: aid, rid: eid, loc: a.n, locId: aid,
          note: a.cat, x: { t: 'fight', e: eid, dark: a.dark || 0 }, quest: questArea || undefined,
        });
      }
    }
    // dungeons: a fixed run of waves; enemies inside drop nothing, the reward comes at the end
    for (const [did, d] of Object.entries(C.dungeons || {})) {
      const rw = dropsPerKill({ drops: d.rewards });
      const boss = d.waves[d.waves.length - 1]?.[0]?.[0]?.[0];
      out.push({
        id: 'Dungeon:' + did, s: 'Combat', n: d.n, i: C.enemies[boss]?.i, k: 'active', ms: 60000, xp: 0, in: [], out: rw.items, gp: rw.gp,
        lv: Math.max(1, ...d.r.filter((q) => q.t === 'lvl').map((q) => q.l)), r: d.r, cat: 'Dungeon', rid: did, loc: 'Dungeon', locId: did,
        note: 'Dungeon', x: { t: 'dungeon', id: did },
      });
    }
    return out;
  }

  value(item) {
    const it = this.items[item];
    if (!it) return 0;
    if (it.open && it._ov === undefined) {
      const v = (x) => this.items[x]?.v ?? 0;
      const tot = it.open.table.reduce((a, r) => a + r[1], 0) || 1;
      it._ov = it.open.fixed.reduce((a, [x, lo, hi]) => a + v(x) * (lo + hi) / 2, 0)
        + it.open.table.reduce((a, [x, w, lo, hi]) => a + (w / tot) * v(x) * (lo + hi) / 2, 0);
    }
    return Math.max(it.v ?? 0, it._ov ?? 0);
  }
  name(item) { return this.items[item]?.n ?? item; }

  // ---------------------------------------------------------------- player
  setPlayer(p, { extraShop = [], extraTools = [], extraGear = [], extraAstro = [], useMods = this.useMods, keepCombat = false } = {}) {
    this.p = p;
    this.useMods = useMods;
    this.levels = {};
    for (const [s, v] of Object.entries(p.skills || {})) this.levels[s] = v.level;
    this.bank = p.bank || {};
    this.shopOwned = { ...(p.shop || {}) };
    for (const id of extraShop) this.shopOwned[id] = Math.max(1, this.shopOwned[id] || 0);
    this.tools = { ...(p.tools || {}) };
    for (const id of extraTools) this.tools[id] = 1;
    this._cache = new Map();
    this._rateCache = new Map();
    // combat loadouts don't depend on skilling upgrades/tools, so hypothetical clones can share them
    this._combatCache = keepCombat && this._combatCache ? this._combatCache : new Map();
    this.computeGuilds(p);
    this.fighter = this.g.combat ? playerFighter(this.g, p) : null;
    this.extraGear = extraGear;
    this.gearPool = this.g.combat ? gearPool(this.g, p, (id) => (this.items[id].eq.r || []).every((q) => this.reqStatus(q).ok), extraGear,
      (sp) => (sp.r || []).every((q) => this.reqStatus(q).ok)) : null;
    // food: the cheapest heal per gold you have in the bank, else Shrimp
    const foods = Object.keys(this.bank).filter((it) => this.items[it]?.heal > 0).sort((a, b) => this.value(a) / this.items[a].heal - this.value(b) / this.items[b].heal);
    this.food = foods[0] || (this.items.Shrimp?.heal ? 'Shrimp' : null);
    // Collect active bonuses: owned shop upgrades + equipped toolbelt items + guild rank rewards.
    this.sources = [];
    for (const [sk, gs] of Object.entries(this.guild)) {
      const gd = this.g.guild[sk];
      for (const b of gd.bonuses || []) {
        if (gs.lo >= gs.need(b.rank)) this.sources.push({ kind: 'guild', id: b.id, n: b.n, i: this.g.skills[sk]?.i, b: b.b, skill: sk });
      }
    }
    for (const [id, n] of Object.entries(this.shopOwned)) {
      const s = this.g.shop[id];
      if (n > 0 && s?.b) this.sources.push({ kind: 'shop', id, n: s.n, i: s.i, b: s.b });
    }
    for (const id of Object.keys(this.tools)) {
      const it = this.items[id];
      if (it?.tb) this.sources.push({ kind: 'tool', id, n: it.n, i: it.i, b: it.tb });
    }
    for (const [id, pet] of Object.entries(this.g.pets || {})) {
      if ((p.pets?.[id] || p.allGuild) && pet.b?.length) this.sources.push({ kind: 'pet', id, n: pet.n, i: pet.i, b: pet.b });
    }
    // astrology: unlocked minor/major nodes, plus each constellation's per-minor-node bonus
    const astro = {};
    for (const [cid, a] of Object.entries(p.astro || {})) astro[cid] = { ...a, minor: [...a.minor], major: [...a.major] };
    for (const nid of extraAstro) {
      const nd = this.g.astro?.nodes[nid];
      if (!nd) continue;
      const a = astro[nd.c] || (astro[nd.c] = { knowledge: 0, minor: [], major: [] });
      (nd.t === 'Major' ? a.major : a.minor).push(nid);
    }
    this.astro = astro;
    for (const c of this.g.astro?.cons || []) {
      const a = astro[c.id];
      if (!a) continue;
      for (const nid of [...a.minor, ...a.major]) {
        const nd = this.g.astro.nodes[nid];
        if (nd?.b?.length) this.sources.push({ kind: 'astro', id: nid, n: `${c.n} ${nd.n}`, i: c.i, b: nd.b });
      }
      if (a.minor.length && c.pmb?.length) this.sources.push({ kind: 'astro', id: c.id + ':per', n: `${c.n} (${a.minor.length} nodes)`, i: c.i, b: c.pmb.map(([t, nm, v, ctx]) => [t, nm, v * a.minor.length, ctx]) });
    }
    this.bIndex = new Map();
    for (const src of this.sources) {
      for (const [st, name, v, ctx] of src.b) {
        const key = st === 'G' ? 'G|' + name : st + '|' + name;
        if (!this.bIndex.has(key)) this.bIndex.set(key, []);
        this.bIndex.get(key).push({ v, ctx, src });
      }
    }
  }

  /**
   * Mastery guild points per skill. Goal and trigger tasks come straight from the save; level,
   * item-statistic and value-statistic conditions are evaluated; anything else (pets, agility,
   * astrology) is unknown, so we keep a lower and an upper bound.
   */
  computeGuilds(p) {
    this.guild = {};
    for (const [sk, gd] of Object.entries(this.g.guild || {})) {
      const sv = p.guild?.[sk];
      const done = new Set(sv?.done || []), trig = new Set(sv?.trig || []);
      let lo = 0, hi = 0, total = 0;
      for (const [id, t] of Object.entries(gd.tasks)) {
        const pts = t[0];
        total += pts;
        let st = null;
        if (p.allGuild) st = true;
        else if (t[1] === 'g') st = done.has(id);
        else if (t[1] === 't') st = trig.has(id);
        else if (t[1] === 'l') st = (this.levels[t[2]] ?? 1) >= t[3];
        else if (t[1] === 'i') st = (p.stats?.all?.[t[2]]?.[t[3]] ?? p.stats?.items?.[t[2]]?.[t[3]] ?? 0) >= t[4];
        else if (t[1] === 'v') st = (p.stats?.simple?.[t[2]] ?? 0) >= t[3];
        else if (t[1] === 'p') st = !!p.pets?.[t[2]];
        if (st) { lo += pts; hi += pts; } else if (st === null) hi += pts;
      }
      const need = (rank) => Math.ceil(total * (gd.ranks[rank] ?? 0));
      const order = Object.entries(gd.ranks).sort((a, b) => a[1] - b[1]).map(([k]) => k);
      const rankAt = (pts) => order.filter((k) => pts >= need(k)).pop() || order[0];
      const rank = rankAt(lo);
      const next = order[order.indexOf(rank) + 1] || null;
      this.guild[sk] = { lo, hi, total, rank, rankHi: rankAt(hi), next, need, known: !!sv || !!p.allGuild, order };
    }
  }

  /** Units of goal q that method m makes per hour (0 if it doesn't count toward q). */
  goalPerHour(m, r, q) {
    const match = (!q.r || m.rid === q.r) && (!q.sub || m.sub === q.sub) && (!q.cat || m.cat === q.cat);
    switch (q.t) {
      case 'WoodcuttingCutTree': case 'MiningMineRock': case 'FishingFishRecipe': case 'FiremakingBurnRecipe':
      case 'ArtisanCreateRecipe': case 'HuntingTrapAnimal':
        return match ? r.aph : 0;
      case 'CookRecipe': return match ? r.aph * r.succ : 0;
      case 'ArtisanCompleteStep': return match ? r.aph * (r.extra?.steps || 1) : 0;
      case 'ThievingPickpocketTargetType': return (!q.tt || m.rt === q.tt) && (!q.loc || m.cat === q.loc) ? r.aph * r.succ : 0;
      case 'ThievingPickpocketTarget': return !q.r || m.rid === q.r ? r.aph * r.succ : 0;
      case 'ActionGainItem': return r.outs.find(([it]) => it === q.it)?.[1] || 0;
      case 'ActionGainItemValue': return r.outValue - r.gp;
      case 'CombatKillEnemy': return !q.en || m.rid === q.en ? r.aph : 0;
      case 'HuntingTrapAnimalLocation': return !q.loc || m.locId === q.loc ? r.aph : 0;
      default: return 0;
    }
  }

  /** Units per hour of the fastest unlocked way to progress a goal (per hour of play), or null. */
  taskRate(sk, q, left = 0) {
    const ms = this.unlockedMethods().filter((m) => m.s === sk && m.k === 'active');
    let best = null;
    for (const m of ms) {
      const per = this.goalPerHour(m, this.rate(m), q);
      if (per > 0 && (!best || per > best.perHour)) best = { m, perHour: per };
    }
    // Per hour of play: inputs come from the bank while it lasts, then have to be made (chain time).
    if (best && best.m.in.length && left > 0) {
      const r = this.rate(best.m);
      const bankH = Math.min(...r.ins.map(([it, qq]) => (this.bank[it] || 0) / qq));
      if (bankH * best.perHour < left) {
        const tr = this.trainRate(best.m, this.levels);
        if (!tr.feasible) return null;
        const hours = bankH + (left - bankH * best.perHour) / (best.perHour * tr.share);
        best = { m: best.m, perHour: left / hours };
      }
    }
    return best;
  }

  /**
   * Hours to finish `left` units of a goal, one layer deeper than taskRate: if the action is
   * locked behind levels, add the training to get there. Returns { hours, m, train: [{skill, level, hours}], why }.
   */
  goalPlan(sk, q, left) {
    const b = this.taskRate(sk, q, left);
    if (b) return { hours: left / b.perHour, m: b.m, train: [] };
    let best = null, why = null;
    for (const m of this.methods) {
      if (m.s !== sk || m.k !== 'active') continue;
      if (!(this.goalPerHour(m, this.rate(m, { ...this.levels, [sk]: 99 }), q) > 0)) continue;
      const st = this.status(m);
      if (st.unlocked) { why ||= this.rate(m).blocked || 'Not safe to farm yet'; continue; }
      if (!st.onlyLevelLocked) { why ||= 'Needs ' + st.missing.map((x) => x.text).join(', '); continue; }
      const need = new Map();
      for (const x of st.missing) if (x.kind === 'lvl') need.set(x.skill, Math.max(need.get(x.skill) || 0, x.need));
      const lv = { ...this.levels, ...Object.fromEntries(need) };
      const per = this.goalPerHour(m, this.rate(m, lv), q);
      if (!(per > 0)) continue;
      const train = [...need.entries()].map(([skill, level]) => ({ skill, level, hours: NOT_TRAINABLE.has(skill) ? Infinity : this.planLevel(skill, level).hours }));
      const hours = train.reduce((a, t) => a + t.hours, 0) + left / per;
      if (Number.isFinite(hours) && (!best || hours < best.hours)) best = { hours, m, train };
    }
    return best || { hours: Infinity, why: why || 'Not modelled yet' };
  }

  /** Hours of play to get `qty` of an item: what you have first, then the cheapest way to make or buy it. */
  itemTime(item, qty) {
    const need = Math.max(0, qty - (this.bank[item] || 0));
    if (need <= 0) return { hours: 0, gp: 0, have: true };
    const c = this.solveChains().costs.get(item);
    if (!c) return { hours: Infinity, gp: 0, have: false, need };
    return { hours: (c.t * need) / HOUR, gp: c.gp * need, have: false, need, via: c.via };
  }

  /** Status, progress and time left for one quest, plus what it rewards and unlocks. */
  questInfo(qid) {
    const Q = this.g.quests?.[qid];
    if (!Q) return null;
    const sv = this.p.quests?.[qid] || { state: 0, steps: {} };
    const reqs = Q.r.map((r) => this.reqStatus(r));
    const done = this.p.allGuild || sv.state >= 2;
    const steps = [];
    let hours = 0, gp = 0, unknown = false, current = null;
    const trainNeed = new Map(); // skill -> highest level any remaining goal needs
    for (const st of Q.steps) {
      const ss = sv.steps?.[st.id];
      const stepDone = done || (ss?.state ?? 0) >= 2;
      const tasks = st.tasks.map((t) => {
        const ts = ss?.tasks?.[t.id];
        const goals = t.goals.map((gl0) => {
          let gl = gl0;
          const prog = Math.min(gl.q.n, ts?.goals?.[gl.id]?.progress ?? 0);
          const complete = stepDone || !!ts?.goals?.[gl.id]?.complete || prog >= gl.q.n;
          let est = null;
          if (!complete) {
            const g = this.goalPlan(gl.q.e, gl.q, gl.q.n - prog);
            est = Number.isFinite(g.hours) ? g : null;
            if (!est) gl = { ...gl, why: g.why };
          }
          return { ...gl, prog, complete, est };
        });
        const cost = t.cost.map(([it, q]) => ({ item: it, qty: q, ...((stepDone || ts?.costsMet) ? { hours: 0, have: true } : this.itemTime(it, q)) }));
        return { ...t, goals, cost, done: stepDone || (ts?.state ?? 0) >= 2 };
      });
      if (!stepDone) {
        if (!current) current = st.id;
        for (const t of tasks) {
          for (const gl of t.goals) {
            if (gl.complete) continue;
            if (!gl.est) { unknown = true; continue; }
            const tr = gl.est.train || [];
            hours += gl.est.hours - tr.reduce((a, x) => a + x.hours, 0); // the action itself
            for (const x of tr) trainNeed.set(x.skill, Math.max(trainNeed.get(x.skill) || 0, x.level));
          }
          for (const c of t.cost) if (!c.have) { if (Number.isFinite(c.hours)) { hours += c.hours; gp += c.gp || 0; } else unknown = true; }
          if (t.cond?.length) unknown = true;
        }
      }
      steps.push({ ...st, tasks, done: stepDone });
    }
    const training = [...trainNeed.entries()].map(([skill, level]) => ({ skill, level, hours: this.planLevel(skill, level).hours }));
    for (const t of training) hours += t.hours;
    const rewardValue = Q.rw.items.reduce((a, [it, q]) => a + q * this.value(it), 0) + Q.rw.gp;
    return {
      id: qid, Q, state: sv.state, done, started: sv.state >= 1 || Object.values(sv.steps || {}).some((x) => x.state > 0),
      available: reqs.every((r) => r.ok), reqs, steps, current, hours, gp, unknown, rewardValue, training,
      unlocks: Q.unlocks,
    };
  }

  /** Every quest with its status and time estimate, in game order. */
  questList() {
    if (this._cache.has('quests')) return this._cache.get('quests');
    const out = Object.keys(this.g.quests || {}).map((id) => this.questInfo(id));
    this._cache.set('quests', out);
    return out;
  }

  /** Every task of a skill's mastery guild with status, progress and a time estimate. */
  guildTasks(sk) {
    const gd = this.g.guild?.[sk];
    const gs = this.guild?.[sk];
    if (!gd || !gs) return [];
    const sv = this.p.guild?.[sk] || {};
    const done = new Set(sv.done || []), trig = new Set(sv.trig || []);
    const out = [];
    for (const [id, t] of Object.entries(gd.tasks)) {
      const [pts, kind] = t;
      let status = null, text = '', prog = 0, max = 1, est = null;
      if (kind === 'g') {
        const q = t[3];
        text = t[2]; max = q.n; prog = Math.min(max, this.p.guild?.[sk]?.progress?.[id] ?? 0);
        status = done.has(id);
        if (!status) { const b = this.taskRate(sk, q, max - prog); if (b) est = { hours: (max - prog) / b.perHour, m: b.m }; }
      } else if (kind === 't') { text = 'Trigger: ' + t[2]; status = trig.has(id); }
      else if (kind === 'l') {
        text = t[4]; max = t[3]; prog = Math.min(max, this.levels[t[2]] ?? 1); status = prog >= max;
        if (!status && SKILL_ORDER.includes(t[2]) && !PASSIVE_SKILLS.has(t[2])) {
          const pl = this.planLevel(t[2], t[3]);
          if (Number.isFinite(pl.hours)) est = { hours: pl.hours, m: pl.segs[0]?.m };
        }
      } else if (kind === 'i') {
        const skill = t[2].replace(/ItemGained$/, '');
        text = `Get ${t[4].toLocaleString('en-US')} ${this.name(t[3])} from ${skill}`;
        max = t[4]; prog = Math.min(max, this.p.stats?.items?.[t[2]]?.[t[3]] ?? 0); status = prog >= max;
        if (!status && /ItemGained$/.test(t[2])) { const b = this.taskRate(skill, { t: 'ActionGainItem', it: t[3] }, max - prog); if (b) est = { hours: (max - prog) / b.perHour, m: b.m }; }
      } else if (kind === 'p') {
        const pet = this.g.pets?.[t[2]];
        text = `Find ${pet?.n || t[2]}`; status = !!this.p.pets?.[t[2]];
        const best = pet?.scale && SKILL_ORDER.includes(pet.skill) ? this.trainOptions(pet.skill)[0] : null;
        if (!status && best) est = { hours: pet.scale / best.xph, m: best.m };
      } else if (kind === 'v') { text = t[4]; max = t[3]; prog = Math.min(max, this.p.stats?.simple?.[t[2]] ?? 0); status = prog >= max; }
      else { text = t[3] || t[2]; status = this.p.allGuild ? true : null; }
      out.push({ id, pts, kind, text, done: status, prog, max, est });
    }
    return out;
  }

  /** Greedy: open tasks by guild points per hour until the next rank is reached. */
  guildPlan(sk) {
    const gs = this.guild?.[sk];
    if (!gs?.next) return null;
    const need = gs.need(gs.next) - gs.lo;
    const open = this.guildTasks(sk).filter((t) => t.done === false && t.est && Number.isFinite(t.est.hours))
      .map((t) => ({ ...t, pph: t.pts / Math.max(t.est.hours, 1 / 60) })).sort((a, b) => b.pph - a.pph);
    const pick = [];
    let pts = 0, hours = 0;
    for (const t of open) { if (pts >= need) break; pick.push(t); pts += t.pts; hours += t.est.hours; }
    return { need, pick, hours: pts >= need ? hours : Infinity, reachable: pts >= need, open };
  }

  /** Pets that come from training a skill, with whether you have them and expected hours at your best XP rate. */
  skillPets(sk) {
    const best = this.trainOptions(sk)[0];
    return Object.entries(this.g.pets || {}).filter(([, p]) => p.skill === sk).map(([id, p]) => ({
      id, ...p, have: !!this.p.pets?.[id], hours: p.scale && best ? p.scale / best.xph : null, via: best?.m,
    }));
  }

  guildName(skill, rank) {
    return this.g.guild?.[skill]?.rankNames?.[rank] || String(rank).replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  /** Items used up per kill: food for the damage you take, ammo per attack, runes per cast. */
  combatInputs(f, p) {
    const ins = [];
    if (this.food && f.takenPerKill > 0) ins.push([this.food, f.takenPerKill / this.items[this.food].heal]);
    if (p.ammo) ins.push([p.ammo, f.attacks]);
    if (p.spell) for (const [it, q] of this.g.combat.spells[p.spell].runes) ins.push([it, q * f.attacks]);
    return ins;
  }

  inputCost(ins) {
    return ins.reduce((a, [it, q]) => {
      const v = this.value(it), b = this.buyPrice(it);
      return a + q * (this.bank[it] ? v : Number.isFinite(b) ? Math.min(b, v || b) : v);
    }, 0);
  }

  /**
   * Best loadout from your gear against one enemy, across melee, ranged and magic.
   * obj = 'money' (gold per hour after food/ammo/runes) or 'xp:<Skill>' (that skill's XP per hour,
   * only from stances that give it). Fights you can't survive (enemy max hit >= 90% of your HP) or
   * that take over 20 minutes per kill don't count.
   */
  combatPlan(eid, obj = 'money', lvOverride = null) {
    const C = this.g.combat;
    if (!C || !this.gearPool) return null;
    const lv = combatLevels(this.p, lvOverride || {});
    const key = 'cp|' + eid + '|' + obj + '|' + Object.values(lv).join(',') + '|' + this.useMods;
    if (this._combatCache.has(key)) return this._combatCache.get(key);
    const e = C.enemies[eid];
    const enemy = enemyFighter(e);
    const m = this.byId.get('Combat:' + eid);
    const loot = (m?.out || []).reduce((a, [it, q]) => a + q * this.value(it), 0) + (m?.gp || 0);
    const viable = (f) => f.danger < 0.9 && f.killMs <= 20 * 60000;
    const xpMult = m ? 1 + this.mod(m, 'PercentXPGained', null, 'Experience') : 1;
    let score;
    const skill = obj.startsWith('xp:') ? obj.slice(3) : null;
    const xpOf = (p) => {
      let best = null;
      for (const stance of p.stances) {
        const per = (C.stances[stance]?.xp || []).find(([sk]) => sk === skill)?.[1];
        if (!per) continue;
        const f = fight(C, p, enemy, stance);
        if (!f || !viable(f)) continue;
        const xph = per * enemy.hp * (HOUR / f.killMs) * xpMult;
        if (!best || xph > best.xph) best = { f, xph, stance };
      }
      return best;
    };
    if (skill) score = (f, p) => xpOf(p)?.xph ?? null;
    else score = (f, p) => (viable(f) ? (HOUR / f.killMs) * (loot - this.inputCost(this.combatInputs(f, p))) : null);
    const start = Object.fromEntries(Object.entries(this.p.equipment || {}).map(([slot, x]) => [slot, x.item]));
    // for XP, only weapons with a stance that gives this skill's XP
    const weaponOk = skill ? (w) => (C.weapons[this.items[w]?.wp?.type || 'Melee'] || []).some((st) => (C.stances[st]?.xp || []).some(([sk]) => sk === skill)) : null;
    let res = bestLoadout(this.g, this.gearPool, lv, enemy, score, start, weaponOk);
    if (res && skill) {
      const x = xpOf(res.p);
      res = x ? { ...res, f: x.f, xph: x.xph, stance: x.stance } : null;
    }
    if (res) {
      const ins = this.combatInputs(res.f, res.p);
      res.gph = (HOUR / res.f.killMs) * (loot - this.inputCost(ins));
      res.ins = ins;
    }
    this._combatCache.set(key, res);
    return res;
  }

  /** Clone with extra hypothetical shop purchases (for the upgrade advisor). */
  withShop(extra) {
    const e = Object.create(Engine.prototype);
    Object.assign(e, this);
    e.setPlayer(this.p, { extraShop: extra, useMods: true, keepCombat: true });
    return e;
  }

  level(skill) { return this.levels?.[skill] ?? 1; }

  ctxMatch(ctx, m, item) {
    if (ctx.x) return false;
    if (ctx.e && ctx.e !== m.s) return false;
    if (ctx.r && ctx.r !== m.rid) return false;
    if (ctx.cat && ctx.cat !== m.cat) return false;
    if (ctx.sub && ctx.sub !== m.sub) return false;
    if (ctx.loc && ctx.loc !== m.locId) return false;
    if (ctx.it && ctx.it !== item) return false;
    if (ctx.cur && ctx.cur !== item) return false;
    return true;
  }

  /** Sum of a stat's modifiers that apply to method m (optionally for one product item). */
  mod(m, name, item = null, st = statsTypeOf(m.s)) {
    if (!this.useMods) return 0;
    let v = 0;
    const list = this.bIndex.get(st + '|' + name);
    if (list) for (const b of list) if (this.ctxMatch(b.ctx, m, item)) v += b.v;
    const grp = STAT_GROUPS[name];
    if (grp) { const gl = this.bIndex.get('G|' + grp); if (gl) for (const b of gl) v += b.v; }
    return v;
  }

  /** Which bonus sources touch method m (for the "your upgrades" breakdown). */
  modSources(m) {
    if (!this.useMods) return [];
    const st = statsTypeOf(m.s);
    const out = new Map();
    for (const src of this.sources) {
      for (const [t, name, v, ctx] of src.b) {
        const okType = t === st || (t === 'Experience' && ctx.e === m.s) || (t === 'G' && STAT_GROUPS[name]);
        if (!okType) continue;
        const items = [null, ...m.out.map(([it]) => it), ...(m.x?.cur ? [m.x.cur[0]] : [])];
        if (t !== 'G' && !items.some((it) => this.ctxMatch(ctx, m, it))) continue;
        if (!out.has(src)) out.set(src, []);
        out.get(src).push({ name, v });
      }
    }
    return [...out.entries()].map(([src, fx]) => ({ src, fx }));
  }

  reqStatus(r, levelOverride) {
    switch (r.t) {
      case 'any': {
        const opts = r.of.map((q) => this.reqStatus(q, levelOverride));
        const met = opts.find((o) => o.ok);
        if (met) return met;
        const best = opts.sort((a, b) => a.gap - b.gap)[0];
        return { ...best, text: opts.map((o) => o.text).join(' or ') };
      }
      case 'lvl': {
        const have = levelOverride?.[r.s] ?? this.level(r.s);
        return { ok: have >= r.l, known: true, text: `${r.s} ${r.l}`, gap: Math.max(0, r.l - have), kind: 'lvl', skill: r.s, need: r.l };
      }
      case 'shop': {
        const n = this.shopOwned[r.id] || 0;
        return { ok: n >= r.n, known: true, text: this.g.shop[r.id]?.n ?? r.id, kind: 'shop', icon: this.g.shop[r.id]?.i, id: r.id };
      }
      case 'tool': {
        const ok = !!(this.tools[r.item] || this.bank[r.item]);
        return { ok, known: true, text: `${this.name(r.item)} equipped`, kind: 'tool', icon: this.items[r.item]?.i };
      }
      case 'quest': {
        const text = `Quest: ${this.g.quests?.[r.id]?.n || r.id.replace(/([a-z])([A-Z0-9])/g, '$1 $2')}`;
        if (this.p.allGuild) return { ok: true, known: true, text, kind: 'quest', id: r.id };
        if (!this.p.quests) return { ok: true, known: false, text, kind: 'quest', id: r.id };
        return { ok: (this.p.quests[r.id]?.state ?? 0) >= 2, known: true, text, kind: 'quest', id: r.id };
      }
      case 'rank': {
        const gs = this.guild?.[r.s];
        const text = this.guildName(r.s, r.id);
        if (!gs || !gs.known) return { ok: true, known: false, text, kind: 'rank' };
        const need = gs.need(r.id);
        if (gs.lo >= need) return { ok: true, known: true, text, kind: 'rank' };
        if (gs.hi < need) return { ok: false, known: true, text, kind: 'rank', pts: need - gs.lo, skill: r.s };
        // Can't tell: some of the tasks that would get you there aren't readable from the save.
        return { ok: true, known: false, text: `${text} (probably)`, kind: 'rank', pts: need - gs.lo, skill: r.s };
      }
      case 'stat': {
        const have = this.p.allGuild ? r.n : this.p.stats?.all?.[r.stat]?.[r.key];
        if (have == null && !this.p.stats) return { ok: true, known: false, text: r.text, kind: 'stat' };
        const h = have || 0;
        const en = r.stat === 'CombatEnemyKilled' && this.g.combat?.enemies?.[r.key]?.n;
        const label = en ? `Kill ${r.n} ${en}` : r.text;
        return { ok: h >= r.n, known: true, text: h >= r.n ? label : `${label} (${Math.floor(h)}/${r.n})`, kind: 'stat', stat: r.stat, key: r.key, n: r.n, have: h };
      }
      default: return { ok: true, known: false, text: r.text, kind: 'other' };
    }
  }

  status(m, levelOverride) {
    const st = m.r.map((r) => this.reqStatus(r, levelOverride));
    return {
      unlocked: st.every((s) => s.ok),
      unverified: st.filter((s) => !s.known),
      missing: st.filter((s) => !s.ok),
      levelGap: st.filter((s) => s.kind === 'lvl').reduce((a, s) => Math.max(a, s.gap), 0),
      onlyLevelLocked: st.every((s) => s.ok || s.kind === 'lvl'),
    };
  }

  // ---------------------------------------------------------------- rates
  /** Per-hour flows for a method at the player's levels, with their upgrades applied. */
  rate(m, levelOverride) {
    const lvl = levelOverride?.[m.s] ?? this.level(m.s);
    const key = m.id + '|' + lvl;
    const c = this._rateCache.get(key);
    if (c) return c;
    const r = this._rate(m, lvl);
    this._rateCache.set(key, r);
    return r;
  }

  _rate(m, lvl) {
    const x = m.x;
    const M = (name, item) => this.mod(m, name, item);
    const xpMult = 1 + this.mod(m, 'PercentXPGained', null, 'Experience');
    const xpFlat = this.mod(m, 'FlatXPGained', null, 'Experience');
    const outs = new Map();
    const add = (it, q) => { if (it && q) outs.set(it, (outs.get(it) || 0) + q); };
    let ins = m.in.map(([it, q]) => [it, q]);
    let ms = m.ms, xp = m.xp, gp = m.gp, succ = 1, extra = {};
    const ingCost = (pres) => {
      const pic = M('PercentIngredientCost');
      ins = m.in.map(([it, q]) => [it, Math.max(1, Math.floor(q * (1 + pic))) * (1 - pres)]);
    };
    const prodQty = (q, it) => Math.max(1, Math.floor((q + M('FlatProductQuantity', it)) * (1 + M('PercentProductQuantity', it))));

    if (!x) {
      for (const [it, q] of m.out) add(it, q);
    } else if (x.t === 'wc') {
      const iv = Math.floor((x.iv + M('FlatInterval')) * (1 + M('PercentInterval')));
      const hp = Math.ceil((x.hp + M('FlatMaxHealth')) * (1 + M('PercentMaxHealth')));
      const hits = treeHits(hp, clamp01(M('InstantCutChance')), clamp01(M('WeakSpotChance')), clamp01(M('DoubleDamageChance')));
      const d = clamp01(M('DoublingChance'));
      ms = hits * iv;
      add(x.p, (x.q + Math.trunc(M('FlatProductQuantity'))) * (1 + d));
      for (const [it, q, ch] of x.hit) add(it, clamp01((ch + M('FlatOnHitItemChance', it)) * (1 + M('PercentOnHitItemChance', it))) * (q + Math.trunc(M('FlatOnHitItemQuantity', it))) * (1 + d) * hits);
      for (const [it, q, ch] of x.cut) add(it, clamp01((ch + M('FlatOnCutItemChance', it)) * (1 + M('PercentOnCutItemChance', it))) * (q + Math.trunc(M('FlatOnCutItemQuantity', it))) * (1 + d));
      extra = { hits, iv, hp };
    } else if (x.t === 'astro') {
      ms = Math.floor((x.iv + M('FlatInterval')) * (1 + M('PercentInterval')));
      extra = { knowledge: x.k * (1 + M('PercentKnowledge')) };
    } else if (x.t === 'mine') {
      const iv = Math.floor((x.iv + M('FlatInterval')) * (1 + M('PercentInterval')));
      const p = clamp01(x.pc * (1 + M('PercentIncreaseRockBreakChance')));
      const hits = rockHits(p, M('FlatMinimumProspecting'));
      const d = clamp01(M('DoublingChance'));
      const shatter = clamp01(M('ShatterChance'));
      ms = hits * iv;
      add(x.p, (x.q + Math.trunc(M('FlatProductQuantity')) + clamp01(M('AdditionalProductQuantityChance'))) * (1 + d) * (1 + 2 * shatter));
      xp = m.xp * (1 + shatter);
      for (const [it, q, ch] of x.hit) add(it, clamp01((ch + M('FlatOnHitItemChance', it)) * (1 + M('PercentOnHitItemChance', it))) * q * (1 + d) * hits);
      if (x.stone) add(x.stone, clamp01(M('StoneItemChance')) * (1 + d) * hits);
      if (x.ess) add(x.ess, clamp01(M('EssenceItemChance')) * (1 + d) * hits);
      if (x.bar) add(x.bar, clamp01(M('BarItemChance')) * (1 + d));
      extra = { hits, iv, breakChance: p };
    } else if (x.t === 'fish') {
      const iv = (v, f, pct) => Math.floor((v + M(f)) * (1 + M(pct)));
      let lo = iv(x.min, 'FlatMinInterval', 'PercentMinInterval');
      let hi = iv(x.max, 'FlatMaxInterval', 'PercentMaxInterval');
      if (hi < lo) hi = lo;
      ms = (lo + hi) / 2;
      const fc = clamp01((x.fc + M('FlatFishChance')) * (1 + M('IncreasedFishChance')));
      const pFish = fc + (1 - fc) * clamp01(M('JunkRerollChance'));
      const d = clamp01(M('DoublingChance'));
      for (const [it, q] of tableEV(x.fish)) add(it, q * pFish * (1 + d));
      if (x.junk && pFish < 1) add(x.junk, (1 - pFish) * (1 + d));
      const sp = x.sp.map(([it, q, ch]) => [it, q + Math.trunc(M('FlatSpecialProductQuantity')), clamp01(ch + M('FlatSpecialProductChance') + ch * M('IncreasedSpecialProductChance'))]).sort((a, b) => a[2] - b[2]);
      let miss = 1;
      const spOut = [];
      for (const [it, q, ch] of sp) { spOut.push([it, q * ch * miss * (1 + d)]); miss *= 1 - ch; }
      const again = 1 + (1 - miss) * clamp01(M('SecondSpecialItemChance'));
      for (const [it, q] of spOut) add(it, q * again);
      extra = { lo, hi, fishChance: pFish };
    } else if (x.t === 'thv') {
      const iv = Math.floor((x.iv + M('FlatInterval')) * (1 + M('PercentInterval')));
      const stealth = Math.max(Math.floor((lvl + M('FlatStealth')) * (1 + M('PercentStealth'))), 0);
      const perc = Math.max(Math.floor((x.perc + M('FlatPerception')) * (1 + M('PercentPerception'))), 0);
      succ = Math.min(1, (100 + stealth) / (100 + perc));
      const stun = Math.floor((BASE_STUN_MS + M('FlatStunInterval')) * (1 + M('PercentStunInterval')));
      const avoid = clamp01(M('StunAvoidanceChance'));
      ms = iv + (1 - succ) * (1 - avoid) * stun;
      const stages = Math.max(1, x.st + Math.trunc(M('FlatStages')));
      const perComplete = stepsWithSkip(stages, clamp01(M('SkipStageChance')), false);
      const fortune = 1 + (M('FlatFortune') + (succ < 1 ? M('FlatFortuneUnderSuccess') : 0)) / 100;
      const d = clamp01(M('DoublingChance'));
      gp = 0;
      if (x.g && x.g[0] === 'GoldPieces') {
        const f = M('FlatCurrencyReward'), pc = M('PercentCurrencyReward');
        const lo = Math.max(0, Math.floor((x.g[1] + f) * (1 + pc))), hi = Math.max(0, Math.floor((x.g[2] + f) * (1 + pc)));
        gp = succ * clamp01(x.gc * (1 + M('PercentCurrencyLootChance'))) * (lo + hi) / 2;
      }
      const cc = clamp01(x.cc * (1 + M('PercentCommonLootChance')));
      const rc = clamp01(x.rc * (1 + M('PercentRareLootChance')));
      for (const [it, q] of tableEV(x.common, 1 + d, fortune)) add(it, q * cc * succ);
      for (const [it, q] of tableEV(x.rare, 1 + d, fortune)) add(it, q * rc * succ);
      for (const [it, q] of tableEV(x.comp, 1 + d, fortune)) add(it, q * succ / perComplete);
      xp = (m.xp * x.st) * succ / perComplete; // m.xp is per stage; BaseExperience is per completion
      // failed attempts hit you for 1..Damage (DamagePlayer), which costs food
      if (m.dmg > 0 && this.food && succ < 1) {
        const taken = (1 - succ) * (1 - clamp01(M('DamageAvoidanceChance'))) * (1 + m.dmg) / 2;
        ins = [[this.food, taken / this.items[this.food].heal]];
      }
      extra = { stealth, perception: perc, stun: stun * (1 - avoid), stages, perComplete };
    } else if (x.t === 'cook') {
      ms = Math.floor(x.iv * (1 + M('PercentInterval')) + M('FlatInterval'));
      const prof = Math.max(0, lvl + M('FlatProficiency'));
      const diff = Math.max(x.diff + M('FlatDifficulty'), 0);
      succ = clamp01((69 + prof) / (69 + diff));
      const p = clamp01(M('PreservationChance'));
      const pres = p + (1 - p) * (1 - succ) * clamp01(M('PreservationChanceOnFail'));
      ingCost(pres);
      const d = clamp01(M('DoublingChance'));
      for (const [it, q, ch] of x.pr) add(it, succ * ch * prodQty(q, it) * (1 + d));
      xp = m.xp * succ;
      extra = { proficiency: prof, difficulty: diff, preserve: pres };
    } else if (x.t === 'art') {
      const iv = Math.floor(x.iv * (1 + M('PercentInterval')) + M('FlatInterval'));
      const steps = Math.max(1, x.steps + Math.trunc(M('FlatSteps')));
      const per = stepsWithSkip(steps, clamp01(M('SkipStepChance')));
      ms = iv * per;
      const pres = clamp01(M('PreservationChance'));
      ingCost(pres);
      const d = clamp01(M('DoublingChance'));
      for (const [it, q, ch] of x.pr) add(it, ch * prodQty(q, it) * (1 + d));
      extra = { iv, steps, stepsTaken: per, preserve: pres };
    } else if (x.t === 'herb') {
      const st = (base, nm) => Math.floor(base * (1 + M('Percent' + nm + 'Interval')) + M('Flat' + nm + 'Interval'));
      const p = st(x.p, 'Preparing'), h = st(x.h, 'Heating'), s = st(x.s, 'Stirring'), b = st(x.b, 'Bottling');
      ms = (p + h + s) / x.n + b;
      const pres = clamp01(M('PreservationChance'));
      ingCost(pres);
      const d = clamp01(M('DoublingChance'));
      for (const [it, q, ch] of x.pr) add(it, ch * prodQty(q, it) * (1 + d));
      extra = { batch: p + h + s + b * x.n, bottles: x.n, preserve: pres };
    } else if (x.t === 'hunt') {
      const iv = (b, f, pct) => Math.floor((b + f) * (1 + pct));
      const rng = (lo, hi, kind) => {
        const f = M('Flat' + kind + 'Interval'), pc = M('Percent' + kind + 'Interval');
        let a = iv(lo, f + M('FlatMin' + kind + 'Interval'), pc + M('PercentMin' + kind + 'Interval'));
        let b = iv(hi, f + M('FlatMax' + kind + 'Interval'), pc + M('PercentMax' + kind + 'Interval'));
        if (b < a) b = a;
        return (a + b) / 2;
      };
      const track = rng(x.tmin, x.tmax, 'Tracking'), trap = rng(x.pmin, x.pmax, 'Trapping');
      const sv = iv(x.sv, M('FlatSurveyInterval'), M('PercentSurveyInterval'));
      const tc = clamp01(x.tc + M('FlatTrackingSuccessChance') + x.tc * M('IncreasedTrackingSuccessChance'));
      const pc = Math.max(0.01, clamp01(x.pc + M('FlatTrappingSuccessChance') + x.pc * M('IncreasedTrappingSuccessChance')));
      const fs = Math.trunc(M('FlatTrackingSteps'));
      const smin = Math.max(1, x.smin + fs + Math.trunc(M('FlatMinTrackingSteps')));
      const smax = Math.max(smin, x.smax + fs + Math.trunc(M('FlatMaxTrackingSteps')));
      const skip = clamp01(M('SkipTrackingStepChance'));
      let steps = 0;
      for (let n = smin; n <= smax; n++) steps += stepsWithSkip(n, skip);
      steps /= smax - smin + 1;
      const surveys = 1 + (1 - tc) + (1 - tc) * (1 - tc); // the third survey always finds tracks
      const attempts = 1 / pc;
      const re = clamp01(M('TrappingReattemptChance'));
      ms = surveys * sv + steps * track + attempts * trap + (attempts - 1) * (1 - re) * stepsWithSkip(smin, skip) * track;
      const pres = clamp01(M('PreservationChance'));
      ins = x.trap ? [[x.trap, attempts * (1 - pres)]] : [];
      const d = clamp01(M('DoublingChance'));
      for (const [it, q, ch] of x.pr) add(it, ch * prodQty(q, it) * (1 + d));
      for (const [it, q, ch] of x.sp) add(it, surveys * ch * prodQty(q, it) * (1 + d));
      xp = m.xp + (x.svXp || 0) * surveys;
      extra = { surveys, steps, attempts, trapChance: pc, trackChance: tc };
    } else if (x.t === 'fight') {
      const C = this.g.combat;
      const e = C.enemies[x.e];
      const plan = this.combatPlan(x.e, 'money');
      if (!plan) return { m, succ: 1, ms: 1e12, aph: 0, outs: [], ins: [], gp: 0, xp: 0, outValue: 0, extra: {}, blocked: 'None of your gear can farm this safely' };
      const f = plan.f;
      ms = f.killMs;
      for (const [it, q] of m.out) add(it, q);
      gp = m.gp;
      xp = f.xp.reduce((a, [, v]) => a + v, 0);
      ins = this.combatInputs(f, plan.p);
      extra = { fight: f, food: this.food, loadout: plan };
      void e;
    } else if (x.t === 'dungeon') {
      const C = this.g.combat;
      const d = C.dungeons[x.id];
      let t = 0, xpSum = 0;
      const insMap = new Map();
      const waves = [];
      for (const [pool, count] of d.waves) {
        const tot = pool.reduce((a, [, w]) => a + w, 0) || 1;
        for (const [eid, w] of pool) {
          const plan = this.combatPlan(eid, 'money');
          if (!plan) return { m, succ: 1, ms: 1e12, aph: 0, outs: [], ins: [], gp: 0, xp: 0, outValue: 0, extra: {}, blocked: `${C.enemies[eid]?.n || eid} is too dangerous or slow for your gear` };
          const n = count * (w / tot);
          t += n * (plan.f.aliveMs + SPAWN_MS);
          xpSum += n * plan.f.xp.reduce((a, [, v]) => a + v, 0);
          for (const [it, q] of this.combatInputs(plan.f, plan.p)) insMap.set(it, (insMap.get(it) || 0) + q * n);
          waves.push({ eid, n, plan });
        }
      }
      ms = t;
      for (const [it, q] of m.out) add(it, q);
      gp = m.gp;
      xp = xpSum;
      ins = [...insMap.entries()];
      extra = { dungeon: { waves, runMs: t }, food: this.food };
    } else if (x.t === 'fm') {
      ms = Math.floor((x.iv + M('FlatInterval')) * (1 + M('PercentInterval')));
      const pres = clamp01(M('PreservationChance'));
      ingCost(pres);
      const d = clamp01(M('DoublingChance'));
      for (const [it, q, ch] of x.pr) add(it, clamp01(ch + M('FlatProductChance', it) + ch * M('IncreasedProductChance', it)) * (q + Math.trunc(M('FlatProductQuantity', it))) * (1 + d));
      gp = 0;
      if (x.cur && x.cur[0] === 'GoldPieces') {
        const q = Math.floor((x.cur[1] + M('FlatCurrencyReward', 'GoldPieces')) * (1 + M('PercentCurrencyReward', 'GoldPieces')));
        gp = q * (1 + d);
      }
      extra = { preserve: pres };
    }
    ms = Math.max(1, ms);
    const aph = HOUR / ms;
    const outArr = [...outs.entries()].map(([it, q]) => [it, q * aph]);
    const insArr = ins.map(([it, q]) => [it, q * aph]);
    const xph = (xp + xpFlat * (x?.t === 'thv' ? succ / (extra.perComplete || 1) : (x?.t === 'cook' ? succ : 1))) * xpMult * aph;
    const gph = gp * aph;
    const outValue = outArr.reduce((a, [it, q]) => a + q * this.value(it), 0) + gph;
    return { m, succ, ms, aph, outs: outArr, ins: insArr, gp: gph, xp: xph, outValue, extra, blocked: extra.blocked };
  }

  buyPrice(item) {
    const b = this.g.buy[item];
    if (!b) return Infinity;
    const shop = this.g.shop[b.shop];
    if (shop && !shop.r.every((r) => this.reqStatus(r).ok)) return Infinity;
    return b.p;
  }

  // ---------------------------------------------------------------- pricing modes
  /**
   * Self-sufficient chains (Dinkelbach): each input is either bought from the shop or
   * produced by your own unlocked methods, charging your time at lambda gp/ms.
   */
  solveChains(unlocked = this.unlockedMethods()) { // includes quest-only actions, so quest items can be made
    const key = 'chains';
    if (this._cache.has(key)) return this._cache.get(key);
    const cand = unlocked.filter((m) => m.k === 'active');
    let lambda = 0;
    for (const m of cand) if (!m.in.length) lambda = Math.max(lambda, this.rate(m).outValue / HOUR);
    let costs = null;
    let rates = null;
    for (let iter = 0; iter < 12; iter++) {
      costs = this.itemCosts(cand, lambda);
      rates = new Map();
      let best = 0;
      for (const m of cand) {
        const r = this.chainRate(m, costs);
        if (r) { rates.set(m.id, r); best = Math.max(best, r.gpPerHour / HOUR); }
      }
      if (Math.abs(best - lambda) < 1e-9 * Math.max(1, best)) break;
      lambda = best;
    }
    const out = { costs, rates, lambda };
    this._cache.set(key, out);
    return out;
  }

  itemCosts(cand, lambda) {
    const costs = new Map();
    for (const it of Object.keys(this.g.buy)) {
      const p = this.buyPrice(it);
      if (Number.isFinite(p)) costs.set(it, { gp: p, t: 0, via: { kind: 'buy', shop: this.g.buy[it].shop }, total: p });
    }
    const makers = cand.filter((m) => m.primary);
    for (let pass = 0; pass < 25; pass++) {
      let changed = false;
      for (const m of makers) {
        let gp = 0, t = 0, ok = true;
        const r = this.rate(m);
        for (const [it, qh] of r.ins) {
          const c = costs.get(it);
          if (!c) { ok = false; break; }
          const q = qh / r.aph;
          gp += c.gp * q; t += c.t * q;
        }
        if (!ok) continue;
        t += r.ms;
        const primQ = (r.outs.find(([it]) => it === m.primary)?.[1] ?? 0) / r.aph;
        if (primQ <= 1e-9) continue;
        const byproducts = r.outs.reduce((a, [it, q]) => a + (it === m.primary ? 0 : (q / r.aph) * this.value(it)), 0) + r.gp / r.aph;
        // By-products can pay for part of the inputs, but never make the item "cost" negative gold.
        const gpPer = Math.max(0, (gp - byproducts) / primQ);
        const tPer = t / primQ;
        const total = gpPer + lambda * tPer;
        const cur = costs.get(m.primary);
        if (!cur || total < cur.total - 1e-9) {
          costs.set(m.primary, { gp: gpPer, t: tPer, via: { kind: 'make', m }, total });
          changed = true;
        }
      }
      if (!changed) break;
    }
    return costs;
  }

  chainRate(m, costs) {
    const r = this.rate(m);
    let gpSpent = 0, tUp = 0;
    const steps = [];
    for (const [it, q] of r.ins) {
      const c = costs.get(it);
      if (!c) return null;
      gpSpent += c.gp * q; tUp += c.t * q;
      steps.push({ item: it, qtyPerHour: q, via: c.via, gp: c.gp * q, t: c.t * q });
    }
    const totalT = HOUR + tUp;
    const gpPerHour = (r.outValue - gpSpent) * (HOUR / totalT);
    return { gpPerHour, share: HOUR / totalT, gpSpent, upstreamMs: tUp, steps, r };
  }

  /** Flatten a chain into "where each minute of an hour of play goes" plus shop spend. */
  chainBreakdown(m, chain) {
    const { costs } = this.solveChains();
    const time = new Map();
    const bought = new Map();
    const byp = new Map();
    let bypGp = 0;
    const add = (mm, ms) => time.set(mm, (time.get(mm) || 0) + ms);
    const walk = (item, qty, depth) => {
      const c = costs.get(item);
      if (!c || depth > 12) return;
      if (c.via.kind === 'buy') { bought.set(item, (bought.get(item) || 0) + qty); return; }
      const mm = c.via.m;
      const r = this.rate(mm);
      const primPerAction = (r.outs.find(([it]) => it === mm.primary)?.[1] ?? 0) / r.aph;
      if (primPerAction <= 0) return;
      const actions = qty / primPerAction;
      add(mm, actions * r.ms);
      for (const [it, q] of r.outs) if (it !== mm.primary) byp.set(it, (byp.get(it) || 0) + (q / r.aph) * actions);
      bypGp += (r.gp / r.aph) * actions;
      for (const [it, q] of r.ins) walk(it, actions * (q / r.aph), depth + 1);
    };
    add(m, HOUR);
    for (const [it, q] of chain.r.ins) walk(it, q, 0);
    const s = chain.share;
    const split = [...time.entries()].map(([mm, ms]) => ({ m: mm, ms: ms * s })).sort((a, b) => b.ms - a.ms);
    const boughtList = [...bought.entries()].map(([item, q]) => ({ item, qty: q * s, gp: q * s * (costs.get(item)?.gp ?? 0) }));
    const outs = new Map();
    for (const [it, q] of chain.r.outs) outs.set(it, (outs.get(it) || 0) + q * s);
    for (const [it, q] of byp) outs.set(it, (outs.get(it) || 0) + q * s);
    return { split, bought: boughtList, outs: [...outs.entries()], gp: (chain.r.gp + bypGp) * s, share: s };
  }

  /** Inputs valued at their sell price (opportunity cost); shop-only items at shop price. */
  sellRate(m, levelOverride) {
    const r = this.rate(m, levelOverride);
    let cost = 0;
    for (const [it, q] of r.ins) {
      const v = this.value(it);
      const b = this.buyPrice(it);
      cost += q * (this.bank[it] ? v : Math.min(Number.isFinite(b) ? b : Infinity, v || b));
    }
    return { gpPerHour: r.outValue - cost, cost, r };
  }

  /** Bank-limited: how long your stock lasts and the total profit available. */
  bankRate(m) {
    const r = this.rate(m);
    let cost = 0;
    let hours = Infinity;
    const limiting = [];
    for (const [it, q] of r.ins) {
      const have = this.bank[it] || 0;
      const b = this.buyPrice(it);
      if (have > 0) {
        const h = have / q;
        if (h < hours) { hours = h; limiting.length = 0; limiting.push(it); }
        cost += q * this.value(it);
      } else if (Number.isFinite(b)) {
        cost += q * b;
      } else return null;
    }
    // Not a bank method unless at least one input actually comes from your bank.
    if (!r.ins.length || !limiting.length) return null;
    const gpPerHour = r.outValue - cost;
    return { gpPerHour, hours, total: gpPerHour * hours, limiting, r };
  }

  // ---------------------------------------------------------------- views
  unlockedMethods(levelOverride) {
    if (!levelOverride && this._cache.has('unlocked')) return this._cache.get('unlocked');
    const out = this.methods.filter((m) => this.status(m, levelOverride).unlocked && !(m.x?.t === 'fight' && this.rate(m, levelOverride).blocked));
    if (!levelOverride) this._cache.set('unlocked', out);
    return out;
  }

  /**
   * Ranked money makers.
   *  best  - the better of "from scratch" and "from your bank" for every method
   *  chain - from scratch (gather or buy every input)
   *  bank  - only what your bank can fuel
   *  sell  - value added (inputs at their sell value)
   */
  ranked(mode, opts = {}) {
    const key = 'ranked|' + mode + '|' + !!opts.includePassive + '|' + !!opts.sortTotal + '|' + (opts.window || '');
    let rows = this._cache.get(key);
    if (!rows) {
      const unlockedAll = this.unlockedMethods();
      const unlocked = unlockedAll.filter((m) => !m.quest && m.s !== 'Astrology');
      rows = [];
      if (mode === 'chain' || mode === 'best') {
        const { rates } = this.solveChains(unlockedAll);
        for (const m of unlocked) {
          if (m.k === 'passive') continue;
          const c = rates.get(m.id);
          const b = mode === 'best' ? this.bankRate(m) : null;
          const bankOk = b && b.hours >= 0.25 && b.gpPerHour > 0;
          if (mode === 'best' && bankOk && (!c || b.gpPerHour > c.gpPerHour)) {
            rows.push({ m, gph: b.gpPerHour, xph: b.r.xp, bank: b, r: b.r, total: b.total, src: 'bank', chain: c });
          } else if (c) {
            rows.push({ m, gph: c.gpPerHour, xph: c.r.xp * c.share, chain: c, r: c.r, src: 'chain', bankAlt: bankOk ? b : null });
          }
        }
      } else if (mode === 'sell') {
        for (const m of unlocked) {
          if (m.rareInputs.length && !m.rareInputs.every((it) => this.bank[it])) continue;
          const s = this.sellRate(m);
          if (!Number.isFinite(s.gpPerHour)) continue;
          rows.push({ m, gph: s.gpPerHour, xph: s.r.xp, sell: s, r: s.r, src: 'sell' });
        }
      } else if (mode === 'afk') {
        // One action left running for `window` hours: gathering, or processing bank/shop stock until it runs out.
        const T = opts.window || 8;
        for (const m of unlocked) {
          if (m.k === 'passive') continue;
          const r = this.rate(m);
          if (!r.ins.length) {
            rows.push({ m, gph: r.outValue, xph: r.xp, r, total: r.outValue * T, hours: T, src: 'afk' });
            continue;
          }
          const b = this.bankRate(m);
          if (b) {
            const h = Math.min(T, b.hours);
            if (h * 60 < 1) continue;
            rows.push({ m, gph: b.gpPerHour, xph: b.r.xp, r: b.r, bank: b, total: b.gpPerHour * h, hours: h, src: 'afk' });
            continue;
          }
          if (r.ins.every(([it]) => Number.isFinite(this.buyPrice(it)))) {
            const s = this.sellRate(m);
            rows.push({ m, gph: s.gpPerHour, xph: s.r.xp, r: s.r, sell: s, total: s.gpPerHour * T, hours: T, src: 'afk', shopOnly: true });
          }
        }
        rows.sort((a, b) => b.total - a.total);
      } else if (mode === 'bank') {
        for (const m of unlocked) {
          if (m.k === 'passive') continue;
          const b = this.bankRate(m);
          if (!b || b.hours < 1 / 120) continue;
          rows.push({ m, gph: b.gpPerHour, xph: b.r.xp, bank: b, r: b.r, total: b.total, src: 'bank' });
        }
      }
      rows = rows.filter((x) => opts.includePassive || x.m.k !== 'passive');
      if (mode !== 'afk') rows.sort((a, b) => (mode === 'bank' && opts.sortTotal ? b.total - a.total : b.gph - a.gph));
      this._cache.set(key, rows);
    }
    return opts.skill ? rows.filter((x) => x.m.s === opts.skill) : rows;
  }

  /** Locked methods you are closest to, with their projected rate at the unlock level. */
  upcoming(limit = 18) {
    const out = [];
    for (const m of this.methods) {
      if (m.k === 'passive' || m.quest) continue;
      const st = this.status(m);
      if (st.unlocked || !st.onlyLevelLocked) continue;
      const lv = {};
      for (const r of m.r) if (r.t === 'lvl') lv[r.s] = Math.max(lv[r.s] || 0, r.l, this.level(r.s));
      const r = this.rate(m, lv);
      const cost = r.ins.reduce((a, [it, q]) => a + q * this.value(it), 0);
      if (m.rareInputs.length || r.outValue - cost <= 0) continue;
      out.push({ m, gap: st.levelGap, gph: r.outValue - cost, r, missing: st.missing });
    }
    const bucket = (g) => (g <= 1 ? 0 : g <= 5 ? 1 : g <= 15 ? 2 : 3);
    out.sort((a, b) => bucket(a.gap) - bucket(b.gap) || b.gph - a.gph);
    return out.slice(0, limit);
  }

  /**
   * Locked methods that would pay more than what you can do today, valued from scratch at their
   * unlock level with today's input costs, plus the training time to get there.
   */
  betterUnlocks(maxGap = 25) {
    if (this._cache.has('better')) return this._cache.get('better');
    const { costs } = this.solveChains();
    const best = this.ranked('chain'); // sustainable rates: bank stock runs out
    const nowBest = best[0]?.gph ?? 0;
    const skillBest = new Map();
    for (const x of best) if (!skillBest.has(x.m.s)) skillBest.set(x.m.s, x);
    const planCache = new Map();
    const timeTo = (sk, lvl) => {
      const k = sk + lvl;
      if (!planCache.has(k)) planCache.set(k, this.planLevel(sk, lvl).hours);
      return planCache.get(k);
    };
    const out = [];
    for (const m of this.methods) {
      if (m.k === 'passive' || m.quest) continue;
      const st = this.status(m);
      if (st.unlocked || st.levelGap > maxGap) continue;
      // locked only by levels, or by levels plus the next mastery guild rank (reachable via guild tasks)
      const rankMiss = st.missing.filter((x) => x.kind === 'rank');
      if (st.missing.some((x) => x.kind !== 'lvl' && x.kind !== 'rank' && !(x.kind === 'stat' && x.stat === 'CombatEnemyKilled'))) continue;
      // kill-count requirements (dungeons): the kills you still need, fought with your best loadout
      const kills = [];
      for (const x of st.missing) {
        if (x.kind !== 'stat') continue;
        const plan = this.combatPlan(x.key, 'money');
        const left = x.n - (x.have || 0);
        kills.push({ enemy: x.key, name: this.g.combat.enemies[x.key]?.n || x.key, left, hours: plan ? left * plan.f.killMs / HOUR : Infinity, style: plan?.style });
      }
      if (kills.some((k) => !Number.isFinite(k.hours))) continue;
      let guild = null;
      if (rankMiss.length) {
        const r0 = m.r.find((q) => q.t === 'rank');
        const gs = this.guild?.[r0?.s];
        if (rankMiss.length > 1 || !gs || gs.next !== r0.id) continue;
        const gp = this.guildPlan(r0.s);
        if (!gp?.reachable) continue;
        guild = { skill: r0.s, rank: r0.id, name: this.guildName(r0.s, r0.id), hours: gp.hours };
      }
      const lv = { ...this.levels };
      for (const r of m.r) if (r.t === 'lvl') lv[r.s] = Math.max(lv[r.s] ?? 1, r.l);
      const r = this.rate(m, lv);
      let gpSpent = 0, tUp = 0, ok = true;
      for (const [it, q] of r.ins) {
        const c = costs.get(it);
        if (c) { gpSpent += c.gp * q; tUp += c.t * q; continue; }
        const p = this.buyPrice(it);
        if (Number.isFinite(p)) gpSpent += p * q;
        else if (this.bank[it] > 0) gpSpent += this.value(it) * q;
        else { ok = false; break; }
      }
      if (!ok) continue;
      const gph = (r.outValue - gpSpent) * (HOUR / (HOUR + tUp));
      const sb = skillBest.get(m.s)?.gph ?? 0;
      if (gph <= sb || gph <= 0) continue;
      const need = new Map();
      for (const x of st.missing) if (x.kind === 'lvl') need.set(x.skill, Math.max(need.get(x.skill) || 0, x.need));
      const needs = [...need.entries()].map(([skill, level]) => ({ skill, level, gap: level - this.level(skill) }));
      const killHours = kills.reduce((a, k) => a + k.hours, 0);
      const hours = needs.reduce((a, n) => a + timeTo(n.skill, n.level), 0) + (guild?.hours || 0) + killHours;
      out.push({ m, gph, r, needs, hours, guild, kills, killHours, gap: st.levelGap, beatsAll: gph > nowBest, gain: gph - nowBest, skillGain: gph - sb, skillBest: skillBest.get(m.s) });
    }
    // keep the best option per (skill, unlock level), then order by how soon it pays off
    const seen = new Map();
    for (const x of out.sort((a, b) => b.gph - a.gph)) {
      const k = x.needs.map((n) => n.skill + n.level).join('|') + x.kills.map((q) => '|k' + q.enemy).join('');
      if (!seen.has(k)) seen.set(k, x);
    }
    const list = [...seen.values()].sort((a, b) => (b.beatsAll - a.beatsAll) || a.hours - b.hours);
    const res = { nowBest, best: best[0], list };
    this._cache.set('better', res);
    return res;
  }

  /** For each bank item: what's the best thing to turn it into? */
  alchemy() {
    const unlocked = this.unlockedMethods().filter((m) => m.k === 'active' && m.in.length && !m.quest);
    const res = [];
    for (const [item, qty] of Object.entries(this.bank)) {
      let best = null;
      for (const m of unlocked) {
        if (!m.in.some(([it]) => it === item)) continue;
        const b = this.bankRate(m);
        if (!b || b.gpPerHour <= 0) continue;
        if (!best || b.total > best.b.total) best = { m, b };
      }
      const sellNow = qty * this.value(item);
      if (best) res.push({ item, qty, sellNow, ...best, uplift: best.b.total });
    }
    res.sort((a, b) => b.uplift - a.uplift);
    return res;
  }

  bankValue() {
    let total = 0;
    const rows = [];
    for (const [it, q] of Object.entries(this.bank)) {
      const v = this.value(it);
      total += v * q;
      rows.push({ item: it, qty: q, v, total: v * q });
    }
    rows.sort((a, b) => b.total - a.total);
    return { total, rows };
  }

  // ---------------------------------------------------------------- training
  /**
   * Training rate when you also have to make the inputs yourself: walks the cheapest production
   * chain, adds the time of every upstream step, and credits XP earned along the way (making
   * Water Runes for Fire Wands is Runecrafting XP too). Per hour of play.
   */
  trainRate(m, lv) {
    const r = this.rate(m, lv);
    const { costs } = this.solveChains();
    const xpBy = new Map([[m.s, r.xp]]);
    const steps = new Map();
    const made = new Map();
    let upMs = 0, gpSpent = 0, feasible = true;
    const walk = (item, qty, depth) => {
      if (depth > 8 || qty <= 0) return;
      const c = costs.get(item);
      if (!c) { feasible = false; return; }
      if (c.via.kind === 'buy') { gpSpent += c.gp * qty; return; }
      const mm = c.via.m;
      const rr = this.rate(mm, lv);
      const prim = (rr.outs.find(([it]) => it === mm.primary)?.[1] ?? 0) / rr.aph;
      if (!(prim > 0)) { feasible = false; return; }
      const actions = qty / prim;
      const ms = actions * rr.ms;
      upMs += ms;
      steps.set(mm, (steps.get(mm) || 0) + ms);
      made.set(item, (made.get(item) || 0) + qty);
      xpBy.set(mm.s, (xpBy.get(mm.s) || 0) + (rr.xp / rr.aph) * actions);
      for (const [it, q] of rr.ins) walk(it, actions * (q / rr.aph), depth + 1);
    };
    for (const [it, q] of r.ins) walk(it, q, 0);
    const share = HOUR / (HOUR + upMs);
    return {
      feasible, share, upMs,
      xph: (xpBy.get(m.s) || 0) * share,
      xpBy: [...xpBy.entries()].map(([s, v]) => [s, v * share]),
      gph: (r.outValue - gpSpent) * share,
      steps: [...steps.entries()].map(([mm, ms]) => ({ m: mm, share: (ms * share) / HOUR })).sort((a, b) => b.share - a.share),
      made: [...made.entries()].map(([it, q]) => [it, q * share]),
    };
  }

  /**
   * Methods for one skill at a given level. `direct` is the rate when the inputs are already in
   * your bank; `scratch` also makes them. `xph` is what you'd actually get: direct while your
   * bank can fuel at least an hour of it, otherwise from scratch.
   */
  trainOptions(skill, level = this.level(skill)) {
    const key = 'train|' + skill + '|' + level;
    if (this._cache.has(key)) return this._cache.get(key);
    if (COMBAT_SKILLS.includes(skill)) { const rows = this.combatTrainOptions(skill, level); this._cache.set(key, rows); return rows; }
    if (skill === 'Slayer') {
      const rows = this.slayerOptions(level).filter((o) => o.ok && o.viable > 0).map((o) => ({
        m: { id: 'Slayer:' + o.id, s: 'Slayer', n: o.sm.n, i: o.sm.i, lv: 1, in: [], out: [], r: o.sm.r, primary: null },
        xph: o.xph, gph: o.gph, r: { succ: 1, ins: [], outs: [], extra: {} }, direct: { xph: o.xph, gph: o.gph },
        scratch: { feasible: true, xph: o.xph, gph: o.gph, steps: [], made: [], xpBy: [['Slayer', o.xph]], share: 1 },
        bankHours: Infinity, src: 'gather', slayer: o,
      })).sort((a, b) => b.xph - a.xph);
      this._cache.set(key, rows);
      return rows;
    }
    const lv = { ...this.levels, [skill]: level };
    const rows = [];
    for (const m of this.methods) {
      if (m.s !== skill || m.k === 'passive' || m.quest) continue;
      const st = this.status(m, lv);
      if (!st.unlocked) continue;
      const s = this.sellRate(m, lv);
      if (!(s.r.xp > 0)) continue;
      const bankHours = s.r.ins.length ? Math.min(...s.r.ins.map(([it, q]) => (this.bank[it] || 0) / q)) : Infinity;
      const scratch = s.r.ins.length ? this.trainRate(m, lv) : { feasible: true, xph: s.r.xp, gph: s.gpPerHour, steps: [], made: [], xpBy: [[skill, s.r.xp]], share: 1 };
      if (!scratch.feasible && !(bankHours > 0)) continue;
      const fromBank = s.r.ins.length > 0 && bankHours >= 1;
      const xph = fromBank || !scratch.feasible ? s.r.xp : scratch.xph;
      const gph = fromBank || !scratch.feasible ? (Number.isFinite(s.gpPerHour) ? s.gpPerHour : -Infinity) : scratch.gph;
      rows.push({ m, xph, gph, r: s.r, direct: { xph: s.r.xp, gph: s.gpPerHour }, scratch, bankHours, src: !s.r.ins.length ? 'gather' : fromBank ? 'bank' : 'scratch' });
    }
    rows.sort((a, b) => b.xph - a.xph);
    this._cache.set(key, rows);
    return rows;
  }

  /**
   * Slayer per master: tasks are random enemies from the master's areas; a task kill pays
   * floor(0.1 x HP^1.15) slayer coins and HP/8 + 4 Slayer XP. Enemies you can't farm safely are
   * rerolled (costing coins). Rates are averaged over the tasks you'd actually do.
   */
  slayerOptions(level = this.level('Slayer')) {
    const key = 'slayer|' + level;
    if (this._cache.has(key)) return this._cache.get(key);
    const C = this.g.combat;
    const out = [];
    const lv = { ...this.levels, Slayer: level };
    for (const [id, sm] of Object.entries(C?.slayer || {})) {
      const reqs = sm.r.map((r) => this.reqStatus(r, lv));
      const ok = reqs.every((r) => r.ok);
      const enemies = [...new Set(sm.areas.flatMap((a) => C.areas[a]?.enemies || []))];
      const avgLen = (sm.len + (sm.len + 3 * level)) / 2;
      let coins = 0, xp = 0, hours = 0, gold = 0, viable = 0;
      const rows = [];
      for (const eid of enemies) {
        const plan = this.combatPlan(eid, 'money');
        const hp = (C.enemies[eid]?.lv.Hitpoints ?? 1) * 10;
        if (!plan) { rows.push({ eid, ok: false }); continue; }
        viable++;
        const kph = HOUR / plan.f.killMs;
        const h = avgLen / kph;
        hours += h;
        coins += avgLen * Math.max(1, Math.floor(0.1 * Math.pow(hp, 1.15)));
        xp += avgLen * (hp / 8 + 4);
        gold += plan.gph * h;
        rows.push({ eid, ok: true, kph, plan });
      }
      const pBlocked = enemies.length ? 1 - viable / enemies.length : 1;
      const rerollPerTask = viable ? (pBlocked / (1 - pBlocked)) * sm.reroll : 0;
      const tasks = viable ? hours / (hours / viable) : 0;
      void tasks;
      const perTaskHours = viable ? hours / viable : Infinity;
      const coinsHr = viable ? (coins - rerollPerTask * viable) / hours : 0;
      out.push({ id, sm, ok, reqs, enemies: rows, viable, total: enemies.length, coinsHr, xph: viable ? xp / hours : 0, gph: viable ? gold / hours : 0, perTaskHours, rerollPerTask,
        task: this.p.slayer?.[id] || null });
    }
    out.sort((a, b) => (b.ok - a.ok) || b.xph - a.xph);
    this._cache.set(key, out);
    return out;
  }

  /** Enemies ranked by XP/hr for one combat skill: best style, loadout and stance that give that XP. */
  combatTrainOptions(skill, level) {
    const rows = [];
    for (const m of this.unlockedMethods()) {
      if (m.x?.t !== 'fight' || m.quest) continue;
      const plan = this.combatPlan(m.rid, 'xp:' + skill, { [skill]: level });
      if (!plan) continue;
      const r = this.rate(m);
      rows.push({ m, xph: plan.xph, gph: plan.gph, r, direct: { xph: plan.xph, gph: plan.gph },
        scratch: { feasible: true, xph: plan.xph, gph: plan.gph, steps: [], made: [], xpBy: [[skill, plan.xph]], share: 1 },
        bankHours: Infinity, src: 'gather', stance: plan.stance, killMs: plan.f.killMs, loadout: plan });
    }
    rows.sort((a, b) => b.xph - a.xph);
    return rows;
  }

  /**
   * Fastest path from the current XP to a target level. In each level band it picks the method
   * that gets there soonest, using inputs from your bank first (no gathering time) and making the
   * rest from scratch, with XP from the intermediate steps counted.
   */
  planLevel(skill, target, { prefer = 'xp' } = {}) {
    const cur = this.p.skills?.[skill];
    let xp = cur?.xp ?? 0;
    let level = cur?.level ?? 1;
    const goal = xpForLevel(target);
    const segs = [];
    let hours = 0, gp = 0;
    const stock = { ...this.bank };
    const used = new Map();
    const madeAll = new Map();
    let guard = 0;
    while (xp < goal && guard++ < 200) {
      const opts = this.trainOptions(skill, level);
      const nextUnlock = this.methods.filter((m) => m.s === skill && m.lv > level).reduce((a, m) => Math.min(a, m.lv), 100);
      // combat rates improve with every level, so re-plan every few levels
      const stopLevel = Math.min(target, COMBAT_SKILLS.includes(skill) || skill === 'Slayer' ? level + 3 : nextUnlock);
      const stopXp = Math.min(goal, xpForLevel(stopLevel));
      const need = Math.max(0, stopXp - xp);
      // time to earn `need` xp with each option: bank stock first, then from scratch
      const plan = (o) => {
        const d = o.direct.xph;
        const ins = o.r.ins;
        const stockH = ins.length ? Math.min(...ins.map(([it, q]) => (stock[it] || 0) / q)) : Infinity;
        const hb = Math.min(stockH, need / d);
        const rem = need - hb * d;
        const hs = rem > 1e-6 ? (o.scratch.feasible && o.scratch.xph > 0 ? rem / o.scratch.xph : Infinity) : 0;
        const g = hb * (Number.isFinite(o.direct.gph) ? o.direct.gph : 0) + hs * (o.scratch.gph || 0);
        return { o, hb, hs, t: hb + hs, g };
      };
      const cands = opts.map(plan).filter((p) => Number.isFinite(p.t));
      const pick = prefer === 'gp'
        ? cands.filter((p) => p.g >= 0).sort((a, b) => b.g / b.t - a.g / a.t)[0] || cands.sort((a, b) => a.t - b.t)[0]
        : cands.sort((a, b) => a.t - b.t)[0];
      if (!pick) return { segs, hours: Infinity, gp, supplies: [], made: [], stuck: level };
      const o = pick.o;
      for (const [it, q] of o.r.ins) {
        const n = q * pick.hb;
        stock[it] = Math.max(0, (stock[it] || 0) - n);
        used.set(it, (used.get(it) || 0) + n);
      }
      if (pick.hs > 0) {
        // inputs consumed from scratch: what the chain makes (bought/shop inputs are counted via gold)
        const directShare = o.scratch.share;
        for (const [it, q] of o.r.ins) used.set(it, (used.get(it) || 0) + q * directShare * pick.hs);
        for (const [it, q] of o.scratch.made) madeAll.set(it, (madeAll.get(it) || 0) + q * pick.hs);
      }
      const last = segs[segs.length - 1];
      const seg = { m: o.m, fromLevel: level, toLevel: stopLevel, hours: pick.t, xp: need, xph: need / pick.t, gph: pick.g / pick.t, bankHours: pick.hb, scratchHours: pick.hs, steps: o.scratch.steps, otherXp: o.scratch.xpBy.filter(([s]) => s !== skill) };
      if (last && last.m.id === o.m.id) {
        last.hours += pick.t; last.toLevel = stopLevel; last.xp += need; last.bankHours += pick.hb; last.scratchHours += pick.hs;
        last.xph = last.xp / last.hours; last.gph = (last.gph * (last.hours - pick.t) + pick.g) / last.hours;
      } else segs.push(seg);
      hours += pick.t;
      gp += pick.g;
      xp = stopXp;
      level = Math.max(level, levelFromXp(xp));
      if (need === 0 && level < stopLevel) level = stopLevel;
    }
    return {
      segs, hours, gp,
      supplies: [...used.entries()].map(([item, qty]) => ({ item, qty, have: this.bank[item] || 0, made: madeAll.get(item) || 0 })),
      made: [...madeAll.entries()].map(([item, qty]) => ({ item, qty })),
    };
  }

  // ---------------------------------------------------------------- shop advisor
  /** Upgrades worth buying next: every unowned shop bonus whose requirements you meet (or nearly). */
  upgradeAdvice() {
    if (this._cache.has('advice')) return this._cache.get('advice');
    const baseBest = new Map();
    const bestBy = (eng, skill) => {
      const money = eng.ranked('best', { skill })[0];
      const train = eng.trainOptions(skill)[0];
      return { gph: money?.gph ?? 0, xph: train?.xph ?? 0, money, train };
    };
    const out = [];
    const skillsOf = (b) => [...new Set(b.map(([, , , ctx]) => ctx.e).filter((s) => SKILL_ORDER.includes(s)))];
    for (const [id, s] of Object.entries(this.g.shop)) {
      if (!s.b || (this.shopOwned[id] || 0) > 0) continue;
      const skills = skillsOf(s.b);
      if (!skills.length) continue;
      const st = s.r.map((r) => this.reqStatus(r));
      const missing = st.filter((x) => !x.ok);
      // only show the next tier: allow at most one missing level requirement, no missing purchases
      if (missing.some((x) => x.kind !== 'lvl')) continue;
      const gap = missing.reduce((a, x) => Math.max(a, x.gap || 0), 0);
      if (gap > 10) continue;
      const gpCost = (s.cost.find(([c]) => c === 'GoldPieces')?.[1]) || 0;
      const otherCur = s.cost.filter(([c]) => c !== 'GoldPieces');
      const itemCost = s.ci.reduce((a, [it, q]) => a + q * this.value(it), 0);
      const alt = this.withShop([id]);
      let dGp = 0, dXp = 0, skill = skills[0], before = null, after = null;
      for (const sk of skills) {
        if (!baseBest.has(sk)) baseBest.set(sk, bestBy(this, sk));
        const b0 = baseBest.get(sk), b1 = bestBy(alt, sk);
        const g = b1.gph - b0.gph, x = b0.xph > 0 ? (b1.xph - b0.xph) / b0.xph : 0;
        if (g > dGp || (dGp === 0 && x > dXp)) { dGp = Math.max(dGp, g); skill = sk; before = b0; after = b1; }
        dXp = Math.max(dXp, x);
      }
      const totalCost = gpCost + itemCost;
      out.push({
        id, s, skills, skill, missing, gap, gpCost, itemCost, otherCur, totalCost,
        dGp, dXp, before, after, payback: dGp > 0 ? totalCost / dGp : Infinity,
        affordable: gpCost <= (this.p.wallet?.GoldPieces ?? this.p.header?.gp ?? 0) && s.ci.every(([it, q]) => (this.bank[it] || 0) >= q),
      });
    }
    out.sort((a, b) => (a.gap > 0) - (b.gap > 0) || (b.dGp > 0) - (a.dGp > 0) || a.payback - b.payback || b.dXp - a.dXp);
    this._cache.set('advice', out);
    return out;
  }

  // ---------------------------------------------------------------- farming
  /** Seeds, compost and flower seeds are priced at the shop if sold there, else at what you'd get selling them. */
  farmPrice(item) {
    const b = this.buyPrice(item);
    return Number.isFinite(b) ? b : this.value(item);
  }

  /**
   * One plot of crop m, planted and harvested promptly, with an optional compost and flowers growing.
   * Yield per harvest is the game's formula: max(1, floor((Q + flat) × (1 + %) × (1 − (excess pests + excess disease)/100))), × (1 + doubling).
   */
  farmCrop(m, { compost = null, flowers = [], water = true } = {}) {
    const x = m.x;
    const F = (name, st = 'FarmingAction') => {
      let v = this.mod(m, name, null, st);
      for (const fid of flowers) for (const [t, nm, val] of this.byId.get('Farming:' + fid)?.x?.fb || []) if (nm === name && t === st) v += val;
      return v;
    };
    const compPct = compost && x.comp ? (this.g.farm.compost[compost]?.b || []).filter(([, nm]) => nm === 'PercentProductQuantity').reduce((a, b) => a + b[2], 0) : 0;
    const pest = Math.max(0, x.pest - F('FlatPestProtection'));
    const dis = Math.max(0, x.dis - F('FlatDiseaseProtection') - (water ? x.water : 0));
    const adj = 1 - (pest + dis) / 100;
    const qty = Math.max(1, Math.floor((x.q + F('FlatProductQuantity')) * (1 + F('PercentProductQuantity') + compPct) * adj));
    const d = clamp01(F('DoublingChance'));
    const harvests = 1 + Math.max(0, Math.floor(x.rg + F('FlatRegrows')));
    const iv = (base) => Math.floor((base + F('FlatInterval')) * (1 + F('PercentInterval')));
    const cycleMs = iv(x.iv) + (harvests - 1) * iv(x.rgiv);
    const pres = clamp01(F('PreservationChance'));
    const seeds = m.in.map(([it, q]) => [it, Math.max(1, Math.floor(q * (1 + F('PercentIngredientCost')))) * (1 - pres)]);
    const compUse = compost && x.comp ? 1 - clamp01(F('CompostPreservationChance')) : 0;
    const xpMult = 1 + F('PercentXPGained', 'Experience');
    const perHarvest = qty * (1 + d);
    const out = perHarvest * harvests;
    const gpOut = out * this.value(x.p);
    const gpIn = seeds.reduce((a, [it, q]) => a + q * this.farmPrice(it), 0) + compUse * (compost ? this.farmPrice(compost) : 0);
    const xp = m.xp * xpMult * harvests;
    const h = cycleMs / HOUR;
    return { m, compost: compost && x.comp ? compost : null, qty, perHarvest, harvests, cycleMs, seeds, compUse, out, gpOut, gpIn, gpCycle: gpOut - gpIn, xp, gph: (gpOut - gpIn) / h, xph: xp / h, adj, pest, dis };
  }

  /**
   * The farm: your plots from the save (what's growing, when it's ready), the best crop and compost for each plot type,
   * which flowers to keep growing, what your farm makes per hour, and which plot to buy next.
   */
  farmPlan() {
    if (this._cache.has('farm')) return this._cache.get('farm');
    const FD = this.g.farm;
    if (!FD) return null;
    const unlocked = this.unlockedMethods().filter((m) => m.s === 'Farming' && m.x?.t === 'farm');
    const saved = this.p.farm?.plots || {};
    const known = Object.keys(saved).length > 0;
    const owned = Object.entries(FD.plots).filter(([id, pl]) => (known ? (saved[id]?.state ?? 0) > 0 : this.p.allGuild && pl.r.every((r) => this.reqStatus(r).ok)));
    const composts = Object.keys(FD.compost).filter((c) => (this.bank[c] || 0) > 0 || unlocked.some((m) => m.x.p === c) || Number.isFinite(this.buyPrice(c)));
    // flowers currently growing count as active
    const activeFlowers = Object.values(saved).filter((p) => (p.state === 2 || p.state === 5) && this.byId.get('Farming:' + p.recipe)?.x?.fb).map((p) => p.recipe);
    const crops = ['Allotments', 'Herbs', 'Trees', 'Orchard', 'MillFarm'];
    const bestIn = (cat, flowers, key = 'gph') => {
      let best = null;
      for (const m of unlocked) {
        if (m.cat !== cat || m.x.fb) continue;
        for (const c of [null, ...composts]) {
          const r = this.farmCrop(m, { compost: c, flowers });
          if (!best || r[key] > best[key]) best = r;
        }
      }
      return best;
    };
    const byCat = {};
    for (const cat of crops) {
      const list = unlocked.filter((m) => m.cat === cat && !m.x.fb).map((m) => {
        const opts = [null, ...composts].map((c) => this.farmCrop(m, { compost: c, flowers: activeFlowers }));
        return opts.sort((a, b) => b.gph - a.gph)[0];
      }).sort((a, b) => b.gph - a.gph);
      byCat[cat] = { list, best: list[0] || null, bestXp: [...list].sort((a, b) => b.xph - a.xph)[0] || null, owned: owned.filter(([, pl]) => pl.c === cat).length };
    }
    const farmGph = (flowers) => crops.reduce((a, cat) => a + byCat[cat].owned * Math.max(0, bestIn(cat, flowers)?.gph || 0), 0);
    const base = crops.reduce((a, cat) => a + byCat[cat].owned * Math.max(0, byCat[cat].best?.gph || 0), 0);
    // flowers: what keeping each one growing adds across your crop plots, net of its seeds
    const flowerPlots = owned.filter(([, pl]) => pl.c === 'Flowers').length;
    const noFlowers = farmGph([]);
    const flowers = unlocked.filter((m) => m.x.fb).map((m) => {
      const gain = farmGph([m.rid]) - noFlowers;
      const seedHr = m.in.reduce((a, [it, q]) => a + q * this.farmPrice(it), 0) / ((m.x.iv + m.x.giv) / HOUR);
      return { m, gain, seedHr, net: gain - seedHr, active: activeFlowers.includes(m.rid) };
    }).sort((a, b) => b.net - a.net);
    // your plots: what's there now and when it's ready
    const plots = owned.map(([id, pl]) => {
      const s = saved[id] || {};
      const m = s.recipe ? this.byId.get('Farming:' + s.recipe) : null;
      const leftMs = s.timer && s.timer.wait > 0 && m ? Math.max(0, s.timer.left) * ((s.state === 4 ? m.x.rgiv : s.state === 5 ? m.x.giv : m.x.iv) / s.timer.wait) : 0;
      const best = byCat[pl.c]?.best || null;
      const cur = m && !m.x.fb && m.x.t === 'farm' ? this.farmCrop(m, { compost: s.compost, flowers: activeFlowers }) : null;
      return { id, pl, s, m, leftMs, ready: s.state === 3 || (s.state >= 2 && leftMs <= 0), empty: s.state === 1, best, cur };
    });
    // compost: worth the extra harvest it gives on your best crop plots; bins turn crops into compost
    const compostWorth = {};
    for (const c of Object.keys(this.g.farm.compost)) {
      let w = 0;
      for (const cat of crops) {
        const b = byCat[cat]; if (!b.list.length) continue;
        for (const x of b.list) {
          if (!x.m.x.comp) continue;
          const plain = this.farmCrop(x.m, { flowers: activeFlowers }), withC = this.farmCrop(x.m, { compost: c, flowers: activeFlowers });
          if (withC.compUse > 0) w = Math.max(w, (withC.gpOut - plain.gpOut) / withC.compUse);
        }
      }
      compostWorth[c] = w;
    }
    const bins = this.methods.filter((m) => m.s === 'Farming' && m.cat === 'CompostBins' && m.x?.t === 'farm').map((m) => {
      const ok = this.status(m).unlocked;
      const out = m.x.q, worth = compostWorth[m.x.p] || 0;
      const cost = m.in.reduce((a, [it, q]) => a + q * this.value(it), 0);
      const h = m.x.iv / HOUR;
      return { m, ok, out, worth, cost, gph: (out * worth - cost) / h, perDay: out * 24 / h };
    }).sort((a, b) => (b.ok - a.ok) || b.gph - a.gph);
    // compost your plots use per day if every compostable plot gets one
    const compostPerDay = crops.reduce((a, cat) => { const b = byCat[cat].best; return a + (b?.compost ? byCat[cat].owned * b.compUse * 24 / (b.cycleMs / HOUR) : 0); }, 0);
    // next plot to buy in each category
    const buy = [];
    for (const cat of [...crops, 'Flowers', 'CompostBins']) {
      const next = Object.entries(FD.plots).find(([id, pl]) => pl.c === cat && !owned.some(([o]) => o === id));
      if (!next) continue;
      const [id, pl] = next;
      const st = pl.r.map((r) => this.reqStatus(r));
      const need = Math.max(this.level('Farming'), ...pl.r.filter((r) => r.t === 'lvl' && r.s === 'Farming').map((r) => r.l));
      // what this plot would grow at the level it needs (crops you can't plant yet count once you can)
      let best = byCat[cat]?.best || null;
      if (crops.includes(cat)) {
        for (const m of this.methods) {
          if (m.s !== 'Farming' || m.cat !== cat || m.x?.t !== 'farm' || m.x.fb || m.lv > need || !this.status(m, { Farming: need }).unlocked) continue;
          for (const c of [null, ...composts]) { const r = this.farmCrop(m, { compost: c, flowers: activeFlowers }); if (!best || r.gph > best.gph) best = r; }
        }
      }
      const gain = cat === 'Flowers' ? Math.max(0, flowers.filter((f) => !f.active)[0]?.net || 0) : cat === 'CompostBins' ? Math.max(0, bins[0]?.gph || 0) : Math.max(0, best?.gph || 0);
      buy.push({ id, pl, cat, gain, need, payback: gain > 0 ? pl.gp / gain : Infinity, missing: st.filter((x) => !x.ok), best: cat === 'Flowers' ? flowers[0] || null : best });
    }
    buy.sort((a, b) => (a.missing.length > 0) - (b.missing.length > 0) || a.payback - b.payback);
    const res = { known, byCat, crops, plots, flowers, flowerPlots, activeFlowers, buy, gph: base, savedAt: this.p.header?.timestamp, composts, compostWorth, bins, compostPerDay };
    this._cache.set('farm', res);
    return res;
  }

  /** Clone with extra hypothetical astrology nodes. */
  withAstro(nodes) {
    const e = Object.create(Engine.prototype);
    Object.assign(e, this);
    e.setPlayer(this.p, { extraShop: [], extraAstro: nodes, useMods: true, keepCombat: true });
    return e;
  }

  /**
   * Astrology: per constellation, your knowledge, node picks waiting to be spent, how long until the next pick,
   * and what each node you could pick next adds to your best gold/hr and XP/hr in the skill it boosts.
   */
  astroAdvice() {
    if (this._cache.has('astro')) return this._cache.get('astro');
    const A = this.g.astro;
    if (!A) return [];
    const base = new Map();
    const bestBy = (eng, sk) => {
      const money = PASSIVE_SKILLS.has(sk) ? null : eng.ranked('best', { skill: sk })[0];
      const train = eng.trainOptions(sk)[0];
      return { gph: money?.gph ?? 0, xph: train?.xph ?? 0, money, train };
    };
    const valueOf = new Map(); // bonus signature -> gains (nodes often repeat the same bonus)
    const evalNode = (nid) => {
      const nd = A.nodes[nid];
      const sig = JSON.stringify(nd.b);
      if (valueOf.has(sig)) return valueOf.get(sig);
      const skills = [...new Set(nd.b.map(([, , , ctx]) => ctx.e).filter((s) => SKILL_ORDER.includes(s) || s === 'Astrology'))];
      const res = { dGp: 0, dXp: 0, skill: skills[0] || null, modelled: false };
      const testable = skills.filter((s) => !PASSIVE_SKILLS.has(s) && s !== 'Astrology');
      if (testable.length && nd.b.some(([, , , ctx]) => !ctx.x)) {
        const alt = this.withAstro([nid]);
        for (const sk of testable) {
          if (!base.has(sk)) base.set(sk, bestBy(this, sk));
          const b0 = base.get(sk), b1 = bestBy(alt, sk);
          const g = b1.gph - b0.gph, x = b0.xph > 0 ? (b1.xph - b0.xph) / b0.xph : 0;
          if (g > res.dGp || (res.dGp === 0 && x > res.dXp)) { res.dGp = Math.max(res.dGp, g); res.skill = sk; }
          res.dXp = Math.max(res.dXp, x);
          if (Math.abs(g) > 1e-6 || Math.abs(x) > 1e-9) res.modelled = true;
        }
      }
      valueOf.set(sig, res);
      return res;
    };
    const out = [];
    for (const c of A.cons) {
      const m = this.byId.get('Astrology:' + c.id);
      const st = m ? this.status(m) : null;
      const a = this.astro?.[c.id] || { knowledge: 0, minor: [], major: [] };
      const avail = c.thr.filter((t) => a.knowledge >= t).length;
      const freeMinor = Math.max(0, avail - a.minor.length);
      const freeMajor = Math.max(0, Math.floor(a.minor.length / c.per) - a.major.length);
      const r = m && st.unlocked ? this.rate(m) : null;
      const kph = r ? r.extra.knowledge * HOUR / r.ms : 0;
      const need = c.thr[avail];
      const next = need != null ? { need, hours: kph > 0 ? (need - a.knowledge) / kph : Infinity } : null;
      const nodeOk = (nid) => (A.nodes[nid].r || []).every((q) => this.reqStatus(q).ok);
      const picks = [];
      if (st?.unlocked) {
        for (const nid of c.minor) if (!a.minor.includes(nid) && nodeOk(nid)) picks.push({ id: nid, nd: A.nodes[nid], major: false, ...evalNode(nid) });
        if (freeMajor > 0 || a.minor.length + freeMinor >= (a.major.length + 1) * c.per) {
          for (const nid of c.major) if (!a.major.includes(nid) && nodeOk(nid)) picks.push({ id: nid, nd: A.nodes[nid], major: true, ...evalNode(nid) });
        }
      }
      picks.sort((x, y) => y.dGp - x.dGp || y.dXp - x.dXp);
      out.push({ c, m, unlocked: !!st?.unlocked, missing: st?.missing || [], knowledge: a.knowledge, have: a.minor.length, major: a.major.length, avail,
        freeMinor, freeMajor, kph, xph: r ? r.xp * HOUR / r.ms : 0, next, picks, nodes: [...a.minor, ...a.major] });
    }
    this._cache.set('astro', out);
    return out;
  }

  /** Potions you can brew (or already own) that would raise your best rate in their skill, net of what they cost to use. */
  potionAdvice() {
    if (this._cache.has('potions')) return this._cache.get('potions');
    const brewable = new Set(this.unlockedMethods().filter((m) => m.s === 'Herblore').map((m) => m.primary));
    const { costs } = this.solveChains();
    const base = new Map();
    const bestOf = (eng, sk) => ({ money: eng.ranked('best', { skill: sk })[0], train: eng.trainOptions(sk)[0] });
    const out = [];
    for (const [id, it] of Object.entries(this.items)) {
      if (!it.tb || !/Potion$/.test(it.slot || '') || this.tools[id]) continue;
      if (!brewable.has(id) && !(this.bank[id] > 0)) continue;
      const skills = [...new Set(it.tb.map(([, , , ctx]) => ctx.e).filter((x) => SKILL_ORDER.includes(x)))];
      if (!skills.length) continue;
      const sk = skills[0];
      if (!base.has(sk)) base.set(sk, bestOf(this, sk));
      const b0 = base.get(sk);
      const alt = Object.create(Engine.prototype);
      Object.assign(alt, this);
      alt.setPlayer(this.p, { extraShop: [], extraTools: [id], useMods: true, keepCombat: true });
      const b1 = bestOf(alt, sk);
      const m = b1.money?.m || b1.train?.m;
      if (!m) continue;
      const r = alt.rate(m);
      const ticks = r.aph * (r.extra?.hits || r.extra?.stepsTaken || 1); // potions are used per action tick
      const each = costs.get(id)?.total ?? (this.buyPrice(id) < Infinity ? this.buyPrice(id) : this.value(id));
      const costHr = ticks * each;
      const dGp = (b1.money?.gph ?? 0) - (b0.money?.gph ?? 0);
      const dXp = b0.train?.xph ? b1.train.xph / b0.train.xph - 1 : 0;
      if (dGp <= 0 && dXp <= 0.001) continue;
      out.push({ id, it, skill: sk, dGp, dXp, net: dGp - costHr, costHr, perHour: ticks, each, have: this.bank[id] || 0, before: b0, after: b1 });
    }
    out.sort((a, b) => b.net - a.net || b.dXp - a.dXp);
    this._cache.set('potions', out);
    return out;
  }

  /**
   * Gear you could craft or buy that would improve one of your best fights. Situational: each
   * suggestion is tied to the enemy and style it helps, measured by re-optimising that fight's
   * loadout with the new piece available.
   */
  gearAdvice() {
    if (this._cache.has('gear')) return this._cache.get('gear');
    const C = this.g.combat;
    const out = [];
    const top = this.ranked('chain', { skill: 'Combat' }).slice(0, 4);
    if (!C || !this.gearPool || !top.length) { this._cache.set('gear', out); return out; }
    const owned = new Set([...Object.values(this.gearPool.byType).flat(), ...Object.values(this.gearPool.weapons).flat()]);
    const makeable = new Map();
    for (const m of this.unlockedMethods()) if (m.s !== 'Combat') for (const [it] of m.out) if (!makeable.has(it) || m.primary === it) makeable.set(it, m);
    const statSum = (id) => Object.entries(this.items[id].eq.st).reduce((a, [k, v]) => a + (k === 'AttackInterval' ? 0 : k === 'MagicDamageBonus' ? v * 100 : v), 0) + this.items[id].eq.pow / 20 + this.items[id].eq.prot / 10;
    // candidates: equippable, obtainable, not owned, and not worse on every stat than something you own in that slot
    const byType = new Map();
    for (const [id, it] of Object.entries(this.items)) {
      const e = it.eq;
      if (!e || owned.has(id) || e.slot === 'Ammo') continue;
      if (!(e.r || []).every((q) => this.reqStatus(q).ok)) continue;
      const src = makeable.has(id) ? 'make' : Number.isFinite(this.buyPrice(id)) ? 'buy' : null;
      if (!src) continue;
      const mine = e.slot === 'Weapon' ? [] : (this.gearPool.byType[e.slot] || []);
      const dominated = mine.some((o) => Object.entries(e.st).every(([k, v]) => k === 'AttackInterval' || (this.items[o].eq.st[k] || 0) >= v) && this.items[o].eq.prot >= e.prot && this.items[o].eq.pow >= e.pow);
      if (dominated) continue;
      if (!byType.has(e.slot)) byType.set(e.slot, []);
      byType.get(e.slot).push({ id, src });
    }
    const lv = combatLevels(this.p);
    for (const [type, list] of byType) {
      for (const c of list.sort((a, b) => statSum(b.id) - statSum(a.id)).slice(0, 4)) {
        const pool2 = gearPool(this.g, this.p, (id) => id === c.id || (this.items[id].eq.r || []).every((q) => this.reqStatus(q).ok), [...this.extraGear, c.id],
          (sp) => (sp.r || []).every((q) => this.reqStatus(q).ok));
        let bestGain = null;
        for (const x of top) {
          const before = this.combatPlan(x.m.rid, 'money');
          if (!before) continue;
          const e = C.enemies[x.m.rid];
          const loot = x.m.out.reduce((a, [it, q]) => a + q * this.value(it), 0) + x.m.gp;
          const enemy = enemyFighter(e);
          const score = (f, p) => (f.danger < 0.9 && f.killMs <= 20 * 60000 ? (HOUR / f.killMs) * (loot - this.inputCost(this.combatInputs(f, p))) : null);
          const after = bestLoadout(this.g, pool2, lv, enemy, score, before.gear);
          if (!after || !Object.values(after.gear).includes(c.id)) continue;
          const gain = after.s - before.gph;
          if (gain > 1 && (!bestGain || gain > bestGain.gain)) bestGain = { gain, x, before, after };
        }
        if (!bestGain) continue;
        const slot = Object.entries(bestGain.after.gear).find(([, it]) => it === c.id)?.[0];
        out.push({
          slot, id: c.id, it: this.items[c.id], cur: bestGain.before.gear[slot] || null, src: c.src, via: makeable.get(c.id) || null, price: this.buyPrice(c.id),
          dGp: bestGain.gain, enemy: bestGain.x.m, style: bestGain.after.style, styleBefore: bestGain.before.style,
          killBefore: bestGain.before.f.killMs, killAfter: bestGain.after.f.killMs, takenBefore: bestGain.before.f.takenPerKill, takenAfter: bestGain.after.f.takenPerKill,
        });
      }
    }
    out.sort((a, b) => b.dGp - a.dGp);
    this._cache.set('gear', out);
    return out;
  }

  // ---------------------------------------------------------------- collection
  /**
   * Item completion from the save's "found" statistic: per source skill, plus every missing item
   * with the quickest way you can get one right now (or what's stopping you).
   */
  collection() {
    if (this._cache.has('collection')) return this._cache.get('collection');
    const found = this.p.stats?.items?.BankItemFound || {};
    const unlocked = new Set(this.unlockedMethods().map((m) => m.id));
    const groups = new Map();
    const missing = [];
    let total = 0, have = 0;
    for (const [id, it] of Object.entries(this.items)) {
      if (it.ic || !it.n) continue;
      const prods = this.producers.get(id) || [];
      const src = prods.find((m) => !m.quest)?.s || (prods[0]?.quest ? 'Quests' : this.g.buy[id] ? 'Shop' : 'Other');
      total++;
      const g = groups.get(src) || { skill: src, total: 0, have: 0 };
      g.total++;
      const isFound = (found[id] || 0) > 0 || (this.bank[id] || 0) > 0;
      if (isFound) { have++; g.have++; groups.set(src, g); continue; }
      groups.set(src, g);
      let best = null;
      for (const m of prods) {
        if (!unlocked.has(m.id)) continue;
        const per = this.rate(m).outs.find(([x]) => x === id)?.[1] || 0;
        if (per > 0 && (!best || 1 / per < best.hours)) best = { hours: 1 / per, m };
      }
      if (Number.isFinite(this.buyPrice(id)) && (!best || best.hours > 0.01)) best = { hours: 0, buy: this.buyPrice(id) };
      let lock = null;
      if (!best && prods.length) {
        const st = prods.map((m) => ({ m, st: this.status(m) })).sort((a, b) => a.st.levelGap - b.st.levelGap)[0];
        lock = { m: st.m, text: st.st.missing.map((x) => x.text).join(', ') || (this.rate(st.m).blocked || 'not safe to farm yet') };
      }
      missing.push({ id, it, src, best, lock });
    }
    missing.sort((a, b) => (a.best ? a.best.hours : Infinity) - (b.best ? b.best.hours : Infinity));
    const res = { total, have, groups: [...groups.values()].sort((a, b) => b.total - a.total), missing };
    this._cache.set('collection', res);
    return res;
  }

  // ---------------------------------------------------------------- speedrun planner
  /**
   * A forward-simulated route: at each step pick the action that pays back its time fastest,
   * resolving what it depends on (training, gold to save up, earlier quests, guild ranks).
   * Training done for one step counts for later ones. Rates are "from scratch" (sustainable).
   */
  speedPlan({ horizon = 96, maxSteps = 14 } = {}) {
    const key = 'speedplan|' + horizon;
    if (this._cache.has(key)) return this._cache.get(key);
    const start = this.ranked('chain')[0];
    let best = start?.gph ?? 0;
    let bestName = start?.m.n ?? '—';
    let gold = this.p.wallet?.GoldPieces ?? this.p.header?.gp ?? 0;
    const lvNow = { ...this.levels };
    const hCache = new Map();
    const H = (sk, lvl) => { // hours from your save's level to lvl (0 if already there)
      if (lvl <= (this.levels[sk] ?? 1) || NOT_TRAINABLE.has(sk)) return 0;
      const k = sk + lvl;
      if (!hCache.has(k)) hCache.set(k, this.planLevel(sk, lvl).hours);
      return hCache.get(k);
    };
    const trainCost = (needs) => needs.reduce((a, n) => a + Math.max(0, H(n.skill, n.level) - H(n.skill, lvNow[n.skill] ?? 1)), 0);
    const cands = [];
    // sustainable (from scratch) rate of the best method in a skill / against an enemy
    const chainBest = new Map();
    for (const x of this.ranked('chain')) {
      if (!chainBest.has('skill:' + x.m.s)) chainBest.set('skill:' + x.m.s, x.gph);
      chainBest.set('enemy:' + x.m.id, x.gph);
    }

    // 1) better methods behind levels
    for (const x of this.betterUnlocks().list) {
      cands.push({ kind: 'unlock', id: 'u:' + x.m.id, m: x.m, title: `Unlock ${x.m.n}`, needs: x.needs, actionHours: (x.guild?.hours || 0) + x.killHours, guild: x.guild, kills: x.kills, gp: 0, newRate: x.gph,
        why: `${x.m.s}${x.m.loc ? ' · ' + x.m.loc : ''}: ${Math.round(x.gph).toLocaleString('en-US')} gp/hr from scratch` });
    }
    // 2) shop upgrades (with their level requirements)
    for (const a of this.upgradeAdvice()) {
      if (!(a.dGp > 0)) continue;
      const needs = a.missing.filter((m) => m.kind === 'lvl').map((m) => ({ skill: m.skill, level: m.need }));
      cands.push({ kind: 'shop', id: 's:' + a.id, title: `Buy ${a.s.n}`, needs, actionHours: 0, gp: a.gpCost, items: a.s.ci, gain: a.dGp, skill: a.skill,
        key: 'skill:' + a.skill, base: chainBest.get('skill:' + a.skill) ?? 0,
        why: `+${Math.round(a.dGp).toLocaleString('en-US')} gp/hr on ${a.after?.money?.m.n || a.skill}` });
    }
    // 3) combat gear you can craft or buy
    for (const g of this.gearAdvice()) {
      const t = g.src === 'make' ? this.itemTime(g.id, 1) : { hours: 0, gp: g.price };
      if (!Number.isFinite(t.hours)) continue;
      cands.push({ kind: 'gear', id: 'g:' + g.id, title: `${g.src === 'make' ? 'Make' : 'Buy'} ${g.it.n}`, needs: [], actionHours: t.hours, gp: t.gp || 0, gain: g.dGp,
        key: 'enemy:' + g.enemy.id, base: chainBest.get('enemy:' + g.enemy.id) ?? 0,
        why: `+${Math.round(g.dGp).toLocaleString('en-US')} gp/hr fighting ${g.enemy.n}` });
    }
    // 4) astrology: study a constellation to the next node and pick the one that pays most
    for (const a of this.astroAdvice()) {
      const pick = a.picks.find((x) => x.dGp > 0);
      if (!pick || !a.unlocked) continue;
      const hours = a.freeMinor > 0 || pick.major ? 0 : a.next?.hours;
      if (!Number.isFinite(hours)) continue;
      cands.push({ kind: 'astro', id: 'a:' + pick.id, title: `${a.c.n}: pick ${pick.nd.n}`, needs: [], actionHours: hours, gp: 0, gain: pick.dGp, skill: pick.skill, cons: a.c.id,
        key: 'skill:' + pick.skill, base: chainBest.get('skill:' + pick.skill) ?? 0,
        why: `+${Math.round(pick.dGp).toLocaleString('en-US')} gp/hr on ${pick.skill}${hours > 0 ? ` · study ${a.c.n} to ${a.next.need.toLocaleString('en-US')} knowledge` : ' · a node pick is waiting'}` });
    }
    // 5) quests: one-off rewards, and the shop upgrades / areas they unlock
    const quests = this.questList();
    for (const q of quests) {
      if (q.done || !Number.isFinite(q.hours)) continue;
      let gain = 0, gainWhy = '';
      for (const [kind, id, name] of q.unlocks) {
        if (kind !== 'shop' || !this.g.shop[id]?.b) continue;
        const sk = [...new Set(this.g.shop[id].b.map(([, , , c]) => c.e).filter((x) => SKILL_ORDER.includes(x)))][0];
        if (!sk) continue;
        const alt = this.withShop([id]);
        const d = (alt.ranked('best', { skill: sk })[0]?.gph ?? 0) - (this.ranked('best', { skill: sk })[0]?.gph ?? 0);
        if (d > gain) { gain = d; gainWhy = `unlocks ${name} (+${Math.round(d).toLocaleString('en-US')} gp/hr)`; }
      }
      const prereq = q.Q.r.filter((r) => r.t === 'quest').map((r) => r.id);
      cands.push({ kind: 'quest', id: 'q:' + q.id, q, title: `Quest: ${q.Q.n}`, unknown: q.unknown, needs: (q.training || []).map((t) => ({ skill: t.skill, level: t.level })),
        actionHours: Math.max(0, q.hours - (q.training || []).reduce((a, t) => a + t.hours, 0)), gp: q.gp || 0, reward: q.rewardValue, gain, prereq,
        why: [q.rewardValue > 0 ? `rewards worth ${Math.round(q.rewardValue).toLocaleString('en-US')} gold` : '', gainWhy, q.unlocks.filter((u) => u[0] === 'area').map((u) => 'opens ' + u[2]).join(', ')].filter(Boolean).join(' · ') });
    }

    const doneQ = new Set(quests.filter((q) => q.done).map((q) => q.id));
    const rateOf = new Map(); // skill/enemy -> its best rate so far (upgrades on the same thing stack)
    const newRateOf = (c) => (c.kind === 'unlock' ? c.newRate : c.key ? (rateOf.get(c.key) ?? c.base) + c.gain : 0);
    const steps = [];
    let time = 0;
    const used = new Set();
    for (let n = 0; n < maxSteps && time < horizon; n++) {
      let pick = null;
      for (const c of cands) {
        if (used.has(c.id)) continue;
        if (c.prereq && !c.prereq.every((id) => doneQ.has(id))) continue;
        const train = trainCost(c.needs);
        const short = Math.max(0, (c.gp || 0) - gold);
        const earn = short > 0 ? (best > 0 ? short / best : Infinity) : 0;
        const hours = train + c.actionHours + earn;
        if (!Number.isFinite(hours) || time + hours > horizon * 1.5) continue;
        const gain = Math.max(0, newRateOf(c) - best); // only what lifts your best rate counts
        // one-off rewards count as gold earned faster than grinding
        const oneOff = (c.reward || 0) - best * hours;
        let score;
        if (gain > 1) score = hours / gain; // hours of payback per gp/hr gained: lower is better
        else if (oneOff > 0) score = -oneOff / Math.max(hours, 0.01) / 1e6; // beats grinding outright
        else if (c.kind === 'quest') score = 1e6 + hours; // progression: only after everything that pays
        else continue;
        if (!pick || score < pick.score) pick = { c, hours, train, earn, gain, score };
      }
      if (!pick) break;
      const { c } = pick;
      used.add(c.id);
      const trainSteps = c.needs.filter((x) => (lvNow[x.skill] ?? 1) < x.level).map((x) => ({ ...x, hours: Math.max(0, H(x.skill, x.level) - H(x.skill, lvNow[x.skill] ?? 1)) }));
      for (const x of c.needs) lvNow[x.skill] = Math.max(lvNow[x.skill] ?? 1, x.level);
      gold = Math.max(0, gold + best * pick.earn - (c.gp || 0)) + (c.reward || 0);
      time += pick.hours;
      const before = best;
      const nr = newRateOf(c);
      if (c.key) rateOf.set(c.key, nr);
      if (nr > best) { best = nr; bestName = c.kind === 'unlock' ? c.m.n : c.kind === 'gear' ? c.why.replace(/^.*fighting /, '') : (c.skill || bestName); }
      if (c.kind === 'quest') doneQ.add(c.q.id);
      steps.push({ ...c, hours: pick.hours, earn: pick.earn, trainSteps, time, rateBefore: before, rateAfter: best, bestName });
      // unlocks that no longer beat the new best are pointless now
      for (const o of cands) if (o.kind === 'unlock' && o.newRate <= best) used.add(o.id);
    }
    const res = { steps, startRate: start?.gph ?? 0, startName: start?.m.n ?? '—', endRate: best, time };
    this._cache.set(key, res);
    return res;
  }

  /**
   * Route to one goal: { type: 'quest', id } | { type: 'level', skill, level } | { type: 'unlock', id }.
   * Resolves everything it depends on in order (earlier quests, training with levels carried
   * forward, guild ranks, gold), and adds upgrades on the way when they save more time than they cost.
   */
  goalRoute(goal) {
    const key = 'goal|' + JSON.stringify(goal);
    if (this._cache.has(key)) return this._cache.get(key);
    const steps = [];
    const lvNow = { ...this.levels };
    const best = this.ranked('chain')[0]?.gph || 0;
    let gold = this.p.wallet?.GoldPieces ?? this.p.header?.gp ?? 0;
    const hCache = new Map();
    const H = (sk, lvl) => {
      if (lvl <= (this.levels[sk] ?? 1) || NOT_TRAINABLE.has(sk)) return 0;
      const k = sk + lvl;
      if (!hCache.has(k)) hCache.set(k, this.planLevel(sk, lvl).hours);
      return hCache.get(k);
    };
    const train = (sk, lvl, why) => {
      if ((lvNow[sk] ?? 1) >= lvl) return;
      let hours = Math.max(0, H(sk, lvl) - H(sk, lvNow[sk] ?? 1));
      // detours: upgrades for this skill that save more training time than they cost
      for (const a of this.upgradeAdvice()) {
        if (a.skill !== sk || !(a.dXp > 0) || a.gap || steps.some((s) => s.id === 's:' + a.id)) continue;
        const saved = hours * (1 - 1 / (1 + a.dXp));
        const cost = Math.max(0, a.gpCost - gold) / Math.max(best, 1);
        if (saved > Math.max(cost * 1.25, 5 / 60)) {
          steps.push({ kind: 'shop', id: 's:' + a.id, title: `Buy ${a.s.n}`, hours: cost, why: `+${(a.dXp * 100).toFixed(1)}% ${sk} XP saves ~${fmtDuration(saved)} of training`, earn: cost, gp: a.gpCost });
          gold = Math.max(0, gold - a.gpCost);
          hours -= saved;
        }
      }
      steps.push({ kind: 'train', id: 't:' + sk + lvl, skill: sk, level: lvl, from: lvNow[sk] ?? 1, title: `Train ${sk} to ${lvl}`, hours, why });
      lvNow[sk] = lvl;
    };
    const doQuest = (qid, seen = new Set()) => {
      if (seen.has(qid)) return;
      seen.add(qid);
      const q = this.questInfo(qid);
      if (!q || q.done) return;
      for (const r of q.Q.r) {
        if (r.t === 'quest') doQuest(r.id, seen);
        else if (r.t === 'lvl') train(r.s, r.l, `needed to start ${q.Q.n}`);
      }
      for (const t of q.training || []) train(t.skill, t.level, `for ${q.Q.n}`);
      const action = Math.max(0, q.hours - (q.training || []).reduce((a, t) => a + t.hours, 0));
      steps.push({ kind: 'quest', id: 'q:' + qid, q, title: `Quest: ${q.Q.n}`, hours: action, unknown: q.unknown,
        why: [q.rewardValue > 0 ? `rewards worth ${Math.round(q.rewardValue).toLocaleString('en-US')} gold` : '', q.unlocks.filter((u) => u[0] === 'shop' || u[0] === 'area').map((u) => 'unlocks ' + u[2]).join(', ')].filter(Boolean).join(' · ') });
      gold += q.rewardValue;
    };
    let title = '';
    if (goal.type === 'quest') { title = this.g.quests[goal.id]?.n || goal.id; doQuest(goal.id); }
    else if (goal.type === 'level') { title = `${goal.skill} ${goal.level}`; train(goal.skill, goal.level, 'your goal'); }
    else if (goal.type === 'unlock') {
      const m = this.byId.get(goal.id);
      title = m?.n || goal.id;
      if (m) {
        for (const r of m.r) {
          if (r.t === 'quest') doQuest(r.id);
          else if (r.t === 'lvl') train(r.s, r.l, `needed for ${m.n}`);
        }
        for (const r of m.r) {
          if (r.t !== 'stat' || r.stat !== 'CombatEnemyKilled') continue;
          const st = this.reqStatus(r);
          if (st.ok) continue;
          const plan = this.combatPlan(r.key, 'money');
          const left = r.n - (st.have || 0);
          steps.push({ kind: 'kill', id: 'k:' + r.key, title: `Kill ${left} ${this.g.combat.enemies[r.key]?.n || r.key}`, skill: 'Combat', enemy: r.key,
            hours: plan ? left * plan.f.killMs / HOUR : Infinity, why: plan ? `${plan.style} · needed for ${m.n}` : 'not safe with your gear yet' });
        }
        const rank = m.r.find((r) => r.t === 'rank');
        if (rank && !this.reqStatus(rank).ok) {
          const gs = this.guild?.[rank.s];
          const next = gs?.next === rank.id;
          const gp = next ? this.guildPlan(rank.s) : null;
          steps.push({ kind: 'guild', id: 'r:' + rank.id, title: `Reach ${this.guildName(rank.s, rank.id)}`, skill: rank.s, hours: gp?.reachable ? gp.hours : Infinity,
            why: next ? 'mastery guild tasks (see Training)' : `several guild ranks away (${gs ? Math.max(0, gs.need(rank.id) - gs.lo) : '?'} more guild points); work through guild tasks in Training` });
        }
        for (const r of m.r) {
          if (r.t === 'shop' && !this.reqStatus(r).ok) {
            const sp = this.g.shop[r.id];
            const cost = (sp?.cost.find(([c]) => c === 'GoldPieces')?.[1]) || 0;
            const earn = Math.max(0, cost - gold) / Math.max(best, 1);
            steps.push({ kind: 'shop', id: 's:' + r.id, title: `Buy ${sp?.n || r.id}`, hours: earn, earn, gp: cost, why: `required for ${m.n}` });
            gold = Math.max(0, gold - cost);
          }
        }
        const lvAt = { ...lvNow };
        const val = this.ranked('chain').find((x) => x.m.id === m.id)?.gph ?? this.sellRate(m, lvAt).gpPerHour;
        const why = m.s === 'Combat' ? (val ? `about ${Math.round(val).toLocaleString('en-US')} gp/hr once unlocked` : 'not safe or too slow with your current gear') : `${m.s}: about ${Math.round(val || 0).toLocaleString('en-US')} gp/hr once unlocked (inputs at sell value)`;
        steps.push({ kind: 'unlock', id: 'u:' + m.id, m, title: `Start ${m.n}`, hours: 0, why });
      }
    }
    let t = 0;
    for (const s of steps) { t += Number.isFinite(s.hours) ? s.hours : 0; s.time = t; }
    const res = { title, steps, hours: steps.reduce((a, s) => a + s.hours, 0), unknown: steps.some((s) => s.unknown || !Number.isFinite(s.hours)) };
    this._cache.set(key, res);
    return res;
  }

  // ---------------------------------------------------------------- items
  /** Everything about one item: where it comes from, what it makes, what it's worth to you. */
  itemInfo(item) {
    const it = this.items[item];
    if (!it) return null;
    const unlocked = new Set(this.unlockedMethods().map((m) => m.id));
    const sources = (this.producers.get(item) || []).map((m) => {
      const r = this.rate(m);
      const per = r.outs.find(([i]) => i === item)?.[1] ?? 0;
      return { m, perHour: per, unlocked: unlocked.has(m.id) };
    }).sort((a, b) => (b.unlocked - a.unlocked) || b.perHour - a.perHour);
    const uses = (this.consumers.get(item) || []).map((m) => ({ m, unlocked: unlocked.has(m.id), s: this.sellRate(m) }))
      .sort((a, b) => (b.unlocked - a.unlocked) || b.s.gpPerHour - a.s.gpPerHour);
    const buy = this.g.buy[item] ? { price: this.g.buy[item].p, shop: this.g.shop[this.g.buy[item].shop] } : null;
    const costs = this.solveChains().costs.get(item);
    const tool = it.tb ? it.tb : null;
    return { item, it, have: this.bank[item] || 0, equipped: !!this.tools[item], value: it.v, sources, uses, buy, cost: costs, tool };
  }
}

// ---------------------------------------------------------------- xp table
// StandardExperienceTable.Default: scaling .25, exponentScaling 300, base 2^(1/7)
const XP_TABLE = (() => {
  const t = [0];
  let sum = 0;
  const base = Math.pow(2, 1 / 7);
  for (let i = 1; i < 200; i++) { sum += Math.floor(i + 300 * Math.pow(base, i)); t.push(Math.floor(0.25 * sum)); }
  return t;
})();
export const xpForLevel = (lvl) => (lvl <= 1 ? 0 : XP_TABLE[Math.min(lvl, 199) - 1]);
export function levelFromXp(xp, cap = 99) {
  let l = 1;
  while (l < cap && xp >= XP_TABLE[l]) l++;
  return l;
}

// ---------------------------------------------------------------- formatting
export function fmtGp(n, { sign = false, compact = true } = {}) {
  if (!Number.isFinite(n)) return '—';
  const s = sign && n > 0 ? '+' : '';
  const a = Math.abs(n);
  if (compact && a >= 1e9) return s + (n / 1e9).toFixed(a >= 1e10 ? 1 : 2) + 'B';
  if (compact && a >= 1e6) return s + (n / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M';
  if (compact && a >= 1e4) return s + (n / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'k';
  return s + Math.round(n).toLocaleString('en-US');
}
export function fmtNum(n, d = 0) {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 100 || d === 0) return Math.round(n).toLocaleString('en-US');
  return n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 });
}
export function fmtDuration(hours) {
  if (!Number.isFinite(hours)) return '∞';
  const mins = hours * 60;
  if (mins < 1) return '<1m';
  if (mins < 60) return Math.round(mins) + 'm';
  if (hours < 48) { const t = Math.round(hours * 60); const h = Math.floor(t / 60); const m = t % 60; return m ? `${h}h ${m}m` : `${h}h`; }
  if (hours < 24 * 60) { const t = Math.round(hours); const d = Math.floor(t / 24); const h = t % 24; return h ? `${d}d ${h}h` : `${d}d`; }
  return Math.round(hours / 24) + 'd';
}
export function fmtMs(ms) {
  if (ms >= HOUR) return fmtDuration(ms / HOUR);
  if (ms >= 60000) return (ms / 60000).toFixed(1).replace(/\.0$/, '') + 'm';
  return (ms / 1000).toFixed(ms < 10000 ? 2 : 1).replace(/\.?0+$/, '') + 's';
}
export function fmtPct(x, d = 0) { return (x * 100).toFixed(d) + '%'; }
