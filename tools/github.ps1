<#
.SYNOPSIS
    本项目统一的 GitHub 工作流脚本：建仓、推送、开 PR。

.DESCRIPTION
    令牌从 Windows 凭据管理器读取（git credential fill），不落盘、不打印。
    由于沙箱进程与登录用户不同，本脚本必须以管理员/提权方式运行。

.EXAMPLE
    # 1. 首次：创建远程仓库并把 main 推上去
    pwsh -File tools/github.ps1 -Action ensure-repo
    pwsh -File tools/github.ps1 -Action push -Branch main

    # 2. 每次改动：建分支 -> 提交 -> 推送 -> 开 PR
    pwsh -File tools/github.ps1 -Action create-pr -Branch feature/xxx `
        -Title "feat: xxx" -Body "变更说明"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('ensure-repo', 'push', 'create-pr', 'status')]
    [string]$Action,

    [string]$RepoName = 'katago-go',
    [string]$Base = 'main',
    [string]$Branch,
    [string]$Title,
    [string]$Body = '',
    [switch]$Public,
    [switch]$Draft
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- 凭据
function Get-GitHubToken {
    $payload = "protocol=https`nhost=github.com`n`n"
    $out = $payload | git credential fill 2>$null
    $tok = ($out | Where-Object { $_ -match '^password=' }) -replace '^password=', ''
    if (-not $tok) { throw '未找到 GitHub 凭据，请先在凭据管理器中登录（GitHub Desktop / git push 一次即可）。' }
    return $tok.Trim()
}

$script:Token = Get-GitHubToken

function Invoke-GitHubApi {
    param(
        [string]$Method = 'GET',
        [string]$Path,
        $Body,
        [switch]$AllowFailure
    )
    $headers = @{
        Authorization          = "token $script:Token"
        'User-Agent'           = 'katago-go-workflow'
        Accept                 = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
    }
    $uri = if ($Path -like 'http*') { $Path } else { "https://api.github.com$Path" }
    $params = @{ Uri = $uri; Method = $Method; Headers = $headers; TimeoutSec = 60 }
    if ($null -ne $Body) {
        $params.Body = ($Body | ConvertTo-Json -Depth 8 -Compress)
        $params.ContentType = 'application/json'
    }
    try {
        return Invoke-RestMethod @params
    } catch {
        if ($AllowFailure) { return $null }
        $detail = ''
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $detail = $_.ErrorDetails.Message }
        throw "GitHub API $Method $Path 失败: $($_.Exception.Message) $detail"
    }
}

$script:User = Invoke-GitHubApi -Path '/user'
$script:Owner = $script:User.login

function Get-RepoFullName { "$script:Owner/$RepoName" }

function Test-RemoteExists {
    $repo = Invoke-GitHubApi -Path "/repos/$(Get-RepoFullName)" -AllowFailure
    return [bool]$repo
}

function Resolve-RepoUrl {
    $repo = Invoke-GitHubApi -Path "/repos/$(Get-RepoFullName)"
    return $repo.clone_url
}

function Ensure-Remote {
    $url = Resolve-RepoUrl
    $existing = git remote 2>$null
    if ($existing -contains 'origin') {
        git remote set-url origin $url
    } else {
        git remote add origin $url
    }
    return $url
}

function Current-Branch {
    return (git rev-parse --abbrev-ref HEAD).Trim()
}

# ---------------------------------------------------------------- 动作
switch ($Action) {
    'ensure-repo' {
        if (Test-RemoteExists) {
            Write-Host "仓库已存在: https://github.com/$(Get-RepoFullName)"
        } else {
            $created = Invoke-GitHubApi -Method POST -Path '/user/repos' -Body @{
                name        = $RepoName
                description = '基于 KataGo 的围棋对战程序（人机对战 / 人人对战）'
                private     = (-not $Public)
                has_issues  = $true
                has_wiki    = $false
                auto_init   = $false
            }
            Write-Host "已创建仓库: $($created.html_url) (private=$($created.private))"
        }
        $url = Ensure-Remote
        Write-Host "origin -> $url"
        git fetch origin --prune 2>&1 | Out-Null
        Write-Host '远程已同步。'
    }

    'push' {
        if (-not (Test-RemoteExists)) { throw "远程仓库不存在，请先运行 -Action ensure-repo" }
        Ensure-Remote | Out-Null
        $b = if ($Branch) { $Branch } else { Current-Branch }
        Write-Host "推送分支 $b ..."
        git push -u origin $b
        if ($LASTEXITCODE -ne 0) { throw "推送失败（退出码 $LASTEXITCODE）" }
        Write-Host "已推送: https://github.com/$(Get-RepoFullName)/tree/$b"
    }

    'create-pr' {
        if (-not (Test-RemoteExists)) { throw "远程仓库不存在，请先运行 -Action ensure-repo" }
        Ensure-Remote | Out-Null
        $b = if ($Branch) { $Branch } else { Current-Branch }
        if ($b -eq $Base) { throw "当前分支就是 $Base，请先切到功能分支。" }
        if (-not $Title) { throw '请用 -Title 指定 PR 标题。' }

        git push -u origin $b
        if ($LASTEXITCODE -ne 0) { throw "推送失败（退出码 $LASTEXITCODE）" }

        # 若 base 分支尚未推送到远程，先补推一次，否则 PR 无法建立
        git rev-parse --verify --quiet "origin/$Base" 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "远程缺少 $Base 分支，先行推送 ..."
            git push -u origin $Base
        }

        $body = $Body
        if (-not $body) { $body = "本 PR 由 Codex 自动创建。`n`n分支：``$b``" }
        $pr = Invoke-GitHubApi -Method POST -Path "/repos/$(Get-RepoFullName)/pulls" -Body @{
            title = $Title
            head  = $b
            base  = $Base
            body  = $body
            draft = [bool]$Draft
        }
        Write-Host "PR 已创建: $($pr.html_url)"
        Write-Output $pr.html_url
    }

    'status' {
        if (-not (Test-RemoteExists)) { Write-Host "远程仓库不存在: $(Get-RepoFullName)"; break }
        $repo = Invoke-GitHubApi -Path "/repos/$(Get-RepoFullName)"
        Write-Host "仓库: $($repo.html_url)  (default=$($repo.default_branch))"
        $prs = Invoke-GitHubApi -Path "/repos/$(Get-RepoFullName)/pulls?state=open&per_page=20"
        if ($prs.Count -eq 0) { Write-Host '没有打开的 PR。' }
        else { $prs | ForEach-Object { Write-Host ("  #{0} [{1}] {2}" -f $_.number, $_.head.ref, $_.title) } }
    }
}
