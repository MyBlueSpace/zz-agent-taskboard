// src/collect.js —— 会话观测采集（唯一写库入口②：观测类——活跃/空转/粗略水位）
// 数据源：~/.dsh/sessions/<工作区>/<UUID>/ 目录（LastWriteTime=最后活动；session 档案大小=粗略水位）
// 用法：
//   node src/collect.js                # 干跑：打印将采集的内容，不写库
//   node src/collect.js --write        # 采集并写库（session upsert + session_check 追加）
// 纪律：只写 session/session_check 两张观测表；阈值从 meta 表读（idle_warn_min=30，2026-10-28 拍板）。
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = path.join(root, 'data', 'taskboard.db');
if (!existsSync(dbPath)) {
  console.error('[collect] data/taskboard.db 不存在，先跑 node src/init_db.js');
  process.exit(1);
}
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON;');

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const doWrite = args.includes('--write');
const onlyWs = opt('workspace', 'all');

const nowIso = () => new Date().toISOString();
const idleWarnMin = Number(db.prepare("SELECT value FROM meta WHERE key='idle_warn_min'").get()?.value ?? 30);

// 工作区目录名 → 别名（实测 ~/.dsh/sessions 下的真实目录名）
const WS_ALIAS = {
  '--C-Users-zhangyan-.dsh-dsh_wechat--': 'dsh_wechat',
  '--C-Users-zhangyan-Documents-deepseek-harness-default-workspace--': 'default-workspace',
};
const aliasOf = dir => WS_ALIAS[dir] ?? dir.replace(/^--C-Users-[^-]+-/, '').replace(/--$/, '');

// 采集一个会话目录
function collectSession(wsDir, sessionDirName) {
  const dir = path.join(wsDir, sessionDirName);
  const st = statSync(dir);
  const lastActive = st.mtimeMs;
  const lastActiveMin = Math.round((Date.now() - lastActive) / 60000);
  let sizeKb = 0;
  try {
    for (const f of readdirSync(dir)) {
      try { sizeKb += statSync(path.join(dir, f)).size; } catch {}
    }
  } catch {}
  return {
    dsh_id: sessionDirName,
    workspace: aliasOf(wsDir ? path.basename(wsDir) : ''),
    last_active_at: new Date(lastActive).toISOString(),
    last_active_min: lastActiveMin,
    size_kb: Math.round(sizeKb / 1024),
    idle: lastActiveMin > idleWarnMin,
  };
}

// 读现有 session 表（dsh_id+workspace → S-xxx）
const idByKey = new Map();
for (const r of db.prepare('SELECT id, dsh_id, workspace FROM session').all()) {
  idByKey.set(`${r.dsh_id}|${r.workspace}`, r.id);
}

let nextSeq = Number((db.prepare("SELECT COALESCE(MAX(CAST(substr(id,3) AS INTEGER)),0) AS m FROM session WHERE id LIKE 'S-%'").get()?.m ?? 0)) + 1;

const SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions');
if (!existsSync(SESSIONS_ROOT)) {
  console.error('[collect] ~/.dsh/sessions 不存在');
  process.exit(1);
}
const rows = [];

for (const wsDirName of readdirSync(SESSIONS_ROOT)) {
  const wsDir = path.join(SESSIONS_ROOT, wsDirName);
  if (!statSync(wsDir).isDirectory()) continue;
  const ws = aliasOf(wsDirName);
  if (onlyWs !== 'all' && ws !== onlyWs) continue;
  for (const s of readdirSync(wsDir)) {
    const sd = path.join(wsDir, s);
    try {
      if (!statSync(sd).isDirectory()) continue;
      rows.push(collectSession(wsDir, s));
    } catch {}
  }
}

rows.sort((a, b) => b.last_active_min - a.last_active_min);

console.log(`[collect] 扫描 ${rows.length} 个会话（工作区过滤: ${onlyWs}；空转阈值 ${idleWarnMin} 分钟）`);
const idle = rows.filter(r => r.idle);
console.log(`[collect] 活跃 ${rows.length - idle.length} / 空转 ${idle.length}`);
if (idle.length) {
  console.log('[collect] 空转会话（距最后活动 >' + idleWarnMin + ' 分钟）：');
  for (const r of idle.slice(0, 20)) console.log(`  - ${r.workspace}/${r.dsh_id.slice(0, 12)}… ${r.last_active_min} 分钟前`);
}

if (!doWrite) {
  console.log('[collect] 干跑模式（未写库）。确认无误后加 --write 执行。');
  db.close();
  process.exit(0);
}

const upsert = db.prepare(`
  INSERT INTO session(id, dsh_id, workspace, last_active_at, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET last_active_at=excluded.last_active_at, status=excluded.status
`);
const insertCheck = db.prepare(
  'INSERT INTO session_check(session_id, at, last_active_min, context_pct, note) VALUES (?, ?, ?, NULL, ?)'
);

db.exec('BEGIN');
try {
  for (const r of rows) {
    const key = `${r.dsh_id}|${r.workspace}`;
    let id = idByKey.get(key);
    if (!id) { id = `S-${nextSeq++}`; idByKey.set(key, id); }
    const status = r.idle ? 'idle' : 'active';
    upsert.run(id, r.dsh_id, r.workspace, r.last_active_at, status, nowIso());
    insertCheck.run(id, nowIso(), r.last_active_min, `size=${r.size_kb}KB`);
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

console.log(`[collect] 已写库：session upsert ${rows.length} 条 + session_check 追加 ${rows.length} 条`);
db.close();
