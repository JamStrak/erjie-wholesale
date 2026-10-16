param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$stateDirectory = Join-Path $appRoot '.local'
$statePath = Join-Path $stateDirectory 'server.json'
$preferredPort = 23168
$launchMutex = $null
$hasLock = $false

function Get-AppUrl([int]$Port) {
    if ($Port -lt 1024 -or $Port -gt 65535) { return $null }
    $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/health")
    $request.Proxy = $null
    $request.Timeout = 500
    $request.ReadWriteTimeout = 500
    $response = $null
    $reader = $null
    try {
        $response = $request.GetResponse()
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        $health = $reader.ReadToEnd() | ConvertFrom-Json
        if ($health.app -eq 'erjie-wholesale' -and $health.version -eq '1.0.0') {
            return "http://127.0.0.1:$Port/"
        }
    } catch { return $null }
    finally {
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Dispose() }
    }
    return $null
}

function Find-RunningApp {
    if (Test-Path -LiteralPath $statePath) {
        try {
            $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
            $candidate = Get-AppUrl ([int]$state.port)
            if ($candidate) { return $candidate }
        } catch { }
    }
    # Skip ports with no listener; otherwise Windows may spend half a second per refusal.
    $listeningPorts = @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { $_.Port })
    for ($port = $preferredPort; $port -le $preferredPort + 20; $port++) {
        if ($listeningPorts -notcontains $port) { continue }
        $candidate = Get-AppUrl $port
        if ($candidate) { return $candidate }
    }
    return $null
}

try {
    $hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
    try { $rootHash = [BitConverter]::ToString($hashAlgorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($appRoot.ToLowerInvariant()))).Replace('-', '').Substring(0, 20) }
    finally { $hashAlgorithm.Dispose() }
    $launchMutex = New-Object System.Threading.Mutex($false, "Local\ErjieWholesale-$rootHash")
    try { $hasLock = $launchMutex.WaitOne(20000) }
    catch [System.Threading.AbandonedMutexException] { $hasLock = $true }
    if (-not $hasLock) { throw '另一个启动窗口正在处理，请稍等片刻后再双击。' }

    $appUrl = Find-RunningApp
    if (-not $appUrl) {
        $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        $nodeCandidates = @()
        if ($nodeCommand) { $nodeCandidates += $nodeCommand.Source }
        $nodeCandidates += @(
            (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
            'D:\Program Files\nodejs\node.exe',
            (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
            (Join-Path $env:APPDATA 'npm\node.exe')
        )
        $nodePath = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
        if (-not $nodePath) { throw '没有找到 Node.js。请先安装 Node.js 24 LTS，再双击“启动小算盘”。下载地址：https://nodejs.org/' }
        $serverPath = Join-Path $appRoot 'server.mjs'
        if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw '缺少 server.mjs。请重新下载完整工具，并保留 scripts 文件夹。' }
        New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
        $outputLog = Join-Path $stateDirectory 'server-output.log'
        $errorLog = Join-Path $stateDirectory 'server-error.log'
        $serverProcess = Start-Process -FilePath $nodePath -ArgumentList @('"' + $serverPath + '"') -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 150
            if (Test-Path -LiteralPath $statePath) {
                try {
                    $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
                    if ([int]$state.pid -eq $serverProcess.Id) { $appUrl = Get-AppUrl ([int]$state.port) }
                } catch { }
            }
            if ($appUrl) { break }
            $serverProcess.Refresh()
            if ($serverProcess.HasExited) { break }
        } while ([DateTime]::UtcNow -lt $deadline)
        if (-not $appUrl) {
            $detail = ''
            if (Test-Path -LiteralPath $errorLog) { $detail = (Get-Content -Tail 6 -LiteralPath $errorLog) -join "`n" }
            throw "小算盘未能启动。请确认文件夹可写、Node.js 版本为 24 或更新，然后重试。`n错误日志：$errorLog`n$detail"
        }
    }
    if (-not $NoBrowser) {
        $browserStart = New-Object System.Diagnostics.ProcessStartInfo
        $browserStart.FileName = $appUrl
        $browserStart.UseShellExecute = $true
        [System.Diagnostics.Process]::Start($browserStart) | Out-Null
    }
    Write-Output $appUrl
} catch {
    $failureMessage = "二姐批发小算盘启动失败`n`n$($_.Exception.Message)"
    if ($NoBrowser) { [Console]::Error.WriteLine($failureMessage) }
    else {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($failureMessage, '二姐批发小算盘', 'OK', 'Error') | Out-Null
    }
    exit 1
} finally {
    if ($hasLock -and $launchMutex) { $launchMutex.ReleaseMutex() }
    if ($launchMutex) { $launchMutex.Dispose() }
}
