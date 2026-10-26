$ErrorActionPreference = 'Continue'
$node = 'C:\Program Files\nvm-nodejs\node.exe'
$taskjs = 'C:\Users\zhangyan\Documents\zz-agent-taskboard\src\task.js'
$list = Get-Content 'C:\Users\zhangyan\Documents\zz-agent-taskboard\data\migrate_todo.json' -Raw -Encoding UTF8 | ConvertFrom-Json

function Map-Status($s) {
  $t = $s.Trim().TrimStart('*').Trim()
  if ($t -match '搁置') { return 'cancelled' }
  if ($t -match '阻塞|待拍板|待用户确认|待确认') { return 'blocked' }
  if ($t -match '待验收') { return 'review' }
  if ($t -match '合并 main.*部署中|已提交并合并 main|已完成并合并 main') { return 'merged' }
  if ($t -match '已完成|已上线|已部署并验证|对账已收口|完成并推送') { return 'closed' }
  if ($t -match '进行中|代码完成|代码与脚本完成|代码已提交|搬迁已完成|待做|待办') { return 'dev' }
  if ($t -match '未开始') { return 'backlog' }
  return 'backlog'
}

$fails = @(); $n = 0; $stat = @{}
foreach ($r in $list) {
  $st = Map-Status $r.status
  if (-not $stat.ContainsKey($st)) { $stat[$st] = 0 }
  $stat[$st]++
  $title = $r.title; if ($title -eq '') { $title = '未命名任务' }
  $pri = $r.pri; if ($pri -notin @('高','中','低')) { $pri = '中' }
  & $node $taskjs add $r.id --title $title --status $st --priority $pri *> $null
  if ($LASTEXITCODE -ne 0) { $fails += "add $($r.id) exit=$LASTEXITCODE"; continue }
  $n++
  if ($r.status -match 'owner[:：]\s*([^）\)\s]+)') { & $node $taskjs set $r.id owner $Matches[1] *> $null }
  if ($r.start -ne '' -and $r.start -ne '—') { & $node $taskjs set $r.id started_at $r.start *> $null }
  if ($st -eq 'closed' -and $r.fin -ne '' -and $r.fin -ne '—') { & $node $taskjs set $r.id finished_at $r.fin *> $null }
  if ($st -eq 'closed') { & $node $taskjs commit $r.id docs legacy --kind deploy --message 'legacy-migration' *> $null }
  if ($st -eq 'merged') { & $node $taskjs commit $r.id docs legacy --kind merge --message 'legacy-migration' *> $null }
}
"migrated: $n / $($list.Count)"
"status-dist: $($stat | ConvertTo-Json -Compress)"
"fails: $($fails.Count)"
$fails | ForEach-Object { "FAIL $_" }
