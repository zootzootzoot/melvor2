// Money-making engine: turns game data + a decoded save into ranked methods.
// Rates are base rates from the game's own formulas (no tool/mastery modifiers).

export const HOUR = 3_600_000;
export const THIEVING_STUN_MS = 2000; // ThievingActionComponent.BaseStunInterval

export const SKILL_ORDER = [
  'Woodcutting', 'Fishing', 'Mining', 'Thieving', 'Cooking', 'Smithing', 'Crafting', 'Fletching',
  'Runecrafting', 'Herblore', 'Beastcrafting', 'Firemaking', 'Farming',
];

export class Engine {
  constructor(game) {
    this.g = game;
    this.items = game.items;
    this.methods = game.methods;
    // Which items can be produced repeatably at all (ignoring player levels)?
    this.producers = new Map(); // item -> [method]
    for (const m of this.methods) {
      m.primary = m.out[0]?.[0] ?? null;
      for (const [it] of m.out) {
        if (!this.producers.has(it)) this.producers.set(it, []);
        this.producers.get(it).push(m);
      }
    }
    this.sourceable = new Set([...Object.keys(game.buy)]);
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
  }

  value(item) { return this.items[item]?.v ?? 0; }
  name(item) { return this.items[item]?.n ?? item; }

  // ---------------------------------------------------------------- player
  setPlayer(p) {
    this.p = p;
    this.levels = {};
    for (const [s, v] of Object.entries(p.skills || {})) this.levels[s] = v.level;
    this.bank = p.bank || {};
    this.shopOwned = p.shop || {};
    this.tools = p.tools || {};
    this._cache = new Map();
  }

  level(skill) { return this.levels?.[skill] ?? 1; }

  reqStatus(r, levelOverride) {
    switch (r.t) {
      case 'lvl': {
        const have = levelOverride?.[r.s] ?? this.level(r.s);
        return { ok: have >= r.l, known: true, text: `${r.s} ${r.l}`, gap: Math.max(0, r.l - have), kind: 'lvl' };
      }
      case 'shop': {
        const n = this.shopOwned[r.id] || 0;
        return { ok: n >= r.n, known: true, text: this.g.shop[r.id]?.n ?? r.id, kind: 'shop', icon: this.g.shop[r.id]?.i };
      }
      case 'tool': {
        const ok = !!(this.tools[r.item] || this.bank[r.item]);
        return { ok, known: true, text: `${this.name(r.item)} equipped`, kind: 'tool', icon: this.items[r.item]?.i };
      }
      case 'quest': return { ok: true, known: false, text: `Quest: ${r.id}`, kind: 'quest' };
      case 'rank': return { ok: true, known: false, text: `${r.s} guild rank: ${r.id.replace(/([a-z])([A-Z])/g, '$1 $2')}`, kind: 'rank' };
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
  /** Per-hour flows for a method at the player's levels. */
  rate(m, levelOverride) {
    const lvl = levelOverride?.[m.s] ?? this.level(m.s);
    let succ = 1;
    let ms = m.ms;
    if (m.succ?.t === 'cooking') succ = Math.min(1, Math.max(0, (69 + lvl) / (69 + m.succ.d)));
    if (m.succ?.t === 'thieving') {
      succ = Math.min(1, (100 + lvl) / (100 + m.succ.p));
      ms = m.ms + (1 - succ) * THIEVING_STUN_MS;
    }
    const aph = HOUR / ms;
    const outs = m.out.map(([it, q]) => [it, q * succ * aph]);
    const ins = m.in.map(([it, q]) => [it, q * aph]);
    const gp = m.gp * succ * aph;
    const xp = m.xp * succ * aph;
    const outValue = outs.reduce((a, [it, q]) => a + q * this.value(it), 0) + gp;
    return { m, succ, ms, aph, outs, ins, gp, xp, outValue, msPerAction: ms };
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
   * Returns per-item {gp, t, via} cost decomposition and per-method chain rates.
   */
  solveChains(unlocked) {
    const key = 'chains';
    if (this._cache.has(key)) return this._cache.get(key);
    const cand = unlocked.filter((m) => m.k === 'active');
    // starting lambda: best gathering-only rate
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
    // cost(i) = gp_i + lambda * t_i, minimised over buy / make. Bellman-Ford style relaxation.
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
        // per action: inputs
        for (const [it, q] of m.in) {
          const c = costs.get(it);
          if (!c) { ok = false; break; }
          gp += c.gp * q; t += c.t * q;
        }
        if (!ok) continue;
        t += r.ms;
        const perAction = r.outs.map(([it, q]) => [it, q / r.aph]);
        const primQ = perAction.find(([it]) => it === m.primary)?.[1] ?? 0;
        if (primQ <= 1e-9) continue;
        const byproducts = perAction.reduce((a, [it, q]) => a + (it === m.primary ? 0 : q * this.value(it)), 0) + r.gp / r.aph;
        const gpPer = (gp - byproducts) / primQ;
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
    const totalT = HOUR + tUp; // ms spent per "hour of this method"
    const gpPerHour = (r.outValue - gpSpent) * (HOUR / totalT);
    return { gpPerHour, share: HOUR / totalT, gpSpent, upstreamMs: tUp, steps, r };
  }

  /**
   * Flatten a chain into "where each minute of an hour of play goes" plus shop spend.
   * Returns { split: [{m, ms}], bought: [{item, qty, gp}], share } scaled to one hour of play.
   */
  chainBreakdown(m, chain) {
    const { costs } = this.solveChains(this.unlockedMethods());
    const time = new Map();
    const bought = new Map();
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
      for (const [it, q] of mm.in) walk(it, actions * q, depth + 1);
    };
    const byp = new Map();
    let bypGp = 0;
    add(m, HOUR);
    for (const [it, q] of chain.r.ins) walk(it, q, 0);
    const s = chain.share;
    const split = [...time.entries()].map(([mm, ms]) => ({ m: mm, ms: ms * s })).sort((a, b) => b.ms - a.ms);
    const boughtList = [...bought.entries()].map(([item, q]) => ({ item, qty: q * s, gp: q * s * (costs.get(item)?.gp ?? 0) }));
    // final outputs of the hour: the method's own outputs + upstream by-products
    const outs = new Map();
    for (const [it, q] of chain.r.outs) outs.set(it, (outs.get(it) || 0) + q * s);
    for (const [it, q] of byp) outs.set(it, (outs.get(it) || 0) + q * s);
    return { split, bought: boughtList, outs: [...outs.entries()], gp: (chain.r.gp + bypGp) * s, share: s };
  }

  /** Inputs valued at their sell price (opportunity cost); shop-only items at shop price. */
  sellRate(m) {
    const r = this.rate(m);
    let cost = 0;
    for (const [it, q] of r.ins) {
      const v = this.value(it);
      const b = this.buyPrice(it);
      cost += q * (this.bank[it] ? v : Math.min(Number.isFinite(b) ? b : Infinity, v || b));
    }
    return { gpPerHour: r.outValue - cost, cost, r };
  }

  /** Bank-limited: how long your stock lasts and total profit available. */
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
  unlockedMethods() {
    return this.methods.filter((m) => this.status(m).unlocked);
  }

  ranked(mode, opts = {}) {
    const unlocked = this.unlockedMethods();
    const rows = [];
    if (mode === 'chain') {
      const { rates } = this.solveChains(unlocked);
      for (const m of unlocked) {
        if (m.k === 'passive') continue;
        const c = rates.get(m.id);
        if (!c) continue;
        rows.push({ m, gph: c.gpPerHour, xph: c.r.xp * c.share, chain: c, r: c.r });
      }
    } else if (mode === 'sell') {
      for (const m of unlocked) {
        if (m.rareInputs.length && !m.rareInputs.every((it) => this.bank[it])) continue;
        const s = this.sellRate(m);
        if (!Number.isFinite(s.gpPerHour)) continue;
        rows.push({ m, gph: s.gpPerHour, xph: s.r.xp, sell: s, r: s.r });
      }
    } else if (mode === 'bank') {
      for (const m of unlocked) {
        if (m.k === 'passive') continue;
        const b = this.bankRate(m);
        if (!b || b.hours < 1 / 120) continue;
        rows.push({ m, gph: b.gpPerHour, xph: b.r.xp, bank: b, r: b.r, total: b.total });
      }
    }
    const filtered = rows.filter((x) => (opts.includePassive || x.m.k !== 'passive') && (!opts.skill || x.m.s === opts.skill));
    filtered.sort((a, b) => (mode === 'bank' && opts.sortTotal ? b.total - a.total : b.gph - a.gph));
    return filtered;
  }

  /** Locked methods you are closest to, with their projected rate at the unlock level. */
  upcoming(limit = 18) {
    const out = [];
    for (const m of this.methods) {
      if (m.k === 'passive') continue;
      const st = this.status(m);
      if (st.unlocked || !st.onlyLevelLocked) continue;
      const lv = {};
      for (const r of m.r) if (r.t === 'lvl') lv[r.s] = Math.max(lv[r.s] || 0, r.l, this.level(r.s));
      const r = this.rate(m, lv);
      const cost = r.ins.reduce((a, [it, q]) => a + q * this.value(it), 0);
      if (m.rareInputs.length || r.outValue - cost <= 0) continue;
      out.push({ m, gap: st.levelGap, gph: r.outValue - cost, r, missing: st.missing });
    }
    // per level-gap bucket keep the most lucrative
    const bucket = (g) => (g <= 1 ? 0 : g <= 5 ? 1 : g <= 15 ? 2 : 3);
    out.sort((a, b) => bucket(a.gap) - bucket(b.gap) || b.gph - a.gph);
    return out.slice(0, limit);
  }

  /** For each bank item: what's the best thing to turn it into? */
  alchemy() {
    const unlocked = this.unlockedMethods().filter((m) => m.k === 'active' && m.in.length);
    const res = [];
    for (const [item, qty] of Object.entries(this.bank)) {
      let best = null;
      for (const m of unlocked) {
        if (!m.in.some(([it]) => it === item)) continue;
        const b = this.bankRate(m);
        if (!b || b.gpPerHour <= 0) continue;
        // profit attributable while this item lasts
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
  if (hours < 48) { const h = Math.floor(hours); const m = Math.round((hours - h) * 60); return m ? `${h}h ${m}m` : `${h}h`; }
  return Math.round(hours / 24) + 'd';
}
export function fmtMs(ms) {
  if (ms >= HOUR) return fmtDuration(ms / HOUR);
  if (ms >= 60000) return (ms / 60000).toFixed(1).replace(/\.0$/, '') + 'm';
  return (ms / 1000).toFixed(ms < 10000 ? 2 : 1).replace(/\.?0+$/, '') + 's';
}
