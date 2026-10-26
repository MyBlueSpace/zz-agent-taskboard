// src/board.js —— 视图生成器：exports 快照 + taskboard.html + sessionboard.html + todo.md 瘦身视图 + 勾稽断链清单
// 用法：
//   node src/board.js                  # 生成 exports/（json 快照 + 双 HTML + todo.md 瘦身视图）
//   node src/board.js --deploy         # 额外把 todo.md/taskboard.html/sessionboard.html 复制到 docs 仓库根
// 纪律：只读库；生成物=exports/*（提交 git 跨机只读）；勾稽四查断链清单内置。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pathSep = path.sep;

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
const tasks = db.prepare('SELECT * FROM task ORDER BY id DESC').all();
const gates = new Map(db.prepare('SELECT * FROM task_gate').all().map(g => [g.task_id, g]));
const items = db.prepare('SELECT * FROM task_item ORDER BY task_id, seq').all();
const accepts = db.prepare('SELECT * FROM accept_item ORDER BY task_id, id').all();
const bugs = db.prepare('SELECT * FROM bug ORDER BY task_id, id').all();
const commits = db.prepare('SELECT * FROM task_commit ORDER BY task_id, at').all();
const reviews = new Map(db.prepare('SELECT * FROM task_review').all().map(r => [r.task_id, r]));
const sessions = db.prepare('SELECT * FROM session ORDER BY id').all();
const stats = new Map(db.prepare('SELECT * FROM session_stat').all().map(x => [x.session_id, x]));
const checks = db.prepare('SELECT s.session_id, s.at, s.last_active_min, s.note FROM session_check s ORDER BY s.session_id, s.id DESC').all();
const latestCheck = new Map();
for (const c of checks) if (!latestCheck.has(c.session_id)) latestCheck.set(c.session_id, c);
const events = db.prepare('SELECT * FROM task_event ORDER BY task_id, id').all();
const discussions = db.prepare("SELECT * FROM discussion WHERE status='open' ORDER BY id DESC").all();
const devAlerts = db.prepare("SELECT * FROM dev_alerts WHERE resolved=0 ORDER BY id DESC LIMIT 50").all();

const byTask = t => ({
  items: items.filter(i => i.task_id === t.id),
  accepts: accepts.filter(a => a.task_id === t.id),
  bugs: bugs.filter(b => b.task_id === t.id),
  commits: commits.filter(c => c.task_id === t.id),
});

// ---------- 勾稽（口径=task.js check 12 对，单一真相源，避免两份逻辑漂移） ----------
let checkResult = null;
try {
  checkResult = JSON.parse(execSync(`"${process.execPath}" "${path.join(root, 'src', 'task.js')}" check`, { encoding: 'utf8', cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }));
} catch (e) { checkResult = null; }
const broken = [];
if (checkResult) for (const [k, v] of Object.entries(checkResult)) {
  if (k === '勾稽体检') continue;
  if (Array.isArray(v)) v.forEach(msg => {
    const m = String(msg).match(/T\d+/);
    broken.push({ task: m ? m[0] : '—', check: k, msg: String(msg) });
  });
}

// ---------- 时间工具（兼容迁移「MM-DD」短格式与 ISO） ----------
const pad = n => String(n).padStart(2, '0');
const parseT = v => {
  if (!v) return null;
  const s = String(v).trim();
  const iso = new Date(s);
  if (!isNaN(iso.getTime())) return iso;
  const m = s.match(/^(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(new Date().getFullYear(), Number(m[1]) - 1, Number(m[2]));
  return null;
};
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = () => dayKey(new Date());
const weekStart = (() => { const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - (d.getDay() === 0 ? 6 : d.getDay() - 1)); return d; })();

// ---------- 今日焦点：需要处理的事，每条带处置指引 ----------
const NOW = Date.now();
const HOUR_MS = 3600000;
const ACTIVE_STATUS = ['ready','dev','selftest','review','merge_ready','merged','deployed'];
const focusItems = [];
for (const t of tasks) {
  if (t.status === 'blocked')
    focusItems.push({ lvl:'红', text:`${t.id} ${t.title.slice(0,38)} 被阻塞`, act:`原因：${t.blocked_reason ?? '未填'}。处置：按原因逐项拍板（多数方案已附推荐，回「按推荐」即可）→ 拍板后 AI 当场移「待开工」并派工，报账自动流转` });
}
for (const b of broken)
  focusItems.push({ lvl:'红', text:`${b.task} 勾稽断链：${b.msg}`, act:'处置：任意会话执行 task.js set/commit 补挂账（或对会话说一声，AI 来补），补齐后复验变绿' });
for (const b of bugs.filter(x => x.status === 'open'))
  focusItems.push({ lvl:'红', text:`${b.id}（${b.task}）${b.title.slice(0,38)} 未修复`, act:'处置：派修复会话，两轮即停（fix_rounds>2 上报你）' });
for (const t of tasks.filter(x => x.status === 'review'))
  focusItems.push({ lvl:'黄', text:`${t.id} ${t.title.slice(0,38)} 待验收`, act:'处置：L0 复核门禁证据 → L1 Pro 审查（判断段）→ L2 你签字' });
for (const t of tasks.filter(x => x.status === 'merge_ready'))
  focusItems.push({ lvl:'黄', text:`${t.id} ${t.title.slice(0,38)} 待合并`, act:'处置：合并窗口内全量扫描 P0=0 → deploy_guard → merge main（需你点头）' });
for (const t of tasks) {
  if (!ACTIVE_STATUS.includes(t.status)) continue;
  const u = parseT(t.updated_at);
  if (u && NOW - u.getTime() > HOUR_MS)
    focusItems.push({ lvl:'黄', text:`${t.id} ${t.title.slice(0,38)} 卡门超 1 小时（停在「${ZH[t.status]}」）`, act:'处置：问执行会话进展；无进展→打回或上报你' });
  const sid = t.owner_session_id;
  if (sid) {
    const c = latestCheck.get(sid);
    if (c && c.last_active_min > 30)
      focusItems.push({ lvl:'黄', text:`${t.id} 的执行会话 ${sid} 空转 ${c.last_active_min} 分钟`, act:'处置：去该会话问一句「卡哪了」，或收回任务重新派工' });
  }
}
for (const d of discussions)
  focusItems.push({ lvl:'红', text:`【等你拍板】${d.question}${d.options ? `（${d.options}）` : ''}`, act:`处置：直接回复你的选择（如「1=A 2=B」或「按推荐」），AI 当场落账 discussion decide 并继续推进` });
for (const a of devAlerts)
  focusItems.push({ lvl: a.kind === 'stray_write' ? '红' : '黄', text:`【巡检·${a.kind === 'stray_write' ? '清单外写' : '清单外读'}】${a.message}`, act:'处置：确认该文件是否本任务范围；是→把文件补进任务拆解清单（task.js item add）；否→去该会话口头制止并记录（task.js event）' });
const redCount = focusItems.filter(f => f.lvl === '红').length;
const yellowCount = focusItems.filter(f => f.lvl === '黄').length;
// 今天/本周 维度
const todayClosed = tasks.filter(t => { const d = parseT(t.finished_at); return d && dayKey(d) === todayKey(); });
const thisWeekClosed = tasks.filter(t => { const d = parseT(t.finished_at); return d && d >= weekStart; });
const startedThisWeek = tasks.filter(t => { const d = parseT(t.started_at); return d && d >= weekStart; });

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
// 会话质量指标（session_stat= bili 真源）
const waterLamp = st => {
  const n = st?.context_tokens;
  if (n == null) return '—';
  if (n > 250000) return `🔴 ${(n / 1000).toFixed(0)}K`;
  if (n > 150000) return `🟡 ${(n / 1000).toFixed(0)}K`;
  return `🟢 ${(n / 1000).toFixed(0)}K`;
};
const fmtTok = n => n == null ? '—' : n > 1000000 ? (n / 1000000).toFixed(1) + 'M' : Math.round(n / 1000) + 'K';
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
  const sstat = t.owner_session_id ? stats.get(t.owner_session_id) : null;
  return `<div class="${cls}">
    <div class="tid">${esc(t.id)} <span class="pri p${esc(t.priority)}">${esc(t.priority)}</span></div>
    <div class="ttl">${esc(t.title)}</div>
    <div class="meta">${esc(t.owner ?? '未认领')}${t.branch ? ' · ' + esc(t.branch) : ''}</div>
    <div class="lamps">${LAMPS.map(n => lampDot(t.id, n)).join('')}<span class="sesslamp ${sessionLamp}"></span></div>
    ${sstat ? `<div class="squal">👥 ${esc(String(sstat.title ?? '').slice(0, 22))} · ${waterLamp(sstat)} · 压缩${sstat.fold_count ?? 0} · ${fmtTok((sstat.input_tokens ?? 0) + (sstat.output_tokens ?? 0))}</div>` : ''}
    <div class="stats">拆解 ${doneItems}/${d.items.length} · 验收 ${accPassed}/${d.accepts.length}${openBugs ? ` · <b class="bugbadge">BUG×${openBugs}</b>` : ''}</div>
    <div class="docs">${esc([t.req_doc, t.plan_doc].filter(Boolean).join(' ').slice(0, 90))}</div>
    ${t.fix_rounds ? `<div class="fixr">返工 ${t.fix_rounds} 轮</div>` : ''}
    ${rv?.l2 === 'approved' ? '<div class="l2ok">L2 已签字</div>' : ''}
    <details class="det"><summary>详情：拆解/验收/证据/commit/bug</summary>
      <div class="detsec"><b>📐 拆解项（条款×状态）</b>${d.items.length ? d.items.map(i => `<div>${i.status === 'done' ? '✅' : '⬜'} ${esc(i.item)}${i.plan_section ? ' <span class="dim">· ' + esc(i.plan_section) + '</span>' : ''}</div>`).join('') : '<div class="dim">无拆解（方案文件级清单未灌注）</div>'}</div>
      <div class="detsec"><b>✔ 验收项</b>${d.accepts.length ? d.accepts.map(a => `<div>${a.passed === 1 ? '✅' : '⬜'} ${esc(a.item)}${a.passed === 1 && a.evidence ? ' <span class="dim">· 证据：' + esc(String(a.evidence).slice(0, 80)) + '</span>' : ''}</div>`).join('') : '<div class="dim">无验收项</div>'}</div>
      <div class="detsec"><b>🔦 门禁证据</b>${LAMPS.map(n => `<div>${lampDot(t.id, n)} ${n}：${esc(String(g[n] ?? '未填').slice(0, 100))}</div>`).join('')}</div>
      <div class="detsec"><b>🔗 commit 链</b>${d.commits.length ? d.commits.map(c => `<div>${esc(c.repo)} ${esc(c.commit_hash)} <span class="dim">${esc(c.kind)}</span> ${esc(String(c.message ?? '').slice(0, 60))}</div>`).join('') : '<div class="dim">无 commit 挂账（存量 legacy 除外）</div>'}</div>
      <div class="detsec"><b>🐞 bug</b>${d.bugs.length ? d.bugs.map(b => `<div>${esc(b.id)} ${esc(b.severity)} ${esc(b.status)}：${esc(String(b.title ?? '').slice(0, 60))}${b.fix_commit ? ' · 修复 ' + esc(b.fix_commit) : ''}</div>`).join('') : '<div class="dim">无 bug</div>'}</div>
    </details>
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
.det{margin-top:6px}.detsec{margin:6px 0;padding:4px 8px;background:#fafbfc;border-left:3px solid #cbd5e0;font-size:11px;line-height:1.7}.dim{color:#98a1ad}
.squal{color:#666;font-size:10px;margin-top:3px;line-height:1.5}
.gj{margin-top:18px;background:#fff;border-radius:8px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.gj h2{font-size:15px;margin:0 0 8px}.gj table{width:100%;border-collapse:collapse;font-size:12px}
.gj td,.gj th{border-bottom:1px solid #eee;padding:5px 8px;text-align:left}.gj .ok{color:#187}
.r{color:#d43;font-weight:700}.y{color:#d90;font-weight:700}
details{background:#fff;border-radius:8px;padding:8px 14px;margin:8px 0;box-shadow:0 1px 2px rgba(0,0,0,.06)}
summary{cursor:pointer;font-size:14px;font-weight:600;padding:4px 0}
.focus{background:#fff;border-radius:8px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,.06);margin-bottom:14px}
.focus h2{font-size:15px;margin:0 0 8px}
.focus table{width:100%;border-collapse:collapse;font-size:12px}
.focus td,.focus th{border-bottom:1px solid #eee;padding:6px 8px;text-align:left}
footer{color:#aaa;font-size:11px;margin-top:10px}
.purpose{color:#555;font-size:13px;background:#fffbe6;border:1px solid #ffe58f;border-radius:6px;padding:6px 12px;margin:2px 0 14px}
</style></head><body>
<nav style="margin:10px 0 14px"><a href="/" style="background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:6px 14px;color:#1f2328;text-decoration:none;font-size:14px;font-weight:600">📌 今日进展</a>&nbsp;&nbsp;<a href="/taskboard.html" style="background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:6px 14px;color:#1f2328;text-decoration:none;font-size:14px;font-weight:600">📋 全景看板</a>&nbsp;&nbsp;<a href="/sessionboard.html" style="background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:6px 14px;color:#1f2328;text-decoration:none;font-size:14px;font-weight:600">👥 会话看板</a>&nbsp;&nbsp;<a href="/todo.md" style="background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:6px 14px;color:#1f2328;text-decoration:none;font-size:14px;font-weight:600">📝 任务清单</a></nav>
<h1>AI 开发治理总看板</h1><div class="purpose">本页解决：每张工单现在卡在哪——12 阶段全景档案（编号倒序），按需查阅；红灯=阻塞、灰灯=未报门禁。</div>
<div class="sub">生成于 ${new Date().toLocaleString('zh-CN')} · 数据源 zz-agent-taskboard/data/taskboard.db · 制度权威=zz-option-docs/docs/方案/AI开发治理与任务生命周期管理方案.md</div>
<div class="sum">
<div class="s red"><b>${redCount}</b>红·需处理</div>
<div class="s"><b>${yellowCount}</b>黄·需关注</div>
<div class="s green"><b>${todayClosed.length}</b>今日关闭</div>
<div class="s green"><b>${thisWeekClosed.length}</b>本周完成</div>
<div class="s"><b>${startedThisWeek.length}</b>本周开工</div>
<div class="s"><b>${tasks.length}</b>总任务</div>
<div class="s"><b>${bugs.filter(b=>b.status==='open').length}</b>BUG 未修</div>
<div class="s"><b>${broken.length}</b>勾稽断链</div>
</div>
<div class="focus"><h2>今日焦点：${redCount + yellowCount} 件需要处理（发现 → 按处置指引处理 → 绿灯复归）</h2>
${focusItems.length === 0 ? '<span class="ok">✔ 今天没有需要处理的事</span>' :
`<table><tr><th>级</th><th>问题</th><th>处置指引</th></tr>${focusItems.map(f => `<tr><td class="${f.lvl==='红'?'r':'y'}">${f.lvl}</td><td>${esc(f.text)}</td><td>${esc(f.act)}</td></tr>`).join('')}</table>`}
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
writeFileSync(path.join(exportsDir, 'taskboard.html'), boardHtml);

// ---------- 会话看板.html ----------
// ---------- 会话过滤：归档（空转且 >7 天未活动）不展示 ----------
const ARCHIVE_DAYS = 7;
const ARCHIVE_MS = ARCHIVE_DAYS * 86400000;
const nowTs = Date.now();
const visibleSessions = sessions.filter(s => {
  if (s.status === 'active') return true;
  const at = s.last_active_at ? new Date(s.last_active_at).getTime() : 0;
  return nowTs - at <= ARCHIVE_MS;
});
const archivedCount = sessions.length - visibleSessions.length;
const sessionRows = visibleSessions.map(s => {
  const c = latestCheck.get(s.id);
  const min = c?.last_active_min;
  const st = s.status === 'idle' ? '🟡 空转' : '🟢 活跃';
  return `<tr><td>${esc(s.id)}</td><td>${esc(s.workspace ?? '')}</td><td>${esc(s.model ?? '')}</td><td>${st}</td><td>${min == null ? '—' : min + ' 分钟前'}</td><td>${esc(c?.note ?? '')}</td></tr>`;
}).join('');
// 会话质量聚合：名下任务/完成/返工
const taskBySession = new Map();
for (const t of tasks) {
  if (!t.owner_session_id) continue;
  if (!taskBySession.has(t.owner_session_id)) taskBySession.set(t.owner_session_id, { inprog: 0, done: 0, rounds: 0, ids: [] });
  const o = taskBySession.get(t.owner_session_id);
  if (['closed','cancelled'].includes(t.status)) o.done++; else if (t.status !== 'backlog') o.inprog++;
  o.rounds += t.fix_rounds || 0;
  if (!['closed','cancelled','backlog'].includes(t.status)) o.ids.push(t.id);
}
const sessName = s => {
  const st = stats.get(s.id);
  if (st?.title) return st.title;
  const o = taskBySession.get(s.id);
  const ws = String(s.workspace ?? '').includes('dsh_wechat') ? 'wechat' : 'docs';
  const ids = o && o.ids.length ? o.ids.slice(0, 3).join(',') + (o.ids.length > 3 ? '…' : '') : '无任务';
  return ws + ' · ' + ids;
};
const fmtSize = v => {
  if (v == null || v === '') return '—';
  const m = String(v).match(/\d+/); const n = m ? Number(m[0]) : 0;
  if (!n) return '—';
  return n > 1048576 ? (n / 1048576).toFixed(1) + 'MB' : n > 1024 ? Math.round(n / 1024) + 'KB' : n + 'B';
};
// 今日/本周/告警/折叠分组
const todaySessions = sessions.filter(s => { const d = s.last_active_at ? new Date(s.last_active_at) : null; return d && dayKey(d) === todayKey(); });
const busyIds = new Set(tasks.filter(t => t.owner_session_id).map(t => t.owner_session_id));
const warnSessions = sessions.filter(s => { const c = latestCheck.get(s.id); return c && c.last_active_min > 30 && (busyIds.has(s.id) || s.status === 'active'); });
const yKey = dayKey(new Date(Date.now() - 86400000));
const recent = visibleSessions.map(s => ({ s, d: s.last_active_at ? new Date(s.last_active_at) : null }))
  .filter(x => x.d).sort((a, b) => b.d - a.d);
const groupsHtml = [['今天', recent.filter(x => dayKey(x.d) === todayKey())],
  ['昨天', recent.filter(x => dayKey(x.d) === yKey)],
  ['更早（7 天内）', recent.filter(x => dayKey(x.d) !== todayKey() && dayKey(x.d) !== yKey)]]
  .filter(([, l]) => l.length)
  .map(([gname, l], gi) => `<details ${gi === 0 ? 'open' : ''}><summary>${gname}（${l.length} 个）</summary><table><tr><th>会话</th><th>名称</th><th>模型</th><th>状态</th><th>活跃度</th><th>水位</th><th>Token（缓存命中）</th><th>压缩</th><th>在册</th><th>完成</th><th>返工</th><th>体量</th></tr>${l.map(({ s }) => {
    const c = latestCheck.get(s.id);
    const st = stats.get(s.id);
    const o = taskBySession.get(s.id);
    const m = c?.last_active_min;
    const act = m == null ? '—' : (m <= 30 ? `🟢 ${m} 分钟前` : `🟡 空转 ${m} 分钟`);
    const tok = (st?.input_tokens != null || st?.output_tokens != null) ? `${fmtTok((st?.input_tokens ?? 0) + (st?.output_tokens ?? 0))}（${st?.cache_hit_pct != null ? Math.round(st.cache_hit_pct) + '%' : '—'}）` : '—';
    return `<tr><td>${esc(String(s.dsh_id ?? s.id).slice(0, 8))}</td><td>${esc(sessName(s))}</td><td>${esc(s.model ?? '')}</td><td>${s.status === 'idle' ? '🟡 空转' : '🟢 活跃'}</td><td>${act}</td><td>${waterLamp(st)}</td><td>${tok}</td><td>${st?.fold_count ?? '—'}</td><td>${o ? o.inprog : 0}</td><td>${o ? o.done : 0}</td><td>${o && o.rounds ? o.rounds : 0}</td><td>${fmtSize(c?.note)}</td></tr>`;
  }).join('')}</table></details>`).join('');
const sessHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>会话看板</title><style>
body{font-family:"Microsoft YaHei",sans-serif;background:#f5f6f8;margin:0;padding:16px;color:#222}
h1{font-size:20px;margin:4px 0 12px}.sub{color:#777;font-size:12px;margin-bottom:12px}
table{width:100%;border-collapse:collapse;background:#fff;font-size:13px;box-shadow:0 1px 2px rgba(0,0,0,.06)}
td,th{border-bottom:1px solid #eee;padding:7px 10px;text-align:left}
tr:hover{background:#fafafa}
.sum{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}.sum .s{background:#fff;border-radius:8px;padding:8px 14px;font-size:13px;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.sum .s b{font-size:18px;margin-right:4px}.s.red b{color:#d43}.s.green b{color:#187}
.focus{background:#fff;border-radius:8px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,.06);margin-bottom:14px}
.focus h2{font-size:15px;margin:0 0 8px}.focus .ok{color:#187}
details{background:#fff;border-radius:8px;padding:8px 14px;margin:8px 0;box-shadow:0 1px 2px rgba(0,0,0,.06)}
summary{cursor:pointer;font-size:14px;font-weight:600;padding:4px 0}
h2{font-size:15px;margin:16px 0 8px}
.purpose{color:#555;font-size:13px;background:#fffbe6;border:1px solid #ffe58f;border-radius:6px;padding:6px 12px;margin:2px 0 14px}
</style></head><body><nav style="margin:10px 0 14px"><a href="/" style="background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:6px 14px;color:#1f2328;text-decoration:none;font-size:14px;font-weight:600">📌 今日进展</a>&nbsp;&nbsp;<a href="/taskboard.html" style="background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:6px 14px;color:#1f2328;text-decoration:none;font-size:14px;font-weight:600">📋 全景看板</a>&nbsp;&nbsp;<a href="/sessionboard.html" style="background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:6px 14px;color:#1f2328;text-decoration:none;font-size:14px;font-weight:600">👥 会话看板</a>&nbsp;&nbsp;<a href="/todo.md" style="background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:6px 14px;color:#1f2328;text-decoration:none;font-size:14px;font-weight:600">📝 任务清单</a></nav>
<h1>会话看板（AI 员工）</h1><div class="purpose">本页解决：AI 员工干没干活、干得怎么样——每个会话五列质量（活跃度/在册任务/完成/返工/体量），🟡 空转=去问一句「卡哪了」。</div><div class="sub">生成于 ${new Date().toLocaleString('zh-CN')} · 在册 ${sessions.length} · 归档隐藏 ${archivedCount} · 今日活动 ${todaySessions.length} · 空转告警 ${warnSessions.length}</div>
<div class="sum">
<div class="s${warnSessions.length ? ' red' : ''}"><b>${warnSessions.length}</b>空转告警</div>
<div class="s green"><b>${todaySessions.length}</b>今日活动</div>
<div class="s"><b>${sessions.filter(s => s.status === 'active').length}</b>活跃</div>
<div class="s"><b>${recent.length}</b>7 天内活动</div>
</div>
<div class="focus"><h2>空转告警（去该会话问一句：卡哪了）</h2>
${warnSessions.length === 0 ? '<span class="ok">✔ 无空转告警</span>' :
`<table><tr><th>会话</th><th>名称（工作区·任务）</th><th>空转时长</th></tr>${warnSessions.map(s => {
  const c = latestCheck.get(s.id);
  return `<tr><td>${esc(String(s.dsh_id ?? s.id).slice(0, 8))}</td><td>${esc(sessName(s))}</td><td>${c?.last_active_min} 分钟</td></tr>`;
}).join('')}</table>`}
</div>
<h2>近期会话（按天折叠 · 默认只看今天）</h2>
${groupsHtml || '<div class="sub">本周无会话活动</div>'}</body></html>`;
writeFileSync(path.join(exportsDir, 'sessionboard.html'), sessHtml);

// ---------- 今日进展页 today.html（首页=站会三问：昨天干了啥/今天在干啥/有什么阻碍） ----------
const evToday = events.filter(e => { const d = parseT(e.at); return d && dayKey(d) === todayKey(); }).reverse();
const activeTasks = tasks.filter(t => ACTIVE_STATUS.includes(t.status));
const startedToday = tasks.filter(t => { const d = parseT(t.started_at); return d && dayKey(d) === todayKey(); });
const finishedToday = tasks.filter(t => { const d = parseT(t.finished_at); return d && dayKey(d) === todayKey(); });
const finishedYesterday = tasks.filter(t => { const d = parseT(t.finished_at); return d && dayKey(d) === yKey; });
const ago = t => { const d = parseT(t); if (!d) return '—'; const m = Math.round((NOW - d.getTime()) / 60000); return m < 60 ? m + ' 分钟前' : Math.round(m / 60) + ' 小时前'; };
const sessToday = todaySessions.slice().sort((a, b) => String(b.last_active_at).localeCompare(String(a.last_active_at)));
const stLabel = st => `<span class="st st-${st}">${ZH[st]}</span>`;
const todayHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>今日进展</title><style>
body{font-family:"Microsoft YaHei",sans-serif;background:#f5f6f8;margin:0;padding:16px;color:#222}
h1{font-size:20px;margin:4px 0 2px}.sub{color:#777;font-size:12px;margin-bottom:12px}
.purpose{color:#555;font-size:13px;background:#fffbe6;border:1px solid #ffe58f;border-radius:6px;padding:6px 12px;margin:2px 0 14px}
.sum{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}.sum .s{background:#fff;border-radius:8px;padding:8px 14px;font-size:13px;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.sum .s b{font-size:18px;margin-right:4px}.s.red b{color:#d43}.s.green b{color:#187}.s.yellow b{color:#d90}
h2{font-size:15px;margin:18px 0 8px}
.sec{background:#fff;border-radius:8px;padding:12px 14px;box-shadow:0 1px 2px rgba(0,0,0,.06);margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{border-bottom:1px solid #eee;padding:6px 8px;text-align:left}
.r{color:#d43;font-weight:700}.y{color:#d90;font-weight:700}
.st{font-size:11px;border-radius:3px;padding:1px 6px;margin-left:6px;background:#eef}
.st-dev{background:#e3f2fd}.st-selftest{background:#e8f5e9}.st-review{background:#fff3e0}.st-merge_ready{background:#f3e5f5}.st-merged{background:#ede7f6}.st-deployed{background:#e0f2f1}.st-blocked{background:#ffebee;color:#c62828}
.mut{color:#999;font-size:12px}
.ok{color:#187}
footer{color:#aaa;font-size:11px;margin-top:12px}
</style></head><body>
<nav style="margin:10px 0 14px"><a href="/" style="background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:6px 14px;color:#1f2328;text-decoration:none;font-size:14px;font-weight:600">📌 今日进展</a>&nbsp;&nbsp;<a href="/taskboard.html" style="background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:6px 14px;color:#1f2328;text-decoration:none;font-size:14px;font-weight:600">📋 全景看板</a>&nbsp;&nbsp;<a href="/sessionboard.html" style="background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:6px 14px;color:#1f2328;text-decoration:none;font-size:14px;font-weight:600">👥 会话看板</a>&nbsp;&nbsp;<a href="/todo.md" style="background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:6px 14px;color:#1f2328;text-decoration:none;font-size:14px;font-weight:600">📝 任务清单</a></nav>
<h1>今日进展（站会三问）</h1><div class="purpose">本页解决：今天有没有事要处理——每天开屏第一眼。有红黄→按处置指引逐条处理；全绿→不用管。</div>
<div class="sub">${new Date().toLocaleString('zh-CN')} · 数据源 zz-agent-taskboard/data/taskboard.db</div>
<div class="sum">
<div class="s red"><b>${redCount}</b>阻碍（需处理）</div>
<div class="s yellow"><b>${yellowCount}</b>待关注</div>
<div class="s green"><b>${finishedToday.length}</b>今日完成</div>
<div class="s"><b>${activeTasks.length}</b>进行中</div>
<div class="s"><b>${startedToday.length}</b>今日开工</div>
<div class="s"><b>${todaySessions.length}</b>今日活跃会话</div>
</div>
<div class="sec"><h2>三问之一：有什么阻碍？（${redCount + yellowCount} 件，按处置指引处理后复绿）</h2>
${focusItems.length === 0 ? '<span class="ok">✔ 没有阻碍</span>' :
`<table><tr><th>级</th><th>问题</th><th>处置指引</th></tr>${focusItems.map(f => `<tr><td class="${f.lvl==='红'?'r':'y'}">${f.lvl}</td><td>${esc(f.text)}</td><td>${esc(f.act)}</td></tr>`).join('')}</table>`}
</div>
<div class="sec"><h2>三问之二：今天在干啥？（进行中 ${activeTasks.length} 件，按编号倒序）</h2>
${activeTasks.length === 0 ? '<span class="ok">✔ 当前没有进行中的任务</span>' :
`<table><tr><th>任务</th><th>标题</th><th>状态</th><th>认领</th><th>最后动作</th></tr>${activeTasks.map(t => `<tr><td>${esc(t.id)}</td><td>${esc(t.title.slice(0, 50))}</td><td>${stLabel(t.status)}</td><td>${esc(t.owner ?? '—')}</td><td class="mut">${ago(t.updated_at)}</td></tr>`).join('')}</table>`}
</div>
<div class="sec"><h2>三问之三：今天/昨天完成了啥？</h2>
<h2 style="margin-top:4px">今日完成 ${finishedToday.length} 件</h2>
${finishedToday.length === 0 ? '<span class="mut">今天还没有关闭任务</span>' :
`<table><tr><th>任务</th><th>标题</th><th>完成时间</th></tr>${finishedToday.map(t => `<tr><td>${esc(t.id)}</td><td>${esc(t.title.slice(0, 50))}</td><td class="mut">${esc(t.finished_at)}</td></tr>`).join('')}</table>`}
<h2>昨日完成 ${finishedYesterday.length} 件</h2>
${finishedYesterday.length === 0 ? '<span class="mut">昨天没有关闭任务</span>' :
`<table><tr><th>任务</th><th>标题</th><th>完成时间</th></tr>${finishedYesterday.map(t => `<tr><td>${esc(t.id)}</td><td>${esc(t.title.slice(0, 50))}</td><td class="mut">${esc(t.finished_at)}</td></tr>`).join('')}</table>`}
</div>
<div class="sec"><h2>今日活动流（倒序）</h2>
${evToday.length === 0 ? '<span class="mut">今天还没有任务事件（从明天起开工/交付/验收动作都会自动进流）</span>' :
`<table><tr><th>时间</th><th>任务</th><th>动作</th><th>执行者</th></tr>${evToday.slice(0, 40).map(e => `<tr><td class="mut">${esc(String(e.at).slice(11, 16))}</td><td>${esc(e.task_id)}</td><td>${esc(e.from_status ? ZH[e.from_status] + ' → ' : '')}${esc(ZH[e.to_status] ?? '')}${e.note ? ' · ' + esc(e.note.slice(0, 60)) : ''}</td><td class="mut">${esc(e.actor ?? '')}</td></tr>`).join('')}${evToday.length > 40 ? `<tr><td colspan="4" class="mut">… 其余 ${evToday.length - 40} 条略</td></tr>` : ''}</table>`}
</div>
<div class="sec"><h2>今日活跃会话（${sessToday.length} 个）</h2>
${sessToday.length === 0 ? '<span class="mut">无</span>' :
`<table><tr><th>会话</th><th>名称（工作区·任务）</th><th>最后活动</th><th>状态</th></tr>${sessToday.slice(0, 15).map(s => `<tr><td>${esc(String(s.dsh_id ?? s.id).slice(0, 8))}</td><td>${esc(sessName(s))}</td><td class="mut">${esc(String(s.last_active_at).slice(11, 16))}</td><td>${s.status === 'idle' ? '🟡 空转' : '🟢 活跃'}</td></tr>`).join('')}${sessToday.length > 15 ? `<tr><td colspan="4" class="mut">… 其余 ${sessToday.length - 15} 个见会话看板</td></tr>` : ''}</table>`}
</div>
<footer>zz-agent-taskboard · board.js 生成 · 全景看板 → <a href="taskboard.html">taskboard.html</a> · 会话看板 → <a href="sessionboard.html">sessionboard.html</a></footer>
</body></html>`;
writeFileSync(path.join(exportsDir, 'today.html'), todayHtml);

// ---------- --deploy：复制到 docs 仓库根（批 1⑤ 迁移用） ----------
if (process.argv.includes('--deploy')) {
  if (!existsSync(DOCS_ROOT)) {
    console.error(`[board] --deploy 目标不存在：${DOCS_ROOT}`);
    process.exit(1);
  }
  copyFileSync(path.join(exportsDir, 'todo.md'), path.join(DOCS_ROOT, 'todo.md'));
  copyFileSync(path.join(exportsDir, 'today.html'), path.join(DOCS_ROOT, 'today.html'));
  copyFileSync(path.join(exportsDir, 'taskboard.html'), path.join(DOCS_ROOT, 'taskboard.html'));
  copyFileSync(path.join(exportsDir, 'sessionboard.html'), path.join(DOCS_ROOT, 'sessionboard.html'));
  console.log(`[board] --deploy：todo.md/today.html/taskboard.html/sessionboard.html 已复制到 ${DOCS_ROOT}`);
}

console.log(`[board] 已生成 exports/：tasks.json、todo.md（${tasks.length} 行任务）、taskboard.html（断链 ${broken.length} 条）、sessionboard.html（${sessions.length} 会话）`);
db.close();

// ---------- --serve [port]：本地静态看板服务（node 内置 http，零依赖常驻） ----------
if (process.argv.includes('--serve')) {
  const portArg = process.argv[process.argv.indexOf('--serve') + 1];
  const port = Number(portArg) || 8970;
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]).replace(/\\/g, '/');
    const rel = urlPath === '/' ? 'today.html' : urlPath.replace(/^\//, '');
    const file = path.join(exportsDir, rel);
    if (!file.startsWith(exportsDir)) { res.writeHead(403); res.end('forbidden'); return; }
    try {
      const data = readFileSync(file);
      const ext = path.extname(file);
      res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html; charset=utf-8' : ext === '.json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8' });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[board] 今日进展（首页）：http://127.0.0.1:${port}/`);
    console.log(`[board] 全景看板：http://127.0.0.1:${port}/taskboard.html`);
    console.log(`[board] 会话看板：http://127.0.0.1:${port}/sessionboard.html`);
    console.log('[board] 服务常驻运行中，停止=关闭本进程（Ctrl+C）');
  });
}
