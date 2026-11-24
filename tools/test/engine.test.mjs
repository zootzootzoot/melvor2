// Smoke test: node tools/test/engine.test.mjs <path to .sav or base64 text>
import fs from 'fs';
import { initSync } from '../../docs/js/vendor/brotli_dec_wasm.js';
import { decodeSave } from '../../docs/js/save.js';
import { Engine, fmtGp, fmtDuration } from '../../docs/js/engine.js';
initSync({ module: fs.readFileSync(new URL('../../docs/js/vendor/brotli_dec_wasm_bg.wasm', import.meta.url)) });
const game = JSON.parse(fs.readFileSync(new URL('../../docs/data/game.json', import.meta.url)));
const file = process.argv[2];
const buf = fs.readFileSync(file);
const save = await decodeSave(file.endsWith('.txt') ? buf.toString('utf8') : buf);
console.log(save.header, Object.keys(save.bank).length, 'bank items', save.wallet, Object.keys(save.tools));
console.log(Object.fromEntries(Object.entries(save.skills).map(([k, v]) => [k, v.level])));
const e = new Engine(game); e.setPlayer(save);
console.log('unlocked methods', e.unlockedMethods().length, 'bank value', fmtGp(e.bankValue().total));
for (const mode of ['chain', 'sell', 'bank']) {
  console.log('\n==', mode);
  for (const x of e.ranked(mode).slice(0, 8)) console.log(`${fmtGp(x.gph).padStart(8)}/hr  ${x.m.s.padEnd(12)} ${x.m.n}${x.bank ? '  lasts ' + fmtDuration(x.bank.hours) + ' total ' + fmtGp(x.bank.total) : ''}${x.chain && x.chain.steps.length ? '  via ' + x.chain.steps.map(s => s.item + ':' + s.via.kind + (s.via.m ? '(' + s.via.m.n + ')' : '')).join(',') : ''}`);
}
console.log('\n== upcoming'); for (const x of e.upcoming(8)) console.log(x.gap, x.m.s, x.m.n, fmtGp(x.gph));
console.log('\n== alchemy'); for (const x of e.alchemy().slice(0, 8)) console.log(x.item, x.qty, 'sell', fmtGp(x.sellNow), '->', x.m.n, fmtGp(x.uplift), fmtDuration(x.b.hours));
