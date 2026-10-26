// src/board.js —— 视图生成器：exports 快照 + 总看板.html + 会话看板.html + todo.md 瘦身视图 + 勾稽断链清单
// 用法：
//   node src/board.js                  # 生成 exports/（json 快照 + 双 HTML + todo.md 瘦身视图）
//   node src/board.js --deploy         # 额外把 todo.md/总看板.html/会话看板.html 复制到 zz-option-docs 仓库根（批1⑤迁移用）
// 纪律：只读库；生成物=exports/*（提交 git 跨机只读）；勾稽四查断链清单内置。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = path.join(root, 'data', 'taskboard.db');
const exportsDir = path.join(root, 'exports');
const DOCS_ROOT = 'C:\\Users\\zhangyan\\Documents\\deepseek-harness\\default-workspace';
if (!existsSync(dbPath)) {
  console.error('[board] data/taskboard.db 不存在，先跑 node src/init_db.js');
  process.exit(1);
}
const db = new DatabaseSync(dbPath);
mkdirSync(exportsDir, { recursive: true });

const ZH = { backlog:'需求', plan:'方案', ready:'待开工', dev:'开发中', selftest:'自测中', review:'待验收', merge_ready:'待合并', merged:'已合并', deployed:'已部署', closed:'关闭', blocked:'阻塞', cancelled:'取消' };
const STATUS_ORDER = ['backlog','plan','ready','dev','selftest','review','merge_ready','merged','deployed','closed','blocked','cancelled'];
const LAMPS = ['compile','tests','paradigm','reconcile','scan','deploy'];
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ---------- 读库 ----------
const tasks = db.prepare('SELECT * FROM task ORDER BY id').all();
const gates = new Map(db.prepare('SELECT * FROM task_gate').all().map(g => [g.task_id, g]));
const items = db.prepare('SELECT * FROM task_item ORDER BY task_id, seq').all();
const accepts = db.prepare('SELECT * FROM accept_item ORDER BY task_id, id').all();
const bugs = db.prepare('SELECT * FROM bug ORDER BY task_id, id').all();
const commits = db.prepare('SELECT * FROM task_commit ORDER BY task_id, at').all();
const reviews = new Map(db.prepare('SELECT * FROM task_review').all().map(r => [r.task_id, r]));
const sessions = db.prepare('SELECT * FROM session ORDER BY id').all();
const checks = db.prepare('SELECT s.session_id, s.at, s.last_active_min, s.note FROM session_check s ORDER BY s.session_id, s.id DESC').all();
const latestCheck = new Map();
for (const c of checks) if (!latestCheck.has(c.session_id)) latestCheck.set(c.session_id, c);
const events = db.prepare('SELECT * FROM task_event ORDER BY task_id, id').all();

const byTask = t => ({
  items: items.filter(i => i.task_id === t.id),
  accepts: accepts.filter(a => a.task_id === t.id),
  bugs: bugs.filter(b => b.task_id === t.id),
  commits: commits.filter(c => c.task_id === t.id),
});

// ---------- 勾稽四查 ----------
const broken = [];
for (const t of tasks) {
  if (!['backlog','plan','cancelled','closed'].includes(t.status) && !t.plan_id && !t.plan_doc)
    broken.push({ task: t.id, check: '账证相符', msg: '任务已开工但未挂方案（plan_id/plan_doc 均空）' });
  if (t.status === 'merged' && !commits.some(c => c.task_id === t.id && c.kind === 'merge'))
    broken.push({ task: t.id, check: '时序一致', msg: '状态=已合并 但无 kind=merge 的 commit 挂账' });
  if ((t.status === 'deployed' || t.status === 'closed') && !commits.some(c => c.task_id === t.id && c.kind === 'deploy'))
    broken.push({ task: t.id, check: '时序一致', msg: '状态=已部署/关闭 但无 kind=deploy 的 commit（回答不了「线上跑的是哪版」）' });
  if (t.status === 'closed') {
    const done = byTask(t).items.filter(i => i.status === 'done').length;
    if (done < byTask(t).items.length) broken.push({ task: t.id, check: '汇总一致', msg: `任务已关闭但拆解项 ${done}/${byTask(t).items.length} 未完成` });
    const acc = byTask(t).accepts;
    if (acc.length && acc.filter(a => a.passed === 1).length < acc.length)
      broken.push({ task: t.id, check: '汇总一致', msg: `任务已关闭但验收项 ${acc.filter(a=>a.passed===1).length}/${acc.length} 未通过` });
  }
}
for (const b of bugs) if (b.status === 'fixed' && !b.fix_commit)
  broken.push({ task: b.task_id, check: '账实相符', msg: `bug ${b.id} 标记 fixed 但无修复 commit` });
for (const a of accepts) if (a.passed === 1 && !a.evidence)
  broken.push({ task: a.task_id, check: '账实相符', msg: `验收项 ${a.id} 标记通过但无证据 evidence` });

// ---------- exports/*.json 快照 ----------
const snap = {
  generated_at: new Date().toISOString(),
  tasks, gates: [...gates.values()], items, accepts, bugs, commits,
  reviews: [...reviews.values()], sessions, broken,
};
writeFileSync(path.join(exportsDir, 'tasks.json'), JSON.stringify(snap, null, 2));

// ---------- todo.md 瘦身视图（五列：ID/标题/状态/owner/指针） ----------
const todoLines = ['| ID | 标题 | 状态 | 认领 | 指针 |', '| --- | --- | --- | --- | --- |'];
for (const t of tasks) {
  const ptr = [t.plan_doc, t.req_doc].filter(Boolean).join('、');
  todoLines.push(`| ${t.id} | ${t.title.slice(0, 60)} | ${ZH[t.status]} | ${t.owner ?? '—'} | ${ptr ? esc(ptr).slice(0, 80) : '—'} |`);
}
const todoMd = `# 任务清单（由 zz-agent-taskboard 生成，勿手改；真相库=taskboard.db）\n\n> 生成时间：${new Date().toISOString()}\n\n${todoLines.join('\n')}\n`;
writeFileSync(path.join(exportsDir, 'todo.md'), todoMd);

// ---------- 总看板.html（自包含） ----------
const lampDot = (taskId, name) => {
  const g = gates.get(taskId);
  const v = g ? g[name] : null;
  const color = v ? (String(v).toLowerCase().includes('fail') || String(v).toLowerCase().includes('红') ? 'red' : 'green') : 'gray';
  return `<span class="lamp ${color}" title="${name}: ${esc(v) ?? '未报'}">${name.slice(0,1)}</span>`;
};
const card = t => {
  const g = gates.get(t.id) ?? {};
  const d = byTask(t);
  const openBugs = d.bugs.filter(b => b.status === 'open').length;
  const accPassed = d.accepts.filter(a => a.passed === 1).length;
  const doneItems = d.items.filter(i => i.status === 'done').length;
  const rv = reviews.get(t.id);
  const cls = t.status === 'blocked' ? 'card blocked' : 'card';
  const sessionLamp = t.owner_session_id && latestCheck.get(t.owner_session_id)
    ? (latestCheck.get(t.owner_session_id).last_active_min > 30 ? 'idle' : 'live') : '';
  return `<div class="${cls}">
    <div class="tid">${esc(t.id)} <span class="pri p${esc(t.priority)}">${esc(t.priority)}</span></div>
    <div class="ttl">${esc(t.title)}</div>
    <div class="meta">${esc(t.owner ?? '未认领')}${t.branch ? ' · ' + esc(t.branch) : ''}</div>
    <div class="lamps">${LAMPS.map(n => lampDot(t.id, n)).join('')}<span class="sesslamp ${sessionLamp}"></span></div>
    <div class="stats">拆解 ${doneItems}/${d.items.length} · 验收 ${accPassed}/${d.accepts.length}${openBugs ? ` · <b class="bugbadge">BUG×${openBugs}</b>` : ''}</div>
    <div class="docs">${esc([t.req_doc, t.plan_doc].filter(Boolean).join(' ').slice(0, 90))}</div>
    ${t.fix_rounds ? `<div class="fixr">返工 ${t.fix_rounds} 轮</div>` : ''}
    ${rv?.l2 === 'approved' ? '<div class="l2ok">L2 已签字</div>' : ''}
  </div>`;
};
const boardHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>AI 开发治理总看板</title><style>
body{font-family:"Microsoft YaHei",sans-serif;background:#f5f6f8;margin:0;padding:16px;color:#222}
h1{font-size:20px;margin:4px 0 2px}.sub{color:#777;font-size:12px;margin-bottom:12px}
.sum{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}.sum .s{background:#fff;border-radius:8px;padding:8px 14px;font-size:13px;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.sum .s b{font-size:18px;margin-right:4px}.s.red b{color:#d43}.s.green b{color:#187}
.board{display:grid;grid-template-columns:repeat(12,minmax(150px,1fr));gap:8px;overflow-x:auto;padding-bottom:8px}
.col{background:#eef0f3;border-radius:8px;padding:8px;min-height:120px}
.col h3{margin:0 0 8px;font-size:13px;color:#555;display:flex;justify-content:space-between}
.col h3 .n{background:#fff;border-radius:10px;padding:0 7px;font-size:12px}
.card{background:#fff;border-radius:6px;padding:8px;margin-bottom:8px;font-size:12px;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.card.blocked{border:2px solid #d43;background:#fff5f5}
.tid{font-weight:700}.pri{font-size:10px;border-radius:3px;padding:1px 4px;margin-left:4px}
.p高{background:#fde;color:#a00}.p中{background:#eef;color:#337}
.ttl{margin:3px 0;line-height:1.35}.meta{color:#888;font-size:11px}
.lamps{display:flex;gap:2px;margin:4px 0;align-items:center}
.lamp{width:14px;height:14px;border-radius:50%;display:inline-block;font-size:8px;color:#fff;text-align:center;line-height:14px}
.lamp.green{background:#2a2}.lamp.red{background:#d33}.lamp.gray{background:#bbb}
.sesslamp{width:8px;height:8px;border-radius:50%;margin-left:auto}.sesslamp.live{background:#2a2}.sesslamp.idle{background:#d90}
.stats{color:#555}.bugbadge{color:#d43}.docs{color:#999;font-size:10px;margin-top:3px;word-break:break-all}
.fixr{color:#d43;font-size:10px}.l2ok{color:#187;font-size:10px}
.gj{margin-top:18px;background:#fff;border-radius:8px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.gj h2{font-size:15px;margin:0 0 8px}.gj table{width:100%;border-collapse:collapse;font-size:12px}
.gj td,.gj th{border-bottom:1px solid #eee;padding:5px 8px;text-align:left}.gj .ok{color:#187}
footer{color:#aaa;font-size:11px;margin-top:10px}
</style></head><body>
<h1>AI 开发治理总看板</h1>
<div class="sub">生成于 ${new Date().toLocaleString('zh-CN')} · 数据源 zz-agent-taskboard/data/taskboard.db · 制度权威=zz-option-docs/docs/方案/AI开发治理与任务生命周期管理方案.md</div>
<div class="sum">
${['总任务','需求','待开工','开发中','自测中','待验收','待合并','已部署','关闭','阻塞'].map(label => {
  const map = { '总任务': tasks.length, '需求': tasks.filter(t=>t.status==='backlog').length, '待开工': tasks.filter(t=>t.status==='ready').length, '开发中': tasks.filter(t=>t.status==='dev').length, '自测中': tasks.filter(t=>t.status==='selftest').length, '待验收': tasks.filter(t=>t.status==='review').length, '待合并': tasks.filter(t=>t.status==='merge_ready').length, '已部署': tasks.filter(t=>t.status==='deployed').length, '关闭': tasks.filter(t=>t.status==='closed').length, '阻塞': tasks.filter(t=>t.status==='blocked').length };
  const cls = label==='阻塞' && map[label] ? ' red' : (label==='关闭' ? ' green' : '');
  return `<div class="s${cls}"><b>${map[label]}</b>${label}</div>`;
}).join('')}
<div class="s"><b>${bugs.filter(b=>b.status==='open').length}</b>BUG 未修</div>
<div class="s"><b>${broken.length}</b>勾稽断链</div>
</div>
<div class="board">
${STATUS_ORDER.map(st => {
  const list = tasks.filter(t => t.status === st);
  return `<div class="col"><h3>${ZH[st]}<span class="n">${list.length}</span></h3>${list.map(card).join('')}</div>`;
}).join('')}
</div>
<div class="gj"><h2>勾稽对账（四查断链清单）</h2>
${broken.length === 0 ? '<span class="ok">✔ 四查全部通过，无断链</span>' :
`<table><tr><th>任务</th><th>查项</th><th>断链描述</th></tr>${broken.map(b => `<tr><td>${esc(b.task)}</td><td>${esc(b.check)}</td><td>${esc(b.msg)}</td></tr>`).join('')}</table>`}
</div>
<footer>zz-agent-taskboard · board.js 生成 · 只读视图，改动走 src/task.js</footer>
</body></html>`;
writeFileSync(path.join(exportsDir, '总看板.html'), boardHtml);

// ---------- 会话看板.html ----------
const sessionRows = sessions.map(s => {
  const c = latestCheck.get(s.id);
  const min = c?.last_active_min;
  const st = s.status === 'idle' ? '🟡 空转' : '🟢 活跃';
  return `<tr><td>${esc(s.id)}</td><td>${esc(s.workspace ?? '')}</td><td>${esc(s.model ?? '')}</td><td>${st}</td><td>${min == null ? '—' : min + ' 分钟前'}</td><td>${esc(c?.note ?? '')}</td></tr>`;
}).join('');
const sessHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>会话看板</title><style>
body{font-family:"Microsoft YaHei",sans-serif;background:#f5f6f8;margin:0;padding:16px;color:#222}
h1{font-size:20px;margin:4px 0 12px}.sub{color:#777;font-size:12px;margin-bottom:12px}
table{width:100%;border-collapse:collapse;background:#fff;font-size:13px;box-shadow:0 1px 2px rgba(0,0,0,.06)}
td,th{border-bottom:1px solid #eee;padding:7px 10px;text-align:left}
tr:hover{background:#fafafa}
</style></head><body><h1>会话看板（AI 员工）</h1><div class="sub">生成于 ${new Date().toLocaleString('zh-CN')} · 空转阈值 30 分钟（meta 表）</div>
<table><tr><th>会话</th><th>工作区</th><th>模型</th><th>状态</th><th>最后活动</th><th>备注</th></tr>${sessionRows}</table></body></html>`;
writeFileSync(path.join(exportsDir, '会话看板.html'), sessHtml);

// ---------- --deploy：复制到 docs 仓库根（批 1⑤ 迁移用） ----------
if (process.argv.includes('--deploy')) {
  if (!existsSync(DOCS_ROOT)) {
    console.error(`[board] --deploy 目标不存在：${DOCS_ROOT}`);
    process.exit(1);
  }
  copyFileSync(path.join(exportsDir, 'todo.md'), path.join(DOCS_ROOT, 'todo.md'));
  copyFileSync(path.join(exportsDir, '总看板.html'), path.join(DOCS_ROOT, '总看板.html'));
  copyFileSync(path.join(exportsDir, '会话看板.html'), path.join(DOCS_ROOT, '会话看板.html'));
  console.log(`[board] --deploy：todo.md/总看板.html/会话看板.html 已复制到 ${DOCS_ROOT}`);
}

console.log(`[board] 已生成 exports/：tasks.json、todo.md（${tasks.length} 行任务）、总看板.html（断链 ${broken.length} 条）、会话看板.html（${sessions.length} 会话）`);
db.close();
