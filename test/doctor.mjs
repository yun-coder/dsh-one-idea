/**
 * 环境自检：
 *   node test/doctor.mjs
 *
 * 检查 Node / 配置 / 目录 / ffmpeg / shot-contract / 拉片脚本 / rea-video /
 * Codex / OpenFilm / 出片密钥 / 生图后端 / 包内文件，并给出修复提示。
 * 失败项会以退出码 1 结束，方便装完直接跑一遍。
 */
import { resolveConfig } from '../engine/config.js';
import { runDoctor } from '../engine/doctor.js';

const resolved = resolveConfig({});
const result = await runDoctor(resolved);
const icon = { ok: '✓', warn: '!', fail: '✗' };

console.log('\n创意工作台 · 环境自检\n');
for (const item of result.items) {
  console.log(`  ${icon[item.status] ?? '?'} ${item.name}：${item.detail}`);
  if (item.fix && item.status !== 'ok') console.log(`      → ${item.fix}`);
}
console.log(`\n通过 ${result.summary.ok} · 提醒 ${result.summary.warn} · 失败 ${result.summary.fail}\n`);
process.exit(result.ok ? 0 : 1);
