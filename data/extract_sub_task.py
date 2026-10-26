# -*- coding: utf-8 -*-
"""从子代理会话正文提取任务号：优先匹配「任务代号 **T<数字>」上下文。"""
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / 'data' / 'taskboard.db'
SESS = Path(os.path.expanduser('~')) / '.dsh' / 'sessions'
WS = '--C-Users-zhangyan-Documents-deepseek-harness-default-workspace--'

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row
rows = conn.execute("""
  SELECT s.id, s.dsh_id, st.title FROM session_stat st JOIN session s ON s.id = st.session_id
  WHERE st.title LIKE '%子代理%'
    AND st.at = (SELECT MAX(at) FROM session_stat st2 WHERE st2.session_id = st.session_id)
  ORDER BY s.id
""").fetchall()
print(f'子代理会话 {len(rows)} 个')

import zstandard as zstd
dctx = zstd.ZstdDecompressor()

TASK_RE = re.compile(r'任务代号\s*\**\s*T[-_]?(\d{1,3})')
ANY_T_RE = re.compile(r'\bT[-_]?(\d{2,3})\b')

def extract_t(dsh_id):
    uuid = str(dsh_id or '').removeprefix('session-')
    f = SESS / WS / uuid / 'session.v4.jsonl.zstd'
    if not f.exists():
        return None, '文件不存在'
    try:
        with open(f, 'rb') as fh:
            with dctx.stream_reader(fh) as rd:
                buf = bytearray()
                while len(buf) < 300_000:
                    chunk = rd.read(65536)
                    if not chunk:
                        break
                    buf.extend(chunk)
        text = buf.decode('utf-8', errors='replace')
        m = TASK_RE.search(text)
        task = m.group(1) if m else None
        ctx = text[max(0, m.start() - 40):m.end() + 40] if m else ''
        return task, ctx.replace('\n', ' ')
    except Exception as e:
        return None, f'解压失败 {e}'

for r in rows:
    task, ctx = extract_t(r['dsh_id'])
    print(f"\n{r['id']} | {r['dsh_id']}")
    print(f"  任务代号T: {task}")
    print(f"  上下文: {ctx[:160]}")
