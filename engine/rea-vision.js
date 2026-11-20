/**
 * 看图复核：把 rea-video 的「review_tasks」逐镜交给能看图的模型，
 * 让它按 11 类画面判断这一镜是怎么做出来的，把答案填回 review_answers。
 *
 * 这是 rea-video 推荐的「agent 当 VLM」路径：工具测帧率/噪声/AIGC 标识，
 * 模型看画面做语义判断，两者在 apply-review 里融合（工具证据优先，冲突记下来）。
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** 11 类底层画面的判断要点（压缩自 rea-video 的 taxonomy）。 */
export const LABELS = [
  ['live_action', '真实摄像机/手机实拍：真实光影与物理、传感器噪声、手持抖动、对焦呼吸'],
  ['ai_video', 'AI 生成视频：形变、纹理闪烁、物理不合理、文字乱码、过度完美的皮肤、动作漂浮'],
  ['avatar', '数字人口播：一张人像被音频驱动，嘴型动、头微摆、身体几乎不动'],
  ['cg_3d', '传统 3D 渲染：几何干净、材质规则、光影一致、运动精确无形变'],
  ['code_render', '代码/模板渲染：MG 动效、排版、UI、图表、渐变/辉光、粒子/线框数据可视化'],
  ['screen_capture', '录屏或网页/应用截图：真实界面元素、光标、滚动'],
  ['still_motion', '静态图做推拉摇移（Ken Burns）：整幅画面按单一刚体变换运动，画面内部无独立运动'],
  ['static_hold', '静帧定格：图片或卡片停住不动'],
  ['anim_2d', '2D 动画：手绘逐帧、Live2D、骨骼动画，线条和平涂色块，常见一拍二'],
  ['stop_motion', '定格动画：黏土/毛毡/乐高等实物逐帧拍，真实材质与灯光，动作一顿一顿、帧间闪烁'],
  ['film_footage', '剪进来的影视作品画面：认得出的演员、专业布光多机位、群演布景、台标或宽画幅黑边'],
];

const NARRATIVE_ROLES = 'hook 抓注意｜context 交代背景｜info 补信息｜proof 给证据｜turn 转折｜payoff 给结论｜cta 引导行动｜mood 渲染情绪';

export const SHOT_SYSTEM = [
  '你是视频制作的逆向工程师。你只看画面，判断这个镜头底层是怎么做出来的，并如实标出证据不足的地方。',
  '不要编造：看不清就分散概率并写清缺什么证据。只输出一个 JSON 对象，不要 Markdown，不要解释。',
].join('\n');

function taxonomyText() {
  return LABELS.map(([key, hint]) => `- ${key}：${hint}`).join('\n');
}

/** 一个镜头的看图请求。 */
export function buildShotRequest({ task, common }) {
  const tool = task?.tool ?? {};
  const user = [
    `整条视频：${common?.duration ?? '?'} 秒，${common?.shotCount ?? '?'} 个镜头，${common?.transcoded ? '经过了平台转码（噪声证据被洗掉，画面印象权重更高）' : '原始文件'}`,
    `这一镜：第 ${task?.index ?? '?'} 镜，${task?.start ?? '?'}-${task?.end ?? '?'} 秒（${task?.duration ?? '?'}s）`,
    `工具测到（可能出错，但帧率类与 AIGC 标识可靠）：${tool?.label_zh ?? tool?.label ?? '未知'}（置信度 ${tool?.confidence ?? '?'}）${tool?.second ? `；次选 ${tool.second[0]} ${tool.second[1]}` : ''}`,
    tool?.evidence?.length ? `工具证据：${tool.evidence.join('；')}` : '',
    '',
    '看图，从这 11 类里选（label_probs 的 key，概率加起来等于 1）：',
    taxonomyText(),
    '',
    `另外判断它在叙事里干什么（role 只能取：${NARRATIVE_ROLES}），point 用一句话写它讲的那一点（去掉具体的人和产品也成立）。`,
    '',
    '只输出 JSON：',
    '{',
    '  "label_probs": { "live_action": 0.0, "ai_video": 0.0, "avatar": 0.0, "cg_3d": 0.0, "code_render": 0.0, "screen_capture": 0.0, "still_motion": 0.0, "static_hold": 0.0, "anim_2d": 0.0, "stop_motion": 0.0, "film_footage": 0.0 },',
    '  "image_source": "ai_image | photo | graphic | screenshot | unknown",',
    '  "evidence": ["你看到的、支持这个判断的具体细节，2–4 条"],',
    '  "description": "画面里是什么：主体、动作、场景、运镜（一两句，具体到能复述）",',
    '  "narrative": { "role": "hook", "point": "一句话" },',
    '  "replication": { "image_prompt": "复刻首帧的中文提示词（景别/机位/主体位置/光线/风格）", "video_prompt": "复刻这一镜的中文提示词（景别机位→动作过程→结束状态→运镜）" }',
    '}',
    '概率只有一类明显占优时才写 0.8 以上；拿不准就给两个接近的概率并说明缺什么证据。',
  ].filter(Boolean).join('\n');
  return { system: SHOT_SYSTEM, user };
}

/** 把模型答案并进 review_answers.json（只覆盖它填的字段，保留模板结构）。 */
export function applyShotAnswer(answers, shotId, result) {
  const shot = (answers?.shots ?? []).find((row) => row.id === shotId);
  if (!shot) return false;
  const probs = result?.label_probs && typeof result.label_probs === 'object' ? result.label_probs : {};
  const clean = {};
  let total = 0;
  for (const [key] of LABELS) {
    const value = Number(probs[key]);
    if (Number.isFinite(value) && value > 0) {
      clean[key] = Math.round(value * 1000) / 1000;
      total += clean[key];
    }
  }
  if (total > 0) {
    // 归一化：apply-review 要求概率和为 1。
    for (const key of Object.keys(clean)) clean[key] = Math.round((clean[key] / total) * 1000) / 1000;
    shot.label_probs = clean;
  }
  if (typeof result?.image_source === 'string' && ['ai_image', 'photo', 'graphic', 'screenshot', 'unknown'].includes(result.image_source)) {
    shot.image_source = result.image_source;
  }
  if (Array.isArray(result?.evidence)) shot.evidence = result.evidence.map(String).filter(Boolean).slice(0, 6);
  if (typeof result?.description === 'string') shot.description = result.description.trim();
  if (result?.narrative && typeof result.narrative === 'object') {
    shot.narrative = { role: String(result.narrative.role ?? ''), point: String(result.narrative.point ?? '') };
  }
  if (result?.replication && typeof result.replication === 'object') {
    shot.replication = {
      ...(shot.replication ?? {}),
      image_prompt: String(result.replication.image_prompt ?? '').trim(),
      video_prompt: String(result.replication.video_prompt ?? '').trim(),
    };
  }
  return true;
}

/**
 * 跑一遍看图复核：挑镜头 → 逐镜问模型 → 写回答案 → apply-review。
 * 返回融合后的 summary/timeline 与复核统计。
 */
export async function runVisionReview({ ctx, callModel, extractJson, reference, rea, config, log = () => {}, onProgress = () => {} }) {
  const out = rea?.out;
  if (!out || !existsSync(out)) throw new Error('没有 rea-video 的输出目录');
  const { tasks, answers } = await reference.reaReview({ out, cmd: config.reaVideoCmd });
  const shots = Array.isArray(tasks?.shots) ? tasks.shots : [];
  if (shots.length === 0) throw new Error('没有可复核的镜头');

  const limit = Math.max(1, Number(config.reaVisionShots) || 12);
  // 优先复核 high，其次 normal；同一优先级按顺序取前 limit 个。
  const ranked = [...shots].sort((a, b) => (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1));
  const picked = ranked.slice(0, limit);
  const common = {
    duration: Number(tasks?.video_context?.duration) || null,
    shotCount: shots.length,
    transcoded: Boolean(tasks?.video_context?.transcoded),
  };

  let reviewed = 0;
  const failures = [];
  for (const task of picked) {
    const sheet = task?.images?.sheet ? resolve(out, task.images.sheet) : null;
    if (!sheet || !existsSync(sheet)) {
      failures.push(`${task.id}：没有关键帧图`);
      continue;
    }
    onProgress(`看图复核 ${reviewed + 1}/${picked.length}：${task.id}`);
    const request = buildShotRequest({ task, common });
    try {
      const raw = await callModel({ system: request.system, user: request.user, temperature: 0.2, maxTokens: 2500, images: [sheet] });
      const result = extractJson(raw);
      if (applyShotAnswer(answers, task.id, result)) reviewed += 1;
    } catch (error) {
      failures.push(`${task.id}：${error.message}`);
      log(`[rea] 看图复核 ${task.id} 失败：${error.message}`);
    }
  }
  if (reviewed === 0) throw new Error(`一镜都没复核成功${failures.length ? `（${failures[0]}）` : ''}`);

  // 顶层的整片判断（核心看点 / 角色 / 场景）也交给模型看 storyboard 联系表补一次。
  try {
    const storyboard = tasks?.storyboard ? resolve(out, tasks.storyboard) : null;
    if (storyboard && existsSync(storyboard)) {
      onProgress('看图复核整片：核心看点与角色');
      const raw = await callModel({
        system: SHOT_SYSTEM,
        user: [
          `这是整条视频（${common.duration ?? '?'} 秒、${common.shotCount} 镜）的联系表。`,
          '请给出整片的看点，以及角色/场景/道具清单，供报告开头使用。只输出 JSON：',
          '{',
          '  "story": { "summary": "这条视频是什么、靠什么吸引人（一句话）", "hook": "开头几秒怎么抓住人（第几秒、画面和字幕做了什么）", "highlights": ["2–4 条能火/能卖货的关键做法，每条写手法+第几秒+为什么有效"] },',
          '  "cast": { "style": "一句整体视觉风格与调色", "characters": [{ "id": "A", "name": "称呼", "kind": "person|animal|cartoon|avatar|product|other", "look": "外观，写到能据此再画出同一个角色", "role": "作用", "shots": [] }], "scenes": [{ "id": "S1", "where": "地点", "when": "时间", "look": "样子", "shots": [] }], "props": [{ "name": "道具/商品", "note": "", "shots": [] }] }',
          '}',
          '看不清的就少写，不要编。',
        ].join('\n'),
        temperature: 0.2,
        maxTokens: 2000,
        images: [storyboard],
      });
      const globalResult = extractJson(raw);
      if (globalResult?.story) answers.story = { ...(answers.story ?? {}), ...globalResult.story };
      if (globalResult?.cast) answers.cast = { ...(answers.cast ?? {}), ...globalResult.cast };
    }
  } catch (error) {
    log(`[rea] 整片看点复核失败（不影响逐镜）：${error.message}`);
  }

  answers.by = config.reaVisionBy || 'dsh';
  await writeFile(join(out, 'review_answers.json'), JSON.stringify(answers, null, 2), 'utf8');
  const merged = await reference.reaApplyReview({ out, cmd: config.reaVideoCmd, by: answers.by });

  return {
    summary: merged.summary || rea.summary,
    timeline: merged.timeline || rea.timeline,
    vision: { reviewed, total: shots.length, limit, failures: failures.slice(0, 6) },
  };
}
