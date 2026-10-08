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
    [ValidateSet('ensure-repo', 'push', 'create-pr', 'merge-pr', 'release', 'repo-settings', 'protect-branch', 'status')]
    [string]$Action,

    [string]$RepoName = 'katago-go',
    [string]$Base = 'main',
    [string]$Branch,
    [string]$Title,
    [string]$Body = '',
    [int]$Number = 0,
    [ValidateSet('merge', 'squash', 'rebase')]
    [string]$Method = 'squash',
    [string]$Tag = '',
    [string]$Name = '',
    [string]$Notes = '',
    [string]$Description = '',
    [string[]]$Topics = @(),
    [string[]]$RequiredChecks = @('规则引擎测试'),
    [int]$Approvals = 0,
    [switch]$EnforceAdmins,
    [switch]$Public,
    [switch]$Draft,
    [switch]$Prerelease
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
        [switch]$AllowFailure,
        [int]$Retries = 3
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
    $lastErr = $null
    for ($attempt = 1; $attempt -le $Retries; $attempt++) {
        try {
            return Invoke-RestMethod @params
        } catch {
            $lastErr = $_
            $status = 0
            try { $status = [int]$_.Exception.Response.StatusCode } catch { }
            # 5xx / 网络抖动值得重试；4xx 直接放弃
            if ($status -ge 400 -and $status -lt 500) { break }
            if ($attempt -lt $Retries) { Start-Sleep -Milliseconds (400 * $attempt) }
        }
    }
    if ($AllowFailure) { return $null }
    $detail = ''
    if ($lastErr.ErrorDetails -and $lastErr.ErrorDetails.Message) { $detail = $lastErr.ErrorDetails.Message }
    throw "GitHub API $Method $Path 失败: $($lastErr.Exception.Message) $detail"
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

    'merge-pr' {
        if (-not (Test-RemoteExists)) { throw "远程仓库不存在，请先运行 -Action ensure-repo" }
        $n = $Number
        if (-not $n) {
            $prs = Invoke-GitHubApi -Path "/repos/$(Get-RepoFullName)/pulls?state=open&per_page=1"
            if (-not $prs -or $prs.Count -eq 0) { throw '没有打开的 PR。' }
            $n = $prs[0].number
        }
        $pr = Invoke-GitHubApi -Path "/repos/$(Get-RepoFullName)/pulls/$n"
        Write-Host "合并 PR #$n 「$($pr.title)」 ($($pr.head.ref) -> $($pr.base.ref)) 方式=$Method"
        $res = Invoke-GitHubApi -Method PUT -Path "/repos/$(Get-RepoFullName)/pulls/$n/merge" -Body @{
            merge_method = $Method
            commit_title = "$($pr.title) (#$n)"
        }
        if ($res.merged) {
            Write-Host "已合并: $($res.sha)"
            git fetch origin --prune 2>&1 | Out-Null
            Write-Host '本地已 fetch，可执行 git checkout main; git pull 同步。'
        } else {
            Write-Warning "未合并: $($res.message)"
        }
    }

    'release' {
        if (-not (Test-RemoteExists)) { throw "远程仓库不存在，请先运行 -Action ensure-repo" }
        if (-not $Tag) { throw '请用 -Tag 指定版本号，例如 v1.0.0' }
        $releaseName = if ($Name) { $Name } else { $Tag }
        $releaseBody = $Notes
        if (-not $releaseBody) {
            # 未提供说明时，从 CHANGELOG.md 里取对应版本段落
            $changelog = Join-Path (Split-Path -Parent $PSScriptRoot) 'CHANGELOG.md'
            if (Test-Path $changelog) {
                $text = Get-Content $changelog -Raw
                $pattern = "(?ms)^##\s*\[?$([regex]::Escape($Tag.TrimStart('v')))\]?.*?(?=^##\s|\z)"
                $m = [regex]::Match($text, $pattern)
                if ($m.Success) { $releaseBody = $m.Value.Trim() }
            }
        }
        if (-not $releaseBody) { $releaseBody = "版本 $Tag" }

        $release = Invoke-GitHubApi -Method POST -Path "/repos/$(Get-RepoFullName)/releases" -Body @{
            tag_name               = $Tag
            target_commitish       = $Base
            name                   = $releaseName
            body                   = $releaseBody
            draft                  = [bool]$Draft
            prerelease             = [bool]$Prerelease
            generate_release_notes = $false
        }
        Write-Host "Release 已创建: $($release.html_url)"
        Write-Output $release.html_url
    }

    'repo-settings' {
        if (-not (Test-RemoteExists)) { throw "远程仓库不存在，请先运行 -Action ensure-repo" }
        if (-not $Description -and $Topics.Count -eq 0) { throw '请至少提供 -Description 或 -Topics' }

        if ($Description) {
            # 简介走 PATCH /repos/{owner}/{repo}
            $repo = Invoke-GitHubApi -Method PATCH -Path "/repos/$(Get-RepoFullName)" -Body @{ description = $Description }
            Write-Host "仓库简介: $($repo.description)"
        }

        if ($Topics.Count -gt 0) {
            # 话题标签必须走专用接口 PUT /repos/{owner}/{repo}/topics，
            # 用 PATCH 仓库的方式改是无效的（返回成功但不会生效）
            # 注意：用 -File 调用脚本时逗号不会被解析成数组，
            # 所以这里再按逗号/分号/空白拆一次，并统一转小写。
            $names = @()
            foreach ($t in $Topics) { $names += ($t -split '[,;\s]+') }
            $names = $names |
                Where-Object { $_ } |
                ForEach-Object { $_.Trim().ToLower() } |
                Where-Object { $_ -match '^[a-z0-9][a-z0-9-]{0,49}$' } |
                Select-Object -Unique
            if ($names.Count -eq 0) { throw '没有合法的话题标签（只能用小写字母、数字和连字符）' }
            $t = Invoke-GitHubApi -Method PUT -Path "/repos/$(Get-RepoFullName)/topics" -Body @{ names = @($names) }
            Write-Host "话题标签: $($t.names -join ', ')"
        }
    }

    # 给主分支加保护：必须走 PR、必须过检查、禁止强推与删除。
    # 批准数默认 0 —— 单人仓库如果要求 1 个批准，自己就合不了了。
    'protect-branch' {
        if (-not (Test-RemoteExists)) { throw "远程仓库不存在，请先运行 -Action ensure-repo" }

        $checks = @()
        foreach ($c in $RequiredChecks) { $checks += ($c -split '[,;]\s*') }
        $checks = $checks | Where-Object { $_ } | Select-Object -Unique

        $body = @{
            required_status_checks        = @{ strict = $true; contexts = @($checks) }
            enforce_admins                = [bool]$EnforceAdmins
            required_pull_request_reviews = @{
                required_approving_review_count = $Approvals
                dismiss_stale_reviews           = $false
                require_code_owner_reviews      = $false
            }
            restrictions                      = $null
            allow_force_pushes                = $false
            allow_deletions                   = $false
            required_conversation_resolution  = $true
        }

        Invoke-GitHubApi -Method PUT -Path "/repos/$(Get-RepoFullName)/branches/$Base/protection" -Body $body | Out-Null
        $p = Invoke-GitHubApi -Path "/repos/$(Get-RepoFullName)/branches/$Base/protection"
        Write-Host "$Base 分支保护已设置："
        Write-Host "  必须走 PR          : $($null -ne $p.required_pull_request_reviews)"
        Write-Host "  需要批准数          : $($p.required_pull_request_reviews.required_approving_review_count)"
        Write-Host "  必须通过的检查      : $($p.required_status_checks.contexts -join ', ')"
        Write-Host "  要求分支是最新的    : $($p.required_status_checks.strict)"
        Write-Host "  禁止强推 / 删除     : $((-not $p.allow_force_pushes.enabled)) / $((-not $p.allow_deletions.enabled))"
        Write-Host "  管理员也受约束      : $($p.enforce_admins.enabled)"
    }
}
