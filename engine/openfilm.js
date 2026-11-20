/**
 * OpenFilm 收尾器（finisher）：把工作台的 EDL 变成一份 film.html，再用 OpenFilm 渲染成片。
 *
 * 为什么要它：原来的收尾是「逐段重编码统一规格 → concat 拼接 → 混 BGM → loudnorm」，
 * 一次性把钱花在重编码上，而且成片是个黑盒 MP4。换成 OpenFilm 之后：
 *
 *   - 不再逐段重编码：片段原样当 <video> 用，#t=in,out 做非破坏裁剪，画幅靠 CSS 消化；
 *   - 成片同时是一份可打开、可手改的工程（film.html），人能进 Studio 调，agent 重跑不会覆盖；
 *   - 免费拿到字幕带、字卡层、LUT 调色、4K 导出、硬件编码；
 *   - `look` 给审核 Agent 一份逐帧证据（白闪 / 黑帧 / 静帧 / 响度 / 确定性）。
 *
 * 这个模块不 import 任何 DSH 包，也不碰 ctx：可以拿两个合成片段脱离 Harness 单测。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

/** cp 里给「渲染不确定」这类硬问题的退出码，和 look 的约定一致：0 过、1 有问题、2 用错。 */
const EXIT_OK = 0;

function run(bin, args, { cwd, timeout = 1_800_000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      // 插件跑在 Electron 里时 process.execPath 是 app 本身：要它当 node 用，得开 ELECTRON_RUN_AS_NODE
      const asNode = bin === process.execPath && process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
      child = spawn(bin, args, { cwd, windowsHide: true, env: { ...process.env, ...asNode, ...env } });
    } catch (error) {
      reject(new Error(`启动 ${bin} 失败：${error.message}`));
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退出 */
      }
      reject(new Error(`${bin} 超时（${Math.round(timeout / 1000)}s）：${stderr.trim().slice(-300)}`));
    }, timeout);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`跑不了 ${bin}：${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const fmt = (value) => (Math.round(Number(value) * 1000) / 1000).toFixed(3);
/** 相对路径进 HTML 之前：Windows 反斜杠、空格与非 ASCII 都要能当 URL 用。 */
const toSrc = (from, to) => encodeURI(relative(from, to).split('\\').join('/'));
/** 分贝转线性音量：EDL 里的 gainDb 是「BGM 相对原文件的增益」。 */
const dbToGain = (db) => Math.min(1, Math.max(0, 10 ** (Number(db) / 20)));
const attr = (value) => String(value).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');

/**
 * 找 OpenFilm 的命令行。
 *
 * 顺序：配置里的 openfilmCmd → 配置里的检出目录 → npm 全局包装在哪（常见前缀）→ PATH 上的 openfilm。
 *
 * Windows 上不能直接 spawn `openfilm`：npm 装的是 .cmd shim，Node 不允许无 shell 执行。
 * 所以先按「全局包的 bin 入口」推路径（node 的安装目录与 %APPDATA%\\npm 两种布局），
 * 一条都不通再把裸命令当最后的兜底（那一条在 Windows 上会失败，失败就跳过）。
 */
export function resolveOpenFilm({ cmd = '', candidates = [] } = {}) {
  const list = [];
  if (cmd) list.push({ bin: process.execPath, args: [cmd], label: cmd, script: cmd });
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) list.push({ bin: process.execPath, args: [candidate], label: candidate, script: candidate });
  }
  // npm i -g openfilm 之后，包就在 node 前缀的 node_modules 里
  const prefixes = [join(dirname(process.execPath), 'node_modules')];
  if (process.env.APPDATA) prefixes.push(join(process.env.APPDATA, 'npm', 'node_modules'));
  if (process.env.ProgramFiles) prefixes.push(join(process.env.ProgramFiles, 'nodejs', 'node_modules'));
  for (const prefix of prefixes) {
    const entry = join(prefix, 'openfilm', 'bin', 'openfilm.mjs');
    if (existsSync(entry)) list.push({ bin: process.execPath, args: [entry], label: entry, script: entry });
  }
  // 还找不到就问一遍 PATH：`where openfilm` 拿到 shim，再从 shim 里读它真正跑的那个 .mjs。
  // （Windows 上 npm 装的是 .cmd，Node 不允许无 shell 直接 spawn，所以要读出来走 node。）
  for (const shim of shimsOnPath()) list.push(shim);
  list.push({ bin: 'openfilm', args: [], label: 'openfilm', script: '' });
  return list;
}

/** 从 PATH 上把 openfilm 的 shim 拆成「node + 脚本」的形式。 */
function shimsOnPath() {
  const found = [];
  try {
    const where = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(where, ['openfilm'], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0 || !result.stdout) return found;
    for (const line of String(result.stdout).split(/\r?\n/).map((text) => text.trim()).filter(Boolean)) {
      if (/\.m?js$/i.test(line) && existsSync(line)) {
        found.push({ bin: process.execPath, args: [line], label: line, script: line });
        continue;
      }
      if (/\.(cmd|bat)$/i.test(line) && existsSync(line)) {
        const text = readFileSync(line, 'utf8');
        const match = text.match(/"([^"]+\.m?js)"/i);
        // npm 的 shim 写的是 %dp0%\node_modules\...，要按 shim 所在目录展开
        const target = match ? match[1].replace(/%dp0%\\?/gi, `${dirname(line)}\\`) : '';
        if (target && existsSync(target)) {
          found.push({ bin: process.execPath, args: [target], label: target, script: target });
          continue;
        }
        const beside = join(dirname(line), 'node_modules', 'openfilm', 'bin', 'openfilm.mjs');
        if (existsSync(beside)) found.push({ bin: process.execPath, args: [beside], label: beside, script: beside });
      }
    }
  } catch {
    /* 问不到就算了，交给最后那条裸命令兜底 */
  }
  return found;
}

export function createOpenFilmFinisher({ config = {}, log = () => {}, media = null, probe = null } = {}) {
  const candidates = [config.openfilmCmd, ...(config.openfilmCheckouts ?? [])].filter(Boolean);
  const tries = resolveOpenFilm({ cmd: '', candidates });
  const readProbe = probe ?? (media ? (file) => media.probe(file) : null);
  let cached = null;

  /** 一次 `--version` 定音：有、且能跑。 */
  async function available() {
    if (cached) return cached;
    for (const entry of tries) {
      const result = await run(entry.bin, [...entry.args, '--version'], { timeout: 60_000 }).catch(() => null);
      if (result && result.code === 0 && /\d+\.\d+/.test(result.stdout)) {
        cached = { ok: true, ...entry, version: result.stdout.trim() };
        return cached;
      }
    }
    cached = { ok: false, reason: '没找到可用的 OpenFilm 命令行（配置 openfilmCmd，或把它装进 PATH）' };
    return cached;
  }

  const invoke = (entry, args, options) => run(entry.bin, [...entry.args, ...args], options);

  /**
   * OpenFilm 只服务项目目录内的文件：`../` 一律 404。
   * 素材在项目外（例如片段落在别的目录）就先复制进 `<项目>/media/`，再按项目内路径引用。
   */
  async function localize(file, projectDir) {
    const rel = relative(projectDir, file);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return file;
    const mediaDir = join(projectDir, 'media');
    await mkdir(mediaDir, { recursive: true });
    const target = join(mediaDir, basename(file));
    const same = existsSync(target) && (await stat(target)).size === (await stat(file)).size;
    if (!same) await copyFile(file, target);
    return target;
  }

  /**
   * 由 EDL 生成 film.html。
   *
   * @param {object} input
   * @param {string} input.projectDir  项目目录（片段、BGM、字幕都在里面）
   * @param {string[]} input.clips     按成片顺序排好的片段文件
   * @param {Array<{trimStart?: number, trimEnd?: number, transition?: string}>} input.entries
   * @param {string|null} input.bgm
   * @param {number} input.width
   * @param {number} input.height
   * @param {number} input.lufs
   * @param {number} input.gainDb
   * @param {string|null} input.captions  字幕 .vtt 路径
   * @param {string} input.filmDir   film.html 落盘目录
   */
  async function writeFilm(input) {
    const { projectDir, clips, entries, bgm, width, height, captions, filmDir } = input;
    const fadeEdge = 0.25;
    const tracks = [];
    let at = 0;
    const timeline = [];

    for (const [index, file] of clips.entries()) {
      const entry = entries[index] ?? {};
      const local = await localize(file, projectDir);
      const info = readProbe ? await readProbe(local) : { duration: 0 };
      const total = Number(info?.duration) || 0;
      const start = Math.max(0, Number(entry.trimStart) || 0);
      const end = entry.trimEnd === null || entry.trimEnd === undefined ? total : Math.min(total, Number(entry.trimEnd) || total);
      const length = Math.max(0.1, (end > start ? end - start : total) || total);
      const fragment = total > 0 ? `#t=${fmt(start)},${fmt(start + length)}` : '';
      const fade = String(entry.transition ?? 'cut') === 'fade' && length > 0.8;
      const overrides = fade ? ` overrides='[{"fade":[${fadeEdge},${fadeEdge}]}]'` : '';
      tracks.push(
        `  <video id="s${String(index + 1).padStart(2, '0')}" src="${attr(toSrc(filmDir, local))}${fragment}" at="${fmt(at)}"${overrides}></video>`,
      );
      timeline.push({ clip: `s${String(index + 1).padStart(2, '0')}`, file: local, at: Math.round(at * 1000) / 1000, length: Math.round(length * 1000) / 1000, fade });
      at += length;
    }

    const sections = [`<section>\n${tracks.join('\n')}\n</section>`];

    if (bgm && existsSync(bgm)) {
      const volume = Number(dbToGain(input.gainDb ?? -18).toFixed(3));
      // BGM 比成片短就首尾相接地铺满（等价于 ffmpeg 那条 -stream_loop -1）：同一条轨道上顺序排，绝不重叠。
      const localBgm = await localize(bgm, projectDir);
      const bgmInfo = readProbe ? await readProbe(localBgm) : { duration: 0 };
      const bgmLength = Number(bgmInfo?.duration) || 0;
      const pieces = [];
      if (bgmLength <= 0.05) {
        pieces.push({ at: 0, fragment: '' });
      } else {
        for (let offset = 0; offset < at - 0.05; offset += bgmLength) {
          const length = Math.min(bgmLength, at - offset);
          pieces.push({ at: offset, fragment: length < bgmLength ? `#t=0,${fmt(length)}` : `#t=0,${fmt(bgmLength)}` });
        }
      }
      const clips = pieces.map((piece, index) => {
        const fadeIn = index === 0 ? 0.5 : 0;
        const fadeOut = index === pieces.length - 1 ? 0.8 : 0;
        const overrides = fadeIn || fadeOut ? ` overrides='[{"fade":[${fadeIn},${fadeOut}]}]'` : '';
        return `  <audio id="bgm${index + 1}" src="${attr(toSrc(filmDir, localBgm))}${piece.fragment}" at="${fmt(piece.at)}" volume="${volume}"${overrides}></audio>`;
      });
      sections.push(`<section>\n${clips.join('\n')}\n</section>`);
    }

    if (captions && existsSync(captions)) {
      const localCaptions = await localize(captions, projectDir);
      sections.push(
        `<section>\n  <track kind="captions" src="${attr(toSrc(filmDir, localCaptions))}" srclang="zh" label="中文">\n</section>`,
      );
    }

    const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${width}, height=${height}">
<style>
  /* 字幕的样式：工作台出的 VTT 只写台词，样子在这里 */
  ::cue { font-family: "Microsoft YaHei", system-ui, sans-serif; font-size: 42px; line-height: 1.35;
          color: #fff; background-color: rgba(0, 0, 0, .42); padding: 8px 14px; border-radius: 10px; }
</style>
</head>
<body>
${sections.join('\n\n')}
</body>
</html>
`;
    await mkdir(filmDir, { recursive: true });
    const filmHtml = join(filmDir, 'film.html');
    await writeFile(filmHtml, html, 'utf8');
    // 「Studio 已经看过这个项目」的标记：不写它，render 会先起一个 Studio 再渲染。
    await mkdir(join(filmDir, '.film'), { recursive: true });
    await writeFile(join(filmDir, '.film', 'opened'), '', 'utf8');
    return { filmHtml, timeline, duration: Math.round(at * 1000) / 1000 };
  }

  /** 渲染。成片直接写到 finalFile（--out），工作目录是 film.html 所在的目录。 */
  async function render({ filmDir, finalFile, fps = 30, lufs = -14, workers = 0, scale = 1, timeout = 1_800_000 }) {
    const entry = await available();
    if (!entry.ok) throw new Error(entry.reason);
    const args = ['render', '--fps', String(fps), `--loudness=${Number(lufs)}`, '--out', finalFile];
    const parallel = Number(workers) || 0;
    if (parallel > 0) args.push('--workers', String(parallel));
    // 超采样：OpenFilm 按这个像素密度画，输出就是 N 倍宽高（之后由 ffmpeg 降到交付尺寸）。
    if (Number(scale) > 1) args.push('--scale', String(Number(scale)));
    const started = Date.now();
    const result = await invoke(entry, args, { cwd: filmDir, timeout, env: { OPENFILM_NO_BROWSER: '1' } });
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (result.code !== EXIT_OK || !existsSync(finalFile)) {
      throw new Error(`openfilm render 失败（退出码 ${result.code}）：${(result.stderr || result.stdout).trim().split('\n').slice(-3).join('；').slice(0, 400)}`);
    }
    return { finalFile, elapsed, log: result.stdout.trim(), engine: 'openfilm', version: entry.version };
  }

  /**
   * 把超采样出来的大图降到交付尺寸，同时把码率定下来。
   *
   * OpenFilm 的 render 没有码率参数：它优先用硬件编码器的「高质量」档，1080×1920 大约 1.2 Mbps，
   * 对平台投递偏软。两条路里选了不碰上游的那条：先按 2 倍画（2160×3840）渲出来，
   * 再用 ffmpeg 的 lanczos 降采样到交付尺寸——细节比原生 1.2 Mbps 明显更实，码率也随之可控。
   */
  async function downscale({ input, output, width, height, bitrate = 0, timeout = 1_800_000 }) {
    const args = ['-y', '-v', 'error', '-i', input,
      '-vf', `scale=${width}:${height}:flags=lanczos`, '-c:v', 'libx264', '-preset', 'medium'];
    const mbps = Number(bitrate) || 0;
    if (mbps > 0) {
      args.push('-b:v', `${mbps}M`, '-maxrate', `${(mbps * 1.5).toFixed(1)}M`, '-bufsize', `${(mbps * 2).toFixed(0)}M`);
    } else {
      args.push('-crf', '18');
    }
    args.push('-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', output);
    await media.run(media.ffmpeg, args, { timeout });
    return output;
  }

  /**
   * 逐帧体检：look --full 看完整片（白闪 / 跳帧 / 静帧 / 黑帧），--loudness 说混音离目标多远。
   * 返回的结构直接进审核证据：errors 是硬问题，warnings 是提醒。
   */
  async function look({ filmDir, file, lufs = -14, timeout = 900_000 }) {
    const entry = await available();
    if (!entry.ok) return { ok: false, skipped: true, reason: entry.reason, errors: [], warnings: [], lines: [] };
    const args = ['look', file, '--full', `--loudness=${Number(lufs)}`];
    const result = await invoke(entry, args, { cwd: filmDir, timeout, env: { OPENFILM_NO_BROWSER: '1' } });
    const lines = (result.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const errors = lines.filter((line) => line.startsWith('✗')).map((line) => line.replace(/^✗\s*/, ''));
    const warnings = lines.filter((line) => line.startsWith('!')).map((line) => line.replace(/^!\s*/, ''));
    const info = lines.filter((line) => !line.startsWith('✗') && !line.startsWith('!') && !line.startsWith('→'));
    return {
      ok: result.code === EXIT_OK && errors.length === 0,
      exitCode: result.code,
      errors,
      warnings,
      info: info.slice(0, 6),
      lines,
    };
  }

  /**
   * 一步到位：写 film.html → 渲染 →（需要时）降采样到交付尺寸 → 返回。
   * 失败时抛错，调用方据此退回原来的 ffmpeg 收尾。
   *
   * quality：'native' 原生渲（快，约 1.2 Mbps）；'high' 2 倍画再降采样（慢约 4 倍，画质更实、码率可控）。
   */
  async function finish({ projectDir, edl, clips, entries, bgm, width, height, lufs, gainDb, fps = 30, workers = 0, finalFile, captions, quality = 'native', bitrate = 0 }) {
    // film.html 就写在项目根：媒体用 segments/x.mp4 这种相对路径，不越过项目边界（OpenFilm 的服务只认项目内的文件）。
    const filmDir = projectDir;
    const film = await writeFilm({ projectDir, clips, entries, bgm, width, height, lufs, gainDb, captions: captions ?? (existsSync(join(projectDir, 'captions.vtt')) ? join(projectDir, 'captions.vtt') : null), filmDir });
    log(`[openfilm] film.html：${film.timeline.length} 段 · ${film.duration}s · ${width}x${height}`);

    const supersample = String(quality).toLowerCase() === 'high' ? 2 : 1;
    if (supersample === 1) {
      const rendered = await render({ filmDir, finalFile, fps, lufs, workers });
      log(`[openfilm] ${rendered.elapsed}s 渲完 → ${finalFile}`);
      return { ...rendered, ...film, filmDir, quality: 'native' };
    }

    // 超采样：先渲到项目内临时文件（OpenFilm 只服务项目内路径），再降采样到最终文件。
    const hiDir = join(projectDir, '.film');
    await mkdir(hiDir, { recursive: true });
    const hiFile = join(hiDir, 'render-hi.mp4');
    const rendered = await render({ filmDir, finalFile: hiFile, fps, lufs, workers, scale: supersample });
    log(`[openfilm] ${rendered.elapsed}s 渲完 ${width * supersample}x${height * supersample} → 降采样到 ${width}x${height}`);
    await downscale({ input: hiFile, output: finalFile, width, height, bitrate });
    const bytes = existsSync(finalFile) ? (await stat(finalFile)).size : 0;
    log(`[openfilm] 成片 ${(bytes / 1024 / 1024).toFixed(2)} MB${Number(bitrate) > 0 ? ` @ ${bitrate} Mbps` : '（CRF 18）'}`);
    return { ...rendered, finalFile, ...film, filmDir, quality: 'high', supersample, bytes };
  }

  return { available, writeFilm, render, look, downscale, finish };
}

/** 从 EDL + 片段任务里取出真正要剪的顺序（和 executeEdl 用的是同一份判定）。 */
export function planFromEdl(edl, completedTasks) {
  const bySegment = new Map(completedTasks.map((task) => [String(task.segmentId), task]));
  return (edl?.order ?? [])
    .map((entry) => ({ ...entry, task: bySegment.get(String(entry.segmentId)) }))
    .filter((entry) => entry.task?.file);
}

export { planFromEdl as plan };
