/**
 * 平台策略表：把「投放平台」从表单标签变成约束源。
 *
 * 为什么需要这一层：之前 platform 只是一个字符串，拼进提示词就没了。`targetSeconds`
 * 和 `aspect` 是项目自由字段，门禁只校验「成片时长 ≈ targetSeconds」，从不校验
 * 「这个时长和画幅在这个平台上成立吗」——所以「抖音 / 240 秒 / 16:9」这种组合能一路
 * 走到成片，没人拦。
 *
 * 两档判定，故意分开，不要合并：
 *   hard    → 平台真的发不出去，拦下来（超过硬上限、竖版平台的横版画幅）。
 *   advisory→ 平台能发，但不在常见区间，只提示、不否决。时长偏好随平台变，
 *             偏好不是错误，不该一票否决（20 秒的抖音竖版短片完全合法）。
 *
 * 硬上限的取值参考各平台 2026-09 的公开上限；它是「能不能上传」的边界，
 * 不是「好不好」的边界。好不好的部分留给 idealSec 和审核 Agent 去说。
 */

export const PLATFORMS = {
  douyin: {
    id: 'douyin',
    label: '抖音',
    aspect: '9:16',
    portraitFirst: true,
    landscapePreferred: false,
    maxSec: 900,
    idealSec: [15, 90],
    // 硬性可接受区间 / 建议区间（LUFS）。短视频平台统一按 -14 附近归一。
    audio: { hard: [-20, -8], ideal: [-15, -12] },
    coverAspect: '9:16',
    subtitle: 'accent',
  },
  xiaohongshu: {
    id: 'xiaohongshu',
    label: '小红书',
    aspect: '9:16',
    portraitFirst: true,
    landscapePreferred: false,
    maxSec: 900,
    idealSec: [20, 90],
    audio: { hard: [-20, -8], ideal: [-15, -12] },
    coverAspect: '3:4',
    subtitle: 'box',
  },
  shipinhao: {
    id: 'shipinhao',
    label: '视频号',
    aspect: '9:16',
    portraitFirst: false,
    landscapePreferred: false,
    maxSec: 1800,
    idealSec: [15, 120],
    audio: { hard: [-20, -8], ideal: [-15, -12] },
    coverAspect: '9:16',
    subtitle: 'accent',
  },
  bilibili: {
    id: 'bilibili',
    label: 'B站',
    aspect: '16:9',
    portraitFirst: false,
    landscapePreferred: true,
    maxSec: null,
    idealSec: [60, 600],
    audio: { hard: [-22, -10], ideal: [-18, -14] },
    coverAspect: '16:9',
    subtitle: 'clean',
  },
};

const DEFAULT_PLATFORM_ID = 'douyin';

/** 未知平台返回 null：不拦、也不假装知道它的规则。 */
export function platformOf(project) {
  const raw = project?.platform;
  const key = String(raw === null || raw === undefined || raw === '' ? DEFAULT_PLATFORM_ID : raw)
    .trim()
    .toLowerCase();
  return PLATFORMS[key] ?? null;
}

/** 只认 `宽:高` 形式的画幅；其它写法当作没填，交给各平台默认值。 */
export function aspectOf(project) {
  const raw = String(project?.aspect ?? '').trim();
  return /^\d+:\d+$/.test(raw) ? raw : null;
}

function isPortrait(aspect) {
  const [width, height] = aspect.split(':').map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  return height > width;
}

/**
 * 判定一个项目（可带实际时长）在当前平台上的适配情况。
 * @param {object} project 项目（读 platform / aspect / targetSeconds）
 * @param {{seconds?: number|null, aspect?: string|null}} [actual] 实际成片时长与画幅（剪辑阶段传）
 * @returns {{platform: object|null, failures: string[], advisories: string[]}}
 */
export function checkPlatform(project, actual = {}) {
  const platform = platformOf(project);
  const failures = [];
  const advisories = [];
  if (!platform) return { platform: null, failures, advisories };

  const aspect = aspectOf(project) ?? (actual.aspect ? String(actual.aspect) : null);
  if (aspect) {
    if (platform.portraitFirst && !isPortrait(aspect)) {
      failures.push(`画幅 ${aspect} 是横版，${platform.label}是竖版形态（${platform.aspect}）：横版在信息流里会被压成一条，等于放弃流量`);
    } else if (platform.landscapePreferred && isPortrait(aspect)) {
      advisories.push(`画幅 ${aspect} 是竖版，${platform.label}横版更常见（${platform.aspect}）：竖版也能发，但推荐位与封面裁切要另外考虑`);
    }
  }

  const seconds = Number(actual.seconds);
  if (Number.isFinite(seconds) && seconds > 0) {
    if (platform.maxSec && seconds > platform.maxSec) {
      failures.push(`成片 ${Math.round(seconds)} 秒超过${platform.label}硬上限 ${platform.maxSec} 秒，发不出去`);
    }
    const [low, high] = platform.idealSec;
    if (seconds < low) {
      advisories.push(`${Math.round(seconds)} 秒短于${platform.label}常见区间 ${low}–${high} 秒：能发，但完播和推荐通常吃亏`);
    } else if (seconds > high) {
      advisories.push(`${Math.round(seconds)} 秒长于${platform.label}常见区间 ${low}–${high} 秒：能发，前 3 秒要额外做留人`);
    }
  }

  return { platform, failures, advisories };
}

/** 响度目标：剪辑阶段按平台取区间，不再硬编码「短视频 -16 到 -12」。 */
export function audioTargetOf(project) {
  return platformOf(project)?.audio ?? { hard: [-20, -8], ideal: [-16, -12] };
}

/** 给提示词用的一句话：平台、目标时长、画幅、该平台的常见时长与硬上限。 */
export function platformBrief(project) {
  const target = Number(project?.targetSeconds) || 0;
  const aspect = aspectOf(project);
  const platform = platformOf(project);
  if (!platform) {
    return `平台 ${project?.platform ?? '未填'} / 目标 ${target || '未填'} 秒 / 画幅 ${aspect ?? '未填'}（这个平台没有策略表，时长与画幅按项目自己的目标走）`;
  }
  const [low, high] = platform.idealSec;
  const cap = platform.maxSec ? `，硬上限 ${platform.maxSec} 秒` : '，没有时长硬上限';
  return `${platform.label}（${platform.id}）/ 目标 ${target || '未填'} 秒 / 画幅 ${aspect ?? platform.aspect} / 这个平台常见 ${low}–${high} 秒${cap}`;
}
