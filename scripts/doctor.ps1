# 健康检查：Node.js/CLI/config/连通性/磁盘
$ErrorActionPreference = 'Continue'
$DataDir = Join-Path $env:USERPROFILE '.claude-to-feishu'
$Passed = 0; $Warned = 0; $Failed = 0

# 统一读取 config.env（后续各检查直接使用 $ConfigContent）
$ConfigPath = Join-Path $DataDir 'config.env'
$ConfigContent = if (Test-Path $ConfigPath) { Get-Content $ConfigPath -Raw } else { $null }

# 解析 CTF_ALLOWED_DIRS 为目录数组，供白名单目录和路径长度检查复用
function Get-AllowedDirs {
    if (-not $script:ConfigContent) { return @() }
    $match = [regex]::Match($script:ConfigContent, 'CTF_ALLOWED_DIRS=(.+)')
    if (-not $match.Success) { return @() }
    return ($match.Groups[1].Value -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Test-Check($name, $scriptBlock) {
    try {
        $result = & $scriptBlock
        if ($result.Status -eq 'PASS') {
            Write-Host "[PASS] $name - $($result.Detail)" -ForegroundColor Green
            $script:Passed++
        } elseif ($result.Status -eq 'WARN') {
            Write-Host "[WARN] $name - $($result.Detail)" -ForegroundColor Yellow
            $script:Warned++
        } else {
            Write-Host "[FAIL] $name - $($result.Detail)" -ForegroundColor Red
            $script:Failed++
        }
    } catch {
        Write-Host "[FAIL] $name - $_" -ForegroundColor Red
        $script:Failed++
    }
}

Test-Check 'Node.js 版本' {
    $ver = (node --version 2>&1).ToString().TrimStart('v')
    $major = [int]($ver -split '\.')[0]
    if ($major -ge 20) { @{ Status='PASS'; Detail="v$ver" } }
    else { @{ Status='FAIL'; Detail="v$ver (需要 >= 20)" } }
}

Test-Check 'Claude CLI' {
    $ver = claude --version 2>&1
    if ($LASTEXITCODE -eq 0) { @{ Status='PASS'; Detail=$ver } }
    else { @{ Status='FAIL'; Detail='命令不存在或执行失败' } }
}

Test-Check 'config.env' {
    if (-not $ConfigContent) {
        @{ Status='FAIL'; Detail="文件不存在: $ConfigPath" }
    } else {
        $required = @('CTF_FEISHU_APP_ID', 'CTF_FEISHU_APP_SECRET', 'CTF_ALLOWED_USERS', 'CTF_ALLOWED_DIRS')
        $missing = @()
        foreach ($key in $required) {
            if ($ConfigContent -notmatch "$key=\S+") { $missing += $key }
        }
        if ($missing.Count -gt 0) {
            @{ Status='FAIL'; Detail="缺少必填项: $($missing -join ', ')" }
        } else {
            @{ Status='PASS'; Detail='必填项齐全' }
        }
    }
}

Test-Check 'config.env 权限' {
    if (-not $ConfigContent) {
        @{ Status='WARN'; Detail='文件不存在，跳过' }
    } else {
        $acl = icacls $ConfigPath 2>&1
        if ($acl -match 'BUILTIN\\Users' -or $acl -match 'Everyone') {
            @{ Status='FAIL'; Detail="文件权限过宽，请运行: icacls `"$ConfigPath`" /inheritance:r /grant:r `"$env:USERNAME`:F`"" }
        } else {
            @{ Status='PASS'; Detail='权限正常' }
        }
    }
}

Test-Check '白名单目录' {
    if (-not $ConfigContent) {
        @{ Status='WARN'; Detail='无 config.env，跳过' }
    } else {
        $dirs = Get-AllowedDirs
        if ($dirs.Count -eq 0) {
            @{ Status='WARN'; Detail='未配置' }
        } else {
            $missing = $dirs | Where-Object { -not (Test-Path $_) }
            if ($missing.Count -gt 0) {
                @{ Status='FAIL'; Detail="目录不存在: $($missing -join ', ')" }
            } else {
                @{ Status='PASS'; Detail="$($dirs.Count) 个目录全部存在" }
            }
        }
    }
}

Test-Check '路径长度' {
    if (-not $ConfigContent) {
        @{ Status='WARN'; Detail='无 config.env，跳过' }
    } else {
        $dirs = Get-AllowedDirs
        if ($dirs.Count -eq 0) {
            @{ Status='WARN'; Detail='未配置' }
        } else {
            $long = $dirs | Where-Object { $_.Length -ge 240 }
            if ($long.Count -gt 0) {
                @{ Status='WARN'; Detail="路径过长 (>=240): $($long -join ', ')" }
            } else {
                @{ Status='PASS'; Detail='全部 < 240 字符' }
            }
        }
    }
}

Test-Check '磁盘空间' {
    $drive = (Get-PSDrive ($DataDir.Substring(0,1)))
    $freeMB = [math]::Round($drive.Free / 1MB)
    if ($freeMB -lt 100) {
        @{ Status='FAIL'; Detail="剩余 ${freeMB}MB (CRITICAL: < 100MB)" }
    } elseif ($freeMB -lt 500) {
        @{ Status='WARN'; Detail="剩余 ${freeMB}MB (< 500MB)" }
    } else {
        @{ Status='PASS'; Detail="剩余 ${freeMB}MB" }
    }
}

Test-Check 'PID 文件' {
    $pidPath = Join-Path $DataDir 'daemon.pid'
    if (-not (Test-Path $pidPath)) {
        @{ Status='PASS'; Detail='无残留 PID 文件' }
    } else {
        $info = Get-Content $pidPath -Raw | ConvertFrom-Json
        $proc = $null
        try { $proc = Get-Process -Id $info.pid -ErrorAction SilentlyContinue } catch {}
        if ($null -ne $proc -and $proc.ProcessName -eq 'node') {
            @{ Status='PASS'; Detail="daemon 运行中 (PID: $($info.pid))" }
        } else {
            @{ Status='WARN'; Detail='残留 PID 文件（进程已不存在），建议删除' }
        }
    }
}

Test-Check '飞书连通性' {
    if (-not $ConfigContent) {
        @{ Status='WARN'; Detail='无 config.env，跳过' }
    } else {
        $appId = [regex]::Match($ConfigContent, 'CTF_FEISHU_APP_ID=(\S+)').Groups[1].Value
        $appSecret = [regex]::Match($ConfigContent, 'CTF_FEISHU_APP_SECRET=(\S+)').Groups[1].Value
        if (-not $appId -or -not $appSecret) {
            @{ Status='WARN'; Detail='缺少 APP_ID 或 APP_SECRET，跳过' }
        } else {
            try {
                $body = @{ app_id = $appId; app_secret = $appSecret } | ConvertTo-Json
                $resp = Invoke-RestMethod -Uri 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' `
                    -Method Post -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 10
                if ($resp.tenant_access_token) {
                    @{ Status='PASS'; Detail='tenant_access_token 获取成功' }
                } else {
                    @{ Status='FAIL'; Detail="响应异常: $($resp.msg)" }
                }
            } catch {
                @{ Status='FAIL'; Detail="请求失败: $_" }
            }
        }
    }
}

Write-Host "`n总计: $Passed PASS, $Warned WARN, $Failed FAIL"
