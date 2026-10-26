# -*- coding: utf-8 -*-
"""一次性：查 T200/T189/T190/T196/T168 等状态"""
import json, sys, sqlite3
sys.stdout.reconfigure(encoding='utf-8')

db = sqlite3.connect(r"C:\Users\zhangyan\Documents\zz-agent-taskboard\data\taskboard.db")
rows = db.execute("SELECT id, title, status, owner_session_id FROM task WHERE id IN ('T200','T189','T190','T196','T168','T107','T97','T108') ORDER BY id").fetchall()
for r in rows:
    print(f'{r[0]:6s} [{r[2]:8s}] sess={str(r[3] or "-"):8s} {r[1][:64]}')
db.close()
