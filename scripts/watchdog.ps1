# 通过 Windows 计划任务每 5 分钟执行，检测 daemon 是否存活
$ErrorActionPreference = 'Stop'
$DataDir = Join-Path $env:USERPROFILE '.claude-to-feishu'
$PidFile = Join-Path $DataDir 'daemon.pid'
$RestartCountFile = Join-Path $DataDir 'watchdog-restarts.txt'
$MaxRestarts = 5

function Write-Log($msg) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    "$ts $msg" | Out-File -Append (Join-Path $DataDir 'logs\watchdog.log')
}

$restartCount = 0
if (Test-Path $RestartCountFile) {
    $state = Get-Content $RestartCountFile -Raw | ConvertFrom-Json
    $restartCount = [int]$state.count
    if ($state.lastRestart) {
        $lastRestart = [datetime]$state.lastRestart
        if ((Get-Date) - $lastRestart -gt [TimeSpan]::FromHours(1)) {
            $restartCount = 0
        }
    }
}

if ($restartCount -ge $MaxRestarts) {
    Write-Log "[ERROR] 连续重启 $restartCount 次，停止 watchdog"
    exit 1
}

$alive = $false
if (Test-Path $PidFile) {
    try {
        $pidInfo = Get-Content $PidFile -Raw | ConvertFrom-Json
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($pidInfo.httpPort)/health" -TimeoutSec 5
        if ($health.status -eq 'ok' -or $health.status -eq 'degraded') {
            $alive = $true
        }
    } catch {
        Write-Log "[WARN] health 检测失败: $_"
    }
}

if (-not $alive) {
    Write-Log "[INFO] daemon 不可达，尝试重启 (第 $($restartCount + 1) 次)"
    $restartCount++
    @{ count = $restartCount; lastRestart = (Get-Date -Format 'o') } | ConvertTo-Json -Compress | Out-File -NoNewline $RestartCountFile

    if (Test-Path $PidFile) {
        try {
            $pidInfo = Get-Content $PidFile -Raw | ConvertFrom-Json
            Stop-Process -Id $pidInfo.pid -Force -ErrorAction SilentlyContinue
        } catch {}
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }

    & (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'daemon.ps1') start
} else {
    if ($restartCount -gt 0) {
        @{ count = 0; lastRestart = (Get-Date -Format 'o') } | ConvertTo-Json -Compress | Out-File -NoNewline $RestartCountFile
    }
}
