# dev-nodes.ps1 —— 本机模拟多个节点（验证同步用）
# 用法：
#   powershell -ExecutionPolicy Bypass -File dev-nodes.ps1 -Action init
#   powershell -ExecutionPolicy Bypass -File dev-nodes.ps1 -Action list
param(
  [ValidateSet('init','list','reset')]
  [string]$Action = 'init',
  [int[]]$Ports = @(3000, 3001, 3002),
  [string]$Repo = 'D:\aiwork\onepanel'
)
$ErrorActionPreference = 'Continue'
$prismaDir = Join-Path $Repo 'backend\prisma'
$baseDb = Join-Path $prismaDir 'dev.db'

function Reset-NodeData([int]$port) {
  $db = Join-Path $prismaDir ("dev-$port.db")
  if (-not (Test-Path $db)) { Copy-Item $baseDb $db -Force }
  $sql = 'DELETE FROM NodeState; DELETE FROM Member; DELETE FROM PeerAck; DELETE FROM AppliedChange; DELETE FROM ChangeLog; DELETE FROM ItemRevision;'
  & sqlite3 $db $sql
  $dataDir = Join-Path $Repo ("backend\data\node-$port")
  if (Test-Path $dataDir) { Remove-Item $dataDir -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  Write-Output ("[ok] node $port -> dev-$port.db")
}

function Show-Node([int]$port) {
  try {
    $info = Invoke-RestMethod -Uri ("http://127.0.0.1:$port/api/node/info") -TimeoutSec 3
    Write-Output ("[$port] nodeId=" + $info.nodeId + " seq=" + $info.seq + " locked=" + $info.vaultLocked)
  } catch {
    Write-Output ("[$port] down")
  }
}

switch ($Action) {
  'init'  { foreach ($p in $Ports) { Reset-NodeData $p } }
  'reset' { foreach ($p in $Ports) { Reset-NodeData $p } }
  'list'  { foreach ($p in $Ports) { Show-Node $p } }
}
