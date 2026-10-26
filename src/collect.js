// src/collect.js —— 会话观测采集（唯一写库入口②：观测类——活跃/空转/水位/质量五维）
// 数据源：
//   1. ~/.dsh/sessions/<工作区>/<UUID>/ 目录（LastWriteTime=最后活动；档案大小=体量）
//   2. bili http://127.0.0.1:18787/__bili/sessions（title/上下文水位/token/压缩次数——会话质量唯一真源）
// 用法：
//   node src/collect.js                # 干跑：打印将采集的内容，不写库
//   node src/collect.js --write        # 采集并写库（session upsert + session_check 追加 + session_stat upsert）
// 纪律：只写 session/session_check/session_stat 三张观测表；阈值从 meta 表读（idle_warn_min=30，2026-10-28 拍板）。
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

// ---- bili 会话统计（唯一真源：标题/上下文水位/token/压缩次数）----
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const statByUuid = new Map();
try {
  const res = await fetch('http://127.0.0.1:18787/__bili/sessions', { headers: { 'User-Agent': UA } });
  if (res.ok) {
    const list = (await res.json()).sessions ?? [];
    for (const b of list) statByUuid.set(String(b.id).replace(/^session-/, ''), b);
    console.log(`[collect] bili 会话统计 ${list.length} 条（title/水位/token/压缩）`);
  } else {
    console.warn('[collect] bili API HTTP ' + res.status + '（会话质量维跳过）');
  }
} catch (e) {
  console.warn('[collect] bili API 不可用：' + e.message + '（会话质量维跳过）');
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
db.exec(`CREATE TABLE IF NOT EXISTS session_stat (
  session_id TEXT PRIMARY KEY REFERENCES session(id), title TEXT, context_tokens INTEGER,
  input_tokens INTEGER, cached_tokens INTEGER, output_tokens INTEGER, cache_hit_pct REAL,
  fold_count INTEGER, blocks INTEGER, requests INTEGER, live INTEGER, at TEXT
);`);
const upsertStat = db.prepare(`
  INSERT INTO session_stat(session_id, title, context_tokens, input_tokens, cached_tokens,
    output_tokens, cache_hit_pct, fold_count, blocks, requests, live, at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET title=excluded.title, context_tokens=excluded.context_tokens,
    input_tokens=excluded.input_tokens, cached_tokens=excluded.cached_tokens,
    output_tokens=excluded.output_tokens, cache_hit_pct=excluded.cache_hit_pct,
    fold_count=excluded.fold_count, blocks=excluded.blocks, requests=excluded.requests,
    live=excluded.live, at=excluded.at
`);

let statMatched = 0;
db.exec('BEGIN');
try {
  for (const r of rows) {
    const key = `${r.dsh_id}|${r.workspace}`;
    let id = idByKey.get(key);
    if (!id) { id = `S-${nextSeq++}`; idByKey.set(key, id); }
    const status = r.idle ? 'idle' : 'active';
    upsert.run(id, r.dsh_id, r.workspace, r.last_active_at, status, nowIso());
    insertCheck.run(id, nowIso(), r.last_active_min, `size=${r.size_kb}KB`);
    const b = statByUuid.get(String(r.dsh_id).replace(/^session-/, ''));
    if (b) {
      statMatched++;
      upsertStat.run(id, b.title ?? null, b.contextBest?.tokens ?? b.contextTokens ?? null,
        b.inputTokens ?? null, b.cachedTokens ?? null, b.outputTokens ?? null,
        b.cacheHitPct ?? null, b.foldCount ?? null, b.blocks ?? null,
        b.requests ?? null, b.live ? 1 : 0, nowIso());
    }
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

console.log(`[collect] 已写库：session upsert ${rows.length} 条 + session_check 追加 ${rows.length} 条 + session_stat upsert ${statMatched} 条（bili 匹配 ${statByUuid.size - statMatched} 条未对上 dsh_id）`);
db.close();
