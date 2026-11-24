// Smoke test: node tools/test/engine.test.mjs <path to .sav or base64 text>
import fs from 'fs';
import { decodeSave, initBrotliSync } from '../../docs/js/save.js';
import { Engine, fmtGp, fmtDuration } from '../../docs/js/engine.js';
initBrotliSync(fs.readFileSync(new URL('../../docs/js/vendor/brotli_dec_wasm_bg.wasm', import.meta.url)));
const game = JSON.parse(fs.readFileSync(new URL('../../docs/data/game.json', import.meta.url)));
const file = process.argv[2];
const buf = fs.readFileSync(file);
const save = await decodeSave(file.endsWith('.txt') ? buf.toString('utf8') : buf);
console.log(save.header.name, Object.keys(save.bank).length, 'bank items', Object.keys(save.tools));
const e = new Engine(game);
let t = performance.now();
e.setPlayer(save);
console.log('unlocked methods', e.unlockedMethods().length, 'bank value', fmtGp(e.bankValue().total), 'bonus sources', e.sources.length);
const line = (x) => `${fmtGp(x.gph).padStart(8)}/hr ${fmtGp(x.xph).padStart(7)}xp  ${x.m.s.padEnd(12)} ${x.m.n}${x.src ? ' [' + x.src + ']' : ''}${x.bank ? '  lasts ' + fmtDuration(x.bank.hours) + ' total ' + fmtGp(x.bank.total) : ''}`;
for (const mode of ['best', 'chain', 'sell', 'bank']) {
  console.log('\n==', mode);
  for (const x of e.ranked(mode).slice(0, 6)) console.log(line(x));
}
console.log('ranked ms', (performance.now() - t).toFixed(0));

// base vs modded for a few skills
const base = new Engine(game); base.setPlayer(save, { useMods: false });
console.log('\n== modifiers (base -> with upgrades)');
for (const id of ['Woodcutting:OakTree', 'Mining:IronOre', 'Fishing:Shrimp', 'Cooking:Chicken', 'Smithing:IronPlatelegs']) {
  const m = e.byId.get(id) || e.methods.find((mm) => mm.id.startsWith(id.split(':')[0]) && mm.rid.includes(id.split(':')[1].replace('Tree', '')));
  if (!m) { console.log('missing', id); continue; }
  const a = base.rate(m), b = e.rate(m);
  console.log(m.id.padEnd(28), 'ms', a.ms.toFixed(0), '->', b.ms.toFixed(0), ' out/hr', fmtGp(a.outValue), '->', fmtGp(b.outValue), ' xp/hr', fmtGp(a.xp), '->', fmtGp(b.xp), ' src', e.modSources(m).map((s) => s.src.n).join(', '));
}

console.log('\n== train Cooking'); for (const x of e.trainOptions('Cooking').slice(0, 4)) console.log(fmtGp(x.xph), 'xp/hr', fmtGp(x.gph), 'gp/hr', x.m.n);
t = performance.now();
const plan = e.planLevel('Mining', 50);
console.log('\n== plan Mining -> 50', fmtDuration(plan.hours), plan.segs.map((s) => `${s.m.n} ${s.fromLevel}-${s.toLevel} ${fmtDuration(s.hours)}`).join(' | '), (performance.now() - t).toFixed(0) + 'ms');
const p2 = e.planLevel('Smithing', 40);
console.log('== plan Smithing -> 40', fmtDuration(p2.hours), p2.segs.map((s) => `${s.m.n} ${s.fromLevel}-${s.toLevel}`).join(' | '), 'supplies', p2.supplies.map((s) => `${s.item}:${Math.round(s.qty)}/${s.have}`).join(' '));
t = performance.now();
const adv = e.upgradeAdvice();
console.log('\n== upgrades', adv.length, (performance.now() - t).toFixed(0) + 'ms');
for (const a of adv.slice(0, 10)) console.log(a.s.n.padEnd(28), a.skill.padEnd(12), 'cost', fmtGp(a.totalCost), 'dGp', fmtGp(a.dGp), 'dXp', (a.dXp * 100).toFixed(1) + '%', 'payback', fmtDuration(a.payback), a.gap ? 'needs +' + a.gap : '', a.affordable ? 'affordable' : '');
console.log('\n== upcoming'); for (const x of e.upcoming(5)) console.log(x.gap, x.m.s, x.m.n, fmtGp(x.gph));
console.log('\n== alchemy'); for (const x of e.alchemy().slice(0, 5)) console.log(x.item, x.qty, 'sell', fmtGp(x.sellNow), '->', x.m.n, fmtGp(x.uplift), fmtDuration(x.b.hours));
const info = e.itemInfo('IronBar');
console.log('\n== item IronBar sources', info.sources.slice(0, 3).map((s) => s.m.n), 'uses', info.uses.length);
