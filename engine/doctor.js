/**
 * 自检：装完之后跑一遍，知道缺什么、怎么补。
 * 同一份逻辑给 CLI（test/doctor.mjs）和面板（doctor 接口）用。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { machineFile } from './config.js';
import { findCodex } from './video.js';
import { resolveOpenFilm } from './openfilm.js';

const okItem = (name, detail) => ({ name, status: 'ok', detail, fix: '' });
const warnItem = (name, detail, fix = '') => ({ name, status: 'warn', detail, fix });
const failItem = (name, detail, fix = '') => ({ name, status: 'fail', detail, fix });

function writable(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.doctor-${process.pid}.tmp`);
    writeFileSync(probe, 'ok', 'utf8');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function runDoctor({ options, dataRoot, projectRoot, promptsDir }) {
  const items = [];
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

  // 1. Node
  const major = Number(String(process.versions.node).split('.')[0]);
  items.push(major >= 20
    ? okItem('Node 运行时', `v${process.versions.node}`)
    : failItem('Node 运行时', `v${process.versions.node} 太旧`, '装 Node 20 或更高版本'));

  // 2. 本机配置
  const file = machineFile();
  if (!existsSync(file)) {
    items.push(warnItem('本机配置 machine.json', '没有这个文件，全部走默认值/环境变量',
      `可选：新建 ${file}，或在环境变量里给密钥`));
  } else {
    try {
      JSON.parse(readFileSync(file, 'utf8'));
      items.push(okItem('本机配置 machine.json', file));
    } catch (error) {
      items.push(failItem('本机配置 machine.json', `JSON 解析失败：${error.message}`, '修好这个文件的 JSON 格式'));
    }
  }

  // 3. 目录可写
  items.push(writable(projectRoot) ? okItem('项目目录', projectRoot) : failItem('项目目录不可写', projectRoot, '换一个路径，或给它写权限'));
  items.push(writable(dataRoot) ? okItem('数据目录', dataRoot) : failItem('数据目录不可写', dataRoot, '换一个路径，或给它写权限'));
  items.push(writable(promptsDir) ? okItem('提示词目录', promptsDir) : warnItem('提示词目录不可写', promptsDir, '提示词模板将无法保存'));

  // 4. ffmpeg
  const ffmpeg = options.ffmpegPath || 'ffmpeg';
  const ff = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  if (ff.status === 0) {
    const version = String(ff.stdout ?? '').split('\n')[0].slice(0, 60);
    items.push(okItem('ffmpeg', `${ffmpeg}｜${version}`));
  } else {
    items.push(failItem('ffmpeg 不可用', `试过：${ffmpeg}`,
      '装 FFmpeg 6.1+，把 ffmpegPath 指到 ffmpeg.exe，或把 ffmpeg 加进 PATH'));
  }

  // 5. shot-contract（分镜硬依赖）
  const checkScript = join(options.skillDir, 'scripts', 'check.mjs');
  items.push(existsSync(checkScript)
    ? okItem('shot-contract 技能', options.skillDir)
    : failItem('缺 shot-contract 技能', `找不到 ${checkScript}`,
      '分镜的 13 道门依赖它；装到 ~/.dsh/skills/shot-contract，或把 skillDir 指过去'));

  // 6. 拉片脚本（可选）
  const frames = join(options.scriptsDir, 'frames.mjs');
  items.push(existsSync(frames)
    ? okItem('拉片脚本', options.scriptsDir)
    : warnItem('没有拉片脚本', `找不到 ${frames}`, '不装也能用；装了才能在拉片台按链接/文件拆片'));

  // 7. rea-video（可选）
  if (!options.reaVideoCmd) {
    items.push(warnItem('rea-video', '没配置（拉片时会跳过逐镜判定）', '可选：配 reaVideoCmd 指向 rea-video.exe'));
  } else {
    items.push(existsSync(options.reaVideoCmd)
      ? okItem('rea-video', options.reaVideoCmd)
      : failItem('rea-video 路径不对', options.reaVideoCmd, '改 reaVideoCmd，或置空跳过'));
  }

  // 8. Codex（可选，生图用）
  const codex = options.codexCmd || findCodex();
  items.push(codex && existsSync(codex)
    ? okItem('Codex（生图）', codex)
    : warnItem('没有 Codex', '定妆图会退回 HTTP 生图端点', '可选：装 Codex 桌面版，或配 imageKey + imageBaseUrl'));

  // 9. OpenFilm（可选，收尾用）
  let openfilm = null;
  try {
    const runners = resolveOpenFilm({ cmd: options.openfilmCmd, candidates: options.openfilmCheckouts ?? [] });
    openfilm = Array.isArray(runners) ? runners[0] ?? null : runners;
  } catch {
    openfilm = null;
  }
  items.push(openfilm
    ? okItem('OpenFilm（收尾）', openfilm.label ?? '已找到')
    : warnItem('没有 OpenFilm', '成片收尾会退回 ffmpeg', '可选：npm i -g openfilm'));

  // 10. 出片密钥
  if (options.easyframeApiKey || options.mnmxCardKey) {
    const which = [options.easyframeApiKey ? 'EasyFrame' : '', options.mnmxCardKey ? '鼠鼠工具' : ''].filter(Boolean).join(' + ');
    items.push(okItem('出片密钥', which));
  } else {
    items.push(failItem('没有出片密钥', 'easyframeApiKey / mnmxCardKey 都是空的', '在 machine.json 或环境变量里配一个，否则出片阶段必然失败'));
  }

  // 11. 生图
  if (options.imageBackend === 'codex' || (codex && existsSync(codex))) {
    items.push(okItem('生图后端', 'Codex image_generation'));
  } else if (options.imageKey) {
    items.push(okItem('生图后端', options.imageBaseUrl || 'HTTP 端点'));
  } else {
    items.push(warnItem('没有生图后端', '人物定妆图会被跳过', '装 Codex，或配 imageKey + imageBaseUrl'));
  }

  // 12. 包内文件
  const files = ['index.js', 'client.js', 'cordis.patch.yml', 'locale/zh.json'];
  const missing = files.filter((name) => !existsSync(join(pkgRoot, name)));
  items.push(missing.length === 0
    ? okItem('包内文件', `${files.length} 个关键文件齐全`)
    : failItem('包内文件缺失', missing.join('、'), '重新安装插件（包可能不完整）'));

  const failed = items.filter((item) => item.status === 'fail').length;
  return { ok: failed === 0, summary: { ok: items.filter((i) => i.status === 'ok').length, warn: items.filter((i) => i.status === 'warn').length, fail: failed }, items };
}
