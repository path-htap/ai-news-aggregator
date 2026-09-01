import fs from 'fs';
import path from 'path';
import { createHmac } from 'crypto';

const DIR = 'D:\\app\\myfirstproject\\aizixun';
const WEBHOOK = process.env.FEISHU_WEBHOOK_URL || 'https://open.feishu.cn/open-apis/bot/v2/hook/c384f885-e3f2-4bf1-87cf-37e98dae9a84';
const SECRET = process.env.FEISHU_WEBHOOK_SECRET || 'aYCj6hgcQRUaQUKz0jpPse';
const DRY = process.env.DRY_RUN !== '0';   // default dry-run
const N = Number(process.env.TOP_N || 12);

function extractItems(raw) {
  if (Array.isArray(raw)) return raw;
  // prefer an array whose elements look like news items
  let best = null;
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    if (!Array.isArray(v)) continue;
    if (v.length && (v[0].title !== undefined || v[0].url !== undefined)) return v; // news items
    if (!best) best = v;
  }
  return best || [];
}

function readItems(file) {
  try {
    return extractItems(JSON.parse(fs.readFileSync(path.join(DIR, 'data', file), 'utf8')));
  } catch (e) { console.error('read fail', file, e.message); return []; }
}

function buildReport(max) {
  const push = []; const seen = new Set();
  const add = (file, site, limit) => {
    for (const it of readItems(file)) {
      const title = it.title_zh || it.title_bilingual || it.title || it.title_en;
      if (!title) continue;
      const key = it.url || title;
      if (seen.has(key)) continue;
      seen.add(key);
      push.push({ ...it, title, site });
      if (push.length >= max) break;
    }
  };
  add('latest-24h.json', '24h', max);
  if (push.length < max) add('latest-7d.json', '本周', max);
  return push;
}

function sign(secret) {
  const ts = Math.floor(Date.now() / 1000);
  const s = createHmac('sha256', `${ts}\n${secret}`).digest('base64');
  return { timestamp: ts, sign: s };
}

function clean(t) { return (t || '').replace(/[*_`#>\[\]]/g, '').trim(); }
function clip(s, n = 70) { return s.length > n ? s.slice(0, n) + '…' : s; }

async function run() {
  const items = buildReport(N);
  if (!items.length) { console.log('NO_ITEMS_READ'); process.exit(0); }
  console.log('ITEMS=' + items.length);
  items.slice(0, 6).forEach((it, i) => console.log('#' + (i + 1) + ' [' + it.site + '] ' + clip(clean(it.title), 50)));

  const lines = items.map((it, i) =>
    `**${i + 1}. ${clip(clean(it.title), 80)}**\n来源: ${it.site || it.source || it.site_name || ''}`
  ).join('\n\n');

  const body = {
    msg_type: 'interactive',
    card: {
      header: { title: { tag: 'plain_text', content: '🤖 AI 资讯日报' }, template: 'blue' },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: `**今日 AI 精选（${items.length} 条）**` } },
        { tag: 'hr' },
        { tag: 'div', text: { tag: 'lark_md', content: lines.slice(0, 1800) } },
      ],
    },
  };
  if (!DRY) Object.assign(body, sign(SECRET));
  if (DRY) { console.log('DRY_RUN: would send card with', items.length, 'items'); process.exit(0); }

  const res = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const txt = await res.text();
  console.log('STATUS', res.status);
  console.log(txt);
}

run().catch(e => { console.error('ERR', e.message); process.exit(1); });
