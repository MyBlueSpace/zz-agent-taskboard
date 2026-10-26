// 给 session 表加 task_id 列并挂账左侧工作区 7 个会话（一次性）
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(path.join(root, 'data', 'taskboard.db'));

// 1) 加列（已存在则忽略）
try {
  db.exec('ALTER TABLE session ADD COLUMN task_id TEXT');
  console.log('已加列 session.task_id');
} catch (e) {
  console.log('列已存在或加列失败:', e.message);
}

// 2) 左侧工作区（zz-option）会话 → 任务挂账
const map = [
  ['S-1202', 'T202'], // K线翻桶异常与CPU卡顿诊断
  ['S-1173', 'T203'], // AI开发多任务调度最佳实践
  ['S-1148', 'T204'], // AI稳定性差与上下文过长
  ['S-1161', 'T196'], // 修正review结果
  ['S-1165', 'T168'], // 回测回放实盘
  ['S-1167', 'T200'], // T200 数据湖「增量导入/取消」
  ['S-1163', 'T200'], // K线初始化和增量导入
];
for (const [sid, tid] of map) {
  const r = db.prepare('UPDATE session SET task_id=? WHERE id=?').run(tid, sid);
  console.log(`${sid} → ${tid}  updated=${r.changes}`);
}

// 3) 对照任务.owner_session_id 也保持一致（主会话挂账）
db.prepare("UPDATE task SET owner_session_id='S-1167' WHERE id='T200'").run();

console.log('\n--- 验证：会话 task_id ---');
db.prepare("SELECT id, task_id, substr(dsh_id,1,13) dsh FROM session WHERE task_id IS NOT NULL ORDER BY id").all()
  .forEach(r => console.log(`${r.id} | ${r.task_id} | ${r.dsh}`));
