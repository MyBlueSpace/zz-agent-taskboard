#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
档 B 实时巡检 watchdog（2026-10-28 m02597 用户拍板「选 B」——弃 DSH 插件拦截，降级为秒级巡检）
职责：常驻循环，每 INTERVAL 秒扫活跃会话 → 解析会话日志里「本轮新增」的 write/edit 工具调用
      → 与 taskboard.db 的 task_item.files 清单比对 → 清单外=stray_write 红灯：
      写 dev_alerts（与档 A 同表、同消息格式、resolved=0 去重）+ 飞书推送。
与 patrol.py（档 A 每日巡检）区别：只盯 write/edit、常驻模式只报「启动后新增」、秒级心跳。
决策口径（与 guard_hook.js 一致）：未挂任务的会话不逐文件报（档 A 汇总游离）；解析失败/库打不开=跳过本轮，绝不误伤。

运行：python src/watchdog.py              # 常驻，每 5 秒一轮
      python src/watchdog.py --once       # 单轮干跑（全量扫活跃会话的 write 违规，只输出不写库不推送）
      python src/watchdog.py --interval 10
      python src/watchdog.py --no-feishu
"""
import re, sys, json, sqlite3, time, urllib.parse, urllib.request, socket
from pathlib import Path

if sys.stdout and hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# 单实例锁（2026-10-26 计划任务注册配套）：绑定固定端口，失败=已有实例在跑，直接退出
# 作用：计划任务每 5 分钟兜底触发时，不会叠出多个 watchdog 实例
_LOCK = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    _LOCK.bind(('127.0.0.1', 47651))
except OSError:
    sys.exit(0)  # 已有实例在跑，本实例静默退出

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / 'data' / 'taskboard.db'
SESSIONS = Path(r'C:\Users\zhangyan\.dsh\sessions\--C-Users-zhangyan-Documents-deepseek-harness-default-workspace--')
IDLE_MIN = 30          # 活跃判定：目录最后写入 ≤ 30 分钟（与档 A 同口径）
WRITE_TOOLS = {'write', 'edit'}
# 绝对路径 C:\... 或 C:/...
ABS_RE = re.compile(r'([A-Za-z]:[\\/][^\s，。；"\'<>|]+?\.(?:java|vue|ts|js|py|md|yml|yaml|json|xml|sql|html|css|ps1|mjs))')
# 相对路径 docs/... src/... scripts/...
REL_RE = re.compile(r'((?:docs|src|scripts|deploy)[\\/][^\s，。；"\'<>|]+?\.(?:java|vue|ts|js|py|md|yml|yaml|json|xml|sql|html|css|ps1|mjs))')
HEARTBEAT = Path(r'C:\Users\zhangyan\.dsh\logs\watchdog.log')


def db():
    c = sqlite3.connect(str(DB))
    c.row_factory = sqlite3.Row
    return c


def load_allowlist():
    """允许清单=task_item.files（去端前缀）+通用纪律文档（AGENTS/红线卡/细则）——与 patrol.py 同口径"""
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


def heartbeat(text):
    try:
        with open(HEARTBEAT, 'a', encoding='utf-8') as fh:
            fh.write('%s %s\n' % (time.strftime('%Y-%m-%dT%H:%M:%S'), text))
    except Exception:
        pass


def session_writes(session_file):
    """解析会话文件 → [(write 工具名, touched_paths)]，按 callId 配对 call/result（与 patrol.py 同算法，只取写类）"""
    import zstandard
    actions, calls = [], {}
    try:
        with open(session_file, 'rb') as fh:
            data = zstandard.ZstdDecompressor().stream_reader(fh).read()
    except Exception:
        return actions
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
            if name not in WRITE_TOOLS:
                continue
            content = m.get('content') or []
            text = ''
            for part in content:
                if isinstance(part, dict) and part.get('type') == 'text':
                    text += str(part.get('text', ''))
            touched = set()
            for src in (args, text):
                for mm in ABS_RE.finditer(src):
                    touched.add(mm.group(1).replace('\\', '/').lower())
                for mm in REL_RE.finditer(src):
                    touched.add(mm.group(0).replace('\\', '/').lower())
            if touched:
                actions.append((name, sorted(touched)))
    return actions


def feishu_push(message):
    """复用档 A 同款飞书机器人签名（HMAC-SHA256 key=ts+\"\\n\"+secret）"""
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
            return r.status
    except Exception:
        return 'ERR'


def scan_all(once, allowed, owner_map, task_of, seen):
    """一轮扫描。once=True：全量扫活跃会话并报全部 write 违规（干跑）；False：只报启动后新增。"""
    c = db()
    alerts, changed = [], 0
    now = time.time()
    for d in SESSIONS.iterdir():
        if not d.is_dir():
            continue
        f = d / 'session.v4.jsonl.zstd'
        if not f.exists():
            continue
        age_min = (now - f.stat().st_mtime) / 60
        if age_min > IDLE_MIN:
            continue
        mtime = f.stat().st_mtime
        last = seen.get(str(f))
        seen[str(f)] = mtime
        if not once and last is not None and mtime <= last:
            continue          # 无新写入
        if not once and last is None:
            continue          # 首轮基线，历史不追报
        changed += 1
        dsh_id = d.name
        sid = owner_map.get(dsh_id)
        task_id = task_of.get(sid)
        for name, touched in session_writes(f):
            if task_id is None:
                continue      # 未挂任务会话不逐文件报（档 A 汇总游离）
            for p in touched:
                if p in allowed:
                    continue
                msg = '会话 %s %s 清单外文件：%s' % (dsh_id[:12], name, p)
                key = (dsh_id, 'stray_write', p)
                if key in seen:
                    continue
                seen.add(key)
                dup = c.execute('SELECT id FROM dev_alerts WHERE session_id=? AND message=? AND resolved=0',
                                (dsh_id, msg)).fetchone()
                if dup is not None:
                    continue  # 已在台账（档 A 或本 watchdog 已报过）
                if not once:
                    c.execute('INSERT INTO dev_alerts(session_id, kind, message, at) VALUES(?,?,?,?)',
                              (dsh_id, 'stray_write', msg, time.strftime('%Y-%m-%dT%H:%M:%S')))
                alerts.append({'session_id': dsh_id, 'kind': 'stray_write', 'message': msg})
    if not once:
        c.commit()
    c.close()
    return alerts, changed


def main():
    once = '--once' in sys.argv
    no_feishu = '--no-feishu' in sys.argv
    interval = 5
    for a in sys.argv[1:]:
        if a.startswith('--interval='):
            interval = int(a.split('=', 1)[1])
        elif a == '--interval' :
            interval = 10
    allowed = load_allowlist()
    c = db()
    owner_map = {r['dsh_id']: r['id'] for r in c.execute('SELECT id, dsh_id FROM session WHERE dsh_id IS NOT NULL').fetchall()}
    task_of = {r['owner_session_id']: r['id'] for r in c.execute('SELECT id, owner_session_id FROM task WHERE owner_session_id IS NOT NULL').fetchall()}
    c.close()
    seen = {}
    round_no = 0
    heartbeat('start once=%s interval=%ds allowlist=%d' % (once, interval, len(allowed)))
    while True:
        round_no += 1
        try:
            alerts, changed = scan_all(once, allowed, owner_map, task_of, seen)
        except Exception as e:
            heartbeat('round=%d ERROR %s' % (round_no, str(e)[:120]))
            alerts, changed = [], 0
        pushed = 0
        for a in alerts:
            if not once and not no_feishu:
                if feishu_push('[治理巡检·红灯] ' + a['message']) == 200:
                    pushed += 1
        heartbeat('round=%d changed=%d alerts=%d pushed=%d' % (round_no, changed, len(alerts), pushed))
        if once:
            print(json.dumps({'ok': True, 'mode': 'once', 'round': round_no, 'changed_sessions': changed,
                              'alerts': alerts}, ensure_ascii=False, indent=2))
            return
        time.sleep(interval)


if __name__ == '__main__':
    main()
