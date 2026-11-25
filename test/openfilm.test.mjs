/**
 * OpenFilm 收尾器自测：不联网、不调模型、不花额度。
 *
 * 造两段合成片段（不同画幅，用来验证「不重编码、靠 CSS 消化画幅」），
 * 走一遍 film.html → render → look，检查成片时长、工程文件、逐帧体检结果。
 *
 *   node test/openfilm.test.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createMedia } from '../engine/media.js';
import { createOpenFilmFinisher } from '../engine/openfilm.js';

// OpenFilm render 依赖 Playwright 的 chromium；没有就直接跳过，别在测试里等它下载浏览器。
const playwrightRoot = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
const hasChromium = existsSync(playwrightRoot) && readdirSync(playwrightRoot).some((name) => /^chromium/i.test(name));
if (!hasChromium) {
  console.log('跳过：本机没装 Playwright Chromium，OpenFilm render 会在渲染现场下载浏览器（通常卡很久）。');
  process.exit(0);
}

const media = createMedia({});

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-y', '-v', 'error', ...args], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-300)))));
  });
}

async function makeClip(file, { width, height, seconds, color, tone }) {
  await ffmpeg([
    '-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}:r=30:d=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${seconds}:sample_rate=48000`,
    '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-c:a', 'aac', '-b:a', '128k',
    file,
  ]);
}

const steps = [];
const step = (name, ok, detail = '') => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const root = await mkdtemp(join(tmpdir(), 'cs-openfilm-'));
const projectDir = join(root, 'cs_test_0001');
const segmentsDir = join(projectDir, 'segments');
await mkdir(segmentsDir, { recursive: true });

try {
  // 1) 两段合成片段：一段竖屏、一段横屏（横屏会在 stage 上被 object-fit 收进画幅里）
  const clipA = join(segmentsDir, 'seg-01.mp4');
  const clipB = join(segmentsDir, 'seg-02.mp4');
  await makeClip(clipA, { width: 480, height: 864, seconds: 3, color: '0x2a6f97', tone: 440 });
  await makeClip(clipB, { width: 864, height: 480, seconds: 3, color: '0xb5651d', tone: 660 });
  step('合成测试片段', existsSync(clipA) && existsSync(clipB), '480x864 / 864x480，各 3s');

  const edl = {
    order: [
      { segmentId: 'seg-01', transition: 'fade', trimStart: 0.2, trimEnd: 2.8 },
      { segmentId: 'seg-02', transition: 'cut', trimStart: 0, trimEnd: null },
    ],
    audio: { bgm: '', gainDb: -18, lufs: -14 },
  };
  const tasks = [
    { segmentId: 'seg-01', status: 'completed', file: clipA },
    { segmentId: 'seg-02', status: 'completed', file: clipB },
  ];

  const finisher = createOpenFilmFinisher({
    // 留空就走 PATH 上的 openfilm（npm i -g openfilm）；设 OPENFILM_BIN 可以指到别的检出
    config: {
      openfilmCmd: process.env.OPENFILM_BIN ?? '',
      openfilmCheckouts: [],
    },
    media,
    log: (line) => console.log(`  ${line}`),
  });

  const availability = await finisher.available();
  step('找到 OpenFilm', availability.ok, availability.ok ? `${availability.version}` : availability.reason);
  if (!availability.ok) throw new Error('没有 OpenFilm，后面的用例跳过');

  // 2) 由 EDL 生成 film.html（不渲染，先看结构）
  const planned = await finisher.writeFilm({
    projectDir,
    clips: [clipA, clipB],
    entries: edl.order,
    bgm: null,
    width: 1080,
    height: 1920,
    lufs: -14,
    gainDb: -18,
    filmDir: projectDir,
  });
  const html = await readFile(planned.filmHtml, 'utf8');
  const videoCount = (html.match(/<video /g) ?? []).length;
  step('film.html 结构', videoCount === 2 && /#t=0\.200,2\.800/.test(html) && /overrides='\[\{"fade":\[0\.25,0\.25\]\}\]'/.test(html),
    `${videoCount} 个 <video>，裁剪一段、淡入淡出一段`);
  step('时间线由 EDL 算出', Math.abs(planned.duration - 5.6) < 0.05, `${planned.duration}s（2.6s 裁剪段 + 3.0s 整段）`);

  // 3) 渲染
  const finalFile = join(projectDir, '07-final.mp4');
  const rendered = await finisher.render({ filmDir: projectDir, finalFile, fps: 30, lufs: -14, workers: 2 });
  const info = await media.probe(finalFile);
  step('渲染成片', existsSync(finalFile) ? true : false, `${info.width}x${info.height} · ${info.duration.toFixed(2)}s · ${rendered.elapsed}s 渲完`);

  // 4) 逐帧体检
  const qa = await finisher.look({ filmDir: projectDir, file: finalFile, lufs: -14 });
  step('look 逐帧体检', qa.exitCode === 0 || qa.exitCode === 1, `exit ${qa.exitCode} · ${qa.errors.length} 个硬问题 / ${qa.warnings.length} 个提醒`);
  if (qa.warnings.length) console.log(`    提醒：${qa.warnings.join(' | ').slice(0, 300)}`);
  if (qa.errors.length) console.log(`    硬问题：${qa.errors.join(' | ').slice(0, 300)}`);

  // 5) 工程可复用：Studio 能把它当项目打开
  step('留下可手改的工程', existsSync(join(projectDir, 'film.html')) && existsSync(join(projectDir, '.film', 'opened')));

  // 6) 带 BGM（比成片短，要首尾相接地铺满）与字幕带的完整收尾
  const bgmFile = join(projectDir, 'bgm-test.mp3');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=1.5:sample_rate=48000', '-c:a', 'libmp3lame', bgmFile]);
  const captions = join(projectDir, 'captions.vtt');
  await writeFile(captions, 'WEBVTT\n\n00:00:00.500 --> 00:00:03.000\n第一句测试字幕\n\n00:00:03.000 --> 00:00:05.500\n第二句测试字幕\n', 'utf8');

  const finalWithBgm = join(projectDir, '07-final-bgm.mp4');
  const full = await finisher.finish({
    projectDir,
    edl,
    clips: [clipA, clipB],
    entries: edl.order,
    bgm: bgmFile,
    width: 1080,
    height: 1920,
    lufs: -14,
    gainDb: -18,
    fps: 30,
    workers: 2,
    finalFile: finalWithBgm,
  });
  const withBgmHtml = await readFile(full.filmHtml, 'utf8');
  const bgmClips = (withBgmHtml.match(/<audio /g) ?? []).length;
  step('BGM 铺满整条时间线', bgmClips >= 4, `${bgmClips} 段 1.5s 的 BGM 铺到 5.6s 上`);
  step('字幕带进 film.html', /<track kind="captions"/.test(withBgmHtml));
  const bgmInfo = await media.probe(finalWithBgm);
  step('带 BGM 的成片', Math.abs(bgmInfo.duration - 5.6) < 0.15, `${bgmInfo.duration.toFixed(2)}s`);

  // 7) 同一份工程再渲一次：确定性重渲不该变长度
  const again = join(projectDir, '07-final-again.mp4');
  await finisher.render({ filmDir: projectDir, finalFile: again, fps: 30, lufs: -14, workers: 2 });
  const againInfo = await media.probe(again);
  step('重渲结果一致', Math.abs(againInfo.duration - bgmInfo.duration) < 0.05, `${againInfo.duration.toFixed(2)}s`);

  // 8) 画质档 high：2 倍画再降采样，尺寸与时长都不能变
  const hq = join(projectDir, '07-final-hq.mp4');
  const hqResult = await finisher.finish({
    projectDir,
    edl,
    clips: [clipA, clipB],
    entries: edl.order,
    bgm: null,
    width: 1080,
    height: 1920,
    lufs: -14,
    gainDb: -18,
    fps: 30,
    workers: 2,
    quality: 'high',
    bitrate: 8,
    finalFile: hq,
  });
  const hqInfo = await media.probe(hq);
  const hqBytes = (await stat(hq)).size;
  step('超采样后降到交付尺寸', hqInfo.width === 1080 && hqInfo.height === 1920 && Math.abs(hqInfo.duration - 5.6) < 0.15,
    `${hqInfo.width}x${hqInfo.height} · ${hqInfo.duration.toFixed(2)}s · ${(hqBytes / 1024 / 1024).toFixed(2)} MB · 档位 ${hqResult.quality}`);
  step('超采样倍率生效', hqResult.supersample === 2, `渲染 ${1080 * 2}x${1920 * 2} 后降采样`);

  const failed = steps.filter((entry) => !entry.ok);
  console.log(`\n${steps.length - failed.length}/${steps.length} 通过`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error(`\n✗ 中断：${error.message}`);
  process.exitCode = 1;
} finally {
  if (!process.env.KEEP) await rm(root, { recursive: true, force: true }).catch(() => {});
  else console.log(`\n产物留在 ${root}`);
}
