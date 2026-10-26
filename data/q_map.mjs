// 精简查询：按 bili 短 id 片段找 S 编号（一次性）
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(path.join(root, 'data', 'taskboard.db'));

const marks = ['904c5fac', '4bd83d0f', '002c0', '1fa63', 'a53d5e55', 'a6ad8', '83322', '9bfb7', '9ded6', 'a9050', '334f3252', 'd79b1b4b', 'd6a77acd'];
console.log('--- 按 bili 短 id 片段匹配 S 编号 ---');
for (const m of marks) {
  const rows = db.prepare(`SELECT id, dsh_id, workspace FROM session WHERE dsh_id LIKE ?`).all(`%${m}%`);
  if (rows.length === 0) console.log(`${m} -> 未匹配`);
  else rows.forEach(r => console.log(`${m} -> ${r.id} | ${r.dsh_id} | ${r.workspace}`));
}

console.log('\n--- 活跃任务（dev/selftest/review/merge_ready/blocked）---');
db.prepare(`SELECT id,title,status,owner_session_id FROM task WHERE status IN ('dev','selftest','review','merge_ready','blocked') ORDER BY id`).all()
  .forEach(r => console.log(`${r.id} | ${r.status} | sess=${r.owner_session_id ?? '-'} | ${r.title.slice(0, 36)}`));
