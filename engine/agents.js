/**
 * 三个 Agent：生产 / 剪辑团队 / 审核。
 *
 * 每个 Agent 是独立的一次模型调用：各自的角色提示、各自的上下文、各自的产出契约，
 * 互相看不到对方的推理过程，只通过「产物 + 门禁结果」交接。模型走宿主自己的
 * ctx.llm（跟随当前默认模型），由 index.js 注入 callModel，所以这里能脱离 Harness 单测。
 *
 * 打回重做时，上一轮的门禁失败项与审核意见会逐条塞回生产 Agent 的提示词里。
 */
import { SIX_DIMENSIONS, VOICE_CATALOG, dialogueOf, segmentsOf } from './contracts.js';

const MAX_SEGMENT_SECONDS = 15;
const MIN_SEGMENT_SECONDS = 5;

const text = (value) => String(value ?? '').trim();

/** 从模型输出里抠出第一个完整 JSON 对象（容忍 ```json 围栏与前后解释）。 */
export function extractJson(raw) {
  const body = text(raw);
  if (!body) throw new Error('模型返回了空内容');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(body);
  const source = fenced ? fenced[1] : body;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`模型没有返回 JSON：${body.slice(0, 160)}`);
  const slice = source.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (err) {
    // 常见毛病：尾逗号、中文引号。先在最小范围内修，再放弃。
    const cleaned = slice
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019]/g, "'");
    try {
      return JSON.parse(cleaned);
    } catch {
      throw new Error(`模型输出的 JSON 解析失败：${err.message}（前 160 字：${slice.slice(0, 160)}）`);
    }
  }
}

const briefBlock = (project) => {
  const brief = project?.brief ?? {};
  const lines = [
    `项目：${project?.title ?? ''}（${project?.platform ?? 'douyin'} / 目标 ${project?.targetSeconds ?? 45} 秒 / 画幅 ${project?.aspect ?? '9:16'}）`,
    `产品名：${brief.productName || '（未填）'}`,
    `品类：${brief.category || '（未填）'}`,
    `目标人群：${brief.audience || '（未填）'}`,
    `核心卖点：${(brief.sellingPoints ?? []).filter(Boolean).join('；') || '（未填）'}`,
    `调性：${brief.tone || '（未填）'}`,
    `价格带：${brief.priceBand || '（未填）'}`,
    `客户禁用词：${(brief.forbidden ?? []).filter(Boolean).join('、') || '（无）'}`,
    brief.extra ? `补充要求：${brief.extra}` : '',
  ].filter(Boolean);
  return lines.join('\n');
};

const hotspotBlock = (project) => {
  const list = (project?.brief?.hotspots ?? []).filter((hotspot) => hotspot?.title);
  if (list.length === 0) return '实时热点：（这一轮没有抓到热点，请在 whyNow 里只依据品类常识，不要编造热点）';
  return [
    '实时热点（只能引用这里的 title，逐字引用）：',
    ...list.map((hotspot, index) => `${index + 1}. ${hotspot.title}${hotspot.heat ? `（热度 ${hotspot.heat}）` : ''}${hotspot.source ? ` · ${hotspot.source}` : ''}`),
  ].join('\n');
};

const issuesBlock = (issues) => {
  const list = (issues ?? []).map((issue) => text(issue)).filter(Boolean);
  if (list.length === 0) return '';
  return [
    '上一轮被打回，原因如下（这一版必须逐条修掉，不要绕开）：',
    ...list.slice(0, 24).map((issue, index) => `${index + 1}. ${issue}`),
  ].join('\n');
};

const priorBlock = (context = {}) => {
  const chunks = [];
  if (context.idea) {
    const chosen = context.idea.ideas?.find((idea) => idea.id === context.idea.recommended?.id) ?? context.idea.ideas?.[0];
    chunks.push(`选定创意方向：${JSON.stringify(chosen, null, 2)}`);
  }
  if (context.story) chunks.push(`故事剧情：${JSON.stringify(context.story, null, 2)}`);
  if (context.storyboard) {
    chunks.push(`分镜（后续阶段必须与它的人物名、台词、段号对齐）：${JSON.stringify({
      title: context.storyboard.title,
      targetSeconds: context.storyboard.targetSeconds,
      scenes: context.storyboard.scenes,
      shots: (context.storyboard.shots ?? []).map((shot) => ({
        id: shot.id,
        segment: shot.segment,
        durationSec: shot.durationSec,
        inFrame: (shot.inFrame ?? []).map((person) => person.who),
        action: shot.action,
      })),
      beats: (context.storyboard.beats ?? []).map((beat) => ({ id: beat.id, kind: beat.kind, speaker: beat.speaker, text: beat.text, durationSec: beat.durationSec })),
    }, null, 2)}`);
  }
  if (context.characters) chunks.push(`人物六维：${JSON.stringify(context.characters, null, 2)}`);
  if (context.voice) chunks.push(`配音方案：${JSON.stringify(context.voice, null, 2)}`);
  if (context.reference?.report) {
    chunks.push(`参考爆款的拆解报告（可借结构，不许照抄台词/人物）：\n${String(context.reference.report).slice(0, 6000)}`);
  }
  return chunks.length ? `\n\n---- 已有产物 ----\n${chunks.join('\n\n')}` : '';
};

const PRODUCER_IDENTITY = [
  '你是「创意工作台」的生产 Agent（Producer）。',
  '职责：把一份产品画像和当下的热点，做成一条真能出片子的短视频内容资产——创意、故事、分镜、人物、配音方案。',
  '你不负责出片调度，也不做终审：那是剪辑团队和审核的事。',
  '',
  '硬规矩：',
  '1. 只输出一个 JSON 对象。不要 Markdown 围栏，不要解释，不要前后寒暄。',
  '2. 全中文（品牌名、英文术语除外）。',
  '3. 不编造事实：热点只能来自给定清单，卖点只能来自给定画像，人物只能来自给定分镜。',
  '4. 台词口语化，单句 ≤ 18 字；不要旁白腔，不要用台词解释情绪。',
  '5. 每一条都要能拍、能生成：具体到动作、光线、机位、道具、颜色。',
  '6. 禁用空话词：电影感、高级感、大片感、超写实、杰作、获奖、4k、8k、脸沉下来、嘴角勾起、五味杂陈、气氛凝固。',
].join('\n');

const STORYBOARD_RULES = [
  '## 分镜输出结构（shot-contract，必须逐字遵守字段名）',
  '{',
  '  "title": "片名",',
  '  "targetSeconds": 45,',
  '  "floorPlan": "一句话讲清空间关系：谁在哪、门在哪、镜头在哪一侧",',
  '  "params": { "maxSegmentSeconds": 15, "minCutSeconds": 2, "maxCutSeconds": 5, "charsPerSecond": 4.5, "tolerance": 0.15, "maxPeoplePerFrame": 3, "beatBudgetEpsilon": 0.5 },',
  '  "scenes": [{ "id": "S01", "location": "", "light": "" }],',
  '  "beats": [{ "id": "B01", "scene": "S01", "kind": "action", "text": "", "durationSec": 2 }],',
  '  "shots": [{',
  '    "id": "E01-01-01", "segment": "E01-01", "scene": "S01", "kind": "action", "durationSec": 4, "claims": ["B01"],',
  '    "camera": { "side": "", "size": "" },',
  '    "inFrame": [{ "who": "", "pos": "", "facing": "" }],',
  '    "eyeline": "", "action": "", "others": "", "light": "", "lastFrame": "", "prompt": ""',
  '  }]',
  '}',
  '台词节拍：{ "id": "B02", "scene": "S01", "kind": "line", "speaker": "人物名", "text": "台词原文", "durationSec": 2 }',
  '',
  '## 13 道确定性质量门（任何一道不过，这一版就会被判失败）',
  'G01 结构完整：scenes / beats / shots 三个数组都在；所有 id 唯一；节拍字段齐全（kind 只能是 action 或 line，line 必须带 speaker）；必须有 targetSeconds。',
  'G02 节拍认领覆盖：每一个节拍恰好被一个镜头认领，认领必须连续、顺序不回退；每个镜头至少认领一个 action 拍。',
  'G03 认领不跨场：一个镜头的节拍与它的 scene 同属一场。',
  'G04 时长预算：单镜 2–5 秒；一个 segment 合计 ≤ 15 秒；总时长与 targetSeconds 误差 ≤ 15%；镜头时长与认领节拍合计误差 ≤ 0.5 秒。',
  'G05 台词装得下：台词按 4.5 字/秒折算的时长 ≤ 镜头时长。',
  'G06 同框人数：inFrame 不能为空，人数 ≤ 3。',
  'G07 现场表完整：camera.side / camera.size / inFrame 的 who、pos、facing / eyeline / action / others / light / lastFrame 一格都不能空，也不能写「默认、随意、同上、——」。',
  'G08 反应镜反打：kind 为 reaction 的镜头，机位侧必须和上一镜不同。',
  'G09 锁行逐字：prompt 末尾必须逐字包含这一句：',
  '    光：{light}。{who}在{pos}，{facing}。机位在{side}，{size}。',
  '    有多个人物时，各人的「{who}在{pos}，{facing}」按 inFrame 顺序用「；」连接，再写「。机位在{side}，{size}。」',
  '     完整形态：光：{light}。{who1}在{pos1}，{facing1}；{who2}在{pos2}，{facing2}。机位在{side}，{size}。',
  'G10 台词逐字：prompt 里必须逐字出现该镜认领的每一条台词原文。',
  'G11 禁用词：prompt / action / light 里不能出现上面那批空话词。',
  'G12 终点在画面内：lastFrame 不能出现「走出画面、离开画面、走出画外、消失在、转身离去」。',
  'G13 单一动作：action 里不能出现「然后、接着、随后」，不能「一边…一边」。',
  '',
  '## 写提示词的顺序（每镜）',
  '切/机位 → 动作与表情 → 位置变化 → 这一镜的声音 → 台词（引号内逐字） → 锁行。锁行不要手写，按 G09 的格式拼。',
  '',
  '## 一镜的完整示例（照这个结构与密度写）',
  '{',
  '  "id": "E01-01-02", "segment": "E01-01", "scene": "S01", "kind": "reaction", "durationSec": 3.5, "claims": ["B03", "B04"],',
  '  "camera": { "side": "门外人行道、正对窗口", "size": "中景" },',
  '  "inFrame": [{ "who": "男人", "pos": "窗口外的雨里", "facing": "朝窗口" }],',
  '  "eyeline": "越过窗口看向柜台后的她",',
  '  "action": "他抬手敲了两下玻璃，雨水顺着手背淌下来。",',
  '  "others": "街上没有行人", "light": "窗口透出的白炽灯照在他半边脸上，身后是蓝色雨夜",',
  '  "lastFrame": "他放下手，站在窗口外，雨衣帽子还在滴水",',
  '  "prompt": "镜头2：反打，机位在门外人行道、正对窗口。雨水顺着雨衣帽子往下淌，他抬手敲了两下玻璃，玻璃上的水痕晃了一下。他看着窗口里的她，说：「一碗面，清汤。」\\n光：窗口透出的白炽灯照在他半边脸上，身后是蓝色雨夜。男人在窗口外的雨里，朝窗口。机位在门外人行道、正对窗口，中景。"',
  '}',
  '注意示例里 prompt 的最后一行就是锁行：它逐字来自 light / inFrame / camera，多一个人就多一段「谁在哪、朝向」并用「；」连接。',
].join('\n');

const STAGE_TASKS = {
  idea: (project) => [
    `目标：给出 3 个互不相似、并且锚定在当下热点上的创意方向，然后推荐一个。`,
    '',
    '输出 JSON：',
    '{',
    '  "ideas": [{',
    '    "id": "A", "title": "方向名（≤ 12 字）", "oneLiner": "一句话说清这条片子拍什么",',
    '    "hook": "前 3 秒画面上具体发生什么（≤ 40 字，写成能拍的动作）",',
    '    "structure": ["0-3s：…", "3-15s：…", "15s-结尾：…"],',
    '    "emotion": "主情绪（好奇/焦虑/爽/认同/羡慕/温情/愤怒 之一）",',
    '    "whyNow": "为什么现在做它（必须挂到热点清单里的某一条）",',
    '    "hotspotLinks": ["逐字来自热点清单的 title"],',
    '    "score": { "hook": 8, "fit": 9, "feasible": 7 },',
    '    "risk": "这条方向最容易被骂/被限流的点"',
    '  }],',
    '  "recommended": { "id": "A", "reason": "为什么推荐它（≥ 30 字，要比较三个方向）" }',
    '}',
    '',
    '规则：',
    `- 三个方向必须真的不同：换人设 / 换场景 / 换叙事结构，不要同一件事换皮。`,
    `- hook 必须是画面上能发生的事，不要写「引发共鸣」「制造好奇」这种结果描述。`,
    `- hotspotLinks 里每一条都要在热点清单里逐字出现；一个方向至少挂 1 条热点。`,
    '- 挂热点不是装饰，是硬要求：如果你觉得热点和产品不贴，就换一个能贴上的角度，不要留空——留空这一版会被门禁打回。',
    '- **例外（复刻模式）**：如果给了「参考爆款」的拆解报告，创意的依据换成参考片的结构——每条方向必须写 `borrowedFrom`（借了原片哪一段：钩子/结构/节奏/情绪弧）和 `swapped`（换掉了什么人物、场景、台词、产品），这两个字段每条都不能空；这种模式下 hotspotLinks 可以留空。',
    `- 三个方向的 score 三个维度都要给 0–10 的整数。`,
    `- 全片 ${project?.targetSeconds ?? 45} 秒，方向要撑得住这个时长，也要塞得进这个时长。`,
    '- 如果给了「参考爆款」的拆解报告：至少一个方向要借用它验证过的结构（几段式、钩子设计、信息点间隔），',
    '  但人物、场景、台词、产品必须换掉，并在 risk 里写清同质化风险。',
  ].join('\n'),

  story: (project) => [
    `目标：把选定的创意方向写成一条 ${project?.targetSeconds ?? 45} 秒能拍完的故事。`,
    '',
    '输出 JSON：',
    '{',
    '  "title": "片名",',
    '  "logline": "一句话：谁、想要什么、卡在哪（≥ 20 字）",',
    '  "theme": "这条片子到底在讲什么",',
    '  "premise": "一句把前因说清的话：为什么会有这个冲突（这句话会变成片头第一句台词或最后一个动作的伏笔）",',
    '  "punchline": "落点那句台词（必须真的出现在某一拍里，或出现在 ending 里）",',
    '  "characters": [{ "name": "人物名", "role": "身份", "age": "年龄段", "want": "他要什么", "obstacle": "什么挡着他" }],',
    '  "acts": [{',
    '    "name": "钩子", "goal": "这一幕要完成什么",',
    '    "beats": [{ "t": 0, "action": "画面上发生什么（能拍）", "emotion": "观众此刻应该感觉到什么", "durationSec": 3 }]',
    '  }],',
    '  "ending": "落点：最后一句话或最后一个画面",',
    '  "dialogueDensity": "low | medium | high"',
    '}',
    '',
    '规则：',
    `- 至少 3 幕：钩子 / 转折 / 落点；节拍合计要接近 ${project?.targetSeconds ?? 45} 秒（允许 ±45%），每拍都要给 durationSec。`,
    '- 每拍只做一件事。action 写画面，不写心理活动（不要「她心里一沉」）。',
    '- 人物名就是后面分镜 inFrame.who 的名字，用 2–4 个字，全片统一，不要出现别名、代称、「她」。',
    '- 不要旁白解释情绪；情绪靠动作和台词。',
    '- **可理解性（硬要求）**：不看标题、不看简介，只凭片子也要能看懂三件事——① 冲突从哪来（premise 要变成片头第一句台词或第一个明确的画面证据）；② 发生了什么（发现/反转）；③ 最后怎么收（punchline 必须真的说出来或演出来）。',
    '- 第一拍就要把前提立住：允许用一句画外台词交代（例如「我妈收拾完，我的拖鞋就不见了」），不要只靠画面猜。',
  ].join('\n'),

  storyboard: () => [
    '目标：把故事写成一份能直接下单生成的分镜，必须一次通过 13 道门。',
    '',
    STORYBOARD_RULES,
    '',
    '## 可拍性红线（审核 Agent 会逐条挑这些毛病）',
  '- 一镜一个动作。走位、转身、横穿房间都要单独成镜；3 秒里不要出现「走过去 + 放下 + 转身」这种连招。',
  '- 机位写「固定」就不能有横移/推拉/摇镜；要运镜就把运镜写进 camera.size（例如「缓慢横移中景」）并留够时间。',
  '- inFrame 要包含这一镜动作涉及的所有人和关键道具；动作里出现的碗、手机、雨伞，必须在 inFrame 或 others 里交代来处。',
  '- 特写一次只做一个微动作。不要写屏幕 UI 状态变化（红点消失、数字跳动），生成模型控制不了。',
  '- 动作点数量要和时长匹配：每个动作点约 1–1.5 秒，3 秒的镜头最多两个动作点。',
  '- 曝光逻辑要自洽：不要在同一镜里要求「全黑」和「看清半张脸」。',
  '',
  '## 分段的规则：',
    `- 一个 segment 就是一次生成任务，合计时长必须在 ${MIN_SEGMENT_SECONDS}–${MAX_SEGMENT_SECONDS} 秒之间（推荐 8–15 秒）。`,
    '- 段号按顺序编号：E01-01、E01-02、E02-01……换场换前缀。',
    '- 同一段内的镜头要能接成一条连续的片子：落点与入口对得上，光线方向不变。',
  ].join('\n'),

  characters: () => [
    '目标：给分镜里每一个出场人物写「六维形象档案」和一条能直接出定妆图的提示词。',
    '',
    '输出 JSON：',
    '{',
    '  "style": "全片统一视觉风格（一句话，含光线与色彩基调）",',
    '  "characters": [{',
    '    "name": "人物名（必须与分镜 inFrame.who 完全一致）",',
    '    "role": "身份",',
    '    "voiceHint": "声音给人的第一印象（给配音阶段用）",',
    '    "dims": {',
    '      "face": "骨相与脸型", "features": "五官与妆容", "hair": "发型与发色",',
    '      "costume": "服装与配饰", "posture": "体态与动作习惯", "motif": "气质与记忆点"',
    '    },',
    '    "prompt": "定妆提示词（120–260 字中文画面描述）",',
    '    "negative": "不要出现的东西"',
    '  }]',
    '}',
    '',
    '规则：',
    '- 六维每一维至少 12 个字，写具体：颜色、材质、形状、数量、长度。不要「气质出众」「五官精致」。',
    '- prompt 要把六维写进同一段描述里，并按这个模板收尾：半身像，正面，纯灰背景，柔和均匀的棚拍光，无文字，无水印，无边框。',
    '- 出场人物一个不多一个不少：只能覆盖分镜 inFrame 里出现过的人。',
    '- 同一个人在不同镜头里必须长得一样：把最有辨识度的 2–3 个特征（发型、痣、配饰、服装色）写成固定锚点。',
  ].join('\n'),

  voice: () => [
    '目标：给这条片子定配音方案：谁用什么音色、每句台词什么情绪、什么 BGM。',
    '',
    `可选音色（voiceId 只能取这些，不能自造）：`,
    ...VOICE_CATALOG.map((voice) => `- ${voice.id}：${voice.name}（${voice.gender}声，${voice.age}，${voice.tone}，适合${voice.use}）`),
    '',
    '输出 JSON：',
    '{',
    '  "narration": { "enabled": false, "voiceId": "", "rate": 1.0, "emotion": "" },',
    '  "characters": [{ "name": "人物名", "voiceId": "v_xxx", "rate": 1.0, "pitch": "偏低/中性/偏高", "style": "说话习惯" }],',
    '  "lines": [{ "beatId": "B02", "speaker": "人物名", "text": "逐字照抄分镜台词", "voiceId": "v_xxx", "emotion": "", "rate": 1.0 }],',
    '  "bgm": { "enabled": true, "mood": "情绪", "recommended": "风格描述（不写版权曲名）", "bpm": 95, "note": "" },',
    '  "mix": { "dialogueDb": 0, "musicDb": -18 }',
    '}',
    '',
    '规则：',
    '- lines 必须一一覆盖分镜里的每一句台词：beatId 对应、text 逐字照抄、不许合并也不许多出。',
    '- 每个说话人都要在 characters 里有音色；同一个人全片用同一个 voiceId。',
    '- 音色要跟人物六维的气质对得上；两个人物不要用同一个音色（除非剧情要求）。',
    '- BGM 只写情绪与编制（如「低保真钢琴 + 雨声」），不要写具体版权曲名。',
  ].join('\n'),
};

const EDITOR_IDENTITY = [
  '你是「创意工作台」的专业剪辑团队 Agent（Editorial Team）。一个团队三个座位，你要一起出方案：',
  '1) 节奏剪辑师：定段落顺序、切点、转场、总时长，把最强的钩子提到最前面。',
  '2) 声音设计师：BGM 与对白的平衡、响度目标、什么时候留白。',
  '3) 包装师：标题、话题标签、封面文案，按平台习惯写。',
  '',
  '你只做剪辑决策，不重写内容，不改台词，不改人物。',
  '只输出一个 JSON 对象，不要 Markdown 围栏，不要解释。',
].join('\n');

const REVIEWER_IDENTITY = [
  '你是「创意工作台」的审核 Agent（Reviewer）。',
  '你只做质检：不改稿、不创作、不吹捧。你的判断必须让制作方无法糊弄——每条问题都要指到具体位置并给出可执行的修法。',
  '只输出一个 JSON 对象，不要 Markdown 围栏，不要解释。',
].join('\n');

const ANALYST_IDENTITY = [
  '你是「创意工作台」的爆款拆解分析师。',
  '目标不是描述视频内容，而是回答三个问题：它靠什么在 3 秒内留住人、靠什么让人看完、靠什么让人转发，最后落成一份别人能照着复刻的方案。',
  '只依据给定证据（元数据、镜表、台词）。写不出证据的结论必须标「推测」，不要编造画面或台词。',
  '只输出纯 Markdown：不要组件标签，不要 HTML，不要 emoji 装饰。',
].join('\n');

const REFERENCE_TEMPLATE = [
  '按这个结构输出报告：',
  '# <标题> 拉片报告',
  '## 0. 基本信息（账号 / 时长 / 点赞·评论 / BGM）',
  '## 0.5 制作方式判定（逐镜）：| # | 时间 | 时长 | 实拍 / AI 生成 / 代码渲染 / 静态图推拉 / 待确认 | 证据 | 复刻路线 |',
  '## 1. 3 秒钩子（第一帧是什么，在制造什么，为什么划不走）',
  '## 2. 镜头表（按镜表逐镜：时间 / 时长 / 画面 / 台词 / 作用；作用只能填 钩子/铺垫/冲突/转折/证据/爽点/收尾/引导）',
  '## 3. 节奏曲线（平均镜长、最短镜长、切镜密度变化、信息点间隔、防划走补丁）',
  '## 4. 情绪弧（起点 → 加压 → 释放 → 结尾引导；预期违背在哪）',
  '## 5. 爆款因子归因（内容 / 形式 / 算法，每项给证据、1–5 分、可否复刻）',
  '## 6. 一句话结论（它火是因为 ___，最容易被忽略的是 ___，最难复刻的是 ___）',
  '## 7. 复刻方案（可复用的结构、必须替换的变量、风险点、开拍清单）',
].join('\n');

const DIRECTOR_IDENTITY = [
  '你是「创意工作台」的复刻导演。',
  '你要把一条已验证过的爆款视频，翻译成一份能直接下单生成的分镜（shot-contract 结构）。',
  '保留它为什么火的结构（钩子位置、信息点间隔、切镜密度），换掉人物、场景、台词与产品。',
  '只输出一个 JSON 对象，不要 Markdown 围栏，不要解释。',
].join('\n');

const STAGE_LABEL = {
  idea: '创意 idea',
  story: '故事剧情',
  storyboard: '分镜脚本',
  characters: '人物形象六维',
  voice: '配音方案',
  render: '分段出片',
  edit: '成片剪辑',
};

/** 每个阶段审什么：不写清楚，审核 Agent 会拿整片的标准去挑单阶段产的刺。 */
const REVIEW_FOCUS = {
  idea: '钩子是不是画面上真能发生的事、三个方向是不是真的不同、每条是否真的挂到了给定热点、可拍性与目标人群是否对得上。',
  story: '三幕是否闭合（钩子→转折→落点）、节拍是否都能拍出来、人物动机与冲突是否成立、节拍合计是否撑得住目标时长；**以及不看标题能不能看懂：冲突从哪来、发生了什么、最后怎么收的**——三件事缺一件就是 blocker。',
  storyboard: '可拍性：一镜是否只做一件事、走位是否单独成镜、机位是否与运镜自洽（写固定就不能横移）、道具是否有来处、动作点数量与时长是否匹配、同段内光线与人物位置是否连贯。',
  characters: '六维是否具体到能画出来（颜色/材质/形状/数量）、同一个人物的六个维度是否自洽、定妆提示词与六维是否一致、人物是否服务于这个故事。',
  voice: '音色是否贴合人物气质、有没有两个人物撞音色、BGM 情绪与编制是否匹配、每句台词的情绪标注是否合理、语速与台词长度是否匹配。',
  edit: '这条片子从钩子到落点是否成立、剪辑顺序与节奏是否比原顺序更好、声音是否平衡、发布包（标题/文案/话题）是否合规可发。',
};

export function createAgents({ callModel, config = {} }) {
  const maxTokens = Number(config.llmMaxTokens) || 8000;

  /** 一次「要 JSON」的调用：解析失败带错误重问；传输类故障退避重试一次。 */
  const askJson = async ({ system, user, temperature = 0.8, signal, label }) => {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const prompt = attempt === 0
        ? user
        : `${user}\n\n注意：上一次的输出不是合法 JSON（${lastError?.message ?? '解析失败'}）。这一次只输出一个 JSON 对象，不要任何其他文字。`;
      let raw;
      try {
        raw = await callModel({ system, user: prompt, temperature, maxTokens, signal });
      } catch (error) {
        // 上游传输抖动不是内容问题：退避一次再说，别让整条流水线因为一次断流停住。
        lastError = error;
        const retriable = /transport|timeout|timed out|ECONN|socket|fetch failed|network|429|502|503|504/i.test(String(error?.message ?? ''));
        if (retriable && attempt < 2) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500 * (attempt + 1)));
          continue;
        }
        throw error;
      }
      try {
        return extractJson(raw);
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(`${label ?? '模型'}没有给出可用 JSON：${lastError?.message ?? '未知原因'}`);
  };

  return {
    /** 生产 Agent：跑 idea / story / storyboard / characters / voice。 */
    async produce({ stage, project, context = {}, issues = [], directive = '', signal }) {
      const task = STAGE_TASKS[stage];
      if (!task) throw new Error(`生产 Agent 不负责阶段 ${stage}`);
      const user = [
        briefBlock(project),
        '',
        hotspotBlock(project),
        priorBlock(context),
        '',
        task(project),
        '',
        // 硬性要求放在规则后面、打回原因前面：它不是「上一版哪里错了」，是这一版必须照做的规格。
        directive ? `## 本轮硬性要求（覆盖上面的默认写法，逐条照做）\n${directive}` : '',
        '',
        issuesBlock(issues),
      ].filter((part) => part !== '').join('\n');
      const artifact = await askJson({
        system: PRODUCER_IDENTITY,
        user,
        temperature: stage === 'storyboard' || stage === 'voice' ? 0.4 : 0.85,
        signal,
        label: `生产 Agent（${STAGE_LABEL[stage] ?? stage}）`,
      });
      if (stage === 'storyboard') {
        // 模型偶尔把 targetSeconds 写成字符串：统一成数字，免得门禁误判。
        artifact.targetSeconds = Number(artifact.targetSeconds) || Number(project?.targetSeconds) || 45;
        if (!Array.isArray(artifact.params)) artifact.params = { ...(artifact.params ?? {}), maxSegmentSeconds: MAX_SEGMENT_SECONDS };
      }
      return artifact;
    },

    /** 剪辑团队 Agent：出一份可执行的 EDL + 发布包。被打回时把门禁/终审意见一起递进去。 */
    async edit({ project, storyboard, render, voice, characters, issues = [], signal }) {
      const actual = new Map((render?.tasks ?? []).map((task) => [String(task.segmentId), Number(task.duration) || null]));
      const segments = segmentsOf(storyboard).map((segment) => ({
        segmentId: segment.id,
        seconds: segment.seconds,
        duration: segment.duration,
        // 真实可用时长（落盘后 ffprobe 出来的）：算总长要用这个，不是分镜里的计划时长。
        actualSeconds: actual.get(segment.id) ?? null,
        people: segment.people,
        opening: segment.shots[0]?.action ?? '',
        promptHead: segment.prompt.slice(0, 120),
      }));
      const lines = dialogueOf(storyboard).map((line) => `${line.speaker}：${line.text}`);
      const user = [
        briefBlock(project),
        '',
        `故事：${storyboard?.title ?? ''}（${project?.targetSeconds ?? 45} 秒目标）`,
        `台词：${lines.length ? lines.join(' / ') : '（无对白）'}`,
        `BGM 建议：${voice?.bgm?.mood ?? '（无）'} / ${voice?.bgm?.recommended ?? '（无）'}`,
        `人物：${(characters?.characters ?? []).map((character) => `${character.name}（${character.voiceHint ?? ''}）`).join('、') || '（无）'}`,
        '',
        '可用素材（每段一条，顺序是生成顺序，不是成片顺序）：',
        JSON.stringify(segments, null, 2),
        '',
        '出片结果：',
        JSON.stringify((render?.tasks ?? []).map((task) => ({ segmentId: task.segmentId, duration: task.duration, status: task.status, file: task.file ? '已落盘' : null })), null, 2),
        '',
        '输出 JSON（剪辑清单 EDL）：',
        '{',
        '  "order": [{ "segmentId": "E01-01", "trimStart": 0, "trimEnd": null, "transition": "cut", "transitionSec": 0.25, "reason": "为什么放这里" }],',
        '  "audio": { "bgm": "BGM 情绪描述（不写版权曲名）", "gainDb": -18, "duck": true, "lufs": -14 },',
        '  "subtitles": { "enabled": false, "note": "" },',
        '  "packaging": { "title": "发布标题（≤ 20 字）", "hook": "封面文案（≤ 12 字）", "description": "发布文案（80–150 字）", "hashtags": ["#话题"] },',
        '  "notes": ["给制作方的一条执行提醒"],',
        '  "rationale": "团队的整体判断（≥ 40 字）"',
        '}',
        '',
        '规则：',
        `- order 必须正好 ${segments.length} 条，每段恰好出现一次（段号只有：${segments.map((segment) => segment.segmentId).join('、')}），不要按镜头拆、不要重复。`,
        `- 时长硬约束：成片总长必须接近目标 ${project?.targetSeconds ?? 45} 秒（±10%）。每段能用多久 = 该段的 actualSeconds（trimEnd 不填就是整段），把 order 里每段实际用量加起来核对一遍再输出；超了就压 trim，不够就补。`,
        '- 结局不能前置：不要把最后一段（落点/结局）整段挪到片头。要拿它当钩子，最多截其中 1.5–2 秒的一个动作，并且这个动作不能暴露结局。',
        '- 叙事顺序优先：这一段有台词、讲一件事（前提→发现→落点）时，不要重排顺序；每段的裁切至少保留它可用时长的 70%，把一段砍到两三秒等于把这场戏删了。',
        '- transition 只能是 cut 或 fade（fade 由宿主在每段首尾做 0.25 秒淡入淡出）。',
        '- lufs 取 -16 到 -12；gainDb 取 -24 到 -12；bgm 写情绪编制，不写版权曲名。',
        '- 标题 ≤ 20 字且带具体利益点；hashtags 至少 2 个。',
        '- 每段的 reason 一句话，说清剪辑判断，不要写「衔接自然」。',
        issuesBlock(issues),
      ].join('\n');
      const edl = await askJson({
        system: EDITOR_IDENTITY,
        user,
        temperature: 0.55,
        signal,
        label: '剪辑团队 Agent',
      });
      // 模型偶尔把数组字段写成字符串（或漏字段）：统一成宿主能吃的形状，别让类型问题炸掉整条剪辑。
      const asList = (value) => (Array.isArray(value) ? value.map(String).filter(Boolean) : typeof value === 'string' && value.trim() ? [value.trim()] : []);
      const validIds = segments.map((segment) => segment.segmentId);
      const validSet = new Set(validIds);
      // 剪辑清单必须是「每段恰好一次」：去重、丢掉不存在的段、补齐漏掉的段——这是确定性的活，不指望模型。
      const seen = new Set();
      const order = [];
      for (const entry of Array.isArray(edl.order) ? edl.order : []) {
        const id = String(entry?.segmentId ?? '');
        if (!validSet.has(id) || seen.has(id)) continue;
        seen.add(id);
        order.push({ ...entry, segmentId: id });
      }
      for (const id of validIds) {
        if (seen.has(id)) continue;
        order.push({ segmentId: id, trimStart: 0, trimEnd: null, transition: 'cut', transitionSec: 0.25, reason: '补齐：上一版漏了这一段' });
      }
      edl.order = order;

      // 总时长对账：模型算不准，这里按真实可用时长把总长压回目标 ±8%（只压不拉，不能凭空造镜头）。
      const target = Number(project?.targetSeconds) || 0;
      const availableOf = (id) => {
        const task = (render?.tasks ?? []).find((row) => String(row?.segmentId) === id);
        return Number(task?.duration) || null;
      };
      const usedOf = (entry) => {
        const available = availableOf(entry.segmentId);
        if (!available) return null;
        const start = Math.max(0, Number(entry.trimStart) || 0);
        const end = entry.trimEnd === null || entry.trimEnd === undefined ? available : Math.min(Number(entry.trimEnd), available);
        return Math.max(0, end - start);
      };
      const totalUsed = () => order.reduce((sum, entry) => sum + (usedOf(entry) ?? 0), 0);
      // 叙事片不能乱砍：一段被砍到 2 秒，等于把结尾删了。每段至少保留可用时长的 70%。
      for (const entry of order) {
        const available = availableOf(entry.segmentId);
        if (!available) continue;
        const start = Math.max(0, Number(entry.trimStart) || 0);
        const used = usedOf(entry);
        if (used === null) continue;
        const floor = Math.min(available - start, available * 0.7);
        if (used < floor) entry.trimEnd = Math.min(available, Math.round((start + floor) * 100) / 100);
      }
      // 还是不够长就用满每段（不能凭空造镜头，但把已有的全用上）。
      if (target > 0 && totalUsed() < target * 0.95) {
        for (const entry of order) {
          if (!availableOf(entry.segmentId)) continue;
          entry.trimStart = 0;
          entry.trimEnd = null;
        }
        edl.extended = true;
      }
      if (target > 0) {
        let total = totalUsed();
        if (total > target * 1.05) {
          const factor = (target * 0.98) / total;
          for (const entry of order) {
            const available = availableOf(entry.segmentId);
            const used = usedOf(entry);
            if (!available || !used) continue;
            const start = Math.max(0, Number(entry.trimStart) || 0);
            const next = Math.max(2, Math.min(available - start, used * factor));
            entry.trimEnd = Math.min(available, Math.round((start + next) * 100) / 100);
          }
          edl.adjusted = true;
        }
      }

      edl.notes = asList(edl.notes);
      edl.audio = { ...(edl.audio && typeof edl.audio === 'object' ? edl.audio : {}), lufs: Number(edl.audio?.lufs) || -14 };
      edl.packaging = {
        ...(edl.packaging && typeof edl.packaging === 'object' ? edl.packaging : {}),
        hashtags: asList(edl.packaging?.hashtags ?? []),
      };
      return edl;
    },

    /** 爆款拆解：把参考视频的证据写成报告（Markdown，不是 JSON）。 */
    async analyzeReference({ project, evidence, signal }) {
      const user = [
        briefBlock(project),
        '',
        `参考视频元数据：${JSON.stringify(evidence.summary ?? {}).slice(0, 1200)}`,
        `总时长：${evidence.shots?.duration ?? evidence.summary?.duration ?? '未知'}s，切点数：${evidence.shots?.cutCount ?? 0}，镜头数：${(evidence.shots?.shots ?? []).length}，平均镜长：${evidence.shots?.avgShotSeconds ?? '?'}s`,
        `镜表：\n${evidence.shotTable || '（没有镜表）'}`,
        `台词/字幕（带时间戳）：\n${evidence.lines || '（没有语音转写结果，只依据画面与元数据）'}`,
        ...(evidence.rea?.summary
          ? [
            '',
            'rea-video 的高级拆解（逐镜判定实拍 / AI 生成 / 代码渲染，并给复刻路线；这部分是测量出来的，优先级高于你的直觉判断）：',
            evidence.rea.summary,
            ...(evidence.rea.timeline ? ['', '逐镜时间线（一行一镜）：', evidence.rea.timeline] : []),
          ]
          : []),
        '',
        REFERENCE_TEMPLATE,
        '',
        '最后再加一节：「## 8. 对本次项目的可借用点」——列出 2–3 个可以直接借的结构（几段式、每段几秒、钩子怎么设计），并写清哪些必须换掉（人物/场景/产品/台词），避免同质化。',
      ].join('\n');
      const report = await callModel({ system: ANALYST_IDENTITY, user, temperature: 0.4, maxTokens, signal });
      return String(report).replace(/<\/?(?:badge|box|row|col|text|title|divider|image|icon|card)\b[^>]*>/g, '').replace(/\n{3,}/g, '\n\n').trim();
    },

    /** 复刻分镜：把参考片的证据翻成 shot-contract 结构的分镜。 */
    async replicateStoryboard({ project, evidence, signal }) {
      const duration = Number(evidence?.shots?.duration ?? evidence?.summary?.duration) || 45;
      const user = [
        briefBlock(project),
        '',
        `参考片：${evidence.summary?.title ?? ''}（${duration} 秒 / ${evidence.summary?.shotCount ?? '?'} 镜）`,
        `镜表：\n${evidence.shotTable || '（没有镜表）'}`,
        `台词：\n${evidence.lines || '（没有转写，只依据镜表）'}`,
        ...(evidence.rea?.summary
          ? ['', 'rea-video 的逐镜判定（实拍 / AI / 代码）与复刻路线，优先沿用它的判断：', evidence.rea.summary, ...(evidence.rea.timeline ? ['', evidence.rea.timeline] : [])]
          : []),
        '',
        STORYBOARD_RULES,
        '',
        `要求：targetSeconds 用 ${Math.round(duration)}；镜头数量与原片接近；保留原片的节奏结构，但人物、场景、台词必须全部换掉。`,
        '台词拍只写在 beats 里（kind=line 带 speaker），prompt 里逐字引用台词原文，结尾按锁行格式收尾。',
        '每个 shot 另加两个附加字段（不影响 13 道门）："origin": "live|ai|code|still|unknown"（这一镜原来是实拍还是 AI 生成/代码渲染），"route": "这一镜在复刻里怎么做"（实拍给拍摄方案，AI 给生成提示词，代码给 Remotion/3D 实现路径）。',
      ].join('\n');
      const doc = await askJson({ system: DIRECTOR_IDENTITY, user, temperature: 0.45, signal, label: '复刻分镜' });
      doc.targetSeconds = Number(doc.targetSeconds) || Math.round(duration) || 45;
      if (!doc.params || typeof doc.params !== 'object') doc.params = { maxSegmentSeconds: MAX_SEGMENT_SECONDS };
      return doc;
    },

    /** 画面验收：抽帧交给能看图的模型，查主体变形、道具错乱、文字乱码、产品不可识别。 */
    async reviewFrames({ project, frames, signal }) {
      const user = [
        `项目：${project?.title ?? ''}｜产品：${project?.brief?.productName ?? ''}｜目标 ${project?.targetSeconds ?? '?'} 秒`,
        '这几张是成片的抽帧（按时间顺序）。请判断这条片子能不能交付：',
        '1. 主体是否清晰可辨；2. 有没有物体变形、融合、多余手指、穿帮；3. 文字/Logo 是否乱码；4. 产品是否可识别（能不能看出是卖什么）；5. 相邻镜头的光线、场景、人物是否连贯。',
        '只输出 JSON：',
        '{',
        '  "pass": true,',
        '  "score": 0,',
        '  "issues": [{ "where": "第几张/哪一镜", "severity": "blocker|major|minor", "problem": "看到了什么", "fix": "怎么改（改提示词就写清改成什么）" }],',
        '  "summary": "一句话"',
        '}',
        '看不出问题就写 pass:true、issues 空数组，不要为了严格而编造。',
      ].join('\n');
      const raw = await callModel({
        system: '你是画面验收员：只看画面，不猜剧情。物体变形、道具错乱、手指异常、文字乱码、产品认不出，都是要拦的硬伤。只输出 JSON。',
        user,
        temperature: 0.2,
        maxTokens: 1600,
        images: frames,
        signal,
      });
      const verdict = extractJson(raw);
      const issues = Array.isArray(verdict?.issues) ? verdict.issues : [];
      const blocker = issues.some((issue) => String(issue?.severity) === 'blocker');
      return {
        pass: verdict?.pass === true && !blocker,
        score: Number(verdict?.score) || null,
        issues: issues.slice(0, 10),
        summary: String(verdict?.summary ?? ''),
      };
    },

    /** 审核 Agent：五维打分 + 问题清单 + 裁决。 */
    async review({ stage, project, artifact, gate, attempt, signal }) {
      const threshold = Number(config.reviewThreshold) || 80;
      const focus = REVIEW_FOCUS[stage] ?? '按本阶段自己的产出契约判断。';
      const referenceMode = Boolean(project?.reference?.report);
      const user = [
        `审核对象：${STAGE_LABEL[stage] ?? stage}（第 ${attempt} 版）`,
        '本次审核范围：只看下面这一份产物。它不含别的阶段的内容是正常的——缺分镜、缺台词、缺时长都不算问题，不要因此扣分。',
        `本阶段审核重点：${focus}`,
        `项目：${project?.title ?? ''}｜目标 ${project?.targetSeconds ?? 45} 秒｜平台 ${project?.platform ?? 'douyin'}`,
        referenceMode
          ? '本项目是**复刻模式**：创意依据是参考片的拆解报告，不是热点清单。hotspotLinks 为空不算问题；但每条方向必须有 borrowedFrom（借了参考片哪段结构）和 swapped（换掉了什么），缺这两个才是问题。'
          : '',
        '',
        '确定性质量门结果（这部分不是建议，是事实）：',
        gate?.ok ? '全部通过。' : (gate?.failures ?? []).map((failure, index) => `${index + 1}. ${failure}`).join('\n'),
        '',
        '待审产物：',
        JSON.stringify(artifact, null, 2).slice(0, 24000),
        '',
        '打分五维（每维 0–20，合计 100）：',
        '1) hook 钩子力：前 3 秒能不能让人停下',
        '2) narrative 叙事完整：钩子→转折→落点是否闭合',
        '3) execution 可执行性：分镜/提示词/时长是不是真能生成出来',
        '4) consistency 一致性：人物六维、音色、台词、段号是否对得上',
        '5) compliance 合规：夸大宣传、版权、审核红线、禁用词',
        '',
        `裁决阈值：总分 ${threshold} 分。`,
        '',
        '输出 JSON：',
        '{',
        '  "score": 0,',
        '  "dimensions": { "hook": 0, "narrative": 0, "execution": 0, "consistency": 0, "compliance": 0 },',
        '  "verdict": "pass | rework",',
        '  "issues": [{ "severity": "blocker | major | minor", "where": "哪一段/哪一镜/哪个人物", "problem": "具体问题", "fix": "具体改法" }],',
        '  "summary": "一句话结论（≤ 50 字）"',
        '}',
        '',
        '规则：',
        `- 有 blocker 或总分 < ${threshold} 时 verdict 必须是 rework。`,
        '- 每条 issue 都要有 where 和 fix；没有具体位置的意见不要写。',
        '- 不要为了显得严格而编造问题，也不要放过结构塌了的地方。',
      ].join('\n');
      const verdict = await askJson({
        system: REVIEWER_IDENTITY,
        user,
        temperature: 0.2,
        signal,
        label: '审核 Agent',
      });
      const dimensions = verdict.dimensions ?? {};
      const total = Number(verdict.score);
      const score = Number.isFinite(total) ? Math.max(0, Math.min(100, Math.round(total))) : 0;
      const issues = Array.isArray(verdict.issues) ? verdict.issues : [];
      const blocker = issues.some((issue) => String(issue?.severity) === 'blocker');
      const pass = verdict.verdict === 'pass' && score >= threshold && !blocker;
      return {
        score,
        dimensions,
        pass,
        verdict: pass ? 'pass' : 'rework',
        issues: issues.slice(0, 20),
        summary: String(verdict.summary ?? ''),
        threshold,
      };
    },
  };
}

export { SIX_DIMENSIONS, VOICE_CATALOG, STAGE_LABEL, briefBlock, hotspotBlock };
