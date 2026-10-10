'use strict';

/**
 * GitHub 工作流工具（零依赖，走 gh CLI）。
 *
 * 本项目的约定：**任何改动都不直接提交到 main**，而是一律
 *   建分支 -> 提交 -> 推送 -> 开 PR -> 合并
 * 并且每次改动都要同步更新版本号（package.json / README / CHANGELOG 三处一致）。
 *
 * 这个脚本把上面的约定做成命令，避免每次手敲一长串 git。
 *
 * 用法：
 *   node tools/github.js status                  看看当前分支、脏文件、开着的 PR
 *   node tools/github.js prepare -m "fix: xxx"   建分支 + 升版本号 + 提交
 *   node tools/github.js open  -t "fix: xxx"     推送分支并开 PR（正文自动取自 CHANGELOG）
 *   node tools/github.js merge -n 16             合并 PR（默认 squash）并同步本地 main
 *   node tools/github.js pr                      一步到位：prepare + open
 *
 * 凭据：全部来自 `gh auth login`，本脚本不读取、不打印任何令牌。
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- 基础

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    ...opts,
  });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), raw: r };
}

function git(...args) {
  const r = run('git', args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.err || r.out}`);
  return r.out;
}

function gitTry(...args) {
  return run('git', args);
}

function gh(args, opts = {}) {
  const r = run('gh', args, opts);
  if (r.code !== 0) throw new Error(`gh ${args.join(' ')} 失败：${r.err || r.out}`);
  return r.out;
}

function ghJson(args) {
  return JSON.parse(gh([...args]));
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`✓ ${msg}`);
}

function info(msg) {
  console.log(`  ${msg}`);
}

/** 极简参数解析：--key value / --flag / -k value */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else if (a.startsWith('-') && a.length === 2) {
      const key = a[1];
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** gh 是否可用且已登录 */
function requireGh() {
  const v = run('gh', ['--version']);
  if (v.code !== 0) fail('找不到 gh（GitHub CLI）。请先安装并运行 gh auth login。');
  const s = run('gh', ['auth', 'status']);
  if (s.code !== 0) fail('gh 尚未登录。请先运行：gh auth login');
  return s.out || s.err;
}

/** 仓库的 owner/name，优先问 gh，其次从 origin 解析 */
function repoSlug() {
  const r = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  if (r.code === 0 && r.out) return r.out;
  const url = git('remote', 'get-url', 'origin');
  const m = /github\.com[:/]([^/]+)\/([^/.]+)/.exec(url);
  if (!m) fail(`无法从 origin 解析仓库：${url}`);
  return `${m[1]}/${m[2]}`;
}

function currentBranch() {
  return git('rev-parse', '--abbrev-ref', 'HEAD');
}

function baseBranch() {
  return process.env.PR_BASE || 'main';
}

/** 工作区是否干净 */
function isClean() {
  return git('status', '--porcelain') === '';
}

/**
 * 有没有"还没纳入本次提交"的东西。
 * 已暂存（`git add` 过）的改动不算问题 —— prepare 正是要把它们提交掉；
 * 未暂存的修改和未跟踪的新文件才算，避免漏提交。
 */
function pendingChanges() {
  const r = gitTry('status', '--porcelain');
  const lines = (r.out || '').split('\n').filter(Boolean);
  const unstaged = lines.filter((l) => l[1] !== ' ' && l[1] !== '?');
  const untracked = lines.filter((l) => l.startsWith('??'));
  return { unstaged, untracked };
}

function requireNothingPending() {
  const { unstaged, untracked } = pendingChanges();
  if (unstaged.length === 0 && untracked.length === 0) return;
  console.error('✗ 有改动还没纳入提交，先 `git add` 一下再跑：');
  for (const l of unstaged) console.error(`    M ${l.slice(3)}`);
  for (const l of untracked) console.error(`    ? ${l.slice(3)}`);
  process.exit(1);
}

function findPr(branch) {
  const r = run('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,title,url']);
  if (r.code !== 0) return null;
  try {
    const list = JSON.parse(r.out || '[]');
    return list[0] || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- status

function cmdStatus() {
  // gh 没登录也要能看本地状态，只有查 PR 那一步才需要 gh
  const ghStatus = run('gh', ['auth', 'status']);
  const authed = ghStatus.code === 0;
  console.log(`GitHub 认证: ${authed ? (ghStatus.out || ghStatus.err).split('\n')[0] : '未登录（gh auth login）'}`);
  console.log(`当前分支  : ${currentBranch()}  (base=${baseBranch()})`);

  const dirty = git('status', '--porcelain');
  if (!dirty) ok('工作区干净');
  else {
    console.log('未提交的改动：');
    for (const line of dirty.split('\n')) info(line);
  }

  if (!authed) {
    console.log('开着的 PR: 需要 gh 登录后才能查询');
    return;
  }
  console.log(`仓库      : ${repoSlug()}`);
  const prs = ghJson(['pr', 'list', '--state', 'open', '--json', 'number,title,headRefName,url']);
  if (prs.length === 0) console.log('开着的 PR: 无');
  else {
    console.log(`开着的 PR (${prs.length})：`);
    for (const p of prs) info(`#${p.number} [${p.headRefName}] ${p.title}\n      ${p.url}`);
  }
}

// ---------------------------------------------------------------- prepare

/** 按 semver 递增版本号 */
function bump(version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) fail(`package.json 的 version 不是 x.y.z：${version}`);
  let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === 'major') { maj++; min = 0; pat = 0; }
  else if (kind === 'minor') { min++; pat = 0; }
  else pat++;
  return `${maj}.${min}.${pat}`;
}

/** 同步改掉三处版本号；README 缺失时直接报错（不允许悄悄跳过） */
function syncVersionFiles(from, to) {
  const edits = [];

  const pkgPath = path.join(ROOT, 'package.json');
  const pkgText = fs.readFileSync(pkgPath, 'utf8');
  const pkgNext = pkgText.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${to}"`);
  if (pkgNext === pkgText) fail('package.json 里没找到 version 字段');
  fs.writeFileSync(pkgPath, pkgNext);
  edits.push('package.json');

  const readmePath = path.join(ROOT, 'README.md');
  const readmeText = fs.readFileSync(readmePath, 'utf8');
  if (!/当前版本\s*\d+\.\d+\.\d+/.test(readmeText)) {
    fail('README.md 里找不到「当前版本 x.y.z」，无法自动同步');
  }
  const readmeNext = readmeText.replace(/(当前版本\s*)\d+\.\d+\.\d+/, `$1${to}`);
  fs.writeFileSync(readmePath, readmeNext);
  edits.push('README.md');

  const clPath = path.join(ROOT, 'CHANGELOG.md');
  const clText = fs.readFileSync(clPath, 'utf8');
  const heading = `## [${to}]`;
  if (clText.includes(heading)) {
    info(`CHANGELOG.md 里已经有 ${to} 的段落，跳过`);
  } else {
    // 插到第一个 ## 条目前面，保留文件头的说明文字
    const m = /^##\s/m.exec(clText);
    if (!m) fail('CHANGELOG.md 里找不到任何版本条目');
    const head = clText.slice(0, m.index);
    const rest = clText.slice(m.index);
    const today = new Date().toISOString().slice(0, 10);
    const block = `## [${to}] - ${today}\n\n### 变更\n\n- （待补充）\n\n`;
    fs.writeFileSync(clPath, `${head}${block}${rest}`);
    edits.push('CHANGELOG.md');
  }

  return edits;
}

function cmdPrepare(args) {
  // prepare 是纯本地操作（建分支、升版本号、提交），不需要联网也不需要 gh 登录；
  // 真正要凭据的是后面的 push 与开 PR，那是 cmdOpen 的事。
  const message = args.m || args.message;
  if (!message) fail('缺少提交说明。用法：node tools/github.js prepare -m "fix: xxx"');

  requireNothingPending();

  const base = baseBranch();
  const cur = currentBranch();
  const kind = args.major ? 'major' : args.minor ? 'minor' : 'patch';

  // 分支名：没有就按提交说明自动生成
  let branch = args.b || args.branch;
  if (!branch) {
    const slug = String(message)
      .replace(/^[a-z]+(\([^)]*\))?:\s*/i, '')
      .replace(/[\s_]+/g, '-')
      .replace(/[^\w\u4e00-\u9fa5-]/g, '')
      .slice(0, 40)
      .replace(/-+$/, '');
    branch = `change/${slug || Date.now().toString(36)}`;
  }

  if (cur === base) {
    // 尽量基于最新的远程 base 开分支；拉不到（没网 / 还没配凭据）就用本地的，不影响提交
    const fetch = gitTry('fetch', 'origin', '--prune');
    if (fetch.code !== 0) info(`git fetch 失败（${fetch.err || fetch.out}），基于本地 ${base} 建分支`);
    git('checkout', '-b', branch);
    ok(`已创建分支 ${branch}`);
  } else if (cur !== branch) {
    info(`当前在分支 ${cur}，继续使用它（未切到 ${branch}）`);
    branch = cur;
  } else {
    ok(`已在分支 ${branch}`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const from = pkg.version;
  const to = args.version ? String(args.version) : bump(from, kind);
  const edits = syncVersionFiles(from, to);
  ok(`版本号 ${from} -> ${to}（已同步 ${edits.join(' / ')}）`);

  git('add', '-A');
  const r = run('git', ['commit', '-m', `${message}（v${to}）`]);
  if (r.code !== 0) {
    if (/nothing to commit/i.test(r.out + r.err)) fail('没有任何改动可提交。');
    throw new Error(`git commit 失败：${r.err || r.out}`);
  }
  ok(`已提交：${message}（v${to}）`);
  info('CHANGELOG.md 里的「（待补充）」记得改成实际内容，再跑 open。');
}

// ---------------------------------------------------------------- open

/** PR 正文：取 CHANGELOG 里当前版本那一段（从 `## [x.y.z]` 到下一个 `## ` 之前） */
function changelogBody(version) {
  const lines = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s/.test(l) && l.includes(`[${version}]`));
  if (start < 0) return '';
  const out = [];
  for (let i = start; i < lines.length; i++) {
    if (i > start && /^##\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

function cmdOpen(args) {
  requireGh();
  const title = args.t || args.title;
  if (!title) fail('缺少 PR 标题。用法：node tools/github.js open -t "fix: xxx"');

  const branch = args.b || args.branch || currentBranch();
  const base = baseBranch();
  if (branch === base) fail(`当前分支就是 ${base}，请先建功能分支（prepare 会自动建）。`);

  requireNothingPending();

  git('push', '-u', 'origin', branch);
  ok(`已推送分支 ${branch}`);

  const existing = findPr(branch);
  if (existing) {
    ok(`该分支已有 PR #${existing.number}：${existing.url}`);
    return existing;
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  let body = args.body || changelogBody(pkg.version);
  if (!body) body = `版本 ${pkg.version}`;
  body += `\n\n---\n\n本 PR 由 \`node tools/github.js\` 创建，分支 \`${branch}\`。`;

  const prArgs = ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body];
  if (args.draft) prArgs.push('--draft');
  const url = gh(prArgs);

  // 输出要能看出 PR 编号，方便接着 merge
  ok(`已创建 PR：${url}`);
  console.log(url);
  return { url };
}

// ---------------------------------------------------------------- merge

function cmdMerge(args) {
  requireGh();
  const method = args.method || 'squash';
  let number = Number(args.n || args.number || 0);

  if (!number) {
    const prs = ghJson(['pr', 'list', '--state', 'open', '--json', 'number,headRefName']);
    const mine = prs.find((p) => p.headRefName === currentBranch());
    if (!mine) fail('没有指定 -n，且当前分支没有对应的打开的 PR。');
    number = mine.number;
  }

  const info0 = ghJson(['pr', 'view', String(number), '--json', 'title,headRefName,baseRefName,url']);
  console.log(`合并 PR #${number}「${info0.title}」(${info0.headRefName} -> ${info0.baseRefName}) 方式=${method}`);

  gh(['pr', 'merge', String(number), `--${method}`, '--delete-branch']);
  ok(`PR #${number} 已合并`);

  const base = baseBranch();
  git('checkout', base);
  git('pull', '--ff-only', 'origin', base);
  run('git', ['fetch', 'origin', '--prune']);
  ok(`本地 ${base} 已同步到 ${git('rev-parse', '--short', 'HEAD')}`);
}

// ---------------------------------------------------------------- pr（一步到位）

function cmdPr(args) {
  cmdPrepare(args);
  if (args['no-push']) {
    info('已指定 --no-push，跳过推送与开 PR');
    return;
  }
  cmdOpen(args);
}

// ---------------------------------------------------------------- 入口

const USAGE = `GitHub 工作流工具

  node tools/github.js status
  node tools/github.js prepare -m "fix: 说明" [-b 分支名] [--minor|--major] [--version x.y.z]
  node tools/github.js open    -t "fix: 说明" [--draft] [--body "..."]
  node tools/github.js merge   [-n PR号] [--method squash|merge|rebase]
  node tools/github.js pr      -m "fix: 说明" -t "fix: 说明"   一步到位

约定：改动一律走 PR；每次改动同步升版本号（package.json / README / CHANGELOG）。`;

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  try {
    switch (cmd) {
      case 'status': return cmdStatus(args);
      case 'prepare': return cmdPrepare(args);
      case 'open': return cmdOpen(args);
      case 'merge': return cmdMerge(args);
      case 'pr': return cmdPr(args);
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        console.log(USAGE);
        return;
      default:
        fail(`未知命令：${cmd}\n\n${USAGE}`);
    }
  } catch (err) {
    fail(err.message);
  }
}

main();
