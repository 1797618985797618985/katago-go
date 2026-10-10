<#
.SYNOPSIS
    一次性联网下载 KataGo 引擎与训练好的权重，之后即可完全离线运行。

.DESCRIPTION
    KataGo 不需要自己训练：官方分布式训练（katagotraining.org）产出的权重
    （.bin.gz / .txt.gz）就是可直接使用的成品。本脚本把它们放到 engine/ 目录，
    程序运行时只读取本地文件，不再访问网络。

    会下载三种引擎构建，运行时自动挑选第一个能跑起来的：
      opencl  只依赖显卡驱动，兼容性最好（默认）
      cuda    需要本机已安装 CUDA + cuDNN，速度最快
      cpu     Eigen 纯 CPU 版，没有独显时的兜底

    以及两份权重：
      主权重       kata1-b18c384nbt-*     段位强度
      轻量权重     kata1-b6c96-*          低配机器 / 秒开

    注意：早先还会下载"人类风格权重"（b18c384nbt-humanv0）用于级位拟人化，
    但那条路径每步要 4~8 秒且时间压不下来，功能已经去掉，权重也就不再下载了。

.EXAMPLE
    pwsh -File tools/fetch-engine.ps1
    pwsh -File tools/fetch-engine.ps1 -SkipNets          # 只补引擎
    pwsh -File tools/fetch-engine.ps1 -Only opencl       # 只下 OpenCL 版
#>
[CmdletBinding()]
param(
    [string[]]$Only = @('opencl', 'cpu', 'cuda'),
    [string]$OpenClVersion = 'v1.18.0',
    [string]$CudaVersion = 'v1.18.2',
    [string]$CpuVersion = 'v1.18.0',
    [string]$Cuda = 'cuda12.8-cudnn9.8.0',
    [string]$MainNet = 'kata1-b18c384nbt-s9996604416-d4316597426',
    [string]$FastNet = 'kata1-b6c96-s175395328-d26788732',
    [switch]$SkipNets,
    [switch]$SkipFast,
    [switch]$SkipWarmup,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $PSScriptRoot
$EngineDir = Join-Path $Root 'engine'
$BinDir = Join-Path $EngineDir 'bin'
$ModelDir = Join-Path $EngineDir 'models'
$CacheDir = Join-Path $EngineDir '_download'
New-Item -ItemType Directory -Force -Path $BinDir, $ModelDir, $CacheDir | Out-Null

$ModelBase = 'https://media.katagotraining.org/uploaded/networks/models/kata1'

function Get-RemoteFile {
    param([string]$Url, [string]$Destination, [string]$Label)
    if ((Test-Path $Destination) -and -not $Force) {
        $mb = [math]::Round((Get-Item $Destination).Length / 1MB, 1)
        Write-Host ("  [跳过] {0} 已存在 ({1} MB)" -f $Label, $mb)
        return
    }
    Write-Host "  [下载] $Label"
    Write-Host "         $Url"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Invoke-WebRequest -Uri $Url -OutFile $Destination -TimeoutSec 1800 -UseBasicParsing
    $sw.Stop()
    $mb = [math]::Round((Get-Item $Destination).Length / 1MB, 1)
    Write-Host ("  [完成] {0}  ({1} MB, {2:N0}s)" -f $Label, $mb, $sw.Elapsed.TotalSeconds)
}

function Expand-EngineZip {
    param([string]$ZipPath, [string]$TargetDir)
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
    $tmp = Join-Path $CacheDir ('x_' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $tmp -Force
    $exe = Get-ChildItem -Path $tmp -Filter 'katago.exe' -Recurse -File | Select-Object -First 1
    if (-not $exe) { throw '压缩包中未找到 katago.exe' }
    $src = $exe.Directory.FullName
    Get-ChildItem -Path $src -File | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $TargetDir $_.Name) -Force
    }
    Remove-Item -LiteralPath $tmp -Recurse -Force
}

function Get-Engine {
    param([string]$Kind, [string]$Tag, [string]$ZipName)
    if ($Only -notcontains $Kind) { return }
    Write-Host "[引擎] $Kind"
    $target = Join-Path $BinDir $Kind
    if ((Test-Path (Join-Path $target 'katago.exe')) -and -not $Force) {
        Write-Host "  [跳过] 已存在 $target\katago.exe"
        return
    }
    $zip = Join-Path $CacheDir $ZipName
    $url = "https://github.com/lightvector/KataGo/releases/download/$Tag/$ZipName"
    Get-RemoteFile -Url $url -Destination $zip -Label $ZipName
    Write-Host "  [解压] -> $target"
    Expand-EngineZip -ZipPath $zip -TargetDir $target
}

# ---------------------------------------------------------------- 引擎
Get-Engine -Kind 'opencl' -Tag $OpenClVersion -ZipName "katago-$OpenClVersion-opencl-windows-x64.zip"
Get-Engine -Kind 'cuda' -Tag $CudaVersion -ZipName "katago-$CudaVersion-$Cuda-windows-x64.zip"
Get-Engine -Kind 'cpu' -Tag $CpuVersion -ZipName "katago-$CpuVersion-eigenavx2-windows-x64.zip"

# ---------------------------------------------------------------- 权重
function Resolve-ModelUrl {
    param([string]$Name)
    try {
        $r = Invoke-RestMethod -Uri "https://katagotraining.org/api/networks/$Name/" -TimeoutSec 30
        if ($r.model_file) { return $r.model_file }
    } catch { }
    return "$ModelBase/$Name.bin.gz"
}

if (-not $SkipNets) {
    Write-Host '[权重] 主权重（段位强度）'
    $url = Resolve-ModelUrl -Name $MainNet
    $file = Join-Path $ModelDir (Split-Path $url -Leaf)
    Get-RemoteFile -Url $url -Destination $file -Label (Split-Path $url -Leaf)

    if (-not $SkipFast) {
        Write-Host '[权重] 轻量权重（低配/秒开）'
        $url = Resolve-ModelUrl -Name $FastNet
        $file = Join-Path $ModelDir (Split-Path $url -Leaf)
        Get-RemoteFile -Url $url -Destination $file -Label (Split-Path $url -Leaf)
    }
}

# ---------------------------------------------------------------- 生成配置
Write-Host "`n生成 config.json ..."
$mainFile = (Get-ChildItem $ModelDir -Filter 'kata1-b18c384nbt-*.bin.gz' | Select-Object -First 1).Name
$fastFile = (Get-ChildItem $ModelDir -Filter 'kata1-b6c96-*.gz' -ErrorAction SilentlyContinue | Select-Object -First 1).Name

$cfg = [ordered]@{
    server   = [ordered]@{ port = 8080; host = '127.0.0.1' }
    katago   = [ordered]@{
        enabled       = $true
        # 留空表示自动探测 engine/bin 下能跑的构建（opencl -> cuda -> cpu）
        path          = ''
        model         = if ($mainFile) { "engine/models/$mainFile" } else { '' }
        fastModel     = if ($fastFile) { "engine/models/$fastFile" } else { '' }
        threads       = 8
        # 时间预算的换算比率：每 VISITS_PER_SECOND 次访问给 1 秒。
        # 想整体调快调慢改这里，或者直接改 server/engine/levels.js 里的默认值。
        # visitsPerSecond = 1000
    }
    defaults = [ordered]@{ boardSize = 19; komi = 7.5; level = '10k' }
}
$cfgPath = Join-Path $Root 'config.json'
$cfg | ConvertTo-Json -Depth 6 | Set-Content -Path $cfgPath -Encoding UTF8
Write-Host "  -> $cfgPath"

# ---------------------------------------------------------------- 探测
Write-Host "`n探测可用引擎构建 ..."
$ok = @()
foreach ($kind in @('opencl', 'cuda', 'cpu')) {
    $exe = Join-Path (Join-Path $BinDir $kind) 'katago.exe'
    if (-not (Test-Path $exe)) { Write-Host "  $kind : 未下载"; continue }
    try {
        $ver = (& $exe version 2>&1 | Select-Object -First 1)
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  $kind : 可用 ($ver)"
            $ok += $kind
        } else {
            Write-Host ("  $kind : 不可用 (退出码 0x{0:X8})" -f [uint32]$LASTEXITCODE)
        }
    } catch {
        Write-Host "  $kind : 不可用 ($($_.Exception.Message))"
    }
}

if ($ok.Count -eq 0) {
    Write-Warning '没有任何 KataGo 构建可直接运行；程序会自动退回内置引擎。'
} else {
    Write-Host "`n优先使用: $($ok[0])"
}

# ---------------------------------------------------------------- 预热
# 为什么要有这一步：OpenCL 版第一次加载权重时会对当前显卡做一次内核调优，
# 在 4070 笔记本上要六七分钟（不同显卡不一样），调完会把结果缓存到
# 用户目录下的 .katago/opencltuning，之后启动只要几秒。
# 把它放在安装阶段做掉，免得用户第一次下棋时干等。
if (-not $SkipWarmup -and $ok.Count -gt 0) {
    $warmKind = $ok[0]
    $warmExe = Join-Path (Join-Path $BinDir $warmKind) 'katago.exe'
    $warmModel = Get-ChildItem $ModelDir -Filter '*.gz' |
        Where-Object { $_.Name -notlike '*human*' } |
        Sort-Object Length -Descending |
        Select-Object -First 1

    # 必须和程序运行时用同一个缓存目录，否则这里白调一次。
    # 程序侧见 server/config.js 的 engineCacheDir()。
    $warmDataDir = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'katago-go' } else { Join-Path $HOME '.cache/katago-go' }
    New-Item -ItemType Directory -Force -Path $warmDataDir | Out-Null

    if ($warmModel) {
        Write-Host ""
        Write-Host "预热引擎（$warmKind）..."
        Write-Host "  首次运行要对你的显卡做一次内核调优，可能要几分钟，只需做一次。"
        Write-Host "  调优结果会缓存到 $warmDataDir"
        $sw = [Diagnostics.Stopwatch]::StartNew()
        # 走一遍真实的 GTP 流程，让引擎把模型加载和调优都做完
        $cmds = "boardsize 19`nkomi 7.5`nclear_board`nkata-set-param maxVisits 1`ngenmove B`nquit`n"
        try {
            $cmds | & $warmExe gtp -model $warmModel.FullName -override-config "homeDataDir = $($warmDataDir.Replace('\','/'))" *> $null
            $sw.Stop()
            Write-Host ("  完成，用时 {0:N0} 秒。以后启动只要几秒。" -f $sw.Elapsed.TotalSeconds)
        } catch {
            $sw.Stop()
            Write-Warning "  预热失败（$($_.Exception.Message)）；不影响使用，只是第一次启动会慢一些。"
        }
    }
}

Write-Host "`n完成。之后运行 'npm start' 即可，全程无需联网。"
