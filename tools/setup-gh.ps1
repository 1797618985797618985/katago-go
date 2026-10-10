# 配置本机的 GitHub 代理与登录（一次性）。
#
# 这台机器的网络只能走本地代理（直连 github.com 会被 TLS 重置），
# 而 git 与 gh 都不会自动读取系统代理设置，所以要显式配一次。
#
# 用法：
#   pwsh -File tools/setup-gh.ps1              # 自动探测代理并配置 + 引导登录
#   pwsh -File tools/setup-gh.ps1 -ProxyPort 7897
#   pwsh -File tools/setup-gh.ps1 -NoLogin     # 只配代理，不登录

[CmdletBinding()]
param(
    [int]$ProxyPort = 0,
    [string]$ProxyHost = '127.0.0.1',
    [switch]$NoLogin
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- 探测代理
function Test-Port([string]$h, [int]$p) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $t = $c.BeginConnect($h, $p, $null, $null)
        $ok = $t.AsyncWaitHandle.WaitOne(1500)
        if ($ok) { $c.EndConnect($t) }
        $c.Close()
        return $ok
    } catch { return $false }
}

if (-not $ProxyPort) {
    # 常见本地代理端口，按顺序试
    foreach ($p in 7897, 7890, 10809, 1080, 8080, 2080) {
        if (Test-Port $ProxyHost $p) { $ProxyPort = $p; break }
    }
}
if (-not $ProxyPort) {
    throw "没找到可用的本地代理端口。请用 -ProxyPort 指定（比如 -ProxyPort 7897）。"
}

$proxyUrl = "http://${ProxyHost}:${ProxyPort}"
Write-Host "使用代理: $proxyUrl" -ForegroundColor Cyan

# ---------------------------------------------------------------- 配 git
# 只对 github.com 走代理，别的远程照旧（避免影响内网仓库）
git config --global "http.https://github.com.proxy" $proxyUrl
Write-Host "git  : http.https://github.com.proxy = $proxyUrl" -ForegroundColor Green

# ---------------------------------------------------------------- 配 gh
# gh 读 HTTPS_PROXY 环境变量；写成用户级环境变量，之后所有终端都生效
[Environment]::SetEnvironmentVariable('HTTPS_PROXY', $proxyUrl, 'User')
[Environment]::SetEnvironmentVariable('HTTP_PROXY', $proxyUrl, 'User')
$env:HTTPS_PROXY = $proxyUrl
$env:HTTP_PROXY = $proxyUrl
Write-Host "gh   : HTTPS_PROXY / HTTP_PROXY 已写入用户环境变量" -ForegroundColor Green

# ---------------------------------------------------------------- 登录
if (-not $NoLogin) {
    Write-Host ''
    Write-Host '接下来走设备码登录：终端会给出一个 8 位码，' -ForegroundColor Yellow
    Write-Host '把它填到浏览器打开的 https://github.com/login/device 页面即可。' -ForegroundColor Yellow
    Write-Host ''
    gh auth login --hostname github.com --git-protocol https --web
    if ($LASTEXITCODE -ne 0) { throw "gh auth login 失败（退出码 $LASTEXITCODE）" }
    gh auth setup-git
    Write-Host ''
    gh auth status
}
