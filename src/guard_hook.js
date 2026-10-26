#!/usr/bin/env node
// 档 B 事前拦截 hook（2026-10-26 m01488「全部开工」+m01558「选 C」拍板）
// 挂载于 @deepseek-ai/dsh-hooks-claude-code 的 PreToolUse（matcher=write|edit）。
// 决策协议：stdout 输出 JSON {"decision":"deny"|"allow","reason":"..."}；无输出/{} 视为放行。
// 规则（只拦「已挂任务的会话」的「清单外 write/edit」，其余一律放行）：
//   1. 工具不是 write/edit → 放行
//   2. 会话未挂任务（session_id 查不到 task.owner_session_id）→ 放行（游离会话由档 A 汇总监控）
//   3. file_path 命中 task_item.files 清单（该任务的）→ 放行
//   4. 命中豁免名单（治理工程自身文件/通用纪律文档）→ 放行
//   5. 其余 → deny，reason 告知模型先补登记（task.js item add）再写
import { readFileSync, appendFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 执行日志：每次被 DSH 调用写一行（验证 hook 加载/审计用；2026-10-26 重启后验证档 B 生效）
const GUARD_LOG = join(process.env.USERPROFILE || '', '.dsh', 'logs', 'guard_hook.log');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB = join(ROOT, 'data', 'taskboard.db');

let payload = null;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch (e) {
  console.log(JSON.stringify({ decision: 'allow' }));  // 读不到 payload 不放行就阻塞所有会话，宁可放行（档 A 兜底）
  process.exit(0);
}

const toolName = payload.tool_name || '';
try {
  appendFileSync(GUARD_LOG, `${new Date().toISOString()} tool=${toolName} session=${payload.session_id || ''}\n`, 'utf8');
} catch (e) { /* 日志失败不影响决策 */ }
if (toolName !== 'write' && toolName !== 'edit') {
  console.log(JSON.stringify({ decision: 'allow' }));
  process.exit(0);
}

const filePath = ((payload.tool_input && (payload.tool_input.file_path || payload.tool_input.path)) || '').toString()
  .replace(/\\/g, '/').toLowerCase();

let db;
try {
  db = new DatabaseSync(DB, { readOnly: true });
} catch (e) {
  console.log(JSON.stringify({ decision: 'allow' }));  // 库打不开→放行（档 A 兜底），不因监控故障阻塞开发
  process.exit(0);
}

const sessionId = (payload.session_id || '').toString().replace(/^session-/, '');
let taskRow;
try {
  const sid = sessionId ? db.prepare('SELECT id FROM session WHERE dsh_id = ? OR dsh_id = ? LIMIT 1').get(sessionId, 'session-' + sessionId) : undefined;
  taskRow = sid
    ? db.prepare('SELECT id FROM task WHERE owner_session_id = ? LIMIT 1').get(sid.id)
    : undefined;
} catch (e) {
  taskRow = undefined;
}
if (!taskRow) {
  console.log(JSON.stringify({ decision: 'allow' }));  // 未挂任务会话
  process.exit(0);
}

// 豁免名单：治理工程自身 + 通用纪律文档
const GLOBAL_ALLOW = [
  'c:/users/zhangyan/documents/zz-agent-taskboard/',
  'docs/agents.md', 'docs/方案/agents细则-红线卡.md',
  'docs/方案/agents细则-开工与落账.md', 'docs/方案/agents细则-开发与门禁.md',
];
if (GLOBAL_ALLOW.some(p => filePath.startsWith(p))) {
  console.log(JSON.stringify({ decision: 'allow' }));
  process.exit(0);
}

// 该任务清单
const rows = db.prepare('SELECT files FROM task_item WHERE task_id = ? AND files IS NOT NULL').all(taskRow.id);
let allowed = false;
for (const r of rows) {
  let files = [];
  try { files = JSON.parse(r.files); } catch (e) { continue; }
  for (const f of files) {
    const norm = String(f).replace(/\\/g, '/').toLowerCase();
    // 支持端前缀 docs:/java:/vue:/py: 与纯相对路径；比对规则=目标路径以清单项结尾
    if (filePath.endsWith(norm) || filePath.endsWith(norm.replace(/^(docs|java|vue|py):\s*/, ''))) {
      allowed = true;
      break;
    }
  }
  if (allowed) break;
}

if (allowed) {
  console.log(JSON.stringify({ decision: 'allow' }));
} else {
  console.log(JSON.stringify({
    decision: 'deny',
    reason: `档 B 拦截：你要写/改的文件「${filePath}」不在任务 ${taskRow.id} 的拆解清单里。先登记再写：task.js item add ${taskRow.id} 该文件路径。若确认属于本任务但漏拆解，补登记即可放行。`,
  }));
}
process.exit(0);
