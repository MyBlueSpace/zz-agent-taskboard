// scripts/init_db.js —— 建库+建表（幂等：已存在则跳过建表，仅补缺失表）
// 用法: node scripts/init_db.js
// 数据源唯一真相库：ops/taskboard.db（SQLite，单文件，本机唯一写入口见 task.js/collect.js）
// 勾稽引用字段：task.req_id/plan_id/owner_session_id、bug.task_id/fix_commit、accept_item.item_id、task_item.task_id
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(path.join(root, 'ops'), { recursive: true });
const db = new DatabaseSync(path.join(root, 'ops', 'taskboard.db'));

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 任务（工单）。id 沿用 todo.md 的 T 编号；上游勾稽：req_id/plan_id；会话勾稽：owner_session_id
CREATE TABLE IF NOT EXISTS task (
  id               TEXT PRIMARY KEY,          -- T-xxx
  title            TEXT NOT NULL,             -- ≤60 字
  status           TEXT NOT NULL DEFAULT 'backlog',  -- backlog/plan/ready/dev/selftest/review/merge_ready/merged/deployed/closed/blocked/cancelled
  epic             TEXT,                      -- 任务链
  priority         TEXT DEFAULT '中',
  owner            TEXT,                      -- 会话@日期（认领）
  owner_session_id TEXT,                      -- 勾稽：S-xxx
  req_id           TEXT,                      -- 勾稽上游：REQ-xxx
  plan_id          TEXT,                      -- 勾稽上游：PLAN-xxx
  req_doc          TEXT,                      -- 需求文档路径
  plan_doc         TEXT,                      -- 方案文档路径
  approved_at      TEXT,                      -- 用户点头时间
  approved_by      TEXT,                      -- 用户点头原话引用
  branch           TEXT,
  blocked_reason   TEXT,
  fix_rounds       INTEGER NOT NULL DEFAULT 0,
  started_at       TEXT,
  finished_at      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- 任务拆解项（文件级清单）。勾稽：task_id；files=声明改动文件（JSON 数组），供账实相符查比对 git
CREATE TABLE IF NOT EXISTS task_item (
  id           TEXT PRIMARY KEY,              -- IT-xxx
  task_id      TEXT NOT NULL REFERENCES task(id),
  seq          INTEGER NOT NULL DEFAULT 0,
  item         TEXT NOT NULL,
  files        TEXT,                          -- JSON 数组
  status       TEXT NOT NULL DEFAULT 'pending', -- pending/done
  plan_section TEXT                           -- 对应方案条款
);

-- 缺陷。勾稽：task_id；fixed 必挂 fix_commit（账实相符查）
CREATE TABLE IF NOT EXISTS bug (
  id          TEXT PRIMARY KEY,               -- BUG-xxx
  task_id     TEXT NOT NULL REFERENCES task(id),
  title       TEXT NOT NULL,
  severity    TEXT DEFAULT 'P1',              -- P0/P1/P2
  status      TEXT NOT NULL DEFAULT 'open',   -- open/fixed/verified
  found_at    TEXT,
  fixed_at    TEXT,
  fix_commit  TEXT,                           -- 勾稽：修复 commit
  fix_session TEXT,                           -- 勾稽：修复会话
  fix_rounds  INTEGER NOT NULL DEFAULT 0
);

-- 验收项。勾稽：item_id（对应拆解项）；pass 必挂 evidence（账实相符查）
CREATE TABLE IF NOT EXISTS accept_item (
  id        TEXT PRIMARY KEY,                 -- ACC-xxx
  task_id   TEXT NOT NULL REFERENCES task(id),
  item_id   TEXT REFERENCES task_item(id),
  item      TEXT NOT NULL,
  criterion TEXT,
  passed    INTEGER NOT NULL DEFAULT 0,       -- 0 未过 / 1 通过
  evidence  TEXT                              -- 命令输出/对账表原文
);

-- 门禁六灯+范围灯。scope_files=git diff 实际改动文件（JSON），与 task_item.files 比对
CREATE TABLE IF NOT EXISTS task_gate (
  task_id     TEXT PRIMARY KEY REFERENCES task(id),
  compile     TEXT,
  tests       TEXT,
  paradigm    TEXT,
  reconcile   TEXT,
  scan        TEXT,
  deploy      TEXT,
  scope       TEXT,
  scope_files TEXT
);

-- 三端 commit 链。kind=first/gate/merge/deploy/other；deploy commit 回答「线上跑的是哪版」
CREATE TABLE IF NOT EXISTS task_commit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id   TEXT NOT NULL REFERENCES task(id),
  repo      TEXT NOT NULL,                    -- java/vue/docs
  commit_hash TEXT NOT NULL,
  message   TEXT,
  kind      TEXT DEFAULT 'other',
  at        TEXT,
  by_session TEXT
);

-- 三层验收。L0 脚本复核 / L1 Pro 审查 / L2 用户终审
CREATE TABLE IF NOT EXISTS task_review (
  task_id  TEXT PRIMARY KEY REFERENCES task(id),
  l0       TEXT,
  l1       TEXT,
  l1_note  TEXT,
  l2       TEXT,
  l2_at    TEXT
);

-- 审计（只 INSERT 不 UPDATE/DELETE）
CREATE TABLE IF NOT EXISTS task_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL,
  at          TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  actor       TEXT,                           -- 会话@日期 / 用户 / 脚本
  note        TEXT
);

-- 会话（AI 员工）。dsh_id 映射 ~/.dsh/sessions 的 UUID
CREATE TABLE IF NOT EXISTS session (
  id              TEXT PRIMARY KEY,           -- S-xxx
  dsh_id          TEXT,
  workspace       TEXT,
  model           TEXT,
  role            TEXT,
  created_at      TEXT,
  last_active_at  TEXT,
  status          TEXT DEFAULT 'active'       -- active/idle/done/error
);

-- 会话观测时间序列（collect.js 挂点采集）
CREATE TABLE IF NOT EXISTS session_check (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL REFERENCES session(id),
  at              TEXT NOT NULL,
  last_active_min INTEGER,                    -- 距最后活动分钟数（空转判定）
  context_pct     REAL,                       -- 上下文水位
  compressed      INTEGER DEFAULT 0,
  task_count      INTEGER DEFAULT 0,
  note            TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_status   ON task(status);
CREATE INDEX IF NOT EXISTS idx_task_item_t   ON task_item(task_id);
CREATE INDEX IF NOT EXISTS idx_bug_task      ON bug(task_id);
CREATE INDEX IF NOT EXISTS idx_accept_task   ON accept_item(task_id);
CREATE INDEX IF NOT EXISTS idx_commit_task   ON task_commit(task_id);
CREATE INDEX IF NOT EXISTS idx_event_task    ON task_event(task_id);
CREATE INDEX IF NOT EXISTS idx_check_session ON session_check(session_id, at);
`;

db.exec(SCHEMA);

const now = new Date().toISOString();
const meta = db.prepare('INSERT OR IGNORE INTO meta(key, value, updated_at) VALUES (?, ?, ?)');
// 阈值默认值（2026-10-28 m00161 拍板）
meta.run('idle_warn_min', '30', now);      // 空转黄灯=30 分钟无活动
meta.run('stall_red_min', '60', now);      // 卡门红灯=状态停留超 1 小时
meta.run('context_warn_pct', '25', now);   // 上下文水位提醒线 25 万 token（bili 25% 提醒线）
meta.run('schema_version', '1', now);

const count = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get();
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
console.log(`[init_db] OK: ops/taskboard.db 就绪，业务表 ${count.n} 张：${tables.join(', ')}`);
console.log('[init_db] 阈值（meta）：空转黄灯 30 分钟 / 卡门红灯 60 分钟 / 上下文水位提醒 25%');
db.close();
