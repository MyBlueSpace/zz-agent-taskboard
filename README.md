# zz-agent-taskboard —— AI 开发治理与任务生命周期管理工具

> 本工程是 `docs\方案\AI开发治理与任务生命周期管理方案.md`（zz-option-docs 仓库）的技术实现。
> 定位：**唯一真相库 + 两个写入口 + 视图生成器**。制度是主体，本工程只是制度里「数据」环节的机器。

## 架构一句话

```
会话（AI 员工）──task.js（事实账）──┐
                                    ├→ data/taskboard.db（SQLite 唯一真相库）→ board.js → 总看板.html / todo.md / exports/*.json
采集脚本 ─────collect.js（观测账）──┘                                                        ↓ git 提交（跨机只读）
```

- **data/taskboard.db**：唯一真相库（本机，gitignore）。
- **exports/*.json**：跨机共享快照（提交 git，只读）。

## 目录

| 路径 | 说明 |
| --- | --- |
| src/init_db.js | 建库建表（11 表+勾稽引用字段+拍板阈值），幂等 |
| src/task.js | 唯一写库入口①：任务/状态迁移/门禁六灯/commit 挂账/bug/验收项/勾稽体检 |
| src/collect.js | 唯一写库入口②：会话观测采集（活跃/水位/空转） |
| src/board.js | 视图生成：总看板.html、会话看板.html、todo.md 瘦身视图、勾稽断链清单、exports 快照 |
| data/ | 本机数据库落点（gitignore） |
| exports/ | JSON 快照（提交 git，跨机只读） |

## 命令速查

```powershell
node src/init_db.js                                  # 建库（幂等）
node src/task.js add T68 --title "..." [--status backlog] [--epic 行情链]
node src/task.js move T68 review --by 会话@10-21 --note "..."
node src/task.js gate T68 compile "exit 0 @ ..."     # 六灯 compile/tests/paradigm/reconcile/scan/deploy/scope
node src/task.js commit T68 docs abc1234 --kind merge
node src/task.js bug add T68 --title "..." [--severity P1]
node src/task.js bug fix BUG-1 --commit abc1234
node src/task.js item add T68 --item "..." --files '["a.md"]' [--section §2.1]
node src/task.js item done IT-1
node src/task.js accept add T68 --item "..." [--item-id IT-1]
node src/task.js accept pass ACC-1 --evidence "..."
node src/task.js review T68 l0|l1|l2 结论 [--note ...]
node src/task.js set T68 plan_doc "docs/方案/xxx.md"
node src/task.js show T68 | list [--status review] | check
```

## 状态机（11 态 + 2）

`需求 → 方案 → 待开工 → 开发中 → 自测中 → 待验收 → 待合并 → 已合并 → 已部署 → 关闭`，旁路 `阻塞/取消`。
每扇门进门前交证据（机器校验，不靠自觉）——门禁规则见 src/task.js 的 `GATES` 表。

## 勾稽四查（task.js check / day_close 体检）

1. 账证相符：孤儿资产（任务无方案挂账）断链清单
2. 账实相符：验收通过必有证据、bug fixed 必挂修复 commit
3. 汇总一致：任务进度=拆解项完成比例、todo 行数=库内任务数
4. 时序一致：已合并必挂 merge commit、已部署必挂 deploy commit（回答「线上跑的是哪版」）

## 纪律指针

- 本工具是**唯一写入口**（治理规则 R1）；AI 与用户只读不写。
- 阈值（meta 表，2026-10-28 用户拍板）：空转黄灯 30 分钟 / 卡门红灯 1 小时 / 上下文水位提醒 25%。
- 制度全文、岗位职责、数据流转五步、治理节拍见 zz-option-docs 仓库 `docs\方案\AI开发治理与任务生命周期管理方案.md`（唯一权威）。
- Node.js ≥ 22（node:sqlite 内置，零第三方依赖）。
