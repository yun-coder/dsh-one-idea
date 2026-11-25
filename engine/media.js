/**
 * 剪辑与媒体：ffmpeg 的确定性封装。
 *
 * 剪辑团队 Agent 只出「剪辑清单」（EDL），真正动手的是这里：
 *   统一规格 → 裁字幕带 → 拼接（cut / fade）→ 混 BGM → 响度归一 → 抽封面帧。
 *
 * 所有函数都是普通 Node，可以脱离 Harness 用合成素材单测。
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const FPS = 30;

/** 跑一次 ffmpeg/ffprobe，失败时把 stderr 尾部带出来。 */
export function run(bin, args, { timeout = 900_000 } = {}) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
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
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`跑不了 ${bin}：${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(`${bin} 退出码 ${code}：${stderr.trim().slice(-400)}`));
    });
  });
}

export function createMedia({ ffmpegPath = 'ffmpeg', log = () => {} }) {
  const ffmpeg = ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
  const ffprobe = (() => {
    const guess = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (match) => match.replace(/ffmpeg/i, 'ffprobe'));
    return guess !== ffmpeg && existsSync(guess) ? guess : 'ffprobe';
  })();

  /** 读一段视频的真实参数；ffprobe 不可用时退回解析 ffmpeg 的输出。 */
  async function probe(file) {
    try {
      const stdout = await runOnce(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
      const payload = JSON.parse(stdout || '{}');
      const video = (payload.streams ?? []).find((stream) => stream.codec_type === 'video');
      const audio = (payload.streams ?? []).find((stream) => stream.codec_type === 'audio');
      return {
        duration: Number(payload.format?.duration ?? video?.duration ?? 0) || 0,
        width: Number(video?.width ?? 0),
        height: Number(video?.height ?? 0),
        hasVideo: Boolean(video),
        hasAudio: Boolean(audio),
      };
    } catch {
      // 没有 ffprobe：从 ffmpeg -i 的 stderr 里抠 Duration 与分辨率。
      const stderr = await run(ffmpeg, ['-hide_banner', '-i', file]).catch((error) => String(error.message));
      const duration = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(stderr);
      const size = /,\s*(\d{2,5})x(\d{2,5})/.exec(stderr);
      return {
        duration: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0,
        width: size ? Number(size[1]) : 0,
        height: size ? Number(size[2]) : 0,
        hasVideo: Boolean(size),
        hasAudio: /Audio:/.test(stderr),
      };
    }
  }

  /** ffprobe 用 stdout；复用 run 会把 stdout 丢掉，这里补一个只取 stdout 的版本。 */
  function runOnce(bin, args) {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const child = spawn(bin, args, { windowsHide: true });
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', (error) => reject(error));
      child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr.slice(-300) || `退出码 ${code}`))));
    });
  }

  /** 下载后裁掉底部字幕带（H3 会把引号台词烧成字幕，且不吃「不要字幕」）。 */
  async function trimBand({ input, output, ratio = 0.18 }) {
    const keep = Math.max(0.5, Math.min(1, 1 - Number(ratio)));
    await run(ffmpeg, [
      '-y', '-v', 'error',
      '-i', input,
      '-vf', `crop=iw:trunc(ih*${keep.toFixed(3)}/2)*2:0:0`,
      '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast',
      '-c:a', 'copy',
      output,
    ]);
    return output;
  }

  /** 统一规格：等比缩放 + 黑边补足 + 30fps + aac 48k 立体声；fade 时首尾各淡 0.25 秒。 */
  async function normalize({ input, output, width = 1080, height = 1920, fade = false, trimStart = 0, trimEnd = null }) {
    const info = await probe(input);
    const duration = info.duration || 0;
    const start = Math.max(0, Number(trimStart) || 0);
    const end = Number.isFinite(Number(trimEnd)) ? Number(trimEnd) : duration;
    const effective = Math.max(0.5, Math.min(duration - start, end - start) || duration);
    const filters = [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      `fps=${FPS}`,
      'setsar=1',
      'format=yuv420p',
    ];
    if (fade && effective > 0.8) {
      const edge = 0.25;
      filters.push(`fade=t=in:st=0:d=${edge}`, `fade=t=out:st=${(effective - edge).toFixed(3)}:d=${edge}`);
    }
    const args = ['-y', '-v', 'error'];
    if (start > 0) args.push('-ss', start.toFixed(3));
    if (Number.isFinite(Number(trimEnd)) && end > 0) args.push('-t', (end - start).toFixed(3));
    args.push('-i', input);
    if (!info.hasAudio) {
      args.push('-f', 'lavfi', '-t', String(Math.max(effective, 1)), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    }
    args.push('-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
    if (info.hasAudio) {
      const audioFilters = ['aresample=48000', 'aformat=channel_layouts=stereo'];
      if (fade && effective > 0.8) {
        const edge = 0.25;
        audioFilters.push(`afade=t=in:st=0:d=${edge}`, `afade=t=out:st=${(effective - edge).toFixed(3)}:d=${edge}`);
      }
      args.push('-af', audioFilters.join(','), '-c:a', 'aac', '-b:a', '192k');
    } else {
      args.push('-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k', '-shortest');
    }
    args.push(output);
    await run(ffmpeg, args);
    return output;
  }

  /** 参数一致的文件用 concat demuxer 直接打通（不重编码）。 */
  async function concatCopy({ files, output }) {
    if (files.length === 0) throw new Error('没有可以拼接的片段');
    if (files.length === 1) {
      await run(ffmpeg, ['-y', '-v', 'error', '-i', files[0], '-c', 'copy', output]);
      return output;
    }
    const listPath = join(dirname(output), `concat-${Date.now()}.txt`);
    await writeFile(listPath, files.map((file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    try {
      await run(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', output]);
    } finally {
      // 清单文件是中间产物，删不掉也不影响成片。
      await rm(listPath, { force: true }).catch(() => {});
    }
    return output;
  }

  /**
   * 混音：BGM + 对白 + 原声，并把整体响度拉到目标值。
   *
   * lines 是配音时间轴（[{ file, at, volume }]）：按 at 用 adelay 铺开，
   * BGM 走 sidechaincompress——有人说话时自动让路，没有对白时就是原来那条混 BGM 的路。
   */
  async function mixAudio({ input, output, bgm = null, gainDb = -18, lufs = -14, lines = [] }) {
    const loudnorm = `loudnorm=I=${Number(lufs).toFixed(1)}:TP=-1.5:LRA=11`;
    const hasBgm = Boolean(bgm && existsSync(bgm));
    const talks = (Array.isArray(lines) ? lines : []).filter((line) => line?.file && existsSync(line.file));
    if (talks.length === 0) {
      if (!hasBgm) {
        await run(ffmpeg, ['-y', '-v', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-af', loudnorm, '-c:a', 'aac', '-b:a', '192k', output]);
        return output;
      }
      const filter = [
        `[1:a]volume=${Number(gainDb).toFixed(1)}dB,aresample=48000,aformat=channel_layouts=stereo[bg]`,
        `[0:a][bg]amix=inputs=2:duration=first:dropout_transition=0,${loudnorm},alimiter=limit=0.95[a]`,
      ].join(';');
      await run(ffmpeg, [
        '-y', '-v', 'error',
        '-i', input,
        '-stream_loop', '-1', '-i', bgm,
        '-filter_complex', filter,
        '-map', '0:v:0', '-map', '[a]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest',
        output,
      ]);
      return output;
    }

    const args = ['-y', '-v', 'error', '-i', input];
    for (const line of talks) args.push('-i', line.file);
    const bgmIndex = talks.length + 1;
    if (hasBgm) args.push('-stream_loop', '-1', '-i', bgm);

    // 片段是 H3 生成的，自带它念的台词；有 TTS 轨时把原声静音，否则同一句会有两个人同时念。
    // 保留一条静音轨只是为了用它的长度定成片时长（amix 的 duration=first）。
    const filters = [`[0:a]aresample=48000,aformat=channel_layouts=stereo${talks.length > 0 ? ',volume=0' : ''}[orig]`];
    talks.forEach((line, index) => {
      const delay = Math.max(0, Math.round((Number(line.at) || 0) * 1000));
      const volume = Number.isFinite(Number(line.volume)) ? Number(line.volume) : 1;
      // seconds 是铺到时间轴上允许的长度：被裁到片尾的句子要在这里截断，和 OpenFilm 的 #t=0,seconds 对齐。
      const limit = Number(line.seconds) > 0 ? `atrim=0:${Number(line.seconds).toFixed(3)},asetpts=PTS-STARTPTS,` : '';
      filters.push(`[${index + 1}:a]${limit}adelay=${delay}|${delay},aresample=48000,aformat=channel_layouts=stereo,volume=${volume}[d${index}]`);
    });
    filters.push(`${['[orig]', ...talks.map((_, index) => `[d${index}]`)].join('')}amix=inputs=${talks.length + 1}:normalize=0:duration=first[dlg]`);
    if (hasBgm) {
      filters.push(`[${bgmIndex}:a]volume=${Number(gainDb).toFixed(1)}dB,aresample=48000,aformat=channel_layouts=stereo[bg]`);
      // sidechain 的输入只能消费一次：分一路给压缩器当触发信号，另一路留在最终混音里。
      filters.push('[dlg]asplit=2[dlgsc][dlgmix]');
      filters.push('[bg][dlgsc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=350[bgduck]');
      filters.push(`[dlgmix][bgduck]amix=inputs=2:normalize=0:duration=first,${loudnorm},alimiter=limit=0.95[a]`);
    } else {
      filters.push(`[dlg]${loudnorm},alimiter=limit=0.95[a]`);
    }
    args.push('-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[a]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', output);
    await run(ffmpeg, args);
    return output;
  }

  /** 抽一帧当封面。 */
  async function frame({ input, output, at = 0.5 }) {
    await mkdir(dirname(output), { recursive: true });
    await run(ffmpeg, ['-y', '-v', 'error', '-ss', String(at), '-i', input, '-frames:v', '1', '-q:v', '2', output]);
    const info = await stat(output);
    return { file: output, bytes: info.size };
  }

  return { ffmpeg, ffprobe, probe, trimBand, normalize, concatCopy, mixAudio, frame, run };
}

/** 按剪辑清单算出每一段要不要淡入淡出（fade 在统一规格时一次做完）。 */
export function fadeFlagsOf(edl, count) {
  const flags = new Array(count).fill(false);
  const order = Array.isArray(edl?.order) ? edl.order : [];
  order.forEach((entry, index) => {
    if (index < count && String(entry?.transition ?? 'cut') === 'fade') flags[index] = true;
  });
  return flags;
}
