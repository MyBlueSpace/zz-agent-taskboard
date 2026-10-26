import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(path.join(root, 'data', 'taskboard.db'));

console.log('--- dev 任务按 updated_at DESC ---');
db.prepare("SELECT id, status, substr(COALESCE(updated_at,'NULL'),1,19) AS up, substr(COALESCE(created_at,'NULL'),1,19) AS cr FROM task WHERE status='dev' ORDER BY COALESCE(updated_at, created_at, '') DESC").all()
  .slice(0, 15).forEach(r => console.log(`${r.id} | up=${r.up} | cr=${r.cr}`));

console.log('\n--- T202/T203/T204 时间戳 ---');
db.prepare("SELECT id, updated_at, created_at, owner_session_id FROM task WHERE id IN ('T202','T203','T204','T196','T168','T200')").all()
  .forEach(r => console.log(`${r.id} | up=${r.updated_at} | cr=${r.created_at} | sess=${r.owner_session_id}`));
