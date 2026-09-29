# Jet Hub 一键安装脚本（客户侧）
#
# 为什么需要这个脚本：
#   pnpm 12 对 **git 来源**的依赖强制要求 allowBuilds 白名单，客户直接
#   执行 `dsh plugin add github:zhengwuji/Jet-Hub` 会得到：
#       ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED
#   要客户自己去改 pnpm-workspace.yaml 是不可接受的。
#
#   实测（2026-09-29，dsh 0.2.0-rc.1 + pnpm 12.7.0）：
#     git+https://...   -> 需要白名单，且会把 core 包复制进 profile
#     file:D:/path      -> 无需白名单，且不产生 core 包副本
#
#   因此本脚本改为「先取源码到本地，再用 file: 安装」，客户无需配置任何文件。
#
# 空间占用：
#   默认使用临时目录，安装完成后**可自动清理**。dsh 只会硬链接/复制所需文件到
#   profile，源码目录不长期占用。加 -KeepSource 可保留以便后续更新。
#
# 用法：
#   pwsh -File install-jethub.ps1
#   pwsh -File install-jethub.ps1 -Profile web -DshVersion 0.2.0-rc.1
#   pwsh -File install-jethub.ps1 -Ref main -KeepSource
#   pwsh -File install-jethub.ps1 -Uninstall

[CmdletBinding()]
param(
    # 要安装的 dsh 版本目录名（profiles 所在的那一层）
    [string]$DshVersion = '0.2.0-rc.1',
    # profile 名
    [string]$Profile = 'web',
    # 源码来源与分支
    [string]$Repo = 'https://github.com/zhengwuji/Jet-Hub.git',
    [string]$Ref = 'main',
    # 源码工作目录；默认落在临时目录
    [string]$WorkDir = (Join-Path $env:TEMP 'jethub-src'),
    # 保留源码目录（便于下次更新时复用，省一次 clone）
    [switch]$KeepSource,
    # 跳过构建（源码目录里已有可用 lib/ 时）
    [switch]$SkipBuild,
    # 卸载
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$LAUNCHER = Join-Path $env:APPDATA 'in.dsh-plug.dsh-launcher'
$DSH_PKG  = Join-Path $LAUNCHER "versions\$DshVersion\node_modules\@deepseek-ai\dsh\lib\bin.js"
$PROFILE_DIR = Join-Path $LAUNCHER "homes\$DshVersion\profiles\$Profile"
$PKG_NAME = 'dsh-codearts-auth'

function Write-Step($m) { Write-Host "  $m" }
function Write-Head($m) { Write-Host "`n$m" -ForegroundColor Cyan }

# ---------------------------------------------------------------- 前置检查

Write-Head "环境检查"

if (-not (Test-Path $DSH_PKG)) {
    throw "找不到 dsh $DshVersion 的入口: $DSH_PKG`n请确认已安装该版本，或用 -DshVersion 指定。"
}
if (-not (Test-Path $PROFILE_DIR)) {
    throw "找不到 profile 目录: $PROFILE_DIR`n请先在 dsh $DshVersion 里启动过一次 profile `"$Profile`"。"
}
Write-Step "✓ dsh $DshVersion / profile $Profile"

# dsh 自带 pnpm，避免依赖客户全局 pnpm
$PNPM = Join-Path $LAUNCHER 'tools\pnpm.cmd'
if (-not (Test-Path $PNPM)) { $PNPM = 'pnpm' }
Write-Step "✓ pnpm: $PNPM"

function Invoke-DshPlugin([string[]]$Args) {
    & node $DSH_PKG plugin --profile $Profile @Args
}

# ---------------------------------------------------------------- 卸载

if ($Uninstall) {
    Write-Head "卸载 $PKG_NAME"
    Invoke-DshPlugin @('remove', $PKG_NAME)
    Write-Step "✓ 已移除"
    Write-Host "`n完成。重启 dsh 生效。"
    exit 0
}

# ---------------------------------------------------------------- 取源码

Write-Head "获取源码"

if (Test-Path (Join-Path $WorkDir '.git')) {
    Write-Step "复用已有目录，拉取最新..."
    & git -C $WorkDir fetch --depth 1 origin $Ref
    & git -C $WorkDir checkout -f FETCH_HEAD
} else {
    if (Test-Path $WorkDir) { Remove-Item $WorkDir -Recurse -Force }
    New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
    Write-Step "克隆 $Repo ($Ref) ..."
    & git clone --depth 1 --branch $Ref $Repo $WorkDir
}
if ($LASTEXITCODE -ne 0) { throw "git 操作失败" }

# 源仓库可能带 .git；file: 安装时 pnpm 不关心，但为减小体积可移除
Write-Step "✓ 源码就绪: $WorkDir"

# ---------------------------------------------------------------- 构建

if (-not $SkipBuild) {
    Write-Head "构建产物"
    Push-Location $WorkDir
    try {
        Write-Step "安装构建依赖（仅此目录，不影响 dsh）..."
        & $PNPM install --silent
        if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败" }

        Write-Step "编译 TypeScript + 前端资源..."
        & $PNPM build:all
        if ($LASTEXITCODE -ne 0) { throw "构建失败（pnpm build:all）" }
    } finally {
        Pop-Location
    }
    Write-Step "✓ 构建完成"
}

# 校验关键产物
foreach ($f in @('lib\index.js', 'lib\client\jet-hub.js', 'cordis.patch.yml')) {
    $p = Join-Path $WorkDir $f
    if (-not (Test-Path $p)) { throw "产物缺失: $f —— 构建未完成？可去掉 -SkipBuild 重试" }
}
Write-Step "✓ 产物校验通过"

# ---------------------------------------------------------------- 安装

Write-Head "安装到 profile"

# 用 file: 指向本地目录 —— 这是绕开 pnpm git 白名单的关键
$spec = 'file:' + ($WorkDir -replace '\\', '/')
Write-Step "dsh plugin add $spec"

Invoke-DshPlugin @('add', $spec)
if ($LASTEXITCODE -ne 0) { throw "安装失败" }

Write-Step "✓ 已安装"

# ---------------------------------------------------------------- 校验

Write-Head "校验"

$nm = Join-Path $PROFILE_DIR 'node_modules'
$coreDir = Join-Path $nm '@deepseek-ai'

# 关键指标：profile 内不应出现任何 @deepseek-ai 包
if (Test-Path $coreDir) {
    $leaked = Get-ChildItem $coreDir -Force | Select-Object -ExpandProperty Name
    if ($leaked) {
        Write-Host "  ⚠ 检测到 core 包副本: $($leaked -join ', ')" -ForegroundColor Yellow
        Write-Host "    这会让 dsh 依赖自检报「不同代」。该插件若已把 core 包声明为"
        Write-Host "    peerDependencies，出现副本说明上游依赖声明未修复。"
    }
} else {
    Write-Step "✓ profile 内无 core 包副本（依赖自检不会报警）"
}

if (Test-Path (Join-Path $nm "$PKG_NAME\lib\index.js")) {
    Write-Step "✓ 插件本体就位"
} else {
    throw "插件本体未就位，安装可能未成功"
}

# ---------------------------------------------------------------- 收尾

if (-not $KeepSource) {
    Write-Head "清理"
    Remove-Item (Join-Path $WorkDir 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $WorkDir '.git') -Recurse -Force -ErrorAction SilentlyContinue
    Write-Step "✓ 已清理构建缓存（源码保留在 $WorkDir）"
    Write-Step "  下次更新用同一目录即可增量拉取；要删干净可手动移除该目录。"
}

Write-Host "`n安装完成。重启 dsh $DshVersion 后，在 设置 -> Jet Hub 里使用。" -ForegroundColor Green
