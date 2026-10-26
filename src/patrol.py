#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
档 A 事中巡检（2026-10-26 m01488「全部开工」+m01558「选 C」拍板）
职责：扫活跃会话文件（~/.dsh/sessions/<docs工作区>/<UUID>/session.v4.jsonl.zstd）
      → 解压取 tool/call（有工具名+完整 arguments）+tool/result（按 callId 配对）
      → 从 arguments 提取「准备操作的文件路径」→ 与 taskboard.db 的 task_item.files 清单比对
      → 清单外文件=偏离告警：写类红灯 stray_write / 读类黄灯 stray_read → 写 dev_alerts + 可选飞书（只推红灯）。
      → 未挂任务的活跃会话=游离，只汇总一行（free），不逐文件报。

运行：python src/patrol.py             # 干跑（只输出）
      python src/patrol.py --write     # 写 dev_alerts（stray 类入库，free 不写库）
      python src/patrol.py --write --feishu   # 写库+飞书推红灯
频率：建议每 60 秒一轮（后台任务）。
"""
import re, sys, json, sqlite3, time, urllib.parse, urllib.request
from pathlib import Path

if sys.stdout and hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / 'data' / 'taskboard.db'
SESSIONS = Path(r'C:\Users\zhangyan\.dsh\sessions\--C-Users-zhangyan-Documents-deepseek-harness-default-workspace--')
IDLE_MIN = 30          # 活跃判定：目录最后写入 ≤ 30 分钟
WRITE_TOOLS = {'write', 'edit'}
READ_TOOLS = {'read', 'grep', 'glob', 'read_image'}
# 绝对路径 C:\... 或 C:/...
ABS_RE = re.compile(r'([A-Za-z]:[\\/][^\s，。；"\'<>|]+?\.(?:java|vue|ts|js|py|md|yml|yaml|json|xml|sql|html|css|ps1|mjs))')
# 相对路径 docs/... src/... scripts/...
REL_RE = re.compile(r'((?:docs|src|scripts|deploy)[\\/][^\s，。；"\'<>|]+?\.(?:java|vue|ts|js|py|md|yml|yaml|json|xml|sql|html|css|ps1|mjs))')

def db():
    c = sqlite3.connect(str(DB))
    c.row_factory = sqlite3.Row
    return c

def load_allowlist():
    """允许清单=task_item.files（去端前缀）+通用纪律文档（AGENTS/红线卡/细则）"""
    c = db()
    rows = c.execute('SELECT files FROM task_item WHERE files IS NOT NULL').fetchall()
    c.close()
    allowed = {'docs/agents.md', 'docs/方案/agents细则-红线卡.md', 'docs/方案/agents细则-开工与落账.md',
               'docs/方案/agents细则-开发与门禁.md'}
    for r in rows:
        try:
            for f in json.loads(r['files']):
                f = str(f).strip()
                m = re.match(r'^(?:docs|java|vue|py):\s*', f)
                if m:
                    f = f[m.end():].lstrip('/\\')
                allowed.add(f.replace('\\', '/').lower())
        except Exception:
            pass
    return allowed

def active_sessions():
    now = time.time()
    out = []
    if not SESSIONS.exists():
        return out
    for d in SESSIONS.iterdir():
        if not d.is_dir():
            continue
        f = d / 'session.v4.jsonl.zstd'
        if not f.exists():
            continue
        age_min = (now - f.stat().st_mtime) / 60
        if age_min <= IDLE_MIN:
            out.append((d.name, age_min, f))
    return out

def session_actions(session_file):
    """解析会话文件 → [(tool_name, touched_paths, args_raw)]，按 callId 配对 call/result"""
    import zstandard
    actions = []
    calls = {}
    try:
        with open(session_file, 'rb') as fh:
            data = zstandard.ZstdDecompressor().stream_reader(fh).read()
    except Exception as e:
        return actions, str(e)
    for line in data.splitlines():
        try:
            o = json.loads(line)
        except Exception:
            continue
        t = o.get('type')
        if t == 'tool/call':
            d = o.get('data') or {}
            calls[d.get('callId')] = {'name': d.get('name') or '', 'arguments': d.get('arguments') or ''}
        elif t == 'tool/result':
            d = o.get('data') or {}
            m = d.get('message') or {}
            cid = m.get('toolCallId') or d.get('toolCallId')
            c = calls.pop(cid, {})
            name = c.get('name') or ''
            args = c.get('arguments') or ''
            content = m.get('content') or []
            text = ''
            for part in content:
                if isinstance(part, dict) and part.get('type') == 'text':
                    text += str(part.get('text', ''))
            if name in WRITE_TOOLS or name in READ_TOOLS or name in ('bash',):
                touched = set()
                for src in (args, text):
                    for mm in ABS_RE.finditer(src):
                        touched.add(mm.group(1).replace('\\', '/').lower())
                    for mm in REL_RE.finditer(src):
                        touched.add(mm.group(0).replace('\\', '/').lower())
                if touched:
                    actions.append((name, sorted(touched), args[:200]))
    return actions, None

def feishu_push(message):
    webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/1cf16f81-9be8-4290-b3c1-03530fb1de71'
    secret = 'PbO3tVQZMb3uGN8ww1kcEb'
    ts = str(int(time.time()))
    import hmac, hashlib, base64
    sign = urllib.parse.quote_plus(base64.b64encode(
        hmac.new((ts + '\n' + secret).encode(), digestmod=hashlib.sha256).digest()))
    body = json.dumps({'timestamp': ts, 'sign': sign, 'msg_type': 'text', 'content': {'text': message}}).encode()
    req = urllib.request.Request(webhook, data=body, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.read().decode()[:120]
    except Exception as e:
        return 'ERR', str(e)[:120]

def main():
    write = '--write' in sys.argv
    feishu = '--feishu' in sys.argv
    allowed = load_allowlist()
    c = db()
    owner_map = {r['dsh_id']: r['id'] for r in c.execute('SELECT id, dsh_id FROM session WHERE dsh_id IS NOT NULL').fetchall()}
    task_of = {r['owner_session_id']: r['id'] for r in c.execute('SELECT id, owner_session_id FROM task WHERE owner_session_id IS NOT NULL').fetchall()}
    alerts, stats = [], {'actions': 0, 'touched': 0, 'free': 0}
    seen = set()
    for dsh_id, age_min, f in active_sessions():
        actions, err = session_actions(f)
        if err:
            alerts.append({'session_id': dsh_id, 'kind': 'stall', 'message': '解压失败：' + err})
            continue
        sid = owner_map.get(dsh_id)
        task_id = task_of.get(sid)
        for name, touched, _args in actions:
            stats['actions'] += 1
            stats['touched'] += len(touched)
            if task_id is None:
                continue  # 未挂任务会话不逐文件报，下方汇总一行
            for p in touched:
                if p in allowed:
                    continue
                kind = 'stray_write' if name in WRITE_TOOLS else 'stray_read'
                msg = '会话 %s %s 清单外文件：%s' % (dsh_id[:12], name, p)
                key = (dsh_id, kind, p)
                if key in seen:
                    continue
                seen.add(key)
                dup = c.execute("SELECT id FROM dev_alerts WHERE session_id=? AND message=? AND resolved=0",
                                (dsh_id, msg)).fetchone()
                if dup is None:
                    if write:
                        c.execute('INSERT INTO dev_alerts(session_id, kind, message, at) VALUES(?,?,?,?)',
                                  (dsh_id, kind, msg, time.strftime('%Y-%m-%dT%H:%M:%S')))
                    alerts.append({'session_id': dsh_id, 'kind': kind, 'message': msg})
                    if feishu and kind == 'stray_write':
                        feishu_push('[治理巡检·红灯] ' + msg)
        if task_id is None:
            stats['free'] += 1
            key = ('free', dsh_id)
            if key not in seen:
                seen.add(key)
                msg = '会话 %s 活跃 %.0f 分钟未挂任务（游离）' % (dsh_id[:12], age_min)
                alerts.append({'session_id': dsh_id, 'kind': 'free', 'message': msg})
    if write:
        c.commit()
    c.close()
    print(json.dumps({'ok': True, 'write': write, 'active_sessions': len(active_sessions()),
                      'actions': stats['actions'], 'touched': stats['touched'], 'free_sessions': stats['free'],
                      'allowlist_size': len(allowed), 'alerts': alerts}, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
