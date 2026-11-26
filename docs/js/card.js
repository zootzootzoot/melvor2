// Shareable profile card: a 1200×630 PNG drawn on a canvas, in the site's own palette and fonts.
const W = 1200, H = 630;
const C = {
  ink0: '#0a0b10', ink1: '#101219', ink2: '#161923', line: 'rgba(255,226,170,0.10)', lineStrong: 'rgba(255,226,170,0.2)',
  text: '#ece6d8', text2: '#b9b2a3', text3: '#837d70', gold1: '#ffe3a1', gold2: '#f3c463', gold3: '#d6952c', green: '#7fe0a8',
};
const DISPLAY = '"Fraunces", Georgia, serif';
const SANS = '"Inter", system-ui, "Segoe UI", sans-serif';

function loadImg(src) {
  return new Promise((res) => {
    if (!src) return res(null);
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = 'icons/' + src;
  });
}

function rr(x, ctx, a, b, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(a + r, b); ctx.arcTo(a + w, b, a + w, b + h, r); ctx.arcTo(a + w, b + h, a, b + h, r);
  ctx.arcTo(a, b + h, a, b, r); ctx.arcTo(a, b, a + w, b, r); ctx.closePath();
}

function fit(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

/**
 * data: { name, mode, totalLevel, bank, gold, best: {name, gph, icon}, scratch: {name, gph}, farm, quests,
 *         skills: [{k, level, icon}], next: string, url, fmtGp }
 */
export async function drawCard(canvas, d) {
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  try { await Promise.all([document.fonts.load(`800 72px ${DISPLAY}`), document.fonts.load(`600 20px ${SANS}`), document.fonts.load(`700 20px ${SANS}`)]); } catch { /* system fonts */ }
  const icons = await Promise.all([d.best?.icon, ...d.skills.map((s) => s.icon), d.goldIcon].map(loadImg));
  const bestIcon = icons[0], skillIcons = icons.slice(1, 1 + d.skills.length), goldIcon = icons[icons.length - 1];

  // background
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, C.ink1); bg.addColorStop(1, C.ink0);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.82, -40, 20, W * 0.82, -40, 620);
  glow.addColorStop(0, 'rgba(243,196,99,0.20)'); glow.addColorStop(1, 'rgba(243,196,99,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  const glow2 = ctx.createRadialGradient(-60, H + 60, 10, -60, H + 60, 520);
  glow2.addColorStop(0, 'rgba(127,224,168,0.07)'); glow2.addColorStop(1, 'rgba(127,224,168,0)');
  ctx.fillStyle = glow2; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = C.lineStrong; ctx.lineWidth = 2; rr(0, ctx, 1, 1, W - 2, H - 2, 28); ctx.stroke();

  // brand
  if (goldIcon) ctx.drawImage(goldIcon, 56, 46, 30, 30);
  ctx.font = `650 24px ${DISPLAY}`; ctx.fillStyle = C.text; ctx.textBaseline = 'middle';
  ctx.fillText('Melvor', 96, 62);
  const mw = ctx.measureText('Melvor ').width;
  ctx.font = `italic 650 24px ${DISPLAY}`; ctx.fillStyle = C.gold2; ctx.fillText('Ledger', 96 + mw, 62);

  // eyebrow + name
  ctx.font = `600 15px ${SANS}`; ctx.fillStyle = C.gold2;
  ctx.fillText('LEDGER OF', 82, 128);
  ctx.fillRect(56, 127, 18, 2);
  ctx.font = `800 78px ${DISPLAY}`; ctx.fillStyle = C.text; ctx.textBaseline = 'alphabetic';
  ctx.fillText(fit(ctx, d.name, 560), 54, 214);

  // pills
  let px = 56;
  const pill = (txt, gold) => {
    ctx.font = `600 16px ${SANS}`;
    const w = ctx.measureText(txt).width + 28;
    rr(0, ctx, px, 240, w, 34, 17);
    ctx.fillStyle = gold ? 'rgba(243,196,99,0.14)' : 'rgba(255,255,255,0.05)'; ctx.fill();
    ctx.strokeStyle = gold ? 'rgba(243,196,99,0.35)' : C.line; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = gold ? C.gold1 : C.text2; ctx.textBaseline = 'middle'; ctx.fillText(txt, px + 14, 257);
    px += w + 10;
  };
  pill(`Total level ${d.totalLevel.toLocaleString('en-US')}`, true);
  if (d.mode) pill(d.mode);
  if (d.quests) pill(`${d.quests} quests done`);

  // stat tiles (right)
  const tiles = [
    ['BEST RIGHT NOW', d.best ? d.fmtGp(d.best.gph) : '—', d.best ? `gp/hr · ${d.best.name}` : '', true],
    ['BANK VALUE', d.fmtGp(d.bank), `${d.fmtGp(d.gold)} gold in wallet`],
    ['FARM', d.farm > 0 ? d.fmtGp(d.farm) : '—', d.farm > 0 ? 'gp/hr on the best crops' : 'no plots yet'],
  ];
  const tx = 680, tw = 464, th = 92;
  tiles.forEach(([label, value, sub, hero], i) => {
    const y = 92 + i * (th + 12);
    rr(0, ctx, tx, y, tw, th, 18);
    const tg = ctx.createLinearGradient(tx, y, tx + tw, y + th);
    tg.addColorStop(0, hero ? 'rgba(243,196,99,0.16)' : 'rgba(255,255,255,0.045)'); tg.addColorStop(1, 'rgba(255,255,255,0.02)');
    ctx.fillStyle = tg; ctx.fill();
    ctx.strokeStyle = hero ? 'rgba(243,196,99,0.4)' : C.line; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.textBaseline = 'alphabetic';
    ctx.font = `700 13px ${SANS}`; ctx.fillStyle = hero ? C.gold2 : C.text3; ctx.fillText(label, tx + 22, y + 30);
    ctx.font = `800 40px ${DISPLAY}`; ctx.fillStyle = hero ? C.gold1 : C.text; ctx.fillText(value, tx + 22, y + 74);
    const vw = ctx.measureText(value).width;
    ctx.font = `500 16px ${SANS}`; ctx.fillStyle = C.text2; ctx.fillText(fit(ctx, sub, tw - vw - 60), tx + 36 + vw, y + 72);
    if (hero && bestIcon) ctx.drawImage(bestIcon, tx + tw - 58, y + 18, 40, 40);
  });

  // next step
  if (d.next) {
    ctx.font = `600 15px ${SANS}`; ctx.fillStyle = C.text3; ctx.textBaseline = 'alphabetic';
    ctx.fillText('NEXT ON THE ROUTE', 56, 318);
    ctx.font = `600 22px ${SANS}`; ctx.fillStyle = C.text;
    ctx.fillText(fit(ctx, d.next, 590), 56, 350);
  }

  // skills grid
  const cols = 10, sx = 56, sy = 412, cw = 108.8, ch = 82;
  d.skills.slice(0, 20).forEach((s, i) => {
    const x = sx + (i % cols) * cw, y = sy + Math.floor(i / cols) * (ch + 8);
    rr(0, ctx, x, y, cw - 8, ch, 14);
    ctx.fillStyle = 'rgba(255,255,255,0.035)'; ctx.fill();
    ctx.strokeStyle = s.level >= 99 ? 'rgba(243,196,99,0.5)' : C.line; ctx.lineWidth = 1; ctx.stroke();
    if (skillIcons[i]) ctx.drawImage(skillIcons[i], x + 12, y + 14, 30, 30);
    ctx.font = `800 26px ${DISPLAY}`; ctx.fillStyle = s.level >= 99 ? C.gold1 : C.text; ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'right'; ctx.fillText(String(s.level), x + cw - 20, y + 40); ctx.textAlign = 'left';
    ctx.font = `500 12px ${SANS}`; ctx.fillStyle = C.text3; ctx.fillText(fit(ctx, s.k, cw - 30), x + 12, y + 66);
  });

  // footer
  ctx.font = `500 14px ${SANS}`; ctx.fillStyle = C.text3; ctx.textBaseline = 'alphabetic';
  ctx.fillText(d.url.replace(/^https?:\/\//, '').replace(/\/$/, ''), 56, H - 22);
  ctx.textAlign = 'right'; ctx.fillText(`Saved ${d.saved}`, W - 56, H - 22); ctx.textAlign = 'left';
  return canvas;
}
