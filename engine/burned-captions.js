/**
 * 烧字检测：参考素材的画面上是不是已经压了字幕/花字。
 *
 * 为什么要它：工作台的主线是「拉片 → 复刻」。抖音素材绝大多数把台词烧进了画面，
 * 复刻时再叠一层自己的字幕，成片就是双字幕——原片那行压在人物脸上，自己那行在底部，
 * 观众第一眼就出戏。这件事**在剪辑阶段补不回来**（可以裁、可以盖，但都会伤画面），
 * 只能提前知道、提前决定：要么不叠字幕，要么把字幕放到烧字区之外。
 *
 * 判定办法（不依赖 OCR，纯 ffmpeg + 像素统计）：
 *   1. 均匀抽 N 帧，缩到 320 宽转灰度；
 *   2. 画面分上 / 中 / 下三条带，各自统计「亮像素且紧邻暗像素」的占比——带描边/阴影的字形特征；
 *   3. 静态台标不会随时间变化，所以还要比较相邻两帧的掩码重合度：
 *      多数采样都有文字 + 掩码逐帧在变 → 判定为烧字。
 *
 * 注意：这里刻意扫三条带而不是只扫底部。只扫底部是偷懒做法（访谈、播客的字幕确实在底部），
 * 但复刻场景里中置烧字很常见，只扫底部会漏检——漏检的代价就是双字幕。
 */
import { spawn } from 'node:child_process';

/** 三条带的归一化纵向范围：避开最上边的安全区和最下边的黑边。 */
export const BANDS = [
  { name: 'top', start: 0.06, end: 0.28 },
  { name: 'middle', start: 0.42, end: 0.72 },
  { name: 'bottom', start: 0.74, end: 0.96 },
];

const SAMPLE_WIDTH = 320;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const BRIGHT = 200;
const DARK = 80;
/** 带内「亮像素 + 紧邻暗边」的最低占比：低于它当作没有字形。 */
export const MIN_TEXT_FRACTION = 0.0012;
/** 多数采样帧都要有文字，否则不是持续的字幕。 */
export const MIN_FRAMES_WITH_TEXT = 0.6;
/** 掩码重合度的中位数上限：静态台标会接近 1，字幕会明显偏低。 */
export const MAX_MEDIAN_OVERLAP = 0.5;

const runBinary = (bin, argv, timeout = 30_000) => new Promise((resolve, reject) => {
  const child = spawn(bin, argv, { windowsHide: true });
  const chunks = [];
  let size = 0;
  let stderr = '';
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error(`${bin} 超时（${timeout}ms）`));
  }, timeout);
  child.stdout.on('data', (chunk) => {
    size += chunk.length;
    if (size <= MAX_OUTPUT_BYTES) chunks.push(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk).slice(0, 4000);
  });
  child.on('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code !== 0) {
      reject(new Error(`${bin} 退出码 ${code}：${stderr.slice(-600)}`));
      return;
    }
    resolve(Buffer.concat(chunks));
  });
});

const median = (values) => {
  const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
};

/** 一条带里「亮像素且同一行紧邻暗像素」的占比（灰度缓冲，行优先）。 */
export function glyphFraction(gray, width, height, start, end) {
  const y0 = Math.max(0, Math.floor(height * start));
  const y1 = Math.min(height, Math.ceil(height * end));
  if (y1 <= y0 || width < 3) return 0;
  let hits = 0;
  for (let y = y0; y < y1; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (gray[row + x] < BRIGHT) continue;
      const left = x > 0 ? gray[row + x - 1] : 0;
      const right = x + 1 < width ? gray[row + x + 1] : 0;
      if (left < DARK || right < DARK) hits += 1;
    }
  }
  return hits / (width * (y1 - y0));
}

/** 带内亮像素掩码（用于比较相邻采样是否在变）。 */
export function glyphMask(gray, width, height, start, end) {
  const y0 = Math.max(0, Math.floor(height * start));
  const y1 = Math.min(height, Math.ceil(height * end));
  const mask = [];
  for (let y = y0; y < y1; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (gray[row + x] < BRIGHT) continue;
      const left = x > 0 ? gray[row + x - 1] : 0;
      const right = x + 1 < width ? gray[row + x + 1] : 0;
      if (left < DARK || right < DARK) mask.push(row + x);
    }
  }
  return mask;
}

/** 两个掩码的重合度：交集 / 并集。静态图形接近 1，逐帧变化的字幕明显低。 */
export function overlapScore(a, b) {
  if (a.length === 0 || b.length === 0) return 1;
  const small = a.length <= b.length ? a : b;
  const large = a === small ? b : a;
  const set = new Set(large);
  let hit = 0;
  for (const index of small) if (set.has(index)) hit += 1;
  const union = a.length + b.length - hit;
  return union === 0 ? 1 : hit / union;
}

/**
 * 由逐帧统计判定每条带是否有烧字。
 * @param {Array<{fraction: number, mask: number[]}>} samples 每个采样帧一条带的数据
 */
export function verdictOf(samples) {
  if (samples.length === 0) {
    return { detected: false, textFrames: 0, medianFraction: null, medianOverlap: null, confidence: 0 };
  }
  const textFrames = samples.filter((sample) => sample.fraction >= MIN_TEXT_FRACTION).length;
  const overlaps = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (previous.fraction < MIN_TEXT_FRACTION || current.fraction < MIN_TEXT_FRACTION) continue;
    overlaps.push(overlapScore(previous.mask, current.mask));
  }
  const textRatio = textFrames / samples.length;
  const medianOverlap = median(overlaps);
  const detected = textRatio >= MIN_FRAMES_WITH_TEXT && (medianOverlap ?? 0) <= MAX_MEDIAN_OVERLAP;
  const confidence = detected
    ? Math.max(0, Math.min(1, textRatio * (1 - (medianOverlap ?? 0))))
    : 0;
  return {
    detected,
    textFrames,
    medianFraction: median(samples.map((sample) => sample.fraction)),
    medianOverlap,
    confidence: Number(confidence.toFixed(2)),
  };
}

/** 均匀取样的时间点：避开片头片尾的标题卡与片尾板。 */
export function sampleTimes(seconds, count) {
  const duration = Number(seconds);
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const from = duration * 0.08;
  const to = duration * 0.92;
  const span = Math.max(0, to - from);
  return Array.from({ length: count }, (_, index) => Number((from + (span * index) / Math.max(1, count - 1)).toFixed(3)));
}

/**
 * 抽帧并判定。**失败不致命**：拿不到帧就返回 detected:null（未知），
 * 让调用方按「没有结论」处理，而不是把拉片流程一起炸掉。
 */
export async function detectBurnedCaptions({ video, seconds, ffmpegPath = 'ffmpeg', samples = 8, log = () => {} }) {
  const times = sampleTimes(seconds, samples);
  if (times.length === 0) return { detected: null, reason: '没有可用的视频时长', bands: [] };
  const frames = [];
  let width = SAMPLE_WIDTH;
  let height = 0;
  for (const time of times) {
    // scale 的 -2 保证高度是偶数；format=gray 直接给原始灰度，省掉图片解码依赖。
    const buffer = await runBinary(ffmpegPath, [
      '-v', 'error', '-ss', String(time), '-i', String(video), '-frames:v', '1',
      '-vf', `scale=${SAMPLE_WIDTH}:-2,format=gray`, '-f', 'rawvideo', '-',
    ]);
    if (buffer.length === 0) continue;
    const frameHeight = Math.floor(buffer.length / width);
    if (frameHeight <= 0) continue;
    height = height || frameHeight;
    if (frameHeight !== height) continue;
    frames.push(Uint8Array.from(buffer.subarray(0, width * height)));
  }
  if (frames.length === 0) return { detected: null, reason: 'ffmpeg 没有抽到帧', bands: [] };

  const bands = BANDS.map((band) => {
    const perSample = frames.map((frame) => ({
      fraction: glyphFraction(frame, width, height, band.start, band.end),
      mask: glyphMask(frame, width, height, band.start, band.end),
    }));
    const verdict = verdictOf(perSample);
    return { ...band, ...verdict };
  });
  const hit = bands.filter((band) => band.detected).sort((a, b) => b.confidence - a.confidence)[0] ?? null;
  const result = {
    detected: Boolean(hit),
    band: hit ? [hit.start, hit.end] : null,
    bandName: hit?.name ?? null,
    confidence: hit?.confidence ?? 0,
    // 检测到多条带时全部列出来：中置烧字 + 底部花字是常见组合。
    bands: bands.map((band) => ({
      name: band.name, start: band.start, end: band.end, detected: band.detected,
      textFrames: band.textFrames, confidence: band.confidence,
      medianOverlap: band.medianOverlap === null ? null : Number(band.medianOverlap.toFixed(2)),
    })),
    sampled: frames.length,
    width,
    height,
  };
  log(`[reference] 烧字检测：${result.detected ? `画面上已有文字（${result.bandName} 带 ${Math.round(result.band[0] * 100)}%–${Math.round(result.band[1] * 100)}% 高度）` : '未发现持续文字层'}`);
  return result;
}
