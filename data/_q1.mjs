import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/taskboard.db');
const rows = db.prepare(`SELECT id,title,status,owner,owner_session_id,updated_at,started_at FROM task WHERE status IN ('dev','selftest','review','merge_ready') ORDER BY COALESCE(updated_at,created_at,'') DESC, id DESC LIMIT 30`).all();
rows.forEach(r => console.log([r.id, r.status, 'owner=' + (r.owner ?? '∅'), 'sess=' + (r.owner_session_id ?? '∅'), 'upd=' + (r.updated_at ?? '∅'), r.title.slice(0, 40)].join(' | ')));
db.close();
