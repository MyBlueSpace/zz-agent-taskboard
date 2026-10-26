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
//   node src/task.js review T68 l2 approved|rejected   (签字/打回，仅 review 态)
//   node src/task.js abandon T68 S-1                  (弃用原会话，任务回收待重派)
//   node src/task.js deliver T68 [--repo docs] --rerun-evidence "重跑命令输出原文"
// 纪律：本脚本是唯一写入口（R1）；一切状态迁移先过门禁（R3）；审计只追加（R4）。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
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

// ---------- git 验真工具（勾稽 4/7/8/9 对用；仓库不在则跳过该项） ----------
const REPOS = {
  docs: 'C:\\Users\\zhangyan\\Documents\\deepseek-harness\\default-workspace',
  java: 'C:\\Users\\zhangyan\\java_workspace\\zz-option-java',
  vue: 'C:\\Users\\zhangyan\\WebstormProjects\\zz-option-vue',
};
function gitIn(repo, gitArgs) {
  if (!REPOS[repo] || !existsSync(REPOS[repo])) return null;
  try {
    return execSync(`git ${gitArgs}`, { cwd: REPOS[repo], encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
  } catch { return null; }
}
const hasCommit = (repo, h) => (h && h !== 'legacy' ? (gitIn(repo, `cat-file -t ${h}`) ?? '').trim() === 'commit' : true);
const inOriginMain = (repo, h) => (h && h !== 'legacy' ? gitIn(repo, `merge-base --is-ancestor ${h} origin/main`) !== null : true);
const showStatFiles = (repo, h) => {
  const stat = gitIn(repo, `-c core.quotepath=false show --stat --stat-width=800 --stat-name-width=800 --format=%H ${h}`);
  if (stat == null) return null;
  const files = [];
  for (const ln of stat.split(/\r?\n/)) {
    const m = ln.match(/^\s*(\S.*?)\s+\|\s+\d+/);
    if (!m) continue;
    let p = m[1].trim();
    if (p.includes('=>')) p = p.slice(p.lastIndexOf('=>') + 1).trim().replace(/}$/, '').trim();
    files.push(p.replace(/\\/g, '/'));
  }
  return files;
};

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
  const allowed = ['title','epic','priority','owner','owner_session_id','req_id','plan_id','req_doc','plan_doc','approved_at','approved_by','branch','blocked_reason','started_at','finished_at'];
  if (!allowed.includes(field)) { console.error(`字段 ${field} 不可直接 set，允许: ${allowed.join('/')}`); process.exit(1); }
  db.prepare(`UPDATE task SET ${field}=?, updated_at=? WHERE id=?`).run(value, now(), id);
  out({ ok: true, id, field, value });

} else if (cmd === 'review') {
  const [id, layer, verdict] = rest;
  const o = kv(rest.slice(2));
  if (layer === 'l1') { db.prepare('INSERT INTO task_review(task_id,l1,l1_note) VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET l1=excluded.l1, l1_note=excluded.l1_note').run(id, verdict, o.note ?? null); }
  else if (layer === 'l2') {
    const t = getTask(id);
    if (!t) { console.error(`任务 ${id} 不存在`); process.exit(1); }
    if (!['approved', 'rejected'].includes(verdict)) { console.error('l2 结论只允许 approved（签）| rejected（打回）'); process.exit(1); }
    if (verdict === 'approved' && t.status !== 'review') { console.error(`[门禁拒绝] 签字仅限待验收 review 态任务，当前 ${ZH[t.status]}`); process.exit(1); }
    if (verdict === 'rejected' && !o.note) { console.error('打回必须写具体缺项 --note "..."（治理纪律：打回必须写具体缺项）'); process.exit(1); }
    db.prepare('INSERT INTO task_review(task_id,l2,l2_at) VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET l2=excluded.l2, l2_at=excluded.l2_at').run(id, verdict, now());
    audit(id, t.status, t.status, o.by ?? '用户', verdict === 'approved' ? '用户签字 sign' : `用户打回 l2-reject：${o.note}`);
  }
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
  // 勾稽 12 对（v2.0 · m01108 拍板；断链=红灯，输出清单+计数）
  const broken = { 孤儿需求: [], 清单无承接: [], 进度不符: [], 拆解漏改: [], 缺门禁灯: [], 扫描过期: [], commit验真失败: [], 未合并说合并: [], 线上版本不明: [], 无修复commit的bug: [], 修复无承接: [], 产出无账: [] };
  // 1 需求↔方案：挂需求但无方案且活跃=孤儿需求
  db.prepare(`SELECT id,status FROM task WHERE status NOT IN ('backlog','plan','cancelled','closed') AND (req_id IS NOT NULL OR req_doc IS NOT NULL) AND plan_id IS NULL AND plan_doc IS NULL`).all()
    .forEach(r => broken['孤儿需求'].push(`${r.id}(${ZH[r.status]}) 挂需求无方案`));
  // 2 方案↔任务：活跃任务有方案但文件级清单无拆解项承接
  db.prepare(`SELECT t.id,t.status,t.plan_doc FROM task t WHERE t.status NOT IN ('backlog','plan','cancelled','closed') AND t.plan_doc IS NOT NULL AND t.plan_doc NOT LIKE '豁免%' AND NOT EXISTS (SELECT 1 FROM task_event e WHERE e.task_id=t.id AND e.actor='存量迁移') AND (SELECT count(*) FROM task_item i WHERE i.task_id=t.id)=0`).all()
    .forEach(r => broken['清单无承接'].push(`${r.id}(${ZH[r.status]}) 方案 ${r.plan_doc} 无拆解项`));
  // 3 任务↔拆解：终态任务拆解未全 done
  db.prepare(`SELECT t.id,t.status,(SELECT count(*) FROM task_item i WHERE i.task_id=t.id) AS total,(SELECT count(*) FROM task_item i WHERE i.task_id=t.id AND i.status='done') AS done FROM task t WHERE t.status IN ('merged','deployed','closed')`).all()
    .forEach(r => { if (r.total > 0 && r.done < r.total) broken['进度不符'].push(`${r.id}(${ZH[r.status]}) 拆解 ${r.done}/${r.total} 未完成即终态`); });
  // 4 拆解↔git：拆解项声明文件 vs docs 仓库最新 commit 实际改动（声明了没改=漏改）
  for (const t of db.prepare(`SELECT id FROM task`).all()) {
    const rows = db.prepare(`SELECT id,files FROM task_item WHERE task_id=? AND files IS NOT NULL AND files!=''`).all(t.id);
    if (!rows.length) continue;
    const c = db.prepare(`SELECT commit_hash FROM task_commit WHERE task_id=? AND repo='docs' AND commit_hash!='legacy' ORDER BY at DESC LIMIT 1`).get(t.id);
    if (!c) continue;
    const changed = showStatFiles('docs', c.commit_hash);
    if (changed == null) continue;
    for (const it of rows) {
      let declared = [];
      try { declared = JSON.parse(it.files); } catch { continue; }
      // 跨端声明：仅 docs: 前缀参与 docs 仓库比对（py:/java:/vue: 端无对应 commit 挂账，跳过——存量诚实边界）
      const docsDeclared = declared.filter(f => f.startsWith('docs:')).map(f => f.slice(5));
      if (!docsDeclared.length) continue;
      const miss = docsDeclared.filter(f => !changed.includes(f) && !changed.some(x => x.endsWith(f)));
      if (miss.length) broken['拆解漏改'].push(`${t.id}/${it.id} 声明未改：${miss.join('、')}`);
    }
  }
  // 5 开发↔测试：过自测的任务四灯齐
  db.prepare(`SELECT t.id,t.status,g.compile,g.tests,g.paradigm,g.reconcile FROM task t LEFT JOIN task_gate g ON g.task_id=t.id WHERE t.status IN ('selftest','review','merge_ready','merged','deployed') AND NOT EXISTS (SELECT 1 FROM task_event e WHERE e.task_id=t.id AND e.actor='存量迁移')`).all()
    .forEach(r => { if (!(r.compile && r.tests && r.paradigm && r.reconcile)) broken['缺门禁灯'].push(`${r.id}(${ZH[r.status]}) 四灯未齐`); });
  // 6 测试↔扫描：scan 灯含 commit 但不在 origin/main
  db.prepare(`SELECT task_id,scan FROM task_gate WHERE scan IS NOT NULL AND scan!=''`).all().forEach(r => {
    const m = String(r.scan).match(/([0-9a-f]{7,40})/i);
    if (m && !inOriginMain('docs', m[1])) broken['扫描过期'].push(`${r.task_id} scan 凭证 commit ${m[1]} 不在 origin/main（合并前必须全量扫描 P0=0）`);
  });
  // 7 提交↔任务：commit hash 在对应仓库验真
  db.prepare(`SELECT task_id,repo,commit_hash FROM task_commit WHERE commit_hash!='legacy'`).all().forEach(r => {
    if (!hasCommit(r.repo, r.commit_hash)) broken['commit验真失败'].push(`${r.task_id} ${r.repo} ${r.commit_hash} 在仓库中不存在（伪造/抄错）`);
  });
  // 8 提交↔合并：merged 的 merge commit 必须在 origin/main
  db.prepare(`SELECT t.id,c.commit_hash FROM task t JOIN task_commit c ON c.task_id=t.id AND c.kind='merge' AND c.commit_hash!='legacy' WHERE t.status IN ('merged','deployed','closed')`).all().forEach(r => {
    if (!inOriginMain(r.repo ?? 'docs', r.commit_hash)) broken['未合并说合并'].push(`${r.id} merge commit ${r.commit_hash} 不在 origin/main`);
  });
  // 9 合并↔部署：deployed/closed 的 deploy commit 必须在 origin/main
  db.prepare(`SELECT t.id,c.repo,c.commit_hash FROM task t JOIN task_commit c ON c.task_id=t.id AND c.kind='deploy' AND c.commit_hash!='legacy' WHERE t.status IN ('deployed','closed')`).all().forEach(r => {
    if (!inOriginMain(r.repo ?? 'docs', r.commit_hash)) broken['线上版本不明'].push(`${r.id} deploy commit ${r.commit_hash} 不在 origin/main`);
  });
  // 10 bug↔任务：fixed 必挂修复 commit（保留）
  db.prepare(`SELECT id,task_id FROM bug WHERE status='fixed' AND (fix_commit IS NULL OR fix_commit='')`).all()
    .forEach(r => broken['无修复commit的bug'].push(`${r.id} 任务 ${r.task_id} fixed 但无修复 commit`));
  // 11 bug↔拆解：有修复 commit 的 bug 其任务必须有拆解项承接
  db.prepare(`SELECT b.id,b.task_id FROM bug b WHERE b.fix_commit IS NOT NULL AND b.fix_commit!=''`).all().forEach(r => {
    const n = db.prepare('SELECT count(*) AS c FROM task_item WHERE task_id=?').get(r.task_id).c;
    if (n === 0) broken['修复无承接'].push(`${r.id} 任务 ${r.task_id} 有修复但无拆解项承接`);
  });
  // 12 会话↔任务：活跃任务无 owner_session_id 挂账（会话勾稽断）
  db.prepare(`SELECT id,status,owner FROM task WHERE status IN ('dev','selftest','review','merge_ready') AND (owner_session_id IS NULL OR owner_session_id='') AND NOT EXISTS (SELECT 1 FROM task_event e WHERE e.task_id=task.id AND e.actor='存量迁移')`).all()
    .forEach(r => broken['产出无账'].push(`${r.id}(${ZH[r.status]}) 无执行会话挂账 owner_session_id`));
  let total = 0; for (const k of Object.keys(broken)) total += broken[k].length;
  out({ 勾稽体检: total === 0 ? 'PASS 无断链' : `红灯 ${total} 条断链`, ...broken });

} else if (cmd === 'deliver') {
  // deliver 五查（v2.0）：AI 说「完成」必须跑；任一不绿=拒收+缺失清单
  const o = kv(rest);
  const id = o._[0];
  const repo = o.repo || 'docs';
  const t = getTask(id);
  if (!t) { console.error(`任务 ${id} 不存在`); process.exit(1); }
  const missing = [];
  const checks = {};
  // 1 完整性清单核查（开发交付清单：四灯+commit 链+拆解+重跑证据）
  for (const lamp of ['compile', 'tests', 'paradigm', 'reconcile']) {
    checks[lamp] = Boolean(t[lamp]);
    if (!t[lamp]) missing.push(`门禁灯 ${lamp} 缺证据原文`);
  }
  const commits = db.prepare(`SELECT * FROM task_commit WHERE task_id=? AND repo=? AND commit_hash!='legacy' ORDER BY at`).all(id, repo);
  checks.commit链 = commits.length > 0;
  if (!commits.length) missing.push('无 commit 挂账（commit 链）');
  const items = db.prepare('SELECT * FROM task_item WHERE task_id=?').all(id);
  checks.拆解项 = items.length > 0;
  if (!items.length) missing.push('无拆解项（条款×状态矩阵缺失）');
  // 2 范围比对：docs 仓库最新 commit 实际改动 vs 拆解项 files 声明（越界+漏改）
  checks.范围比对 = '跳过（无 docs commit）';
  if (commits.length) {
    const latest = commits[commits.length - 1].commit_hash;
    const changed = showStatFiles('docs', latest);
    if (changed != null) {
      const declared = new Set();
      for (const it of items) { try { (JSON.parse(it.files || '[]')).forEach(f => declared.add(f)); } catch {} }
      const docsDeclared = [...declared].filter(f => f.startsWith('docs:')).map(f => f.slice(5));
      const extras = changed.filter(f => !docsDeclared.includes(f) && !docsDeclared.some(d => f.endsWith(d)) && /\.(md|js|ps1|py|java|vue|ts|json)$/.test(f));
      const miss = docsDeclared.filter(f => !changed.includes(f) && !changed.some(x => x.endsWith(f)));
      checks.范围比对 = { 实际改动文件数: changed.length, 声明数: declared.size, 越界: extras, 漏改: miss };
      if (extras.length) missing.push(`越界改动未声明：${extras.join('、')}`);
      if (miss.length) missing.push(`声明未改：${miss.join('、')}`);
    }
  }
  // 3 重跑必跑命令：机器不跨工程代跑（诚实边界），必须贴原文
  checks.重跑证据 = Boolean(o['rerun-evidence']);
  if (!o['rerun-evidence']) missing.push('重跑必跑命令的输出原文（--rerun-evidence "..."；必跑命令=docs:doc_health.ps1 / java:check_java_paradigm.ps1+单测 / vue:lint+test）');
  // 4 对账：reconcile 灯即对账证据（1 已查，此处复核非空且非占位）
  checks.对账 = Boolean(t.reconcile);
  // 5 证据核验：commit hash 验真
  const bad = commits.filter(c => !hasCommit(c.repo, c.commit_hash)).map(c => c.commit_hash);
  checks.commit验真 = bad.length === 0;
  if (bad.length) missing.push(`commit 验真失败：${bad.join('、')}`);
  const pass = missing.length === 0;
  out({ deliver: pass ? 'PASS 五查全绿，交付可受理' : '拒收：缺失清单如下', id, 缺失清单: missing, 五查: checks });
  if (!pass) process.exit(2);

} else if (cmd === 'abandon') {
  const [id, sid] = rest;
  const t = getTask(id);
  if (!t) { console.error(`任务 ${id} 不存在`); process.exit(1); }
  if (!t.owner && !t.owner_session_id) { console.error(`任务 ${id} 无执行会话，无需弃用`); process.exit(1); }
  db.prepare(`UPDATE task SET owner=NULL, owner_session_id=NULL, status='ready', blocked_reason=?, updated_at=? WHERE id=?`)
    .run(`原会话弃用（${t.owner ?? t.owner_session_id}，用户指令），待重派`, now(), id);
  audit(id, t.status, 'ready', sid ? `用户弃用 ${sid}` : '用户弃用', `弃用原会话 ${t.owner ?? t.owner_session_id}，任务回收待重派`);
  out({ ok: true, id, 回收: '待开工', 原会话: t.owner ?? t.owner_session_id });

} else if (cmd === 'migrate') {
  // 存量迁移（一次性）：读 data/migrate_todo.json 建卡；仅空库允许
  const cnt = db.prepare('SELECT count(*) AS c FROM task').get().c;
  if (cnt > 0) { console.error(`[migrate] task 表已有 ${cnt} 条，拒绝重复迁移`); process.exit(1); }
  const list = JSON.parse(readFileSync(path.join(root, 'data', 'migrate_todo.json'), 'utf8').replace(/^\uFEFF/, ''));
  const mapStatus = s => {
    const t = String(s || '').replace(/^\*+/, '').trim();
    if (/搁置/.test(t)) return 'cancelled';
    if (/阻塞|待拍板|待用户确认|待确认/.test(t)) return 'blocked';
    if (/待验收/.test(t)) return 'review';
    if (/合并 main.*部署中|已提交并合并 main|已完成并合并 main/.test(t)) return 'merged';
    if (/已完成|已上线|已部署并验证|对账已收口|完成并推送/.test(t)) return 'closed';
    if (/进行中|代码完成|代码与脚本完成|代码已提交|搬迁已完成|待做|待办/.test(t)) return 'dev';
    if (/未开始/.test(t)) return 'backlog';
    return 'backlog';
  };
  let ok = 0; const fails = []; const dist = {};
  for (const r of list) {
    const st = mapStatus(r.status);
    dist[st] = (dist[st] || 0) + 1;
    const title = String(r.title || '').trim() || '未命名任务';
    const pri = ['高', '中', '低'].includes(r.pri) ? r.pri : '中';
    try {
      db.prepare('INSERT INTO task(id,title,status,priority,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(r.id, title, st, pri, now(), now());
      audit(r.id, null, st, '存量迁移', String(r.status || '').slice(0, 200));
      const m = String(r.status || '').match(/owner[:：]\s*([^）)\s]+)/);
      if (m) db.prepare('UPDATE task SET owner=? WHERE id=?').run(m[1].trim(), r.id);
      if (r.start && r.start !== '—') db.prepare('UPDATE task SET started_at=? WHERE id=?').run(String(r.start), r.id);
      if (st === 'closed' && r.fin && r.fin !== '—') db.prepare('UPDATE task SET finished_at=? WHERE id=?').run(String(r.fin), r.id);
      if (st === 'closed') db.prepare(`INSERT INTO task_commit(task_id,repo,commit_hash,message,kind,at,by_session) VALUES(?,?,?,?,?,?,?)`).run(r.id, 'docs', 'legacy', '存量迁移：历史部署 commit 未结构化留存', 'deploy', now(), '存量迁移');
      if (st === 'merged') db.prepare(`INSERT INTO task_commit(task_id,repo,commit_hash,message,kind,at,by_session) VALUES(?,?,?,?,?,?,?)`).run(r.id, 'docs', 'legacy', '存量迁移：历史合并 commit 未结构化留存', 'merge', now(), '存量迁移');
      ok++;
    } catch (e) { fails.push(`${r.id}: ${e.message}`); }
  }
  out({ ok: fails.length === 0, migrated: ok, total: list.length, dist, fails });

} else if (cmd === 'migrate-plan') {
  // 存量补挂账（一次性）：从 docs 仓库 todo.md 内容列提取 docs/*.md 路径回填 plan_doc
  const TODO_MD = 'C:\\Users\\zhangyan\\Documents\\deepseek-harness\\default-workspace\\todo.md';
  const raw = readFileSync(TODO_MD, 'utf8');
  const rows = {};
  for (const ln of raw.split(/\r?\n/)) {
    const m = ln.match(/^\|\s*(T\d+)\s*\|/);
    if (!m) continue;
    const cells = ln.split(/(?<!\\)\|/);
    const content = (cells[2] || '');
    const pm = content.match(/docs[\\/][^\s，。；）】、|]+?\.md/);
    if (pm) rows[m[1]] = pm[0].replace(/\\/g, '/');
  }
  let filled = 0; const misses = [];
  for (const t of db.prepare('SELECT id,status FROM task').all()) {
    if (rows[t.id]) { db.prepare('UPDATE task SET plan_doc=? WHERE id=?').run(rows[t.id], t.id); filled++; }
    else if (!['backlog', 'plan', 'cancelled', 'closed'].includes(t.status)) misses.push(t.id);
  }
  out({ ok: true, 补挂账: filled, 活跃无方案: misses });

} else {
  console.error(`用法: node scripts/task.js add|move|gate|commit|bug|item|accept|set|review|show|list|check`);
  process.exit(1);
}
db.close();
