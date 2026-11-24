// Small UI helpers shared by every view.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const ICON = (f) => (f ? `icons/${f}` : 'icons/Icons_missing_artwork.webp');
export const img = (f, alt = '', size = 24) => `<img src="${ICON(f)}" alt="${esc(alt)}" width="${size}" height="${size}" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'">`;
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export const svg = {
  search: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  chev: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  arrow: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  lock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  shield: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
  paste: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>',
  check: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  q: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/></svg>',
  x: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  bolt: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  target: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>',
  up: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>',
  spark: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z"/></svg>',
  cmd: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/></svg>',
};

export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2800);
}

export function relTime(d) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86400);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

// ---------------------------------------------------------------- bonus text
const NICE = {
  DoubleDamageChance: 'double-damage chance',
  DoublingChance: 'chance to double items',
  PreservationChance: 'chance to keep ingredients',
  PreservationChanceOnFail: 'chance to keep ingredients on a fail',
  SkipStepChance: 'chance to skip a step',
  SkipStageChance: 'chance to skip a stage',
  InstantCutChance: 'instant-fell chance',
  WeakSpotChance: 'weak-spot chance',
  PercentIncreaseRockBreakChance: 'rock break chance',
  FlatMinimumProspecting: 'starting prospect',
  AdditionalProductQuantityChance: 'chance of +1 ore',
  ShatterChance: 'shatter chance (3× ore)',
  FlatProficiency: 'cooking proficiency',
  FlatDifficulty: 'recipe difficulty',
  FlatStealth: 'stealth',
  PercentStealth: 'stealth',
  FlatPerception: 'target perception',
  PercentPerception: 'target perception',
  StunAvoidanceChance: 'chance to avoid stuns',
  FlatFortune: 'fortune (loot quantity)',
  FlatFortuneUnderSuccess: 'fortune while success < 100%',
  PercentCurrencyReward: 'gold per steal',
  FlatCurrencyReward: 'gold per steal',
  PercentCurrencyLootChance: 'gold drop chance',
  PercentCommonLootChance: 'common loot chance',
  PercentRareLootChance: 'rare loot chance',
  PercentXPGained: 'XP',
  FlatXPGained: 'XP per action',
  FlatFishChance: 'fish chance (less junk)',
  IncreasedFishChance: 'fish chance (less junk)',
  JunkRerollChance: 'junk reroll chance',
  IncreasedSpecialProductChance: 'special catch chance',
  FlatSpecialProductChance: 'special catch chance',
  SecondSpecialItemChance: 'second special catch chance',
  FlatMinInterval: 'minimum catch time',
  FlatMaxInterval: 'maximum catch time',
  PercentMinInterval: 'minimum catch time',
  PercentMaxInterval: 'maximum catch time',
  FlatInterval: 'action time',
  PercentInterval: 'action time',
  PercentHeatingInterval: 'heating time',
  PercentPreparingInterval: 'preparing time',
  PercentStirringInterval: 'stirring time',
  PercentBottlingInterval: 'bottling time',
  FlatProductQuantity: 'items per action',
  PercentProductQuantity: 'items per action',
  PercentIngredientCost: 'ingredient cost',
  FlatSteps: 'steps per craft',
  FlatOnHitItemChance: 'chance per hit',
  PercentOnHitItemChance: 'chance per hit',
  FlatOnCutItemChance: 'chance per log',
  FlatMaxHealth: 'tree health',
  PercentMaxHealth: 'tree health',
  StoneItemChance: 'stone chance per swing',
  EssenceItemChance: 'essence chance per swing',
  BarItemChance: 'free bar chance',
  FlatProductChance: 'by-product chance',
  IncreasedProductChance: 'by-product chance',
  FlatStunInterval: 'stun time',
  PercentStunInterval: 'stun time',
  FlatMaxStacks: 'bank slots',
};

function words(name) {
  return name.replace(/^(Flat|Percent|Increased)/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/** Turn one [statsType, name, value, ctx] bonus into readable text. */
export function bonusText([st, name, v, ctx], lookup) {
  const label = NICE[name] || words(name);
  const isPct = /Chance|^Percent|^Increased|PercentXP/.test(name) && !/^Flat(Fortune|Stealth|Perception)/.test(name);
  const isMs = /Interval$/.test(name) && name.startsWith('Flat');
  let val;
  if (isMs) val = `${v > 0 ? '+' : '−'}${(Math.abs(v) / 1000).toFixed(Math.abs(v) % 1000 ? 2 : 0).replace(/\.?0+$/, '')}s`;
  else if (isPct) {
    const p = Math.abs(v * 100);
    val = `${v > 0 ? '+' : '−'}${p < 0.1 ? p.toFixed(3).replace(/0+$/, '') : p < 1 ? p.toFixed(2).replace(/0+$/, '') : +p.toFixed(1)}%`;
  } else val = `${v > 0 ? '+' : '−'}${Math.abs(v).toLocaleString('en-US')}`;
  const where = [];
  if (ctx?.it && lookup?.item) where.push(lookup.item(ctx.it));
  if (ctx?.cat && lookup?.cat) where.push(lookup.cat(ctx.cat));
  if (ctx?.r && lookup?.recipe) where.push(lookup.recipe(ctx.r, ctx.e));
  if (ctx?.loc) where.push(ctx.loc.replace(/([a-z])([A-Z])/g, '$1 $2'));
  const good = /Interval|Difficulty|Perception|IngredientCost|MaxHealth|Stun/.test(name) && !/Avoid/.test(name) ? v < 0 : v > 0;
  return { val, label, where: where.filter(Boolean).join(', '), good, skill: ctx?.e, cond: !!ctx?.x };
}

export function countUp(root = document) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  root.querySelectorAll('[data-count]').forEach((el) => {
    const target = Number(el.dataset.count);
    const fmt = el.dataset.fmt === 'num' ? (n) => Math.round(n).toLocaleString('en-US') : window.__fmtGp;
    if (!Number.isFinite(target) || target <= 0 || !fmt) return;
    const t0 = performance.now(), dur = 900;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      el.textContent = fmt(target * (1 - Math.pow(1 - p, 4)));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
