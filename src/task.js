// src/task.js —— 任务治理唯一写库入口（事实类：任务/状态/门禁/commit/bug/验收）
// 用法:
//   node src/task.js add T68 --title "标题" [--status backlog] [--epic 行情链] [--priority 高]
//   node src/task.js move T68 review --by 会话@10-21 --note "L0 证据齐"
//   node src/task.js gate T68 compile "exit 0 @ ..."    (六灯: compile/tests/paradigm/reconcile/scan/deploy/scope)
//   node src/task.js commit T68 docs abc1234 --kind merge --message "..."
//   node src/task.js bug add T68 --title "..." [--severity P1]
//   node src/task.js bug fix BUG-1 --commit abc1234 --by 会话@10-21
//   node src/task.js item add T68 --item "..." --files '["a.md"]' [--section §2.1]
//   node src/task.js item done IT-1
//   node src/task.js accept add T68 --item "..." [--item-id IT-1] [--criterion "..."]
//   node src/task.js accept pass ACC-1 --evidence "..."
//   node src/task.js set T68 plan_doc "docs/方案/xxx.md"
//   node src/task.js show T68 | list [--status review] | check
// 纪律：本脚本是唯一写入口（R1）；一切状态迁移先过门禁（R3）；审计只追加（R4）。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(path.join(root, 'data'), { recursive: true });
const dbPath = path.join(root, 'data', 'taskboard.db');
if (!existsSync(dbPath)) {
  console.error('[task] data/taskboard.db 不存在，先跑 node src/init_db.js');
  process.exit(1);
}
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON;');

const now = () => new Date().toISOString();
const args = process.argv.slice(2);

// ---------- 状态机：11 态 + 2 ----------
const STATUS = ['backlog','plan','ready','dev','selftest','review','merge_ready','merged','deployed','closed','blocked','cancelled'];
const ZH = { backlog:'需求', plan:'方案', ready:'待开工', dev:'开发中', selftest:'自测中', review:'待验收', merge_ready:'待合并', merged:'已合并', deployed:'已部署', closed:'关闭', blocked:'阻塞', cancelled:'取消' };
// 允许迁移表 + 门禁函数（返回 null=通过，字符串=缺什么）
const GATES = {
  'backlog→plan':       () => null,
  'plan→ready':         t => t.approved_at ? null : '缺用户点头记录 approved_at（用户原话+时间）',
  'ready→dev':          t => (!t.owner || !t.branch) ? '缺 owner 认领或分支 branch' : null,
  'dev→selftest':       () => null,
  'selftest→review':    t => (t.compile && t.tests && t.paradigm && t.reconcile) ? null : '缺门禁灯：compile/tests/paradigm/reconcile 证据未齐',
  'review→merge_ready': t => (t.l2 === 'approved') ? null : '缺 L2 用户终审签字（task_review.l2=approved）',
  'merge_ready→merged': t => (t.mergeCommit ? null : '缺合并 commit（kind=merge 挂账）'),
  'merged→deployed':    t => (t.deploy ? null : '缺部署灯 deploy 证据'),
  'deployed→closed':    () => null,
  'closed→blocked':     () => null,
  'blocked→closed':     () => null,
  'review→dev':         () => null, // 打回返工
  'dev→blocked':        t => t.blocked_reason ? null : '阻塞必须填 blocked_reason',
  'selftest→blocked':   t => t.blocked_reason ? null : '阻塞必须填 blocked_reason',
  'ready→blocked':      t => t.blocked_reason ? null : '阻塞必须填 blocked_reason',
  'plan→blocked':       t => t.blocked_reason ? null : '阻塞必须填 blocked_reason',
  'blocked→dev':        () => null,
  'blocked→ready':      () => null,
  'blocked→plan':       () => null,
  'blocked→selftest':   () => null,
  'backlog→blocked':    t => t.blocked_reason ? null : '阻塞必须填 blocked_reason',
  'backlog→cancelled':  t => t.blocked_reason ? null : '取消必须给 note/blocked_reason 理由',
};

// ---------- 工具 ----------
function kv(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const nv = args[i + 1];
      if (nv === undefined || nv.startsWith('--')) { o[k] = true; }
      else { o[k] = nv; i++; }
    } else o._.push(a);
  }
  return o;
}
function nextId(prefix) {
  const key = `next_id_${prefix}`;
  db.exec('BEGIN');
  const r = db.prepare('SELECT value FROM meta WHERE key=?').get(key);
  const n = r ? parseInt(r.value, 10) + 1 : 1;
  db.prepare('INSERT INTO meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(key, String(n), now());
  db.exec('COMMIT');
  return `${prefix}-${n}`;
}
function taskView(t) {
  return {
    ...t,
    compile: t.compile, tests: t.tests, paradigm: t.paradigm, reconcile: t.reconcile, scan: t.scan, deploy: t.deploy, scope: t.scope,
    l2: t.l2, mergeCommit: t.mergeCommit,
  };
}
const FULL_TASK_SQL = `
SELECT t.*,
  g.compile, g.tests, g.paradigm, g.reconcile, g.scan, g.deploy, g.scope,
  r.l0, r.l1, r.l1_note, r.l2, r.l2_at,
  (SELECT c.commit_hash FROM task_commit c WHERE c.task_id=t.id AND c.kind='merge' LIMIT 1) AS mergeCommit
FROM task t LEFT JOIN task_gate g ON g.task_id=t.id LEFT JOIN task_review r ON r.task_id=t.id`;
const getTask = id => db.prepare(`${FULL_TASK_SQL} WHERE t.id=?`).get(id);
function audit(task_id, from, to, actor, note) {
  db.prepare('INSERT INTO task_event(task_id,at,from_status,to_status,actor,note) VALUES(?,?,?,?,?,?)').run(task_id, now(), from, to, actor, note ?? null);
}
function out(obj) { console.log(JSON.stringify(obj, null, 2)); }

// ---------- 子命令 ----------
const cmd = args[0];
const rest = args.slice(1);

if (cmd === 'add') {
  const o = kv(rest);
  const id = o._[0], title = o.title, status = o.status || 'backlog';
  if (!id || !title) { console.error('用法: task.js add T68 --title "..." [--status backlog] [--epic ...] [--priority 高]'); process.exit(1); }
  if (!STATUS.includes(status)) { console.error(`非法状态 ${status}，允许: ${STATUS.join('/')}`); process.exit(1); }
  if (title.length > 60) { console.error(`标题超 60 字（当前 ${title.length}）——todo 瘦身纪律`); process.exit(1); }
  db.prepare(`INSERT INTO task(id,title,status,epic,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
    .run(id, title, status, o.epic ?? null, o.priority ?? '中', now(), now());
  audit(id, null, status, o.by ?? '脚本', '建卡');
  out({ ok: true, id, status: ZH[status] });

} else if (cmd === 'move') {
  const o = kv(rest);
  const [id, to] = o._;
  const t = getTask(id);
  if (!t) { console.error(`任务 ${id} 不存在`); process.exit(1); }
  if (!STATUS.includes(to)) { console.error(`非法状态 ${to}`); process.exit(1); }
  const key = `${t.status}→${to}`;
  const gate = GATES[key];
  if (gate === undefined) { console.error(`非法迁移 ${t.status}(${ZH[t.status]}) → ${to}(${ZH[to]})`); process.exit(1); }
  const missing = gate(taskView(t));
  if (missing) { console.error(`[门禁拒绝] ${missing}`); process.exit(1); }
  // 返工两轮即停：review→dev 打回
  let fixRounds = t.fix_rounds;
  if (t.status === 'review' && to === 'dev') {
    fixRounds += 1;
    if (fixRounds > 2) { console.error('[两轮即停] 本工单已返工 2 轮，不再自动打回——请上报用户裁决'); process.exit(1); }
    db.prepare('UPDATE task SET fix_rounds=? WHERE id=?').run(fixRounds, id);
  }
  db.prepare('UPDATE task SET status=?, updated_at=?, started_at=COALESCE(started_at,?) , finished_at=CASE WHEN ?="closed" THEN ? ELSE finished_at END WHERE id=?')
    .run(to, now(), now(), to, now(), id);
  audit(id, t.status, to, o.by ?? '脚本', o.note ?? null);
  out({ ok: true, id, from: ZH[t.status], to: ZH[to], fix_rounds: fixRounds });

} else if (cmd === 'gate') {
  const o = kv(rest);
  const [id, lamp] = o._;
  const v = o._[2] ?? o.evidence;
  const lamps = ['compile','tests','paradigm','reconcile','scan','deploy','scope'];
  if (!lamps.includes(lamp)) { console.error(`灯名必须是: ${lamps.join('/')}`); process.exit(1); }
  if (!v) { console.error('用法: task.js gate T68 compile "证据原文"'); process.exit(1); }
  db.prepare(`INSERT INTO task_gate(task_id,${lamp}) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET ${lamp}=excluded.${lamp}`).run(id, v);
  out({ ok: true, id, lamp, evidence: v });

} else if (cmd === 'commit') {
  const o = kv(rest);
  const [id, repo, hash] = o._;
  if (!id || !repo || !hash) { console.error('用法: task.js commit T68 docs abc1234 [--kind merge] [--message ...]'); process.exit(1); }
  db.prepare('INSERT INTO task_commit(task_id,repo,commit_hash,message,kind,at,by_session) VALUES(?,?,?,?,?,?,?)')
    .run(id, repo, hash, o.message ?? null, o.kind ?? 'other', now(), o.by ?? null);
  out({ ok: true, id, repo, commit_hash: hash, kind: o.kind ?? 'other' });

} else if (cmd === 'bug') {
  const o = kv(rest);
  const sub = o._[0];
  if (sub === 'add') {
    const taskId = o._[1];
    if (!taskId || !o.title) { console.error('用法: task.js bug add T68 --title "..." [--severity P1]'); process.exit(1); }
    const bid = nextId('BUG');
    db.prepare('INSERT INTO bug(id,task_id,title,severity,status,found_at) VALUES(?,?,?,?,?,?)').run(bid, taskId, o.title, o.severity ?? 'P1', 'open', now());
    out({ ok: true, bug: bid, task: taskId });
  } else if (sub === 'fix') {
    const bid = o._[1];
    const b = db.prepare('SELECT * FROM bug WHERE id=?').get(bid);
    if (!b) { console.error(`bug ${bid} 不存在`); process.exit(1); }
    if (!o.commit) { console.error('修复必须挂 commit: --commit abc1234（勾稽：fixed 必挂修复 commit）'); process.exit(1); }
    if (b.status === 'fixed') { console.error(`bug ${bid} 已 fixed，重复修复请先核实`); process.exit(1); }
    db.prepare('UPDATE bug SET status=?, fixed_at=?, fix_commit=?, fix_session=?, fix_rounds=fix_rounds+1 WHERE id=?')
      .run('fixed', now(), o.commit, o.by ?? null, bid);
    out({ ok: true, bug: bid, status: 'fixed', fix_commit: o.commit });
  } else if (sub === 'verify') {
    const bid = o._[1];
    const b = db.prepare('SELECT * FROM bug WHERE id=?').get(bid);
    if (!b) { console.error(`bug ${bid} 不存在`); process.exit(1); }
    if (b.status !== 'fixed') { console.error(`bug ${bid} 未 fixed，不能 verify`); process.exit(1); }
    db.prepare('UPDATE bug SET status=? WHERE id=?').run('verified', bid);
    out({ ok: true, bug: bid, status: 'verified' });
  } else { console.error('用法: bug add|fix|verify ...'); process.exit(1); }

} else if (cmd === 'item') {
  const o = kv(rest);
  const sub = o._[0];
  if (sub === 'add') {
    const taskId = o._[1];
    if (!taskId || !o.item) { console.error('用法: task.js item add T68 --item "..." --files \'["a.md"]\' [--section §2.1]'); process.exit(1); }
    const iid = nextId('IT');
    db.prepare('INSERT INTO task_item(id,task_id,seq,item,files,status,plan_section) VALUES(?,?,?,?,?,?,?)')
      .run(iid, taskId, o.seq ?? 0, o.item, o.files ?? null, 'pending', o.section ?? null);
    out({ ok: true, item: iid, task: taskId });
  } else if (sub === 'done') {
    const iid = o._[1];
    if (!iid) { console.error('用法: task.js item done IT-1'); process.exit(1); }
    db.prepare("UPDATE task_item SET status='done' WHERE id=?").run(iid);
    out({ ok: true, item: iid, status: 'done' });
  } else { console.error('用法: item add|done ...'); process.exit(1); }

} else if (cmd === 'accept') {
  const o = kv(rest);
  const sub = o._[0];
  if (sub === 'add') {
    const taskId = o._[1];
    if (!taskId || !o.item) { console.error('用法: task.js accept add T68 --item "..." [--item-id IT-1] [--criterion ...]'); process.exit(1); }
    const aid = nextId('ACC');
    db.prepare('INSERT INTO accept_item(id,task_id,item_id,item,criterion,passed) VALUES(?,?,?,?,?,0)').run(aid, taskId, o['item-id'] ?? null, o.item, o.criterion ?? null);
    out({ ok: true, accept: aid, task: taskId });
  } else if (sub === 'pass') {
    const aid = o._[1];
    if (!aid || !o.evidence) { console.error('验收通过必须挂证据: --evidence "命令输出/对账表原文"（勾稽：pass 必有证据）'); process.exit(1); }
    db.prepare('UPDATE accept_item SET passed=1, evidence=? WHERE id=?').run(o.evidence, aid);
    out({ ok: true, accept: aid, passed: 1 });
  } else { console.error('用法: accept add|pass ...'); process.exit(1); }

} else if (cmd === 'set') {
  const [id, field, value] = rest;
  const allowed = ['title','epic','priority','owner','owner_session_id','req_id','plan_id','req_doc','plan_doc','approved_at','approved_by','branch','blocked_reason'];
  if (!allowed.includes(field)) { console.error(`字段 ${field} 不可直接 set，允许: ${allowed.join('/')}`); process.exit(1); }
  db.prepare(`UPDATE task SET ${field}=?, updated_at=? WHERE id=?`).run(value, now(), id);
  out({ ok: true, id, field, value });

} else if (cmd === 'review') {
  const [id, layer, verdict] = rest;
  const o = kv(rest.slice(2));
  if (layer === 'l1') { db.prepare('INSERT INTO task_review(task_id,l1,l1_note) VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET l1=excluded.l1, l1_note=excluded.l1_note').run(id, verdict, o.note ?? null); }
  else if (layer === 'l2') { db.prepare('INSERT INTO task_review(task_id,l2,l2_at) VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET l2=excluded.l2, l2_at=excluded.l2_at').run(id, verdict, now()); }
  else if (layer === 'l0') { db.prepare('INSERT INTO task_review(task_id,l0) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET l0=excluded.l0').run(id, verdict); }
  else { console.error('用法: task.js review T68 l0|l1|l2 结论 [--note ...]'); process.exit(1); }
  out({ ok: true, id, layer, verdict });

} else if (cmd === 'show') {
  const id = rest[0];
  const t = getTask(id);
  if (!t) { console.error(`任务 ${id} 不存在`); process.exit(1); }
  const items = db.prepare('SELECT * FROM task_item WHERE task_id=? ORDER BY seq').all(id);
  const bugs = db.prepare('SELECT * FROM bug WHERE task_id=?').all(id);
  const accepts = db.prepare('SELECT * FROM accept_item WHERE task_id=?').all(id);
  const commits = db.prepare('SELECT * FROM task_commit WHERE task_id=?').all(id);
  out({ task: t, 状态: ZH[t.status], items, bugs, accepts, commits });

} else if (cmd === 'list') {
  const o = kv(rest);
  const rows = o.status
    ? db.prepare('SELECT id,title,status,owner,priority FROM task WHERE status=? ORDER BY id').all(o.status)
    : db.prepare('SELECT id,title,status,owner,priority FROM task WHERE status NOT IN (\'closed\',\'cancelled\') ORDER BY id').all();
  out(rows.map(r => ({ id: r.id, 状态: ZH[r.status], title: r.title, owner: r.owner ?? '', priority: r.priority })));

} else if (cmd === 'check') {
  // 勾稽四查（断链=红灯；输出清单+计数）
  const broken = { 孤儿任务: [], 无证据验收通过: [], 无修复commit的bug: [], 状态与commit不符: [] };
  const orphans = db.prepare(`SELECT id,status FROM task WHERE status NOT IN ('backlog','plan','cancelled') AND plan_id IS NULL AND plan_doc IS NULL`).all();
  orphans.forEach(r => broken['孤儿任务'].push(`${r.id}(${ZH[r.status]}) 无方案挂账 plan_id/plan_doc`));
  db.prepare('SELECT id,task_id FROM accept_item WHERE passed=1 AND (evidence IS NULL OR evidence=\'\')').all()
    .forEach(r => broken['无证据验收通过'].push(`${r.id} 任务 ${r.task_id} passed 但无证据`));
  db.prepare('SELECT id,task_id FROM bug WHERE status=\'fixed\' AND (fix_commit IS NULL OR fix_commit=\'\')').all()
    .forEach(r => broken['无修复commit的bug'].push(`${r.id} 任务 ${r.task_id} fixed 但无修复 commit`));
  db.prepare(`SELECT id,status, (SELECT count(*) FROM task_commit c WHERE c.task_id=t.id AND c.kind='merge') AS mc, (SELECT count(*) FROM task_commit c WHERE c.task_id=t.id AND c.kind='deploy') AS dc FROM task t WHERE t.status IN ('merged','deployed','closed')`).all()
    .forEach(r => {
      if (r.status === 'merged' && r.mc === 0) broken['状态与commit不符'].push(`${r.id} 已合并但无 merge commit`);
      if ((r.status === 'deployed' || r.status === 'closed') && r.dc === 0) broken['状态与commit不符'].push(`${r.id} ${ZH[r.status]}但无 deploy commit`);
    });
  let total = 0; for (const k of Object.keys(broken)) total += broken[k].length;
  out({ 勾稽体检: total === 0 ? 'PASS 无断链' : `红灯 ${total} 条断链`, ...broken });

} else {
  console.error(`用法: node scripts/task.js add|move|gate|commit|bug|item|accept|set|review|show|list|check`);
  process.exit(1);
}
db.close();
