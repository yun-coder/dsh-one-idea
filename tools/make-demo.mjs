/**
 * 生成示例项目模板（demo/project.template.json）。
 * 只在维护 demo 时跑：node tools/make-demo.mjs
 * 模板里的媒体路径用 __SEG_1__ / __SEG_2__ / __FINAL__ / __COVER__ 占位，
 * 由 createDemo 接口复制到用户项目目录后替换成绝对路径。
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const now = Date.now();

const prompt1 = '冰箱门打开，冷白光照亮内部，一只白色棉拖鞋躺在鸡蛋盒和牛奶盒旁边，镜头缓慢推近到拖鞋，写实质感，无文字';
const prompt2 = '一只手从冰箱冷藏层拿起一只白色棉拖鞋，转身关上冰箱门离开厨房，暖色顶灯，写实纪录片质感，镜头跟随手部，无文字';

const idea = {
  ideas: [
    { id: 'A', title: '冰箱里的拖鞋', oneLiner: '我妈的勤快，把全家的东西都收进了冰箱', hook: '冰箱门一开，鸡蛋盒旁边躺着一只拖鞋', structure: ['钩子', '反转', '落点'], emotion: '荒诞', whyNow: '冰箱收纳', hotspotLinks: ['冰箱收纳'], score: { hook: 9, fit: 8, feasible: 9 }, risk: '梗偏轻，靠表演撑' },
    { id: 'B', title: '全家找了半小时', oneLiner: '三双光脚踩过同一块地砖，拖鞋在冷藏层', hook: '三双光脚同时停在一块地砖上', structure: ['钩子', '反转', '落点'], emotion: '共鸣', whyNow: '冰箱收纳', hotspotLinks: ['冰箱收纳'], score: { hook: 8, fit: 8, feasible: 8 }, risk: '需要三个人调度' },
    { id: 'C', title: '冷冻室的味道', oneLiner: '拖鞋进了冷冻室，拿出来是硬的', hook: '一只冻得笔直的拖鞋立在台面上', structure: ['钩子', '反转', '落点'], emotion: '好笑', whyNow: '冰箱收纳', hotspotLinks: ['冰箱收纳'], score: { hook: 8, fit: 7, feasible: 9 }, risk: '和 A 撞梗' },
  ],
  recommended: { id: 'A', reason: '钩子最直接：开门即见，反转靠收纳习惯，实拍和生成都好做' },
};

const story = {
  title: '冰箱里的拖鞋',
  logline: '女儿找遍全家找不到拖鞋，最后在冰箱里发现被妈妈"收纳"好的那只',
  theme: '中国式勤快的荒诞感',
  premise: '我妈的勤快，是把东西收到你永远想不到的地方',
  punchline: '下次放冷冻',
  characters: [
    { name: '女儿', role: '刚回家的年轻人', age: '26', want: '找到拖鞋', obstacle: '东西被收得找不到' },
    { name: '妈', role: '持家型母亲', age: '55', want: '把家收拾干净', obstacle: '女儿不理解她的收纳' },
  ],
  acts: [
    { name: '钩子', goal: '把结果先亮出来', beats: [{ t: 0, action: '冰箱门打开，冷光里一只拖鞋躺在鸡蛋盒旁', emotion: '荒诞', durationSec: 3 }] },
    { name: '转折', goal: '揭穿是谁干的', beats: [{ t: 3, action: '一只手把拖鞋从冷藏层拿出来', emotion: '好笑', durationSec: 4 }, { t: 7, action: '女儿举着拖鞋站在厨房门口', emotion: '无语', durationSec: 3 }] },
    { name: '落点', goal: '收在妈妈的逻辑里', beats: [{ t: 10, action: '妈面无表情地把抹布叠好放进冰箱门格', emotion: '好笑', durationSec: 3 }] },
  ],
  ending: '拖鞋被放回冰箱门格，门关上',
  dialogueDensity: 'low',
};

const storyboard = {
  title: '冰箱里的拖鞋',
  targetSeconds: 10,
  params: { maxSegmentSeconds: 15, aspectRatio: '9:16' },
  beats: [
    { id: 'B01', kind: 'action', text: '冰箱门打开，拖鞋躺在鸡蛋盒旁', durationSec: 3 },
    { id: 'B02', kind: 'action', text: '一只手把拖鞋拿出来', durationSec: 4 },
    { id: 'B03', kind: 'action', text: '拖鞋被放回冰箱门格，门关上', durationSec: 3 },
  ],
  shots: [
    {
      id: 'E01-01-01', segment: 'E01-01', durationSec: 5,
      action: '冰箱门打开，冷光照出鸡蛋盒旁的一只白棉拖',
      prompt: prompt1,
      claims: ['B01'], inFrame: [], others: '鸡蛋盒、牛奶盒',
    },
    {
      id: 'E01-02-01', segment: 'E01-02', durationSec: 5,
      action: '一只手把拖鞋从冷藏层拿出来，转身关上冰箱门',
      prompt: prompt2,
      claims: ['B02'], inFrame: [], others: '冰箱门',
    },
  ],
};

const characters = {
  style: '冷调厨房 + 暖色顶灯，浅景深，写实纪录片质感',
  characters: [
    {
      name: '女儿', role: '刚回家的年轻人', voiceHint: '清亮、语速偏快',
      dims: {
        face: '鹅蛋脸，皮肤偏白，眼下有熬夜的淡青',
        features: '内双，鼻梁不高，笑起来有一点虎牙',
        hair: '黑色中长直发，随手扎成低马尾，碎发在耳侧',
        costume: '浅灰卫衣，袖口松垮，脚上只穿一只袜子',
        posture: '站着时重心偏一条腿，找到东西时肩膀先松下来',
        motif: '举着拖鞋看镜头，表情从无语到想笑',
      },
      prompt: '鹅蛋脸，黑色中长直发低马尾，浅灰卫衣，只穿一只袜子，举着一只白色棉拖鞋，冷调厨房暖色顶灯',
      negative: '不要浓妆，不要摆拍感',
    },
    {
      name: '妈', role: '持家型母亲', voiceHint: '低、平、不容置疑',
      dims: {
        face: '圆脸，法令纹明显，皮肤有常年做饭的光泽',
        features: '单眼皮，眉毛淡，嘴角天生向下',
        hair: '齐肩短发，发尾外翻，鬓角有几根白',
        costume: '深蓝棉布围裙，袖口卷到小臂，手上戴着洗到发白的橡胶手套',
        posture: '背略驼，擦台面时肩膀带动整个上身',
        motif: '一边擦台面一边把东西归位，头都不抬',
      },
      prompt: '圆脸，法令纹明显，齐肩短发发尾外翻，深蓝棉布围裙，橡胶手套，擦台面，冷调厨房暖色顶灯',
      negative: '不要夸张表情，不要老人妆',
    },
  ],
};

const voice = {
  narration: { enabled: false, voiceId: '', rate: 1, emotion: '' },
  characters: [],
  lines: [],
  bgm: { enabled: true, mood: '轻快的荒诞感', recommended: '拨弦 + 冰箱低频嗡鸣', bpm: 96, note: '' },
  mix: { dialogueDb: 0, musicDb: -18 },
};

const edl = {
  order: [
    { segmentId: 'E01-01', trimStart: 0, trimEnd: null, transition: 'cut', transitionSec: 0.25, reason: '开门即见，先把荒诞的结果甩出来' },
    { segmentId: 'E01-02', trimStart: 0, trimEnd: null, transition: 'fade', transitionSec: 0.25, reason: '动作收在关门上，落点干净' },
  ],
  audio: { bgm: '拨弦 + 冰箱低频嗡鸣', gainDb: -18, duck: true, lufs: -14 },
  subtitles: { enabled: false, note: '示例没有台词，靠画面动作讲完' },
  packaging: {
    title: '我妈把拖鞋收进了冰箱',
    hook: '冰箱里那只是谁的',
    description: '找拖鞋找了半小时，最后在冰箱冷藏层找到。我妈的勤快，永远能给你惊喜。',
    hashtags: ['#家庭日常', '#冰箱收纳', '#我妈的勤快'],
  },
  notes: ['示例成片：两段 5 秒，直接来自本插件出片引擎'],
  rationale: '把最荒诞的结果放在第一秒，第二段补上"是谁拿的"，结尾不解释，让观众自己笑',
};

const doneStage = (artifact, file, score, summary) => ({
  status: 'done',
  attempts: 1,
  artifact,
  gate: { ok: true, failures: [], at: now },
  review: { score, pass: true, summary, accepted: 'clean', at: now },
  error: null,
  note: null,
  issues: [],
  file,
  updatedAt: now,
});

const stages = {
  idea: doneStage(idea, '01-idea.json', 88, '示例：三个方向都挂到同一个热点，A 的钩子最直接'),
  story: doneStage(story, '02-story.json', 90, '示例：前提与落点都在，两角色动机清楚'),
  storyboard: doneStage(storyboard, '03-storyboard.json', 86, '示例：两镜两段，动作都是单瞬间'),
  characters: doneStage(characters, '04-characters.json', 87, '示例：六维具体，可生成定妆图'),
  voice: doneStage(voice, '05-voice.json', 86, '示例：无对白，只用 BGM 和动作音效'),
  render: {
    ...doneStage(null, null, 90, '示例：两段 5 秒，已落盘'),
    artifact: {
      tasks: [
        { segmentId: 'E01-01', status: 'completed', file: '__SEG_1__', rawFile: '__SEG_1__', duration: 5.17, provider: 'easyframe', providerLabel: 'EasyFrame', taskId: 'demo-01', prompt: prompt1, createdAt: now },
        { segmentId: 'E01-02', status: 'completed', file: '__SEG_2__', rawFile: '__SEG_2__', duration: 5.17, provider: 'easyframe', providerLabel: 'EasyFrame', taskId: 'demo-02', prompt: prompt2, createdAt: now },
      ],
    },
  },
  edit: {
    ...doneStage(edl, '06-edl.json', 88, '示例：两段顺剪，时长 10.4 秒'),
    finalFile: '__FINAL__',
    coverFile: '__COVER__',
    duration: 10.37,
  },
};

const template = {
  version: 1,
  title: '示例 · 冰箱里的拖鞋（10 秒）',
  platform: 'douyin',
  targetSeconds: 10,
  aspect: '9:16',
  resolution: '480p',
  chosenIdea: { id: 'A', title: '冰箱里的拖鞋' },
  brief: {
    productName: '白色棉拖鞋',
    category: '家居日用',
    audience: '25–35 岁、和父母同住的年轻人',
    sellingPoints: ['软底静音', '可机洗', '收纳不占地'],
    tone: '荒诞日常，不叫卖',
    priceBand: '39–59 元',
    forbidden: ['最好', '第一'],
    hotspots: [{ title: '冰箱收纳', source: '示例热点', snippet: '把不该进冰箱的东西收进去', at: new Date(now).toISOString() }],
    extra: '',
    audioMode: 'no-dialogue',
    projectMode: 'promotion',
  },
  stages,
  events: [{ at: now, kind: 'demo', text: '示例项目：已经跑完全流程，可以直接看成片' }],
  finalFile: '__FINAL__',
  coverFile: '__COVER__',
  demo: { madeAt: now, note: '由 tools/make-demo.mjs 生成；媒体在 demo/segments 与 demo/07-final.mp4' },
};

await mkdir(join(root, 'demo'), { recursive: true });
await writeFile(join(root, 'demo', 'project.template.json'), `${JSON.stringify(template, null, 2)}\n`, 'utf8');
console.log('demo/project.template.json 已生成');
