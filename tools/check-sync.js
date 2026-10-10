'use strict';

// 流程校验：**只要改了代码，就必须同步升版本号并更新 README**。
//
// 这个项目的约定是「每次修改都要 PR 上去，并且同步修改版本号和 README」。
// 人总会忘，所以在 CI 里卡住：拿当前分支和 base 比一比，
// 如果 server/ public/ desktop/ tools/ 这些目录动了，就要求
//   - package.json 的 version 相对 base 升过
//   - README.md 跟着改了
//   - CHANGELOG.md 里有新版本的条目
//
// 本地也能跑（用来开 PR 前自查）：
//   node tools/check-sync.js
//   node tools/check-sync.js --base main       指定比较的基准分支
//   CHECK_SYNC_BASE=main node tools/check-sync.js
//
// 在 CI 里如果拿不到 base（比如浅克隆且没有 origin/main），会跳过并提示，
// 不阻塞构建 —— 避免因为环境问题把正确的提交判死。

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** 改这些目录就算「改了代码」，必须配套升版本号 + 更新 README */
const CODE_DIRS = ['server/', 'public/', 'desktop/', 'tools/'];

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function main() {
  const argv = process.argv.slice(2);
  const baseArg = (() => {
    const i = argv.indexOf('--base');
    if (i >= 0 && argv[i + 1]) return argv[i + 1];
    return process.env.CHECK_SYNC_BASE || 'origin/main';
  })();

  const inside = git(['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0) {
    console.log('流程校验跳过：当前目录不是 git 仓库。');
    return 0;
  }

  // 找到真正的分叉点：分支可能落后于 base，直接 diff 会带进无关改动
  let base = baseArg;
  const hasBase = git(['rev-parse', '--verify', '--quiet', base]);
  if (hasBase.code !== 0) {
    const fallback = git(['rev-parse', '--verify', '--quiet', 'main']);
    if (fallback.code !== 0) {
      console.log(`流程校验跳过：找不到基准分支 ${base}（也没有 main）。`);
      return 0;
    }
    console.log(`提示：找不到 ${base}，改用 main 作为基准。`);
    base = 'main';
  }

  const mergeBase = git(['merge-base', 'HEAD', base]);
  if (mergeBase.code !== 0 || !mergeBase.out) {
    console.log(`流程校验跳过：无法计算与 ${base} 的共同祖先。`);
    return 0;
  }
  const from = mergeBase.out;

  if (git(['rev-parse', 'HEAD']).out === from) {
    console.log(`流程校验通过：当前分支相对 ${base} 还没有提交。`);
    return 0;
  }

  const nameOnly = git(['diff', '--name-only', from, 'HEAD']);
  const changed = nameOnly.out ? nameOnly.out.split('\n').filter(Boolean) : [];
  const codeFiles = changed.filter((f) => CODE_DIRS.some((d) => f.startsWith(d)));

  if (codeFiles.length === 0) {
    console.log('流程校验通过：本次改动没有涉及代码目录，不要求升版本号。');
    console.log(`  改动文件：${changed.length ? changed.join(', ') : '(无)'}`);
    return 0;
  }

  const readAt = (rev, file) => {
    const r = git(['show', `${rev}:${file}`]);
    return r.code === 0 ? r.out : null;
  };

  const problems = [];

  // 1) 版本号必须升过
  const pkgText = readAt('HEAD', 'package.json');
  const basePkgText = readAt(from, 'package.json');
  let version = null;
  let baseVersion = null;
  try {
    version = JSON.parse(pkgText).version;
    baseVersion = basePkgText ? JSON.parse(basePkgText).version : null;
  } catch (err) {
    problems.push(`读不出 package.json 的 version：${err.message}`);
  }
  if (version && baseVersion && version === baseVersion) {
    problems.push(`改了代码但版本号没升（还是 ${version}）。跑一下：node tools/github.js prepare -m "..."`);
  }
  if (version && baseVersion) {
    const cmp = (a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
      return 0;
    };
    if (cmp(version, baseVersion) < 0) {
      problems.push(`版本号比 ${base} 还低：${baseVersion} -> ${version}`);
    }
  }

  // 2) README 必须跟着改
  if (!changed.includes('README.md')) {
    problems.push('改了代码但没动 README.md。README 里至少要把「当前版本」同步掉。');
  } else {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    if (version && !new RegExp(`当前版本\\s*${version.replace(/\./g, '\\.')}`).test(readme)) {
      problems.push(`README.md 里的「当前版本」没更新到 ${version}。`);
    }
  }

  // 3) CHANGELOG 必须有对应条目
  if (!changed.includes('CHANGELOG.md')) {
    problems.push('改了代码但没动 CHANGELOG.md。请为本次版本补一条更新日志。');
  } else if (version) {
    const cl = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
    if (!new RegExp(`^##\\s+\\[?${version.replace(/\./g, '\\.')}\\]?`, 'm').test(cl)) {
      problems.push(`CHANGELOG.md 里没有 ${version} 的条目。`);
    }
  }

  if (problems.length > 0) {
    console.error('流程校验未通过（改动必须配套升版本号 + 更新 README）：');
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error('');
    console.error('  代码改动：');
    for (const f of codeFiles.slice(0, 20)) console.error(`    - ${f}`);
    if (codeFiles.length > 20) console.error(`    ... 另有 ${codeFiles.length - 20} 个文件`);
    process.exit(1);
  }

  console.log(`流程校验通过：版本 ${baseVersion} -> ${version}，README 与 CHANGELOG 均已同步。`);
  console.log(`  代码改动 ${codeFiles.length} 个文件，基准 ${base}（分叉点 ${from.slice(0, 7)}）`);
  return 0;
}

process.exit(main());
