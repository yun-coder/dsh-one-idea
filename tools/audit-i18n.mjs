import { readFileSync } from 'node:fs';

const lines = readFileSync('client.js', 'utf8').split(/\r?\n/);

/** 找到 `const zh = {` / `const en = {` 到它自己的 `};`，不写死行号。 */
function dictRange(name) {
  const start = lines.findIndex((line) => new RegExp(`^\\s*const ${name} = \\{`).test(line));
  if (start < 0) return [0, 0];
  let end = start + 1;
  while (end < lines.length && !/^\s*\};\s*$/.test(lines[end])) end += 1;
  return [start, end];
}

const [zs, ze] = dictRange('zh');
const [es, ee] = dictRange('en');
const keysIn = (from, to) => {
  const keys = new Set();
  for (let i = from; i < to; i += 1) {
    const match = lines[i].match(/^\s{4,8}([A-Za-z_][A-Za-z0-9_]*):\s*['"`]/);
    if (match) keys.add(match[1]);
  }
  return keys;
};
const zh = keysIn(zs, ze);
const en = keysIn(es, ee);
console.log(`zh ${zh.size} keys (line ${zs + 1}-${ze + 1}) | en ${en.size} keys (line ${es + 1}-${ee + 1})`);
console.log('缺英文:', [...zh].filter((k) => !en.has(k)).join(',') || '无');
console.log('多英文:', [...en].filter((k) => !zh.has(k)).join(',') || '无');

const cjk = /[\u4e00-\u9fa5]/;
const hits = [];
for (let i = Math.max(ze, ee) + 1; i < lines.length; i += 1) {
  const line = lines[i];
  if (!cjk.test(line)) continue;
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
  if (/\/\^?第/.test(trimmed) || trimmed.includes('第\\s*(')) continue; // 解析用正则，不是文案
  hits.push(`${i + 1}: ${trimmed.slice(0, 110)}`);
}
console.log(`\n字典外中文字符串行数: ${hits.length}`);
console.log(hits.join('\n'));
