'use strict';

// 版本号一致性检查。
//
// 发版时最容易漏的是文档：README 里的「当前版本」、CHANGELOG 的条目、
// package.json 的 version，这三处必须对得上。这个脚本把它们对一遍，
// 对不上就直接报错，接在 npm test 与 CI 里，省得靠自觉。
//
// 用法： node tools/check-version.js

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const pkg = JSON.parse(read('package.json'));
const version = pkg.version;
const problems = [];

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  problems.push(`package.json 的 version 不是 x.y.z 格式：${version}`);
}

const readme = read('README.md');
const readmeMatch = /当前版本\s*([0-9]+\.[0-9]+\.[0-9]+)/.exec(readme);
if (!readmeMatch) {
  problems.push('README.md 里找不到「当前版本 x.y.z」，发版时记得更新');
} else if (readmeMatch[1] !== version) {
  problems.push(`README.md 写的是 ${readmeMatch[1]}，package.json 是 ${version}`);
}

const changelog = read('CHANGELOG.md');
const headings = [...changelog.matchAll(/^##\s+\[([^\]]+)\]/gm)].map((m) => m[1]);
if (headings.length === 0) {
  problems.push('CHANGELOG.md 里没有任何版本条目');
} else {
  if (headings[0] !== version) {
    problems.push(`CHANGELOG.md 最新条目是 ${headings[0]}，package.json 是 ${version}`);
  }
  if (!headings.includes(version)) {
    problems.push(`CHANGELOG.md 里没有 ${version} 的条目`);
  }
}

if (problems.length > 0) {
  console.error('版本号检查未通过：');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

console.log(`版本号检查通过：${version}`);
console.log(`  package.json  ${version}`);
console.log(`  README.md     当前版本 ${version}`);
console.log(`  CHANGELOG.md  最新条目 [${version}]`);
