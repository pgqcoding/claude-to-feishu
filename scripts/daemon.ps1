param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('start','stop','status','restart')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
$DataDir = Join-Path $env:USERPROFILE '.claude-to-feishu'
$PidFile = Join-Path $DataDir 'daemon.pid'
$LogDir = Join-Path $DataDir 'logs'

function Get-DaemonStatus {
    if (-not (Test-Path $PidFile)) {
        return @{ Running = $false; Reason = 'PID 文件不存在' }
    }
    $pidInfo = Get-Content $PidFile -Raw | ConvertFrom-Json
    $proc = $null
    try { $proc = Get-Process -Id $pidInfo.pid -ErrorAction SilentlyContinue } catch {}
    if ($null -eq $proc) {
        return @{ Running = $false; Reason = 'PID 进程不存在' }
    }
    if ($proc.ProcessName -ne 'node') {
        return @{ Running = $false; Reason = 'PID 被其他进程占用' }
    }
    return @{ Running = $true; Port = $pidInfo.httpPort; Pid = $pidInfo.pid }
}

function Start-Daemon {
    $status = Get-DaemonStatus
    if ($status.Running) {
        Write-Host "[INFO] daemon 已在运行 (PID: $($status.Pid))"
        return
    }
    if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

    # 检查 node_modules 是否存在
    $nodeModules = Join-Path $PSScriptRoot '..' 'node_modules'
    if (-not (Test-Path $nodeModules)) {
        Write-Host "[ERROR] node_modules 不存在，请先运行 npm install" -ForegroundColor Red
        return
    }

    $distFile = Join-Path $PSScriptRoot '..\dist\daemon.js'
    if (-not (Test-Path $distFile)) {
        Write-Host "[ERROR] dist/daemon.js 不存在，请先运行 npm run build"
        exit 1
    }

    $BootLog = Join-Path $LogDir 'daemon-boot.log'
    $proc = Start-Process -FilePath 'node' -ArgumentList '--max-old-space-size=640', '--expose-gc', $distFile `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput $BootLog -RedirectStandardError (Join-Path $LogDir 'daemon-boot-err.log')
    Write-Host "[INFO] daemon 已启动 (PID: $($proc.Id))"
    $waited = 0
    while (-not (Test-Path $PidFile) -and $waited -lt 10) {
        Start-Sleep -Seconds 1
        $waited++
    }
    if (Test-Path $PidFile) {
        $info = Get-Content $PidFile -Raw | ConvertFrom-Json
        Write-Host "[INFO] Health: http://127.0.0.1:$($info.httpPort)/health"
    } else {
        Write-Host "[WARN] 等待超时，PID 文件未生成。最后 20 行启动日志："
        if (Test-Path $BootLog) { Get-Content $BootLog -Tail 20 }
    }
}

function Stop-Daemon {
    $status = Get-DaemonStatus
    if (-not $status.Running) {
        Write-Host "[INFO] daemon 未在运行"
        return
    }
    try {
        # 读取 shutdown token 并添加 Authorization header
        $tokenFile = Join-Path $DataDir 'daemon.shutdown.token'
        $token = ''
        if (Test-Path $tokenFile) {
            $token = (Get-Content $tokenFile -Raw -Encoding UTF8).Trim()
        }
        $headers = @{ Authorization = "Bearer $token" }
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:$($status.Port)/shutdown" -Method POST -Headers $headers -TimeoutSec 10
        Write-Host "[INFO] shutdown 信号已发送"
    } catch {
        Write-Host "[WARN] HTTP shutdown 失败，尝试 Stop-Process"
        Stop-Process -Id $status.Pid -Force -ErrorAction SilentlyContinue
    }
    $waited = 0
    while ($waited -lt 10) {
        $proc = $null
        try { $proc = Get-Process -Id $status.Pid -ErrorAction SilentlyContinue } catch {}
        if ($null -eq $proc) { break }
        Start-Sleep -Seconds 1
        $waited++
    }
    try { Stop-Process -Id $status.Pid -Force -ErrorAction SilentlyContinue } catch {}
    if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
    Write-Host "[INFO] daemon 已停止"
}

function Show-Status {
    $status = Get-DaemonStatus
    if ($status.Running) {
        Write-Host "[INFO] daemon 运行中 (PID: $($status.Pid), Port: $($status.Port))"
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($status.Port)/health" -TimeoutSec 5
            Write-Host ($health | ConvertTo-Json -Depth 10)
        } catch {
            Write-Host "[WARN] health 端点不可达"
        }
    } else {
        Write-Host "[INFO] daemon 未运行 ($($status.Reason))"
    }
}

switch ($Action) {
    'start'   { Start-Daemon }
    'stop'    { Stop-Daemon }
    'status'  { Show-Status }
    'restart' { Stop-Daemon; Start-Daemon }
}
