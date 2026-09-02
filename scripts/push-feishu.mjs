import fs from 'fs';
import path from 'path';
import { createHmac } from 'crypto';

// 当前工作目录作为项目根（本地=项目根，云端=repo 根）
const DIR = process.cwd();
const WEBHOOK = process.env.FEISHU_WEBHOOK_URL || 'https://open.feishu.cn/open-apis/bot/v2/hook/c384f885-e3f2-4bf1-87cf-37e98dae9a84';
const SECRET = process.env.FEISHU_WEBHOOK_SECRET || 'aYCj6hgcQRUaQUKz0jpPse';
const DRY = process.env.DRY_RUN !== '0';   // default dry-run

// 分类展示顺序
const CATEGORY_ORDER = ['模型与芯片', '公司动态', '产品与应用', '安全与合规', '研究与论文'];

function clean(t) { return (t || '').replace(/[*_`#>\[\]]/g, '').trim(); }
function clip(s, n = 120) { return s.length > n ? s.slice(0, n) + '…' : s; }

function sign(secret) {
  const ts = Math.floor(Date.now() / 1000);
  const s = createHmac('sha256', `${ts}\n${secret}`).digest('base64');
  return { timestamp: ts, sign: s };
}

async function run() {
  // 读取 digest（由 steps 前置生成），如不存在则回退到只列标题
  let digest = null;
  try {
    digest = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'digest.json'), 'utf8'));
  } catch (e) {
    console.error('no digest.json:', e.message);
  }

  const summary = (digest && digest.summary) || '';
  const items = (digest && digest.items) || [];
  if (!items.length) { console.log('NO_ITEMS'); process.exit(0); }
  console.log('items:', items.length, 'summary:', summary.slice(0, 40));

  // 按分类分组，保持 CATEGORY_ORDER 顺序
  const groups = new Map();
  for (const it of items) {
    const cat = CATEGORY_ORDER.includes(it.category) ? it.category : '其他';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(it);
  }

  // 标题栏
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);

  // 构建卡片元素
  const elements = [];
  // 综述块（要点）
  if (summary) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**📌 今日总结**\n${clean(summary)}` } });
    elements.push({ tag: 'hr' });
  }

  // 逐分类输出
  let num = 0;
  lines_loop: for (const cat of [...CATEGORY_ORDER, '其他']) {
    const g = groups.get(cat);
    if (!g || !g.length) continue;
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**【${cat}】**` } });
    for (const it of g) {
      num++;
      const parts = [];
      parts.push(`**${num}. ${clip(clean(it.title), 90)}**`);
      if (it.comment) parts.push(`💬 ${clean(it.comment)}`);
      if (it.agent) parts.push(`🤖 Agent价值：${clean(it.agent)}`);
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: parts.join('\n') } });
      if (num >= 40) break lines_loop; // 防止卡片过长
    }
    elements.push({ tag: 'hr' });
  }

  // 结尾总结 / 时效提示
  elements.push({ tag: 'div', text: { tag: 'lark_md', content: `🕕 生成时间：${dateStr} · 共 ${items.length} 条` } });

  const body = {
    msg_type: 'interactive',
    card: {
      header: { title: { tag: 'plain_text', content: '🤖 AI 资讯日报（含解读）' }, template: 'blue' },
      elements,
    },
  };
  if (!DRY) Object.assign(body, sign(SECRET));
  if (DRY) { console.log('DRY_RUN: would send', items.length, 'items'); process.exit(0); }

  const res = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const txt = await res.text();
  console.log('STATUS', res.status);
  console.log(txt);
}

run().catch(e => { console.error('ERR', e.message); process.exit(1); });
