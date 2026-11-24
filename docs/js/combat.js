// Combat model: mirrors CharacterStats / TargetCharacterStats / CharacterComponent from the game.
//  accuracy/evasion = floor((levelRatio + 9) * (stanceStat + 64))
//  hit chance       = acc >= eva ? 1 - eva / (2 acc) : acc / (2 eva)
//  max hit (melee/ranged) = floor(22 + L + (L + 17) * strengthBonus / 64)
//  max hit (magic)        = floor(spellMaxHit * (1 + damageBonus) * (1 + (L + 1) / 200))
//  damage roll uniform in [1, maxHit], reduced by resistance = clamp(prot / (pow + prot), 0, 0.7), then armour, min 1
//  enemies respawn after 3 s; HP = Hitpoints level x 10.

export const SPAWN_MS = 3000;
const COMBAT_LEVELS = ['Hitpoints', 'Attack', 'Strength', 'Defence', 'Ranged', 'Magic'];

const ratio = (list, lv) => list.reduce((a, [k, r]) => a + (lv[k] ?? 1) * r, 0);

export function playerFighter(g, save) {
  const lv = {};
  for (const k of COMBAT_LEVELS) lv[k] = save.skills?.[k]?.level ?? (k === 'Hitpoints' ? 10 : 1);
  const st = {};
  let pow = 0, prot = 0;
  const eq = save.equipment || {};
  for (const { item } of Object.values(eq)) {
    const e = g.items[item]?.eq;
    if (!e) continue;
    for (const [k, v] of Object.entries(e.st)) st[k] = (st[k] || 0) + v;
    pow += e.pow; prot += e.prot;
  }
  const weapon = eq.Weapon?.item || null;
  const wtype = g.items[weapon]?.wp?.type || 'Melee';
  const stances = g.combat.weapons[wtype] || g.combat.weapons.Melee || ['Stab'];
  const ammoNeeded = g.items[weapon]?.wp?.ammo || null;
  const ammo = eq.Ammo?.item && g.items[eq.Ammo.item]?.eq?.ammo === ammoNeeded ? eq.Ammo.item : null;
  return { lv, st, pow: Math.max(1, pow), prot, stances, interval: st.AttackInterval || 3000, hp: lv.Hitpoints * 10, weapon, wtype, ammoNeeded, ammo, ammoQty: eq.Ammo?.qty || 0 };
}

export function enemyFighter(e) {
  return { lv: e.lv, st: e.st, pow: Math.max(1, e.pow), prot: e.prot, stances: e.stances, interval: e.st.AttackInterval || 3000, hp: (e.lv.Hitpoints ?? 1) * 10 };
}

function rating(C, f, stance, kind) {
  const s = C.stances[stance];
  const style = C.styles[s.style];
  return Math.max(1, Math.floor((ratio(kind === 'acc' ? style.acc : style.eva, f.lv) + 9) * ((f.st[kind === 'acc' ? s.acc : s.eva] || 0) + 64)));
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
function avgDamage(max, res, armour = 0) {
  if (max <= 0) return 0;
  if (max > 4000) return Math.max(1, ((1 + max) / 2) * (1 - res) - armour);
  let s = 0;
  for (let d = 1; d <= max; d++) s += Math.max(1, Math.floor(d * (1 - res)) - armour);
  return s / max;
}

/** One player-vs-enemy matchup: best stance, kill time, damage taken, XP and danger. */
export function fight(C, player, enemy) {
  let best = null;
  for (const stance of player.stances) {
    const s = C.stances[stance];
    if (!s) continue;
    const mh = maxHit(C, player, s.style);
    if (mh <= 0) continue;
    const hc = hitChance(rating(C, player, stance, 'acc'), rating(C, enemy, stance, 'eva'));
    const dmg = avgDamage(mh, resistance(player.pow, enemy.prot), enemy.st.Armour || 0);
    const dps = (hc * dmg) / player.interval;
    if (!best || dps > best.dps) best = { stance, style: s.style, hc, mh, dmg, dps };
  }
  if (!best || best.dps <= 0) return null;
  const aliveMs = enemy.hp / best.dps;
  // the enemy's attacks against you while it is alive
  const tot = enemy.stances.reduce((a, [, w]) => a + w, 0) || 1;
  let inMs = 0, enemyMax = 0;
  for (const [stance, w] of enemy.stances) {
    const s = C.stances[stance];
    if (!s) continue;
    const mh = maxHit(C, enemy, s.style);
    const res = resistance(enemy.pow, player.prot);
    const hc = hitChance(rating(C, enemy, stance, 'acc'), rating(C, player, stance, 'eva'));
    inMs += (w / tot) * hc * avgDamage(mh, res, player.st.Armour || 0) / enemy.interval;
    enemyMax = Math.max(enemyMax, Math.max(1, Math.floor(mh * (1 - res)) - (player.st.Armour || 0)));
  }
  const xp = (C.stances[best.stance].xp || []).map(([sk, per]) => [sk, per * enemy.hp]);
  return { ...best, aliveMs, killMs: aliveMs + SPAWN_MS, takenPerKill: inMs * aliveMs, enemyMax, danger: enemyMax / player.hp, attacks: aliveMs / player.interval, xp };
}

/** Expected drops per kill: [[item, qty]], gold, other currencies. */
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
