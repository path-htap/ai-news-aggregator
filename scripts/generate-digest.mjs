import fs from 'fs';
import path from 'path';

const DIR = process.cwd();
const API_KEY = process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY || '';
const BASE = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const MODEL = process.env.GLM_MODEL || 'glm-4-flash';
const TOP_N = Number(process.env.TOP_N || 20);
const OUT = process.env.OUT_FILE || path.join(DIR, 'data', 'digest.json');

// 类别顺序（卡片里按此分组展示）
const CATEGORY_ORDER = ['模型与芯片', '公司动态', '产品与应用', '安全与合规', '研究与论文'];

function readSource() {
  const f = path.join(DIR, 'data', 'latest-24h.json');
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  const items = Array.isArray(raw) ? raw : (raw.items || []);
  const seen = new Set();
  const list = [];
  for (const it of items) {
    const t = it.title_zh || it.title_bilingual || it.title || it.title_en;
    if (!t) continue;
    const key = it.url || t;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ ...it, title: String(t).replace(/\n/g, ' ').slice(0, 200), url: it.url || '' });
    if (list.length >= TOP_N) break;
  }
  return list;
}

function callLLM(messages, maxTokens = 4000) {
  return fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.4, max_tokens: maxTokens }),
  }).then(r => {
    if (!r.ok) return r.text().then(t => { throw new Error('HTTP ' + r.status + ': ' + t); });
    return r.json();
  });
}

async function generate(items) {
  // 拼出条目清单给 LLM
  const input = items.map((it, i) => `${i + 1}. ${it.title}${it.url ? ' (来源: ' + (it.site_name || it.source || '') + ')' : ''}`).join('\n');
  const sys = '你是一名资深AI资讯编辑，负责为每日AI新闻撰写中文解读，服务对象是关注AI和对智能体(Agent)开发的人。';
  const user = `请阅读以下 ${items.length} 条AI资讯，为每一条给出：分类、一句中文解读（约80-100字，说明这条新闻讲什么、为什么重要），并额外用一句话点明它对"Agent/大模型应用"的价值、尤其是否能帮助降低出错率(可靠性/安全性)。

只返回一个 JSON 对象，不要任何其他文字或 markdown。格式：
{
  "items": [
    {"index":1,"category":"模型与芯片","comment":"...解读正文...","agent":"...对Agent价值一句话..."}
  ],
  "summary":"今日整体趋势总结，约60-100字"
}
category 只能从：${CATEGORY_ORDER.join('、')} 中选一个最贴切的。

资讯清单：
${input}`;

  const r = await callLLM([{ role: 'system', content: sys }, { role: 'user', content: user }]);
  const content = r.choices[0].message.content;
  // 提取 JSON（防包了 markdown 块）
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('LLM 未返回 JSON: ' + content.slice(0, 500));
  return JSON.parse(m[0]);
}

// 校验并规整
function normalize(result, items) {
  const byIndex = {};
  for (const it of (result.items || [])) byIndex[it.index] = it;
  const out = items.map((it, i) => {
    const g = byIndex[i + 1] || {};
    const cat = CATEGORY_ORDER.includes(g.category) ? g.category : '研究与论文';
    return {
      index: i + 1,
      url: it.url,
      title: it.title,
      site: it.site_name || it.source || '',
      category: cat,
      comment: (g.comment || '').trim(),
      agent: (g.agent || '').trim(),
    };
  });
  return { summary: (result.summary || '').trim(), items: out };
}

async function main() {
  const items = readSource();
  if (!items.length) { console.log('NO_ITEMS_READ'); process.exit(0); }
  console.log('source items:', items.length);

  // 分两批请求，控制单次长度，避免超时/超限
  const half = Math.ceil(items.length / 2);
  const batchA = items.slice(0, half);
  const batchB = items.slice(half);
  let resA, resB;
  try {
    resA = await generate(batchA);
  } catch (e) { console.error('batchA fail', e.message); resA = null; }
  try {
    resB = await generate(batchB);
  } catch (e) { console.error('batchB fail', e.message); resB = null; }

  if (!resA && !resB) { console.error('ALL_BATCHES_FAILED'); process.exit(1); }

  // 合并两条的 summary（若都有则拼接去重）
  let summary = '';
  // 只取第一份摘要作为全局总结（避免拼接重复），若失败则用第二份
  summary = (resA && resA.summary) || (resB && resB.summary) || '';
  const itemsArr = [...(resA ? normalize(resA, batchA).items : []), ...(resB ? normalize(resB, batchB).items : [])];
  // 全局重新编号，保证唯一且连续
  itemsArr.forEach((x, i) => { x.index = i + 1; });

  const digest = { generated_at: new Date().toISOString(), model: MODEL, summary, items: itemsArr };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(digest, null, 2), 'utf8');
  console.log('WROTE', OUT);
  console.log('summary:', summary);
  itemsArr.forEach(x => console.log(`  [${x.category}] #${x.index} ${x.comment.slice(0, 40)}`));
}

main().catch(e => { console.error('ERR', e.message); process.exit(1); });
