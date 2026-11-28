// Combat model: mirrors CharacterStats / TargetCharacterStats / CharacterComponent from the game.
//  accuracy/evasion = floor((levelRatio + 9) * (stanceStat + 64))
//  hit chance       = acc >= eva ? 1 - eva / (2 acc) : acc / (2 eva)
//  max hit (melee/ranged) = floor(22 + L + (L + 17) * strengthBonus / 64)
//  max hit (magic)        = floor(spellMaxHit * (1 + damageBonus) * (1 + (L + 1) / 200))
//  final max hit          = floor(base * (1 + element bonus) * (1 + combat triangle))
//  damage roll uniform in [1, maxHit], reduced by resistance = clamp(prot / (pow + prot), 0, 0.7), then armour, min 1
//  your resistance is also scaled by the combat triangle; enemies respawn after 3 s; HP = Hitpoints level x 10.

export const SPAWN_MS = 3000;
export const STYLES = ['Melee', 'Ranged', 'Magic'];
const COMBAT_LEVELS = ['Hitpoints', 'Attack', 'Strength', 'Defence', 'Ranged', 'Magic'];
const ARMOUR_SLOTS = ['Torso', 'Legs', 'Helmet', 'Offhand', 'Boots', 'Gloves', 'Amulet', 'Cape', 'RingSlot1', 'RingSlot2'];
const SLOT_TYPE = { RingSlot1: 'Ring', RingSlot2: 'Ring' };

const ratio = (list, lv) => list.reduce((a, [k, r]) => a + (lv[k] ?? 1) * r, 0);

export function combatLevels(save, override = {}) {
  const lv = {};
  for (const k of COMBAT_LEVELS) lv[k] = override[k] ?? save.skills?.[k]?.level ?? (k === 'Hitpoints' ? 10 : 1);
  return lv;
}

/** A fighter from an explicit loadout: { slot: item } plus an optional spell. */
export function makeFighter(g, lv, gear, spell = null) {
  const C = g.combat;
  const st = {};
  let pow = 0, prot = 0;
  // bonuses worn gear gives (always-on ones; slayer-task-only bonuses are left out)
  const mods = { maxHit: {}, minHitPct: 0, minHit: {}, intervalPct: 0, intervalFlat: 0, evaPct: 0, protPct: 0, powStyle: {}, lootDouble: 0, coinDouble: 0, coinPct: 0, ammoPres: 0, runePres: 0, runeCost: {} };
  const styleKey = (c) => c.style || '*';
  for (const item of Object.values(gear)) {
    const e = item && g.items[item]?.eq;
    if (!e) continue;
    for (const [k, v] of Object.entries(e.st)) st[k] = (st[k] || 0) + v;
    pow += e.pow; prot += e.prot;
    for (const [n, v, c] of e.b || []) {
      if (c.cond || c.effect) continue;
      if (n === 'PercentMaxHit') mods.maxHit[styleKey(c)] = (mods.maxHit[styleKey(c)] || 0) + v;
      else if (n === 'MinHitBasedOnMaxHit') mods.minHitPct += v;
      else if (n === 'FlatMinHit') mods.minHit[styleKey(c)] = (mods.minHit[styleKey(c)] || 0) + v;
      else if (n === 'PercentAttackInterval') mods.intervalPct += v;
      else if (n === 'FlatAttackInterval') mods.intervalFlat += v;
      else if (n === 'PercentEvasionRating') mods.evaPct += v;
      else if (n === 'PercentProtectionRating') mods.protPct += v;
      else if (n === 'FlatProtectionRating') prot += v;
      else if (n === 'FlatPowerRating') { if (c.style) mods.powStyle[c.style] = (mods.powStyle[c.style] || 0) + v; else pow += v; }
      else if (n === 'FlatCombatStatValue' && c.stat) st[c.stat] = (st[c.stat] || 0) + v;
      else if (n === 'ItemDoublingChance') mods.lootDouble += v;
      else if (n === 'CurrencyDoublingChance') mods.coinDouble += v;
      else if (n === 'PercentRewardCurrency') mods.coinPct += v;
      else if (n === 'AmmoPreservationChance' && !c.ammo) mods.ammoPres += v;
      else if (n === 'RunePreservationChance') mods.runePres += v;
      else if (n === 'FlatRuneCost' && c.rune) mods.runeCost[c.rune] = (mods.runeCost[c.rune] || 0) + v;
    }
  }
  prot = Math.floor(prot * (1 + mods.protPct));
  const weapon = gear.Weapon || null;
  const wp = g.items[weapon]?.wp;
  const stances = C.weapons[wp?.type || 'Melee'] || C.weapons.Melee || ['Stab'];
  const style = C.stances[stances[0]]?.style || 'Melee';
  let el = (wp?.el || []).find((x) => x !== 'Neutral') || 'Neutral';
  if (style === 'Magic' && spell) {
    for (const [k, v] of Object.entries(C.spells[spell].st)) st[k] = (st[k] || 0) + v;
    el = C.spells[spell].el || el;
  }
  pow += mods.powStyle[style] || 0;
  const interval = Math.max(500, Math.floor(((st.AttackInterval || 3000) + mods.intervalFlat) * (1 + mods.intervalPct)));
  return { lv, st, pow: Math.max(1, pow), prot, stances, style, el, interval, hp: lv.Hitpoints * 10, weapon, gear, spell, ammo: gear.Ammo || null, mods };
}

/** The fighter you saved with (equipped gear, no spell selection). */
export function playerFighter(g, save) {
  const gear = Object.fromEntries(Object.entries(save.equipment || {}).map(([slot, x]) => [slot, x.item]));
  return makeFighter(g, combatLevels(save), gear);
}

export function enemyFighter(e) {
  return { lv: e.lv, st: e.st, pow: Math.max(1, e.pow), prot: e.prot, stances: e.stances, interval: e.st.AttackInterval || 3000, hp: (e.lv.Hitpoints ?? 1) * 10, el: e.el || 'Neutral', atk: e.atk || [] };
}

function rating(C, f, stance, kind) {
  const s = C.stances[stance];
  const style = C.styles[s.style];
  const r = Math.max(1, Math.floor((ratio(kind === 'acc' ? style.acc : style.eva, f.lv) + 9) * ((f.st[kind === 'acc' ? s.acc : s.eva] || 0) + 64)));
  return kind === 'eva' && f.mods?.evaPct ? Math.floor(r * (1 + f.mods.evaPct)) : r;
}

export function maxHit(C, f, style) {
  const m = C.styles[style].max;
  const L = ratio(m.lv, f.lv);
  if (m.t === 'StrengthBonus') return Math.max(1, Math.floor(22 + L + (L + 17) * (f.st[m.str] || 0) / 64));
  return Math.floor((f.st[m.stat] || 0) * (1 + (f.st[m.dmg] || 0)) * (1 + (L + 1) / 200));
}

export const hitChance = (acc, eva) => Math.min(1, Math.max(0, acc >= eva ? 1 - eva / 2 / acc : acc / 2 / eva));
export const resistance = (pow, prot) => Math.min(0.7, Math.max(0, prot / (pow + prot)));

/** Expected damage of a uniform [1, max] roll after resistance and armour (min 1). */
function avgDamage(max, res, armour = 0, min = 1) {
  if (max <= 0) return 0;
  const lo = Math.max(1, Math.min(min, max));
  if (max - lo > 300) return Math.max(1, ((lo + max) / 2) * (1 - res) - armour);
  let s = 0;
  for (let d = lo; d <= max; d++) s += Math.max(1, Math.floor(d * (1 - res)) - armour);
  return s / (max - lo + 1);
}

const enemyStyle = (C, enemy) => C.stances[enemy.stances[0]?.[0]]?.style || 'Melee';

/** One player-vs-enemy matchup: best stance (or `only`), kill time, damage taken, XP and danger. */
export function fight(C, player, enemy, only = null) {
  const eStyle = enemyStyle(C, enemy);
  const tri = C.triangle?.[player.style + '|' + eStyle] || {};
  const elem = C.elements?.[player.el + '|' + enemy.el] || 0;
  let best = null;
  for (const stance of only ? [only] : player.stances) {
    const s = C.stances[stance];
    if (!s) continue;
    const base = maxHit(C, player, s.style);
    if (base <= 0) continue;
    const pm = player.mods || {};
    const mh = Math.max(1, Math.floor(base * (1 + (pm.maxHit?.['*'] || 0) + (pm.maxHit?.[s.style] || 0)) * (1 + elem) * (1 + (tri.MaxHitCombatTriangle || 0))));
    const minHit = Math.min(mh, Math.max(1, Math.floor(mh * (pm.minHitPct || 0)) + (pm.minHit?.['*'] || 0) + (pm.minHit?.[s.style] || 0)));
    const hc = hitChance(rating(C, player, stance, 'acc'), rating(C, enemy, stance, 'eva'));
    const dmg = avgDamage(mh, resistance(player.pow, enemy.prot), enemy.st.Armour || 0, minHit);
    const dps = (hc * dmg) / player.interval;
    if (!best || dps > best.dps) best = { stance, style: s.style, hc, mh, dmg, dps };
  }
  if (!best || best.dps <= 0) return null;
  const aliveMs = enemy.hp / best.dps;
  const tot = enemy.stances.reduce((a, [, w]) => a + w, 0) || 1;
  const res = Math.min(1, Math.max(0, resistance(enemy.pow, player.prot) * (1 + (tri.ResistanceCombatTriangle || 0))));
  let inMs = 0, enemyMax = 0, specialShare = 0;
  const arm = player.st.Armour || 0;
  const specChance = Math.min(1, (enemy.atk || []).reduce((a, [c]) => a + c, 0));
  for (const [stance, w] of enemy.stances) {
    const s = C.stances[stance];
    if (!s) continue;
    const mh = maxHit(C, enemy, s.style);
    const hc = hitChance(rating(C, enemy, stance, 'acc'), rating(C, player, stance, 'eva'));
    const normal = hc * avgDamage(mh, res, arm);
    let turn = (1 - specChance) * normal;
    let burst = Math.max(1, Math.floor(mh * (1 - res)) - arm);
    // special attacks: each hit is a share of a normal roll or of max hit; damage over time comes from max hit, after the hit lands
    for (const [c, a] of enemy.atk || []) {
      const land = a.av ? hc : 1;
      let dmg = 0, top = 0;
      for (const [n, kind, pct] of a.hits) {
        if (kind === 'hp' || pct <= 0) continue;
        const per = kind === 'm' ? Math.max(1, Math.floor(mh * pct * (1 - res)) - arm) : avgDamage(Math.floor(mh * pct), res, arm);
        dmg += n * land * per;
        top += n * (kind === 'm' ? per : Math.max(1, Math.floor(mh * pct * (1 - res)) - arm));
      }
      dmg += land * a.dot * mh;
      turn += c * dmg;
      specialShare += (w / tot) * c * dmg;
      burst = Math.max(burst, top);
    }
    inMs += (w / tot) * turn / enemy.interval;
    enemyMax = Math.max(enemyMax, burst);
  }
  const xp = (C.stances[best.stance].xp || []).map(([sk, per]) => [sk, per * enemy.hp]);
  return {
    ...best, aliveMs, killMs: aliveMs + SPAWN_MS, takenPerKill: inMs * aliveMs, enemyMax, danger: enemyMax / player.hp,
    attacks: aliveMs / player.interval, xp, triangle: tri.MaxHitCombatTriangle || 0, element: elem, enemyStyle: eStyle,
    specials: (enemy.atk || []).length, specialShare: inMs > 0 ? (specialShare / enemy.interval) / inMs : 0,
  };
}

/** Expected drops per kill: [[item, qty]], gold. */
export function dropsPerKill(e) {
  const out = new Map();
  const add = (it, q) => out.set(it, (out.get(it) || 0) + q);
  for (const [it, lo, hi] of e.drops.fixed) add(it, (lo + hi) / 2);
  for (const t of e.drops.tables) {
    const tot = t.rows.reduce((a, r) => a + r[1], 0) || 1;
    for (const [it, w, lo, hi] of t.rows) add(it, t.ch * (w / tot) * (lo + hi) / 2);
  }
  const gp = e.drops.gp ? (e.drops.gp[0] + e.drops.gp[1]) / 2 : 0;
  return { items: [...out.entries()], gp };
}

/** Which save slot an equipment type goes in (rings fill the free ring slot first). */
export function SLOT_OF(type, eq = {}) {
  if (type === 'Ring') return !eq.RingSlot1 ? 'RingSlot1' : !eq.RingSlot2 ? 'RingSlot2' : 'RingSlot1';
  return ['Helmet', 'Cape', 'Amulet', 'Ammo', 'Weapon', 'Torso', 'Offhand', 'Legs', 'Gloves', 'Boots'].includes(type) ? type : null;
}

/**
 * Everything you could fight with: equipped gear plus equipment in your bank (and any `extra`
 * items), filtered by `ok(item)` (equip requirements), and the spells you can cast.
 */
export function gearPool(g, save, ok, extra = [], spellOk = () => true) {
  const C = g.combat;
  const ids = new Set([...Object.values(save.equipment || {}).map((x) => x.item), ...Object.keys(save.bank || {}), ...extra]);
  const byType = {};
  const weapons = { Melee: [], Ranged: [], Magic: [] };
  for (const id of ids) {
    const e = g.items[id]?.eq;
    if (!e || !ok(id)) continue;
    if (e.slot === 'Weapon') {
      const stances = C.weapons[g.items[id].wp?.type] || [];
      const style = C.stances[stances[0]]?.style;
      if (style) weapons[style].push(id);
    } else (byType[e.slot] ||= []).push(id);
  }
  if (!weapons.Melee.length) weapons.Melee.push(null); // fists
  const spells = Object.entries(C.spells || {}).filter(([, sp]) => sp.book === 'StandardSpells' && spellOk(sp)).map(([id]) => id);
  return { byType, weapons, spells };
}

function weaponScore(g, id) {
  const st = g.items[id]?.eq?.st || {};
  const acc = Math.max(0, ...Object.entries(st).filter(([k]) => /AttackBonus$/.test(k)).map(([, v]) => v));
  const str = (st.MeleeStrengthBonus || 0) + (st.RangedStrengthBonus || 0) + (st.MagicDamageBonus || 0) * 100;
  return ((64 + acc) * (64 + str)) / (st.AttackInterval || 3000);
}

/**
 * Best loadout against one enemy for an objective. `score(f, fighter)` returns a number
 * (higher is better) or null when the fight isn't viable. Tries every style; per style the top
 * weapons (with matching ammo or spells), then improves each armour slot in turn.
 */
export function bestLoadout(g, pool, lv, enemy, score, startGear = {}, weaponOk = null) {
  const C = g.combat;
  const evalF = (gear, spell) => {
    const p = makeFighter(g, lv, gear, spell);
    const f = fight(C, p, enemy);
    if (!f) return { s: -Infinity, f: null, p };
    const v = score(f, p);
    // not viable (too dangerous / too slow): rank by how close it is, so armour can still fix it
    // (whichever of danger or kill time is further over its limit, so both can be fixed)
    return { s: v == null ? -1e12 - Math.max(f.danger / 0.9, f.killMs / 1200000) * 1e9 : v, ok: v != null, f, p };
  };
  let best = null;
  for (const style of STYLES) {
    let weapons = (pool.weapons[style] || []).filter((w) => !weaponOk || weaponOk(w));
    if (!weapons.length) continue;
    weapons = weapons.slice().sort((a, b) => weaponScore(g, b) - weaponScore(g, a)).slice(0, 3);
    for (const w of weapons) {
      const wp = g.items[w]?.wp;
      const gear = {};
      for (const slot of ARMOUR_SLOTS) if (startGear[slot] && (pool.byType[SLOT_TYPE[slot] || slot] || []).includes(startGear[slot])) gear[slot] = startGear[slot];
      if (w) gear.Weapon = w;
      const occ = g.items[w]?.eq?.occ || [];
      for (const o of occ) delete gear[o];
      if (wp?.ammo) {
        const ammo = (pool.byType.Ammo || []).filter((a) => g.items[a].eq.ammo === wp.ammo)
          .sort((a, b) => (g.items[b].eq.st.RangedStrengthBonus || 0) - (g.items[a].eq.st.RangedStrengthBonus || 0))[0];
        if (!ammo) continue;
        gear.Ammo = ammo;
      }
      let spells = [null];
      if (style === 'Magic') {
        spells = pool.spells.slice().sort((a, b) => {
          const ea = C.elements?.[C.spells[a].el + '|' + enemy.el] || 0, eb = C.elements?.[C.spells[b].el + '|' + enemy.el] || 0;
          return (C.spells[b].st.SpellMaxHit || 0) * (1 + eb) - (C.spells[a].st.SpellMaxHit || 0) * (1 + ea);
        }).slice(0, 2);
        if (!spells.length) continue;
      }
      for (const spell of spells) {
        let cur = evalF(gear, spell);
        for (let pass = 0; pass < 2; pass++) {
          let changed = false;
          for (const slot of ARMOUR_SLOTS) {
            if (occ.includes(slot)) continue;
            const cands = (pool.byType[SLOT_TYPE[slot] || slot] || []).filter((it) => !Object.entries(gear).some(([s2, x]) => s2 !== slot && x === it));
            for (const it of [undefined, ...cands]) {
              if (gear[slot] === it) continue;
              const g2 = { ...gear };
              if (it === undefined) delete g2[slot]; else g2[slot] = it;
              const r = evalF(g2, spell);
              if (r.s > cur.s + 1e-9) { cur = r; gear[slot] = it; if (it === undefined) delete gear[slot]; changed = true; }
            }
          }
          if (!changed) break;
        }
        if (cur.f && (!best || cur.s > best.s)) best = { ...cur, style, gear: { ...gear }, spell };
      }
    }
  }
  return best && best.ok ? best : null;
}
