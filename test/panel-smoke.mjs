/**
 * 面板渲染冒烟测试（不需要浏览器）：把 React 换成「直接执行函数组件」的假实现，
 * 用一份完整项目数据把整棵工作台树渲染一遍，抓运行期的 ReferenceError / TypeError。
 *
 *   node test/panel-smoke.mjs
 *
 * 它验证的是「代码能跑通、不会白屏」，不是视觉效果。
 */
import { fileURLToPath } from 'node:url';

let registration = null;
const queue = [];

const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    if (typeof type === 'function') return type(props ?? {});
    return { type, props: props ?? {}, children };
  },
  useState(initial) {
    const value = queue.length > 0 ? queue.shift() : typeof initial === 'function' ? initial() : initial;
    return [value, () => {}];
  },
  useEffect() {},
  useRef(initial) {
    return { current: initial };
  },
  useCallback(fn) {
    return fn;
  },
};

globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      globalThis.__loaded = factory((name) => {
        if (name === 'react') return React;
        throw new Error(`未知模块 ${name}`);
      });
    },
  },
  localStorage: { getItem: () => '', setItem: () => {} },
  Notification: undefined,
  AudioContext: undefined,
};

const project = {
  id: 'cs_demo_00001',
  title: '清汤面·深夜面馆 45 秒',
  platform: 'douyin',
  targetSeconds: 45,
  aspect: '9:16',
  brief: {
    productName: '清汤面',
    category: '地方小吃到店体验',
    audience: '加班到深夜的上班族',
    sellingPoints: ['一碗面 12 块', '凌晨十二点还开门'],
    tone: '克制的温情',
    forbidden: ['最好'],
    hotspots: [{ title: '年轻人开始报复性熬夜', source: '手动' }],
  },
  chosenIdea: 0,
  stages: {
    idea: { status: 'done', attempts: 2, review: { score: 82, pass: true, dimensions: {} }, gate: { ok: true, failures: [] }, issues: [], error: null },
    story: { status: 'done', attempts: 1, review: { score: 84, pass: true }, gate: { ok: true, failures: [] }, issues: [], error: null },
    storyboard: { status: 'needs_review', attempts: 3, review: { score: 72, pass: false }, gate: { ok: false, failures: ['G04 时长预算：镜 E01-01-02 1s 低于单镜下限 2s'] }, issues: ['[major] E01-02：动作链过长'], error: null },
    characters: { status: 'done', attempts: 1, review: { score: 86, pass: true }, gate: { ok: true, failures: [] }, issues: [], error: null },
    voice: { status: 'empty', attempts: 0, gate: null, review: null, issues: [] },
    render: { status: 'done', attempts: 1, gate: { ok: true, failures: [] }, review: null, issues: [] },
    edit: { status: 'running', attempts: 1, gate: null, review: null, issues: [] },
  },
  pendingReview: {
    at: 1795054786620,
    stage: 'storyboard',
    stageLabel: '分镜脚本',
    reason: '自动重做 3 次仍未过',
    issues: [{ severity: 'blocker', where: 'E01-01-01', problem: '单镜塞了两个动作', fix: '拆成两镜' }],
    gateFailures: ['G04 时长预算'],
  },
  running: { stage: 'edit' },
  reference: { status: 'done', stage: '完成', summary: { title: '参考片', uploader: '某账号', duration: 38, shotCount: 12 }, report: '# 拉片报告\n## 1. 3 秒钩子', shotCount: 12, duration: 38 },
  finalFile: 'D:/demo/07-final.mp4',
  coverFile: 'D:/demo/cover.jpg',
  events: [{ at: Date.now(), kind: 'run', text: '跑 成片剪辑' }],
};

const data = {
  project,
  artifacts: {
    idea: {
      ideas: [
        { id: 'A', title: '老板的账本', oneLiner: '一本账本', hook: '他把账本合上', structure: ['钩子', '转折'], emotion: '温情', whyNow: '热点', hotspotLinks: ['年轻人开始报复性熬夜'], score: { hook: 8, fit: 9, feasible: 7 }, risk: '煽情' },
      ],
      recommended: { id: 'A', reason: '最贴画像' },
    },
    story: { title: '故事', logline: '一句话', acts: [{ name: '钩子', goal: '停下', beats: [{ t: 0, action: '推门', emotion: '意外', durationSec: 3 }] }], characters: [{ name: '老周', role: '老板' }], ending: '收住' },
    storyboard: {
      title: '分镜',
      targetSeconds: 45,
      scenes: [{ id: 'S01', location: '面馆', light: '白炽灯' }],
      beats: [{ id: 'B01', kind: 'line', speaker: '老周', text: '还是不要葱？', durationSec: 2 }],
      shots: [{ id: 'E01-01-01', segment: 'E01-01', scene: 'S01', kind: 'action', durationSec: 3, claims: ['B01'], inFrame: [{ who: '老周' }], action: '抬眼', prompt: '镜头：抬眼' }],
    },
    characters: {
      style: '冷调夜景',
      characters: [{ name: '老周', role: '老板', voiceHint: '低', dims: { face: '长脸', features: '细眼', hair: '寸头', costume: '深蓝围裙', posture: '背微驼', motif: '灯下侧脸' }, prompt: '长脸，细眼，寸头，深蓝围裙', portrait: { file: 'D:/demo/portraits/laozhou.png' } }],
    },
    voice: { characters: [{ name: '老周', voiceId: 'v_m_steady', rate: 0.9 }], lines: [{ beatId: 'B01', speaker: '老周', text: '还是不要葱？', voiceId: 'v_m_steady', emotion: '平静' }], bgm: { mood: '安静', recommended: '钢琴', bpm: 88 }, narration: { enabled: false } },
    edit: { order: [{ segmentId: 'E01-01', trimStart: 0, trimEnd: null, transition: 'fade', reason: '钩子前置' }], audio: { bgm: '钢琴', gainDb: -18, lufs: -14 }, packaging: { title: '十二点的清汤面', hook: '12 块', description: '文案', hashtags: ['#深夜食堂', '#清汤面'] }, rationale: '理由', notes: ['提醒'] },
  },
  render: { tasks: [{ segmentId: 'E01-01', status: 'completed', duration: 5.2, file: 'D:/demo/segments/a.mp4', providerLabel: 'EasyFrame', progress: 100 }] },
  runtime: {
    llm: { provider: 'deepseek-account', model: 'deepseek-flash' },
    video: { provider: 'auto', model: 'minimax-h3-mini', resolution: '720p' },
    image: { backend: '88API / gpt-image-2', mode: 'auto' },
  },
  dir: 'D:/demo',
};

queue.push(
  {
    projectDir: 'D:/demo',
    reviewThreshold: 80,
    maxRework: 2,
    aspect: '9:16',
    resolution: '720p',
    videoProviders: ['easyframe'],
    hasImage: true,
    hasReference: true,
    stages: [
      { id: 'idea', label: '创意 idea', agent: 'producer' },
      { id: 'story', label: '故事剧情', agent: 'producer' },
      { id: 'storyboard', label: '分镜脚本', agent: 'producer' },
      { id: 'characters', label: '人物形象六维', agent: 'producer' },
      { id: 'voice', label: '配音方案', agent: 'producer' },
      { id: 'render', label: '分段出片', agent: 'producer' },
      { id: 'edit', label: '成片剪辑', agent: 'editor' },
    ],
    dimensions: [{ key: 'face', label: '骨相与脸型' }, { key: 'features', label: '五官与妆容' }],
    voices: [{ id: 'v_m_steady', name: '沉稳男声' }],
    aspects: ['9:16', '16:9'],
  },
  [{ id: project.id, title: project.title, doneStages: 4, totalStages: 7, pendingReview: { stageLabel: '分镜脚本' } }],
  project.id,
  data,
  false,
  '',
  '',
  false,
);

const clientUrl = new URL('../client.js', import.meta.url);
await import(`${clientUrl.href}?smoke=${Date.now()}`);

let locales = null;
const ctx = {
  locale: { bind: () => (key) => key, register: (_ns, dict) => { locales = dict; } },
  effect(fn) {
    fn();
    return () => {};
  },
  slots: {
    inject(_name, fn) {
      return fn();
    },
    register(definition, render) {
      if (definition?.name === 'main') registration = render;
      return {};
    },
  },
};

const loaded = globalThis.__loaded;
if (typeof loaded?.apply !== 'function') throw new Error('client bundle 没有返回 apply()');
loaded.apply(ctx);
if (!registration) throw new Error('没有注册 main 面板');

// 中英文案必须一一对应，英文里不能残留中文。
if (!locales?.zh || !locales?.en) throw new Error('没有注册 zh / en 文案');
const zhKeys = Object.keys(locales.zh);
const enKeys = Object.keys(locales.en);
const missing = zhKeys.filter((key) => !(key in locales.en));
const extra = enKeys.filter((key) => !(key in locales.zh));
if (missing.length) throw new Error(`英文缺 ${missing.length} 条：${missing.slice(0, 6).join(', ')}`);
if (extra.length) throw new Error(`英文多 ${extra.length} 条：${extra.slice(0, 6).join(', ')}`);
const cjk = /[\u4e00-\u9fa5]/;
const untranslated = enKeys.filter((key) => cjk.test(String(locales.en[key])));
if (untranslated.length) throw new Error(`英文文案里还有中文：${untranslated.slice(0, 6).join(', ')}`);
console.log(`✓ 中英文案齐全：${zhKeys.length} 条，英文无残留中文`);

const config = queue[0];
const projects = queue[1];
const selectedId = queue[2];
const pageData = queue[3];
/** 每个阶段的详情视图都真的渲染一遍：useState 用队列喂值，函数组件当场执行。 */
function render({ detail = '' } = {}) {
  queue.length = 0;
  queue.push(config, projects, 'production', selectedId, pageData, false, '', '', false); // Panel
  queue.push(detail, ''); // Pipeline
  return registration({ t: (key) => key, host: 'main' });
}

try {
  for (const detail of ['', 'idea', 'story', 'storyboard', 'characters', 'voice', 'render', 'edit']) {
    const tree = render({ detail });
    if (!tree || typeof tree !== 'object') throw new Error(`阶段 ${detail || '总览'} 没有返回元素树`);
    console.log(`✓ 阶段视图渲染通过：${detail || '总览（含待复核条 + 事件日志）'}`);
  }
} catch (error) {
  console.error(`✗ 面板渲染抛错：${error.message}`);
  console.error(error.stack?.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}

// 拉片台的证据面板：联系表 / 逐镜帧 / 报告 / 镜表 / 台词 / 复刻分镜。
const refEvidence = {
  id: 'cs_ref_demo',
  title: '拉片 · 某条爆款',
  status: 'done',
  stage: '完成',
  summary: { title: '某条爆款', uploader: '某账号', shotCount: 12, duration: 38 },
  contactSheet: true,
  frames: ['shot-01.jpg', 'shot-02.jpg'],
  shotTable: '#1 0-3s（3s）\n#2 3-7s（4s）',
  transcriptLines: '[0.0-3.0] 还是不要葱？',
  report: '# 拉片报告\n## 1. 3 秒钩子',
  replicate: { title: '复刻分镜', scenes: [], beats: [], shots: [] },
  replicateSummary: { shots: 4, segments: 2, locks: 4, gate: { ok: true, failures: [] } },
};
let refTree;
try {
  queue.length = 0;
  queue.push(config, projects, 'library', selectedId, pageData, false, '', '', false);
  queue.push([{ id: 'cs_ref_demo', title: '拉片 · 某条爆款', updatedAt: Date.now() }], 'cs_ref_demo', refEvidence, '', '', false, '', '', '', false);
  refTree = registration({ t: (key) => key, host: 'main' });
  if (!refTree || typeof refTree !== 'object') throw new Error('拉片台没有返回元素树');
  console.log('✓ 拉片台（联系表 + 逐镜帧 + 报告 + 复刻分镜）渲染通过');
} catch (error) {
  console.error(`✗ 拉片台渲染抛错：${error.message}`);
  console.error(error.stack?.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}

// 审片标记必须跳到成片时间，并用各段原始时间对齐对比。
const reviewPage = {
  ...pageData,
  project: {
    ...pageData.project, finalFile: 'final.mp4',
    stages: { ...pageData.project.stages, edit: { duration: 20, visual: { issues: [
      { where: '第 2 张', action: 'segment', problem: '道具穿模' },
    ] } } },
  },
  plan: [{ id: 'S1', seconds: 20, people: [], props: [], references: [] }],
  timeline: [{ segmentId: 'S1', start: 0, end: 20, sourceStart: 0.5 }],
  versions: { S1: [{ id: 'take1.mp4', current: true }, { id: 'take2.mp4', current: false }] },
};
queue.length = 0;
queue.push(config, projects, 'review', selectedId, reviewPage, false, '', '', false);
const reviewTree = registration({ t: (key) => key, host: 'main' });
function findAll(node, selector) {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, selector));
  if (!node || typeof node !== 'object') return [];
  return [...(selector(node) ? [node] : []), ...findAll(node.children ?? [], selector)];
}
const reviewVideos = findAll(reviewTree, (node) => node.type === 'video' && node.props.ref);
const marker = findAll(reviewTree, (node) => node.props?.['aria-label'] === 'inspectIssue 00:10.0')[0];
if (reviewVideos.length !== 3 || !marker) throw new Error('缺少成片、双版本预览或跳转标记');
for (const { props } of reviewVideos) props.ref.current = { duration: 30, currentTime: 0, pause() {} };
marker.props.onClick();
if (reviewVideos[0].props.ref.current.currentTime !== 10
  || reviewVideos.slice(1).some(({ props }) => props.ref.current.currentTime !== 10.5)) {
  throw new Error('审片跳转与素材对比时间不一致');
}
console.log('✓ 审片台通过：抽帧标记跳到成片，两个版本使用同一分段时间');

// 空状态：没有项目时必须落到新建表单。
queue.length = 0;
queue.push({ projectDir: '', reviewThreshold: 80, stages: [], dimensions: [], voices: [], aspects: ['9:16'] }, [], 'production', '', null, false, '', '', false);
const empty = registration({ t: (key) => key, host: 'main' });
if (!empty || typeof empty !== 'object') throw new Error('空状态没有返回元素树');
console.log('✓ 空状态（无项目 → 拉片台 + 新建表单）渲染通过');
console.log('\n全部通过：面板在真实数据与空状态下都能完整渲染，没有运行期异常。');
