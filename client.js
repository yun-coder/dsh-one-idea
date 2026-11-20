/**
 * 创意工作台的浏览器侧：左侧栏一个入口，主区域整页工作台。
 *
 * 面板不做任何重活：跑阶段、审核、出片、剪辑、通知都在宿主侧（见 index.js），
 * 这里只负责把「产品画像 + 热点 → 七个阶段 → 成片」画清楚，并把人的裁决送回去。
 */
window.__ModuleLoader__.load({
  id: 'dsh-one-idea',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const ID = 'dsh-one-idea';
    const NS = 'creativeStudio';
    const API = '/creative-studio/api';
    const FILE = '/creative-studio/file';
    const DIM_KEYS = ['face', 'features', 'hair', 'costume', 'posture', 'motif'];

    const zh = {
      reviewDesk: "审片台",
      planDesk: "分段清单",
      openReview: "打开审片台",
      startRendering: "确认并生成分段",
      assemble: "合成当前素材",
      editIssue: "按意见重剪",
      retakeIssue: "重做当前段",
      retakeNotes: "本段返工要求",
      reviewNoIssues: "当前没有画面审片标记",
      techCheck: "技术检查",
      finalCheck: "终审",
      humanCheck: "人工复核",
      notChecked: "待检查",
      passed: "通过",
      failedCheck: "未通过",
      staleCut: "素材已更新，播放器仍显示上一版。合成后查看当前版本。",
      segmentCompare: "分段版本对比",
      useVersion: "采用对比版",
      currentVersion: "当前素材",
      alternateVersion: "对比素材",
      actualReferences: "实际使用的定妆图",
      plannedReferences: "可用定妆图",
      noReferences: "无可用定妆图",
      unknownReferences: "历史任务未记录实际绑定",
      openingFrame: "起始动作",
      endingFrame: "末帧状态",
      criticalProps: "道具和现场关系",
      preflightWait: "先完成分镜、人物和声音方案。",
      preflightDuration: "计划生成 {n} 秒",
      inspectIssue: "查看标记",
      editTimeline: "成片时间线",
      checkFrame: "打开抽检画面",
      approveCut: "通过当前成片",
      viewDetails: "查看剪辑与验收详情",
      title: '创意工作台',
      loading: '正在读取工作台…',
      noProject: '还没有项目',
      newProject: '新建项目',
      removeProject: '删除项目',
      removeConfirm: '这个项目会连目录、分段和成片一起删掉，不能恢复。确定删除？',
      removed: '项目已删除',
      create: '创建项目',
      createAndRun: '创建并开跑',
      creating: '创建中…',
      pickProject: '项目',
      refresh: '刷新',
      emptyTitle: '从一份产品画像开始',
      emptyBody: '填好画像和目标时长：生产 Agent 出创意、写剧情、搭分镜、立人物六维、定配音；剪辑团队 Agent 出剪辑清单；审核 Agent 全程把关。不过就自动打回重做，重试用完会停下来提醒你复核。',
      brief: '产品画像',
      productName: '产品名',
      category: '品类',
      audience: '目标人群',
      sellingPoints: '核心卖点（一行一条）',
      tone: '调性',
      priceBand: '价格带',
      forbidden: '客户禁用词（逗号分隔）',
      extra: '补充要求',
      audioMode: '声音形式',
      projectMode: '制作类型',
      projectPromotion: '产品宣传',
      projectStory: '剧情短片',
      dialogueAudio: '含对白',
      noDialogueAudio: '无对白',
      targetSeconds: '目标时长（秒）',
      platform: '平台',
      aspect: '画幅',
      titleField: '项目名',
      save: '保存画像',
      saved: '已保存',
      hotspots: '实时热点',
      grab: '抓热点',
      grabbing: '抓取中…',
      addHotspot: '手动加一条热点',
      add: '添加',
      noHotspot: '还没有热点。可以点「抓热点」，也可以手填——没有热点时生产 Agent 只按品类常识走。',
      hotspotHint: '热点是创意的依据：每条创意都要挂到具体的热点上，挂不上会被门禁打回。',
      pipeline: '生产流水线',
      runAll: '准备分段清单',
      runStage: '重跑这一阶段',
      running: '运行中…',
      agent: { producer: '生产 Agent', editor: '剪辑团队 Agent', reviewer: '审核 Agent' },
      status: { empty: '未开始', running: '进行中', done: '已完成', rework: '打回重做中', needs_review: '待人工复核', failed: '失败', skipped: '已跳过' },
      score: '审核 {n} 分',
      attempt: '第 {n} 版',
      gateFail: '门禁 {n} 条未过',
      gateOk: '门禁全过',
      issues: '待修问题',
      error: '错误',
      reviewPending: '需要你复核',
      reviewWhy: '{stage}：{reason}',
      approve: '通过',
      rework: '打回重做',
      reworkHint: '打回意见（这段会逐条塞进生产 Agent 的提示词）',
      skip: '跳过这一阶段',
      viewDetail: '展开产物',
      hideDetail: '收起',
      final: '成片',
      noFinal: '还没有成片：跑到「成片剪辑」才会生成',
      downloadHint: '成片路径',
      copy: '复制路径',
      copied: '已复制',
      publish: '发布包',
      events: '运行日志',
      idea: '创意方向',
      choose: '选这个方向',
      chosen: '已选定',
      rerunStory: '用这个方向重跑剧情',
      recommended: '推荐',
      hook: '前 3 秒',
      whyNow: '为什么现在',
      risk: '风险',
      storyboard: '镜表',
      characters: '人物六维',
      voice: '配音',
      segment: '段',
      shots: '镜',
      seconds: '秒',
      portrait: '定妆图',
      portraitFailed: '定妆图没生成',
      voiceOf: '音色',
      voiceAudioReady: '已合成 {n} 句 · {engine}',
      voiceAudioSkipped: '配音还没落地：{reason}',
      voiceAudioOverflow: '{n} 句超出镜头（已自动加速）',
      voiceAudioHard: '{n} 句装不进镜头：{list}',
      voiceListen: '试听',
      bgm: 'BGM',
      edl: '剪辑清单',
      order: '成片顺序',
      transition: '转场',
      renderTasks: '出片任务',
      progress: '进度',
      preview: '预览',
      noArtifact: '还没产出',
      runHint: '出片与剪辑是长任务，进度会自己刷新。',
      needBrief: '产品名不能为空',
      notifyOn: '有结果会通知你',
      notifyOff: '浏览器通知未开启（点这里开）',
      refTitle: '参考爆款（拉片）',
      refPlaceholder: '粘贴抖音分享文案或链接',
      refLocal: '或本机视频路径',
      advancedReference: '高级逐镜分析',
      projectBriefTab: '简报与参考',
      manualReviewPassed: '人工通过',
      renderQueued: '排队中',
      renderCompleted: '已生成',
      renderCancelled: '已取消',
      renderReferenceCount: '角色参考图 {n} 张',
      renderTextOnly: '纯文生视频',
      retakeSegment: '重新生成此段',
      visualUnavailable: '画面验收未完成',
      referenceLibraryTab: '拉片台',
      shotTimeline: '分镜时间线',
      editShot: '编辑',
      saveShot: '保存并过门禁',
      cancelEdit: '取消',
      shotPrompt: '提示词（至少 60 字）',
      shotSeconds: '时长（秒）',
      shotLine: '这一镜的台词',
      shotEditSaved: '已保存，门禁已重跑',
      passedWithNotes: '带建议通过',
      promptTab: '提示词模板',
      doctorTitle: '环境自检',
      doctorHint: '装完先跑一遍：Node、目录、ffmpeg、分镜技能、出片密钥、生图后端，缺什么怎么补都会列出来。',
      doctorRun: '运行自检',
      doctorRunning: '检查中…',
      demoButton: '载入示例项目',
      runtimeUsed: '本次使用',
      demoLoaded: '示例项目已载入：可以直接看成片，也可以从任意阶段重跑',
      agentProducer: '生产 Agent',
      agentEditor: '剪辑团队 Agent',
      agentReviewer: '审核 Agent',
      status_empty: '未开始',
      status_running: '进行中',
      status_done: '已完成',
      status_rework: '打回重做中',
      status_needs_review: '待人工复核',
      status_failed: '失败',
      status_skipped: '已跳过',
      status_interrupted: '已中断',
      errNoJson: '宿主没有返回 JSON（HTTP {n}）',
      errRequest: '请求失败（HTTP {n}）',
      phTitle: '清汤面 · 深夜面馆 45 秒',
      phTone: '克制的温情，不要叫卖',
      phPoints: '一碗面一碗汤\n凌晨十二点还开门\n老板记得每个老客的口味',
      phForbidden: '最,第一,国家级',
      unitShots: '{n} 镜',
      unitSegment: '{m} 段',
      noticeProjectOpened: '已开项目：{id}',
      labelOneLiner: '一句话',
      scoreLine: '钩子 {hook} · 契合 {fit} · 可拍 {feasible}',
      labelEnding: '结局：{text}',
      noticeSaveFailed: '保存失败：{msg}',
      noticeReadFailed: '读取失败：{msg}',
      storyboardMeta: '{d}s · {n} 镜 · {m} 段',
      labelPrompt: '提示词',
      labelNarration: '旁白：{voice} · {emotion}',
      trimHead: '裁头 {n}s',
      trimTail: '裁尾 {n}s',
      doctorSummary: '{ok} 通过 · {warn} 提醒 · {fail} 失败',
      customSuffix: ' · 已自定义',
      notifyTitle: '创意工作台需要复核：{title}',
      noticeStarted: '已开跑：创意 → 剧情 → 分镜 → 人物 → 配音。确认分段清单后出片。',
      noticeHotspots: '抓到 {n} 条热点',
      sourceManual: '手动',
      projectCount: '{n} 个项目',
      reaVisionLine: '{a}/{b} 镜已复核',
      shotsSegments: '{n} 镜 / {m} 段',
      promptHint: '每一段的指令可以改：保存后会追加到内置阶段指令后面，冲突时以这里为准；JSON 结构与门禁要求不能被改掉。留空保存 = 恢复默认。',
      promptName: '阶段',
      promptSave: '保存',
      promptReset: '恢复默认',
      promptSaved: '已保存，下一阶段生效',
      promptResetDone: '已恢复默认',
      promptPlaceholder: '例如：分镜里每一镜的动作必须是一个瞬间，不要写「然后」「接着」；台词只用画外音，不要出现手机屏幕字幕。',
      refRun: '拉片并拆解',
      refRunning: '拉片中',
      refDone: '已拆解',
      refFailed: '拉片失败',
      refReport: '拆解报告',
      refHint: '拆一条已经火过的片子：下载 → 切点 → 逐镜帧 → 语音转写 → 拆解报告。报告会进创意 Agent 的证据，至少一个方向要借用它验证过的结构（人物/台词必须换掉）。',
      refStudio: '拉片台（爆款复刻）',
      refStudioHint: '不建项目也能拉一条片子：下载 → 切点 → 逐镜帧 → 12 格联系表 → 语音转写 → 拆解报告 → 复刻分镜。记录留在这里，随时能翻。',
      refStart: '开始拉片',
      refSelect: '拉片记录',
      refEmpty: '还没有拉片记录。贴一条抖音链接，或填一个本机视频路径。',
      refContact: '联系表',
      refFrames: '逐镜帧',
      refTranscript: '台词 / 字幕',
      refRep: '拆解报告',
      refTable: '镜表',
      refVideo: '原片',
      refReplicate: '生成复刻分镜',
      refReplicated: '复刻分镜',
      refToProject: '用它开一个项目',
      refProduct: '产品名（开项目用）',
      refGateOk: '13 道门全绿',
      refGateFail: '{n} 条门禁未过',
      refDelete: '删除这条拉片记录',
      refDeleteConfirm: '会删掉这一条拉片（原片、联系表、逐镜帧、报告与复刻分镜），不能恢复。确定？',
      refDeleted: '拉片记录已删除',
      reaTitle: '高级拆解（rea-video）',
      reaTimeline: '逐镜时间线（切点 / 怎么做的 / 复刻路线）',
      reaVideoMd: 'VIDEO.md（分层拆解，给模型读）',
      reaFailed: 'rea-video 没跑起来',
      reaVision: '看图复核',
      reaVisionFailed: '看图复核没成功（沿用工具判定）',
      reaHint: '逐镜判定这条片子是实拍 / AI 生成 / 代码渲染，并给出每镜的复刻路线',
      visualCheck: '画面验收',
      visualPass: '通过',
      visualIssues: '{n} 条问题',
    };
    const en = {
      reviewDesk: "Review",
      planDesk: "Segment plan",
      openReview: "Open review workspace",
      startRendering: "Confirm and generate",
      assemble: "Assemble selected takes",
      editIssue: "Re-edit from this note",
      retakeIssue: "Regenerate selected segment",
      retakeNotes: "Notes for this take",
      reviewNoIssues: "No visual review markers",
      techCheck: "Technical checks",
      finalCheck: "Final review",
      humanCheck: "Manual review",
      notChecked: "Pending",
      passed: "Passed",
      failedCheck: "Failed",
      staleCut: "The player shows the previous cut. Assemble the updated takes to preview them.",
      segmentCompare: "Compare takes",
      useVersion: "Use alternate take",
      currentVersion: "Current take",
      alternateVersion: "Alternate take",
      actualReferences: "Character references used",
      plannedReferences: "Available character references",
      noReferences: "No available character references",
      unknownReferences: "Reference use was unrecorded",
      openingFrame: "Opening action",
      endingFrame: "Last frame",
      criticalProps: "Props and blocking",
      preflightWait: "Complete the storyboard, character profiles and sound plan first.",
      preflightDuration: "{n} seconds to generate",
      inspectIssue: "View marker",
      editTimeline: "Final cut timeline",
      checkFrame: "Open review frame",
      approveCut: "Approve current cut",
      viewDetails: "Editing and review details",
      title: 'Creative studio',
      loading: 'Loading the studio…',
      noProject: 'No project yet',
      newProject: 'New project',
      removeProject: 'Delete project',
      removeConfirm: 'This deletes the project folder with its segments and renders. It cannot be undone. Continue?',
      removed: 'Project deleted',
      create: 'Create',
      createAndRun: 'Create and run',
      creating: 'Creating…',
      pickProject: 'Project',
      refresh: 'Refresh',
      emptyTitle: 'Start from a product brief',
      emptyBody: 'Fill the brief: the producer agent writes ideas, story, storyboard, six-dimension characters and the voice plan; the editorial team agent cuts; the reviewer agent checks every stage. Failures are reworked automatically, and anything still failing waits for your review.',
      brief: 'Product brief',
      productName: 'Product',
      category: 'Category',
      audience: 'Audience',
      sellingPoints: 'Selling points (one per line)',
      tone: 'Tone',
      priceBand: 'Price band',
      forbidden: 'Forbidden words (comma separated)',
      extra: 'Extra requirements',
      audioMode: 'Audio format',
      projectMode: 'Production type',
      projectPromotion: 'Product promotion',
      projectStory: 'Narrative short',
      dialogueAudio: 'With dialogue',
      noDialogueAudio: 'No dialogue',
      targetSeconds: 'Target seconds',
      platform: 'Platform',
      aspect: 'Aspect',
      titleField: 'Project title',
      save: 'Save brief',
      saved: 'Saved',
      hotspots: 'Live hotspots',
      grab: 'Fetch hotspots',
      grabbing: 'Fetching…',
      addHotspot: 'Add a hotspot',
      add: 'Add',
      noHotspot: 'No hotspots yet. Fetch them or type some — without hotspots the producer only follows category sense.',
      hotspotHint: 'Hotspots are the evidence: every idea must be anchored to one, or the gate sends it back.',
      pipeline: 'Pipeline',
      runAll: 'Prepare segment plan',
      runStage: 'Re-run this stage',
      running: 'Running…',
      agent: { producer: 'Producer', editor: 'Editorial team', reviewer: 'Reviewer' },
      status: { empty: 'Idle', running: 'Running', done: 'Done', rework: 'Reworking', needs_review: 'Needs review', failed: 'Failed', skipped: 'Skipped' },
      score: 'Score {n}',
      attempt: 'take {n}',
      gateFail: '{n} gates failing',
      gateOk: 'All gates pass',
      issues: 'Open issues',
      error: 'Error',
      reviewPending: 'Needs your review',
      reviewWhy: '{stage}: {reason}',
      approve: 'Approve',
      rework: 'Send back',
      reworkHint: 'Notes for the producer (each line goes into the next prompt)',
      skip: 'Skip this stage',
      viewDetail: 'Show artifacts',
      hideDetail: 'Hide',
      final: 'Final cut',
      noFinal: 'No final cut yet — run the edit stage',
      downloadHint: 'File',
      copy: 'Copy path',
      copied: 'Copied',
      publish: 'Publish pack',
      events: 'Activity',
      idea: 'Ideas',
      choose: 'Choose this',
      chosen: 'Chosen',
      rerunStory: 'Re-run story with it',
      recommended: 'Recommended',
      hook: 'First 3s',
      whyNow: 'Why now',
      risk: 'Risk',
      storyboard: 'Shot list',
      characters: 'Characters',
      voice: 'Voice',
      segment: 'segment',
      shots: 'shots',
      seconds: 's',
      portrait: 'Portrait',
      portraitFailed: 'Portrait failed',
      voiceOf: 'Voice',
      voiceAudioReady: '{n} lines voiced · {engine}',
      voiceAudioSkipped: 'Voice not rendered yet: {reason}',
      voiceAudioOverflow: '{n} lines longer than their shot (auto sped up)',
      voiceAudioHard: '{n} lines do not fit the shot: {list}',
      voiceListen: 'Listen',
      bgm: 'BGM',
      edl: 'Edit list',
      order: 'Final order',
      transition: 'Transition',
      renderTasks: 'Render tasks',
      progress: 'Progress',
      preview: 'Preview',
      noArtifact: 'Not produced yet',
      runHint: 'Rendering and editing are long jobs; progress refreshes itself.',
      needBrief: 'Product name is required',
      notifyOn: 'You will be notified when it needs you',
      notifyOff: 'Browser notifications are off (click to enable)',
      refTitle: 'Reference hit (teardown)',
      refPlaceholder: 'Paste a Douyin share text or link',
      refLocal: 'or a local video path',
      advancedReference: 'Advanced shot analysis',
      projectBriefTab: 'Brief and reference',
      manualReviewPassed: 'Manually approved',
      renderQueued: 'Queued',
      renderCompleted: 'Generated',
      renderCancelled: 'Cancelled',
      renderReferenceCount: '{n} character references',
      renderTextOnly: 'Text to video',
      retakeSegment: 'Regenerate segment',
      visualUnavailable: 'Visual review unavailable',
      referenceLibraryTab: 'Reference studio',
      shotTimeline: 'Storyboard timeline',
      editShot: 'Edit',
      saveShot: 'Save and re-run gates',
      cancelEdit: 'Cancel',
      shotPrompt: 'Prompt (60+ characters)',
      shotSeconds: 'Seconds',
      shotLine: 'Line in this shot',
      shotEditSaved: 'Saved; gates re-ran',
      passedWithNotes: 'Passed with notes',
      promptTab: 'Prompt templates',
      doctorTitle: 'Environment check',
      doctorHint: 'Run once after install: Node, folders, ffmpeg, storyboard skill, render keys and image backend, each with a fix hint.',
      doctorRun: 'Run check',
      doctorRunning: 'Checking…',
      demoButton: 'Load demo project',
      runtimeUsed: 'Using',
      demoLoaded: 'Demo loaded: watch the film, or rerun any stage',
      agentProducer: 'Production agent',
      agentEditor: 'Edit team agent',
      agentReviewer: 'Reviewer',
      status_empty: 'Not started',
      status_running: 'Running',
      status_done: 'Done',
      status_rework: 'Reworking',
      status_needs_review: 'Needs review',
      status_failed: 'Failed',
      status_skipped: 'Skipped',
      status_interrupted: 'Interrupted',
      errNoJson: 'Host did not return JSON (HTTP {n})',
      errRequest: 'Request failed (HTTP {n})',
      phTitle: 'Clear-soup noodles · late-night shop, 45s',
      phTone: 'Restrained warmth, no hard sell',
      phPoints: 'One bowl, one soup\nOpen at midnight\nThe owner remembers regulars',
      phForbidden: 'best, No.1, national-level',
      unitShots: '{n} shots',
      unitSegment: '{m} segs',
      noticeProjectOpened: 'Project opened: {id}',
      labelOneLiner: 'One-liner',
      scoreLine: 'Hook {hook} · Fit {fit} · Feasible {feasible}',
      labelEnding: 'Ending: {text}',
      noticeSaveFailed: 'Save failed: {msg}',
      noticeReadFailed: 'Read failed: {msg}',
      storyboardMeta: '{d}s · {n} shots · {m} segs',
      labelPrompt: 'Prompt',
      labelNarration: 'Voice-over: {voice} · {emotion}',
      trimHead: 'trim in {n}s',
      trimTail: 'trim out {n}s',
      doctorSummary: '{ok} passed · {warn} warnings · {fail} failed',
      customSuffix: ' · custom',
      notifyTitle: 'Creative Studio needs review: {title}',
      noticeStarted: 'Started: idea → story → storyboard → characters → voice. Confirm the segment plan, then render.',
      noticeHotspots: 'Found {n} hotspots',
      sourceManual: 'manual',
      projectCount: '{n} projects',
      reaVisionLine: '{a}/{b} shots reviewed',
      shotsSegments: '{n} shots / {m} segs',
      promptHint: 'Each stage instruction can be extended: saved text is appended to the built-in instruction and wins on conflict; JSON structure and gates stay mandatory. Save empty to restore defaults.',
      promptName: 'Stage',
      promptSave: 'Save',
      promptReset: 'Restore default',
      promptSaved: 'Saved; applies to the next run',
      promptResetDone: 'Restored defaults',
      promptPlaceholder: 'Example: every shot action must be a single instant; no "then"/"after that"; dialogue only as voice-over.',
      refRun: 'Tear down',
      refRunning: 'Tearing down',
      refDone: 'Torn down',
      refFailed: 'Teardown failed',
      refReport: 'Analysis report',
      refHint: 'Tear down a video that already worked: download → cut detection → per-shot frames → speech-to-text → analysis. The report becomes evidence for the idea stage; at least one direction must borrow its proven structure (people and lines must change).',
      refStudio: 'Teardown desk',
      refStudioHint: 'Tear down a video without creating a project: download → cut detection → per-shot frames → contact sheet → transcript → analysis → replicate storyboard. Records stay here.',
      refStart: 'Tear down',
      refSelect: 'Record',
      refEmpty: 'No teardown records yet. Paste a Douyin link or a local video path.',
      refContact: 'Contact sheet',
      refFrames: 'Shot frames',
      refTranscript: 'Lines / captions',
      refRep: 'Analysis report',
      refTable: 'Shot table',
      refVideo: 'Source',
      refReplicate: 'Build replicate storyboard',
      refReplicated: 'Replicate storyboard',
      refToProject: 'Start a project from it',
      refProduct: 'Product name',
      refGateOk: 'All 13 gates pass',
      refGateFail: '{n} gates failing',
      refDelete: 'Delete this teardown record',
      refDeleteConfirm: 'Deletes this teardown record (source video, contact sheet, frames, report, replicate storyboard). Cannot be undone.',
      refDeleted: 'Teardown record deleted',
      reaTitle: 'Deep teardown (rea-video)',
      reaTimeline: 'Shot timeline (cuts / how it was made / remake route)',
      reaVideoMd: 'VIDEO.md (layered breakdown)',
      reaFailed: 'rea-video did not run',
      reaVision: 'Visual review',
      reaVisionFailed: 'Visual review failed (keeping tool verdicts)',
      reaHint: 'Per shot: filmed / AI-generated / coded, plus a remake route for each',
      visualCheck: 'Frame check',
      visualPass: 'Passed',
      visualIssues: '{n} issues',
    };

    const fill = (template, vars = {}) => String(template).replace(/\{(\w+)\}/g, (_, key) => (vars[key] === undefined ? '' : String(vars[key])));

    /** 角色与状态都走 t()，中英切换一致。 */
    const agentLabel = (t, agent) => (agent === 'producer' ? t('agentProducer') : agent === 'editor' ? t('agentEditor') : agent === 'reviewer' ? t('agentReviewer') : agent);
    const statusLabel = (t, status) => {
      const label = t(`status_${status}`);
      // 新状态没来得及翻译时退回原始状态，而不是把 status_xxx 这种键名露给用户。
      return !label || String(label).startsWith('status_') ? status : label;
    };
    /** 非组件函数（call）的文案：Panel 挂载时把 t 注入进来。 */
    let text = (key, vars) => fill(key, vars);

    async function call(endpoint, payload) {
      const response = await fetch(`${API}/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        throw new Error(text('errNoJson', { n: response.status }));
      }
      if (!body || body.ok !== true) throw new Error(body?.error?.message ?? text('errRequest', { n: response.status }));
      return body.value;
    }

    // ---- 设计令牌：跟宿主其余面板同一套 ----
    const RADIUS_MD = 'var(--dsw-radius-md, 6px)';
    const RADIUS_LG = 'var(--dsw-radius-lg, 10px)';
    const FONT_SM = 'var(--dsh-content-font-size-secondary, 13px)';
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    const s = {
      page: {
        display: 'flex', flexDirection: 'column', gap: '14px', height: '100%', minHeight: 0,
        padding: '14px', overflowY: 'auto', boxSizing: 'border-box',
        color: 'var(--dsw-alias-label-primary)', fontSize: FONT_SM, lineHeight: 1.55,
        background: 'var(--dsw-alias-bg-base)',
      },
      pageWide: { padding: '22px 26px 40px', gap: '16px', maxWidth: '1180px', width: '100%', margin: '0 auto' },
      head: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      headTitle: { margin: 0, fontSize: '24px', fontWeight: 600, letterSpacing: '0.01em' },
      headMeta: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      spacer: { flex: 1, minWidth: '8px' },
      card: {
        display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', minWidth: 0,
        background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: RADIUS_LG,
      },
      cardTight: { gap: '6px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flexWrap: 'wrap' },
      rowTop: { display: 'flex', alignItems: 'flex-start', gap: '10px', minWidth: 0 },
      label: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      meta: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' },
      mono: { fontFamily: MONO, fontSize: '11.5px', overflowWrap: 'anywhere', color: 'var(--dsw-alias-label-secondary)' },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '5px 8px', fontSize: FONT_SM, fontFamily: 'inherit',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l3)', borderRadius: RADIUS_MD,
      },
      textarea: {
        width: '100%', boxSizing: 'border-box', padding: '5px 8px', fontSize: FONT_SM, fontFamily: 'inherit',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', resize: 'vertical',
        border: '1px solid var(--dsw-alias-border-l3)', borderRadius: RADIUS_MD, minHeight: '56px',
      },
      btn: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', flex: 'none',
        padding: '6px 12px', fontSize: FONT_SM, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
        color: 'var(--dsw-alias-label-primary-foreground)', background: 'var(--dsw-alias-button-primary-fill)',
        border: '1px solid transparent', borderRadius: RADIUS_MD,
      },
      btnGhost: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', flex: 'none',
        padding: '4px 10px', fontSize: '12px', cursor: 'pointer', fontFamily: 'inherit',
        color: 'var(--dsw-alias-label-primary)', background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l3)', borderRadius: RADIUS_MD,
      },
      btnIcon: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
        width: '26px', height: '26px', padding: 0, cursor: 'pointer', fontFamily: 'inherit',
        color: 'var(--dsw-alias-label-secondary)', background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l3)', borderRadius: RADIUS_MD,
      },
      disabled: { opacity: 0.45, cursor: 'not-allowed' },
      badge: {
        display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '1px 7px',
        borderRadius: '999px', fontSize: '11.5px', fontWeight: 500, border: '1px solid transparent', flex: 'none',
      },
      err: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
      ok: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-state-success-primary)', overflowWrap: 'anywhere' },
      warnText: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-state-warn-primary)', overflowWrap: 'anywhere' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px' },
      stageRow: {
        display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 12px', minWidth: 0,
        background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: RADIUS_MD,
      },
      stageRowActive: { borderColor: 'var(--dsw-alias-state-business-primary)' },
      dot: { width: '8px', height: '8px', borderRadius: '50%', flex: 'none' },
      stageName: { fontWeight: 600, fontSize: '13px', minWidth: 0 },
      chip: {
        display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '3px 8px', fontSize: '12px',
        background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: '999px',
      },
      sectionTitle: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', letterSpacing: '0.02em' },
      video: { width: '100%', maxHeight: '460px', borderRadius: RADIUS_MD, background: '#000', display: 'block' },
      pre: {
        margin: 0, padding: '8px 10px', maxHeight: '260px', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        fontFamily: MONO, fontSize: '11.5px', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-2)', borderRadius: RADIUS_MD,
      },
      kv: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', fontSize: '12px', minWidth: 0 },
      hr: { height: '1px', background: 'var(--dsw-alias-border-l3)', margin: '2px 0', border: 0 },
      banner: {
        display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 14px',
        background: 'var(--dsw-alias-bg-layer-2)', borderRadius: RADIUS_LG,
        border: '1px solid var(--dsw-alias-state-warn-primary)',
      },
      num: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
        width: '20px', height: '20px', borderRadius: '50%', fontSize: '11px', fontWeight: 600,
        color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-3)',
      },
    };

    const TONE = {
      empty: 'dim', running: 'warn', rework: 'warn', needs_review: 'bad', failed: 'bad', done: 'good', skipped: 'dim', interrupted: 'warn',
    };
    const TONE_STYLE = {
      dim: { color: 'var(--dsw-alias-label-secondary)', borderColor: 'var(--dsw-alias-border-l3)' },
      good: { color: 'var(--dsw-alias-state-success-primary)', borderColor: 'var(--dsw-alias-state-success-secondary)' },
      warn: { color: 'var(--dsw-alias-state-warn-primary)', borderColor: 'var(--dsw-alias-state-warn-tertiary)' },
      bad: { color: 'var(--dsw-alias-state-error-primary)', borderColor: 'var(--dsw-alias-state-error-primary)' },
      info: { color: 'var(--dsw-alias-state-business-primary)', borderColor: 'var(--dsw-alias-state-business-primary)' },
    };
    const DOT_COLOR = {
      dim: 'var(--dsw-alias-label-tertiary)',
      good: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      bad: 'var(--dsw-alias-state-error-primary)',
      info: 'var(--dsw-alias-state-business-primary)',
    };

    function Badge({ tone = 'dim', children }) {
      return h('span', { style: { ...s.badge, background: 'var(--dsw-alias-bg-layer-2)', ...(TONE_STYLE[tone] ?? TONE_STYLE.dim) } }, children);
    }

    const timeText = (ms) => {
      if (!ms) return '';
      const date = new Date(ms);
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
    };

    function Field({ label, children, grow }) {
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0, flex: grow ? 1 : 'none' } },
        h('span', { style: s.label }, label),
        children,
      );
    }

    // ---------------------------------------------------------------------
    // 新建项目
    // ---------------------------------------------------------------------
    const emptyForm = () => ({
      title: '', productName: '', category: '', audience: '', sellingPoints: '', tone: '', priceBand: '',
      forbidden: '', extra: '', audioMode: 'dialogue', projectMode: 'promotion', targetSeconds: '45', platform: 'douyin', aspect: '9:16',
    });

    function NewProject({ t, config, onCreate, onDemo, busy }) {
      const [form, setForm] = useState(emptyForm);
      const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));
      const submit = (startNow) => onCreate(form, startNow);

      return h('div', { style: s.card },
        h('div', { style: s.row },
          h('strong', { style: { fontSize: '13px' } }, t('emptyTitle')),
          h('div', { style: s.spacer }),
          onDemo ? h('button', { type: 'button', style: { ...s.btnGhost, ...(busy ? s.disabled : {}) }, disabled: busy, onClick: () => onDemo() }, t('demoButton')) : null,
        ),
        h('p', { style: s.meta }, t('emptyBody')),
        h('div', { style: s.grid },
          h(Field, { label: t('titleField') }, h('input', { style: s.input, value: form.title, onChange: set('title'), placeholder: t('phTitle') })),
          h(Field, { label: t('productName') }, h('input', { style: s.input, value: form.productName, onChange: set('productName') })),
          h(Field, { label: t('category') }, h('input', { style: s.input, value: form.category, onChange: set('category') })),
          h(Field, { label: t('audience') }, h('input', { style: s.input, value: form.audience, onChange: set('audience') })),
          h(Field, { label: t('tone') }, h('input', { style: s.input, value: form.tone, onChange: set('tone'), placeholder: t('phTone') })),
          h(Field, { label: t('priceBand') }, h('input', { style: s.input, value: form.priceBand, onChange: set('priceBand') })),
        ),
        h(Field, { label: t('sellingPoints') },
          h('textarea', { style: s.textarea, value: form.sellingPoints, onChange: set('sellingPoints'), placeholder: t('phPoints') }),
        ),
        h(Field, { label: t('forbidden') }, h('input', { style: s.input, value: form.forbidden, onChange: set('forbidden'), placeholder: t('phForbidden') })),
        h(Field, { label: t('extra') }, h('textarea', { style: { ...s.textarea, minHeight: '42px' }, value: form.extra, onChange: set('extra') })),
        h('div', { style: s.row },
          h(Field, { label: t('targetSeconds') }, h('input', { style: { ...s.input, width: '100px' }, type: 'number', min: 10, max: 180, value: form.targetSeconds, onChange: set('targetSeconds') })),
          h(Field, { label: t('projectMode') },
            h('select', { style: s.input, value: form.projectMode, onChange: set('projectMode') },
              h('option', { value: 'promotion' }, t('projectPromotion')),
              h('option', { value: 'story' }, t('projectStory')),
            ),
          ),
          h(Field, { label: t('audioMode') },
            h('select', { style: s.input, value: form.audioMode, onChange: set('audioMode') },
              h('option', { value: 'dialogue' }, t('dialogueAudio')),
              h('option', { value: 'no-dialogue' }, t('noDialogueAudio')),
            ),
          ),
          h(Field, { label: t('platform') },
            h('select', { style: { ...s.input, width: '130px' }, value: form.platform, onChange: set('platform') },
              ['douyin', 'shipinhao', 'xiaohongshu', 'bilibili'].map((value) => h('option', { key: value, value }, value)),
            ),
          ),
          h(Field, { label: t('aspect') },
            h('select', { style: { ...s.input, width: '110px' }, value: form.aspect, onChange: set('aspect') },
              (config?.aspects ?? ['9:16', '16:9', '1:1']).map((value) => h('option', { key: value, value }, value)),
            ),
          ),
          h('div', { style: s.spacer }),
          h('button', { type: 'button', style: { ...s.btnGhost, ...(busy ? s.disabled : {}) }, disabled: busy, onClick: () => submit(false) }, t('create')),
          h('button', { type: 'button', style: { ...s.btn, ...(busy ? s.disabled : {}) }, disabled: busy, onClick: () => submit(true) }, busy ? t('creating') : t('createAndRun')),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // 产品画像 + 热点
    // ---------------------------------------------------------------------
    function BriefCard({ t, project, config, onSave, onHotspots, onAddHotspot, busy }) {
      const [open, setOpen] = useState(false);
      const brief = project.brief ?? {};
      const [draft, setDraft] = useState({
        title: project.title ?? '',
        productName: brief.productName ?? '',
        category: brief.category ?? '',
        audience: brief.audience ?? '',
        sellingPoints: (brief.sellingPoints ?? []).join('\n'),
        tone: brief.tone ?? '',
        priceBand: brief.priceBand ?? '',
        forbidden: (brief.forbidden ?? []).join(','),
        extra: brief.extra ?? '',
        audioMode: brief.audioMode ?? 'dialogue',
        projectMode: brief.projectMode ?? 'promotion',
        targetSeconds: String(project.targetSeconds ?? 45),
      });
      const [hotspot, setHotspot] = useState('');
      const set = (key) => (event) => setDraft((prev) => ({ ...prev, [key]: event.target.value }));

      const hotspots = brief.hotspots ?? [];

      return h('div', { style: s.card },
        h('div', { style: s.row },
          h('span', { style: s.sectionTitle }, t('brief')),
          h('span', { style: s.meta }, `${brief.productName || '—'} · ${brief.category || '—'} · ${project.targetSeconds}s · ${project.aspect}`),
          h('div', { style: s.spacer }),
          h('button', { type: 'button', style: s.btnIcon, title: t('refresh'), onClick: () => setOpen((prev) => !prev) }, open ? '−' : '+'),
        ),
        open ? h(React.Fragment, null,
          h('div', { style: s.grid },
            h(Field, { label: t('titleField') }, h('input', { style: s.input, value: draft.title, onChange: set('title') })),
            h(Field, { label: t('productName') }, h('input', { style: s.input, value: draft.productName, onChange: set('productName') })),
            h(Field, { label: t('category') }, h('input', { style: s.input, value: draft.category, onChange: set('category') })),
            h(Field, { label: t('audience') }, h('input', { style: s.input, value: draft.audience, onChange: set('audience') })),
            h(Field, { label: t('tone') }, h('input', { style: s.input, value: draft.tone, onChange: set('tone') })),
            h(Field, { label: t('targetSeconds') }, h('input', { style: { ...s.input, width: '100px' }, type: 'number', value: draft.targetSeconds, onChange: set('targetSeconds') })),
          ),
          h(Field, { label: t('sellingPoints') }, h('textarea', { style: s.textarea, value: draft.sellingPoints, onChange: set('sellingPoints') })),
          h(Field, { label: t('forbidden') }, h('input', { style: s.input, value: draft.forbidden, onChange: set('forbidden') })),
          h(Field, { label: t('extra') }, h('textarea', { style: s.textarea, value: draft.extra, onChange: set('extra') })),
          h(Field, { label: t('projectMode') },
            h('select', { style: s.input, value: draft.projectMode, onChange: set('projectMode') },
              h('option', { value: 'promotion' }, t('projectPromotion')),
              h('option', { value: 'story' }, t('projectStory')),
            ),
          ),
          h(Field, { label: t('audioMode') },
            h('select', { style: s.input, value: draft.audioMode, onChange: set('audioMode') },
              h('option', { value: 'dialogue' }, t('dialogueAudio')),
              h('option', { value: 'no-dialogue' }, t('noDialogueAudio')),
            ),
          ),
          h('div', { style: s.row },
            h('button', {
              type: 'button', style: { ...s.btnGhost, ...(busy ? s.disabled : {}) }, disabled: busy,
              onClick: () => onSave({
                title: draft.title,
                targetSeconds: Number(draft.targetSeconds) || project.targetSeconds,
                brief: {
                  productName: draft.productName, category: draft.category, audience: draft.audience,
                  sellingPoints: draft.sellingPoints.split('\n').map((line) => line.trim()).filter(Boolean),
                  tone: draft.tone, priceBand: draft.priceBand,
                  forbidden: draft.forbidden.split(/[,，、]/).map((word) => word.trim()).filter(Boolean),
                  extra: draft.extra,
                  audioMode: draft.audioMode,
                  projectMode: draft.projectMode,
                },
              }),
            }, t('save')),
          ),
          h('hr', { style: s.hr }),
        ) : null,
        h('div', { style: s.row },
          h('span', { style: s.sectionTitle }, t('hotspots')),
          h('span', { style: s.meta }, hotspots.length > 0 ? `${hotspots.length}` : ''),
          h('div', { style: s.spacer }),
          h('button', { type: 'button', style: { ...s.btnGhost, ...(busy ? s.disabled : {}) }, disabled: busy, onClick: onHotspots },
            busy ? t('grabbing') : t('grab')),
        ),
        hotspots.length === 0
          ? h('p', { style: s.meta }, t('noHotspot'))
          : h('div', { style: { ...s.row, gap: '6px' } }, hotspots.map((item, index) =>
            h('span', { key: `${item.title}-${index}`, style: s.chip, title: item.snippet || item.url || '' },
              h('span', { style: { maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title),
            ),
          )),
        h('p', { style: s.meta }, t('hotspotHint')),
        h('div', { style: s.row },
          h('input', { style: { ...s.input, flex: 1, minWidth: '120px' }, value: hotspot, placeholder: t('addHotspot'), onChange: (event) => setHotspot(event.target.value) }),
          h('button', {
            type: 'button', style: s.btnGhost,
            onClick: () => {
              if (!hotspot.trim()) return;
              onAddHotspot(hotspot.trim());
              setHotspot('');
            },
          }, t('add')),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // 参考爆款（拉片）
    // ---------------------------------------------------------------------
    function ReferenceCard({ t, project, config, onRun }) {
      const [advanced, setAdvanced] = useState(false);
      const [url, setUrl] = useState('');
      const [local, setLocal] = useState('');
      const ref = project.reference ?? null;
      const busy = Boolean(ref && ['running', 'analyzing', 'fetching', 'framing', 'asr', 'rea', 'reviewing'].includes(ref.status));
      const canRun = Boolean(url.trim() || local.trim()) && !busy;
      return h('div', { style: s.card },
        h('div', { style: s.row },
          h('span', { style: s.sectionTitle }, t('refTitle')),
          ref?.summary
            ? h('span', { style: s.meta }, `${ref.summary.title || ''}${ref.summary.uploader ? ` · ${ref.summary.uploader}` : ''} · ${fill(t('unitShots'), { n: ref.shotCount ?? ref.summary.shotCount ?? '?' })} · ${ref.duration ?? ref.summary.duration ?? '?'}s`)
            : null,
          h('div', { style: s.spacer }),
          ref?.status
            ? Badge({
              tone: ref.status === 'done' ? 'good' : ref.status === 'failed' ? 'bad' : 'warn',
              children: busy ? `${t('refRunning')} · ${ref.stage ?? ''}` : ref.status === 'done' ? t('refDone') : ref.status === 'failed' ? t('refFailed') : ref.status,
            })
            : null,
        ),
        h('p', { style: s.meta }, t('refHint')),
        h('div', { style: s.row },
          h('input', {
            style: { ...s.input, flex: 1, minWidth: '160px' },
            value: url,
            placeholder: t('refPlaceholder'),
            onChange: (event) => setUrl(event.target.value),
          }),
          h('input', {
            style: { ...s.input, width: '220px' },
            value: local,
            placeholder: t('refLocal'),
            onChange: (event) => setLocal(event.target.value),
          }),
          h('button', {
            type: 'button',
            style: { ...s.btnGhost, ...(canRun ? {} : s.disabled) },
            disabled: !canRun,
            onClick: () => onRun({ url: url.trim(), localPath: local.trim(), advanced }),
          }, busy ? t('refRunning') : t('refRun')),
        ),
        config?.hasRea ? h('label', { style: s.row },
          h('input', { type: 'checkbox', checked: advanced, disabled: busy, onChange: (event) => setAdvanced(event.target.checked) }),
          h('span', { style: s.label }, t('advancedReference')),
        ) : null,
        ref?.error ? h('p', { style: s.err }, `${t('refFailed')}：${ref.error}`) : null,
        ref?.report
          ? h('details', null,
            h('summary', { style: { ...s.meta, cursor: 'pointer' } }, t('refReport')),
            h('pre', { style: { ...s.pre, maxHeight: '320px' } }, ref.report),
          )
          : null,
      );
    }

    // ---------------------------------------------------------------------
    // 拉片台（原「爆款复刻」的独立面板：不依赖创意项目）
    // ---------------------------------------------------------------------
    function ReferenceStudio({ t, onOpenProject }) {
      const [items, setItems] = useState([]);
      const [id, setId] = useState('');
      const [ev, setEv] = useState(null);
      const [url, setUrl] = useState('');
      const [local, setLocal] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [productName, setProductName] = useState('');
      const [notice, setNotice] = useState('');
      const [collapsed, setCollapsed] = useState(false);
      const alive = useRef(true);

      useEffect(() => () => {
        alive.current = false;
      }, []);

      const open = useCallback(async (nextId) => {
        if (!nextId) return;
        setId(nextId);
        const evidence = await call('referenceEvidence', { id: nextId });
        if (alive.current) setEv(evidence);
      }, []);

      const loadList = useCallback(async (prefer) => {
        const result = await call('referenceList');
        if (!alive.current) return;
        setItems(result.items ?? []);
        const keep = prefer || id || result.items?.[0]?.id || '';
        if (keep) await open(keep);
        else setEv(null);
      }, [id, open]);

      useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            await loadList('');
          } catch (err) {
            if (!cancelled) setError(err.message);
          }
        })();
        return () => { cancelled = true; };
      }, [loadList]);

      // 拉片是长任务：跑着的时候每 4 秒刷一次证据包。
      useEffect(() => {
        if (!id) return undefined;
        const status = ev?.status ?? '';
        if (!['running', 'analyzing', 'fetching', 'framing', 'asr', 'rea', 'reviewing'].includes(status)) return undefined;
        let cancelled = false;
        const timer = setTimeout(async () => {
          try {
            const evidence = await call('referenceEvidence', { id });
            if (!cancelled && alive.current) setEv(evidence);
            if (!cancelled && alive.current && evidence.status === 'done') await loadList(id);
          } catch {
            /* 下一轮再说 */
          }
        }, 4000);
        return () => { cancelled = true; clearTimeout(timer); };
      }, [id, ev?.status, ev?.at, loadList]);

      const guard = async (fn) => {
        setError('');
        setBusy(true);
        try {
          await fn();
        } catch (err) {
          if (alive.current) setError(err.message);
        } finally {
          if (alive.current) setBusy(false);
        }
      };

      const start = () => guard(async () => {
        if (!url.trim() && !local.trim()) return;
        const created = await call('referenceStudio', { url: url.trim(), localPath: local.trim() });
        setUrl('');
        setLocal('');
        setNotice(t('refRunning'));
        await loadList(created.id);
        await open(created.id);
      });

      const replicate = () => guard(async () => {
        if (!id) return;
        setNotice(t('refRunning'));
        await call('referenceReplicate', { id });
        setNotice('');
        await open(id);
      });

      const toProject = () => guard(async () => {
        if (!id || !productName.trim()) return;
        const created = await call('referenceToProject', { id, productName: productName.trim() });
        setNotice(fill(t('noticeProjectOpened'), { id: created.id }));
        onOpenProject(created.id);
      });

      const running = ['running', 'analyzing', 'fetching', 'framing', 'asr', 'rea', 'reviewing'].includes(ev?.status ?? '');
      const summary = ev?.summary ?? null;

      return h('div', { style: s.card },
        h('div', { style: s.row },
          h('span', { style: s.sectionTitle }, t('refStudio')),
          h('div', { style: s.spacer }),
          h('button', { type: 'button', style: s.btnGhost, onClick: () => loadList(id) }, t('refresh')),
          h('button', { type: 'button', style: s.btnIcon, onClick: () => setCollapsed((prev) => !prev) }, collapsed ? '+' : '−'),
        ),
        collapsed ? null : h(React.Fragment, null,
          h('p', { style: s.meta }, t('refStudioHint')),
          h('div', { style: s.row },
            h('input', {
              style: { ...s.input, flex: 1, minWidth: '160px' },
              value: url,
              placeholder: t('refPlaceholder'),
              onChange: (event) => setUrl(event.target.value),
            }),
            h('input', {
              style: { ...s.input, width: '200px' },
              value: local,
              placeholder: t('refLocal'),
              onChange: (event) => setLocal(event.target.value),
            }),
            h('button', {
              type: 'button',
              style: { ...s.btnGhost, ...(busy || (!url.trim() && !local.trim()) ? s.disabled : {}) },
              disabled: busy || (!url.trim() && !local.trim()),
              onClick: start,
            }, busy ? t('refRunning') : t('refStart')),
          ),
          h('div', { style: s.row },
            h('span', { style: s.label }, t('refSelect')),
            items.length === 0
              ? h('span', { style: s.meta }, t('refEmpty'))
              : h('select', {
                style: { ...s.input, flex: 1, minWidth: '160px', maxWidth: '420px' },
                value: id,
                onChange: async (event) => { try { await open(event.target.value); } catch (err) { setError(err.message); } },
              }, items.map((item) => h('option', { key: item.id, value: item.id }, `${item.title}${item.updatedAt ? ` · ${timeText(item.updatedAt)}` : ''}`))),
          ),
          error ? h('p', { style: s.err }, error) : null,
          notice ? h('p', { style: s.ok }, notice) : null,
          ev
            ? h(React.Fragment, null,
              h('div', { style: s.row },
                summary ? h('span', { style: s.meta }, `${summary.title || '—'}${summary.uploader ? ` · ${summary.uploader}` : ''} · ${fill(t('unitShots'), { n: summary.shotCount ?? ev.frames?.length ?? '?' })} · ${summary.duration ?? '?'}s`) : null,
                Badge({
                  tone: running ? 'warn' : ev.status === 'failed' ? 'bad' : ev.status === 'done' ? 'good' : 'dim',
                  children: running ? `${t('refRunning')} · ${ev.stage ?? ''}` : ev.status === 'done' ? t('refDone') : ev.status === 'failed' ? t('refFailed') : ev.status,
                }),
              ),
              ev.error ? h('p', { style: s.err }, ev.error) : null,
              ev.status === 'done' ? h(React.Fragment, null,
                ev.contactSheet
                  ? h('div', { style: { ...s.card, ...s.cardTight } },
                    h('span', { style: s.sectionTitle }, t('refContact')),
                    h('img', {
                      src: `${FILE}?id=${encodeURIComponent(ev.id)}&kind=ref&name=contact-sheet.jpg`,
                      alt: t('refContact'),
                      style: { width: '100%', borderRadius: RADIUS_MD },
                    }),
                  )
                  : null,
                (ev.frames ?? []).length > 0
                  ? h('div', { style: { ...s.card, ...s.cardTight } },
                    h('span', { style: s.sectionTitle }, `${t('refFrames')}（${ev.frames.length}）`),
                    h('div', { style: { display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '4px' } },
                      ...ev.frames.slice(0, 16).map((name) => h('img', {
                        key: name,
                        src: `${FILE}?id=${encodeURIComponent(ev.id)}&kind=ref&name=${encodeURIComponent(`frames/${name}`)}`,
                        alt: name,
                        style: { width: '76px', height: '132px', objectFit: 'cover', borderRadius: RADIUS_MD, flex: 'none' },
                      })),
                    ),
                  )
                  : null,
                ev.report ? h('details', null,
                  h('summary', { style: { ...s.meta, cursor: 'pointer' } }, t('refRep')),
                  h('pre', { style: { ...s.pre, maxHeight: '320px' } }, ev.report),
                ) : null,
                ev.rea?.ok
                  ? h('div', { style: { ...s.card, ...s.cardTight } },
                    h('div', { style: s.row },
                      h('span', { style: s.sectionTitle }, t('reaTitle')),
                      Badge({ tone: 'good', children: 'rea-video' }),
                      h('div', { style: s.spacer }),
                      h('button', {
                        type: 'button', style: s.btnGhost,
                        onClick: () => navigator.clipboard?.writeText(ev.rea.reportHtml || ev.rea.out || '').catch(() => {}),
                      }, t('copy')),
                    ),
                    h('p', { style: s.meta }, t('reaHint')),
                    ev.rea.vision
                      ? h('p', { style: s.meta }, `${t('reaVision')}：${fill(t('reaVisionLine'), { a: ev.rea.vision.reviewed, b: ev.rea.vision.total })}`)
                      : null,
                    ev.rea.visionError ? h('p', { style: s.warnText }, `${t('reaVisionFailed')}：${ev.rea.visionError}`) : null,
                    h('pre', { style: { ...s.pre, maxHeight: '240px' } }, ev.rea.summary || ''),
                    ev.rea.timeline
                      ? h('details', null,
                        h('summary', { style: { ...s.meta, cursor: 'pointer' } }, t('reaTimeline')),
                        h('pre', { style: { ...s.pre, maxHeight: '320px' } }, ev.rea.timeline),
                      )
                      : null,
                    ev.rea.videoMd
                      ? h('details', null,
                        h('summary', { style: { ...s.meta, cursor: 'pointer' } }, t('reaVideoMd')),
                        h('pre', { style: { ...s.pre, maxHeight: '320px' } }, ev.rea.videoMd),
                      )
                      : null,
                    ev.rea.reportHtml ? h('span', { style: s.mono }, ev.rea.reportHtml) : null,
                  )
                  : ev.reaError ? h('p', { style: s.warnText }, `${t('reaFailed')}：${ev.reaError}`) : null,
                ev.shotTable ? h('details', null,
                  h('summary', { style: { ...s.meta, cursor: 'pointer' } }, t('refTable')),
                  h('pre', { style: s.pre }, ev.shotTable),
                ) : null,
                ev.transcriptLines ? h('details', null,
                  h('summary', { style: { ...s.meta, cursor: 'pointer' } }, t('refTranscript')),
                  h('pre', { style: s.pre }, ev.transcriptLines),
                ) : null,
                h('div', { style: s.row },
                  h('button', { type: 'button', style: { ...s.btnGhost, ...(busy ? s.disabled : {}) }, disabled: busy, onClick: replicate }, busy ? t('refRunning') : t('refReplicate')),
                  ev.replicateSummary
                    ? Badge({ tone: ev.replicateSummary.gate?.ok ? 'good' : 'warn', children: ev.replicateSummary.gate?.ok ? t('refGateOk') : fill(t('refGateFail'), { n: (ev.replicateSummary.gate?.failures ?? []).length }) })
                    : null,
                  ev.replicateSummary ? h('span', { style: s.meta }, fill(t('shotsSegments'), { n: ev.replicateSummary.shots, m: ev.replicateSummary.segments })) : null,
                ),
                ev.replicate
                  ? h('details', null,
                    h('summary', { style: { ...s.meta, cursor: 'pointer' } }, t('refReplicated')),
                    h('pre', { style: { ...s.pre, maxHeight: '320px' } }, JSON.stringify(ev.replicate, null, 2)),
                  )
                  : null,
                h('div', { style: s.row },
                  h('input', {
                    style: { ...s.input, width: '180px' },
                    value: productName,
                    placeholder: t('refProduct'),
                    onChange: (event) => setProductName(event.target.value),
                  }),
                  h('button', {
                    type: 'button',
                    style: { ...s.btnGhost, ...(busy || !productName.trim() ? s.disabled : {}) },
                    disabled: busy || !productName.trim(),
                    onClick: toProject,
                  }, t('refToProject')),
                  h('div', { style: s.spacer }),
                  h('button', {
                    type: 'button',
                    style: { ...s.btnGhost, color: 'var(--dsw-alias-state-error-primary)' },
                    onClick: () => {
                      if (!window.confirm(t('refDeleteConfirm'))) return;
                      void guard(async () => {
                        await call('remove', { id: ev.id });
                        setEv(null);
                        setId('');
                        setNotice(t('refDeleted'));
                        await loadList('');
                      });
                    },
                  }, t('refDelete')),
                ),
                h('details', null,
                  h('summary', { style: { ...s.meta, cursor: 'pointer' } }, t('refVideo')),
                  h('video', {
                    style: { ...s.video, maxHeight: '320px' },
                    src: `${FILE}?id=${encodeURIComponent(ev.id)}&kind=ref&name=video.mp4`,
                    controls: true,
                    preload: 'metadata',
                  }),
                ),
              ) : null,
            )
            : null,
        ),
      );
    }


    function IdeaView({ t, artifact, project, onChoose, onRerun }) {
      const ideas = artifact?.ideas ?? [];
      const recommended = artifact?.recommended?.id;
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('div', { style: s.grid }, ideas.map((idea, index) => {
          const chosen = project.chosenIdea === index || (project.chosenIdea === null && idea.id === recommended);
          return h('div', { key: idea.id ?? index, style: { ...s.card, ...s.cardTight, borderColor: chosen ? 'var(--dsw-alias-state-business-primary)' : undefined } },
            h('div', { style: s.row },
              h('strong', { style: { fontSize: '13px' } }, idea.title),
              idea.id === recommended ? Badge({ tone: 'info', children: t('recommended') }) : null,
              chosen ? Badge({ tone: 'good', children: t('chosen') }) : null,
            ),
            h('div', { style: s.kv },
              h('span', { style: s.label }, t('hook')),
              h('span', null, idea.hook),
              h('span', { style: s.label }, t('labelOneLiner')),
              h('span', null, idea.oneLiner),
              h('span', { style: s.label }, t('whyNow')),
              h('span', null, idea.whyNow),
              h('span', { style: s.label }, t('risk')),
              h('span', null, idea.risk),
            ),
            h('div', { style: s.row },
              h('span', { style: s.meta }, fill(t('scoreLine'), { hook: idea.score?.hook ?? '?', fit: idea.score?.fit ?? '?', feasible: idea.score?.feasible ?? '?' })),
            ),
            h('div', { style: { ...s.row, marginTop: '2px' } },
              h('button', { type: 'button', style: s.btnGhost, onClick: () => onChoose(index) }, t('choose')),
              h('button', { type: 'button', style: s.btnGhost, onClick: () => { onChoose(index); onRerun(); } }, t('rerunStory')),
            ),
          );
        })),
        h('p', { style: s.meta }, artifact?.recommended?.reason ?? ''),
      );
    }

    function StoryView({ t, artifact }) {
      if (!artifact) return h('p', { style: s.meta }, t('noArtifact'));
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('strong', null, artifact.title),
        h('p', { style: { margin: 0 } }, artifact.logline),
        h('div', { style: s.row }, (artifact.characters ?? []).map((character, index) =>
          h('span', { key: index, style: s.chip }, `${character.name}·${character.role ?? ''}`))),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          (artifact.acts ?? []).map((act, index) => h('div', { key: index, style: { ...s.card, ...s.cardTight } },
            h('div', { style: s.row }, h('strong', { style: { fontSize: '12px' } }, act.name), h('span', { style: s.meta }, act.goal)),
            ...(act.beats ?? []).map((beat, beatIndex) => h('div', { key: beatIndex, style: s.meta },
              `${beat.t ?? ''}s · ${beat.action}${beat.emotion ? `（${beat.emotion}）` : ''} · ${beat.durationSec ?? '?'}s`)),
          )),
        ),
        h('p', { style: { margin: 0 } }, fill(t('labelEnding'), { text: artifact.ending ?? '—' })),
      );
    }

    function StoryboardView({ t, artifact, gate, onEdit }) {
      if (!artifact) return h('p', { style: s.meta }, t('noArtifact'));
      const [editingId, setEditingId] = useState('');
      const [draft, setDraft] = useState({ prompt: '', durationSec: 0, line: '' });
      const [notice, setNotice] = useState('');
      const [busy, setBusy] = useState(false);
      const shots = artifact.shots ?? [];
      const segments = [];
      let cursor = 0;
      const timecode = (seconds) => {
        const minutes = Math.floor(seconds / 60);
        const remainder = (seconds % 60).toFixed(1).padStart(4, '0');
        return `${String(minutes).padStart(2, '0')}:${remainder}`;
      };
      for (const shot of shots) {
        const key = shot.segment ?? shot.scene ?? 'seg';
        let bucket = segments.find((item) => item.id === key);
        if (!bucket) {
          bucket = { id: key, shots: [], seconds: 0 };
          segments.push(bucket);
        }
        const duration = Number(shot.durationSec) || 0;
        bucket.shots.push({ shot, start: cursor, end: cursor + duration });
        bucket.seconds += duration;
        cursor += duration;
      }
      const lineBeatOf = (shot) => (artifact.beats ?? []).find((beat) => (shot.claims ?? []).includes(beat.id) && beat.kind === 'line') ?? null;
      const begin = (shot) => {
        const beat = lineBeatOf(shot);
        setDraft({ prompt: shot.prompt ?? '', durationSec: Number(shot.durationSec) || 0, line: beat?.text ?? '' });
        setEditingId(shot.id);
        setNotice('');
      };
      const save = async (shot) => {
        if (!onEdit) return;
        setBusy(true);
        try {
          const beat = lineBeatOf(shot);
          const beatPatch = beat && draft.line.trim() !== String(beat.text ?? '').trim() ? { id: beat.id, text: draft.line } : null;
          await onEdit({ shot: { id: shot.id, prompt: draft.prompt, durationSec: Number(draft.durationSec) || shot.durationSec }, beat: beatPatch });
          setEditingId('');
          setNotice(t('shotEditSaved'));
        } catch (error) {
          setNotice(fill(t('noticeSaveFailed'), { msg: error.message ?? error }));
        } finally {
          setBusy(false);
        }
      };
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { style: s.row },
          h('strong', null, artifact.title ?? ''),
          h('span', { style: s.meta }, fill(t('storyboardMeta'), { d: artifact.targetSeconds ?? '?', n: shots.length, m: segments.length })),
          gate?.ok ? Badge({ tone: 'good', children: t('gateOk') }) : gate ? Badge({ tone: 'bad', children: fill(t('gateFail'), { n: (gate.failures ?? []).length }) }) : null,
        ),
        notice ? h('p', { style: { ...s.meta, fontSize: '12px' } }, notice) : null,
        segments.length > 0 ? h('div', { role: 'group', 'aria-label': t('shotTimeline') },
          h('div', { style: { display: 'flex', gap: '4px', minHeight: '24px' } },
            ...segments.map((segment, index) => h('div', {
              key: segment.id,
              title: `${segment.id} · ${segment.seconds.toFixed(1)}s`,
              style: {
                flex: segment.seconds || 1, minWidth: '8px', borderRadius: '4px',
                background: index % 2 ? 'var(--dsw-alias-bg-layer-3)' : 'var(--dsw-alias-bg-layer-2)',
                borderTop: '2px solid var(--dsw-alias-state-business-primary)',
              },
            })),
          ),
          h('div', { style: { ...s.row, justifyContent: 'space-between' } },
            h('span', { style: s.mono }, timecode(0)),
            h('span', { style: s.mono }, timecode(cursor)),
          ),
        ) : null,
        ...segments.map((segment) => h('div', { key: segment.id, style: { ...s.card, ...s.cardTight } },
          h('div', { style: s.row },
            h('strong', { style: { fontSize: '12px' } }, `${t('segment')} ${segment.id}`),
            h('span', { style: s.meta }, `${Math.round(segment.seconds * 10) / 10}s · ${segment.shots.length} ${t('shots')}`),
          ),
          ...segment.shots.map(({ shot, start, end }) => h('div', { key: shot.id, style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
            h('div', { style: s.row },
              h('span', { style: s.meta }, `${timecode(start)}–${timecode(end)} · ${shot.id} · ${(shot.inFrame ?? []).map((person) => person.who).join('、')}`),
              h('div', { style: s.spacer }),
              onEdit && editingId !== shot.id
                ? h('button', { type: 'button', style: s.btnGhost, onClick: () => begin(shot) }, t('editShot'))
                : null,
            ),
            editingId === shot.id
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', padding: '4px 0' } },
                h('span', { style: s.label }, t('shotPrompt')),
                h('textarea', {
                  style: { ...s.textarea, minHeight: '78px' },
                  value: draft.prompt,
                  onChange: (event) => setDraft({ ...draft, prompt: event.target.value }),
                }),
                h('div', { style: s.row },
                  h('span', { style: s.label }, t('shotSeconds')),
                  h('input', {
                    style: { ...s.input, width: '78px' },
                    type: 'number', step: '0.5', min: '0.5',
                    value: draft.durationSec,
                    onChange: (event) => setDraft({ ...draft, durationSec: event.target.value }),
                  }),
                ),
                lineBeatOf(shot)
                  ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                    h('span', { style: s.label }, t('shotLine')),
                    h('input', {
                      style: s.input,
                      value: draft.line,
                      onChange: (event) => setDraft({ ...draft, line: event.target.value }),
                    }),
                  )
                  : null,
                h('div', { style: s.row },
                  h('button', {
                    type: 'button',
                    style: { ...s.btn, ...(busy ? s.disabled : {}) },
                    disabled: busy,
                    onClick: () => void save(shot),
                  }, t('saveShot')),
                  h('button', { type: 'button', style: s.btnGhost, onClick: () => setEditingId('') }, t('cancelEdit')),
                ),
              )
              : [
                h('span', { key: 'a', style: s.mono }, shot.action),
                h('details', { key: 'p' },
                  h('summary', { style: { ...s.meta, cursor: 'pointer' } }, t('labelPrompt')),
                  h('pre', { style: s.pre }, shot.prompt ?? ''),
                ),
              ],
          )),
        )),
      );
    }

    function CharactersView({ t, projectId, artifact, style }) {
      if (!artifact) return h('p', { style: s.meta }, t('noArtifact'));
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        artifact.style ? h('p', { style: { margin: 0 } }, artifact.style) : null,
        h('div', { style: s.grid }, (artifact.characters ?? []).map((character) => h('div', { key: character.name, style: { ...s.card, ...s.cardTight } },
          h('div', { style: s.row },
            h('strong', { style: { fontSize: '13px' } }, character.name),
            h('span', { style: s.meta }, character.role ?? ''),
          ),
          character.portrait?.file
            ? h('img', {
              src: `${FILE}?id=${encodeURIComponent(projectId)}&kind=portrait&name=${encodeURIComponent(character.name)}`,
              alt: character.name,
              style: { width: '100%', borderRadius: RADIUS_MD, background: 'var(--dsw-alias-bg-layer-3)' },
            })
            : character.portrait?.error ? h('p', { style: s.warnText }, `${t('portraitFailed')}：${character.portrait.error}`) : null,
          h('div', { style: s.kv }, (style?.dimensions ?? []).map((dimension) => h(React.Fragment, { key: dimension.key },
            h('span', { style: s.label }, dimension.label),
            h('span', null, character.dims?.[dimension.key] ?? ''),
          ))),
        ))),
      );
    }

    function VoiceView({ t, projectId, artifact, catalog, audio }) {
      if (!artifact) return h('p', { style: s.meta }, t('noArtifact'));
      const nameOf = (id) => (catalog ?? []).find((voice) => voice.id === id)?.name ?? id;
      const voiced = new Map((audio?.lines ?? []).map((row) => [String(row.beatId), row]));
      const overflows = audio?.warnings ?? [];
      const hard = audio?.hard ?? [];
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        audio?.skipped && audio?.error
          ? h('p', { style: s.warnText }, fill(t('voiceAudioSkipped'), { reason: audio.error }))
          : (audio?.lines?.length
            ? h('p', { style: s.meta },
              fill(t('voiceAudioReady'), { n: audio.lines.length, engine: audio.engine ?? 'tts' }),
              overflows.length ? ` · ${fill(t('voiceAudioOverflow'), { n: overflows.length })}` : '')
            : null),
        hard.length
          ? h('p', { style: s.warnText }, fill(t('voiceAudioHard'), {
            n: hard.length,
            list: hard.map((row) => `${row.beatId} ${row.seconds}s / ${row.slotSec}s`).join('；'),
          }))
          : null,
        h('div', { style: s.row }, (artifact.characters ?? []).map((row, index) =>
          h('span', { key: index, style: s.chip }, `${row.name} · ${nameOf(row.voiceId)} · ×${row.rate ?? 1}`))),
        artifact.narration?.enabled
          ? h('p', { style: s.meta }, fill(t('labelNarration'), { voice: nameOf(artifact.narration.voiceId), emotion: artifact.narration.emotion ?? '' }))
          : null,
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          (artifact.lines ?? []).map((line, index) => h('div', { key: index, style: s.row },
            h('span', { style: s.meta }, line.beatId),
            h('span', { style: { fontWeight: 500 } }, `${line.speaker}：`),
            h('span', { style: { flex: 1, minWidth: 0 } }, line.text),
            voiced.has(String(line.beatId))
              ? h('audio', {
                src: `${FILE}?id=${encodeURIComponent(projectId)}&kind=voice&beatId=${encodeURIComponent(line.beatId)}`,
                controls: true, preload: 'none', 'aria-label': t('voiceListen'),
                style: { height: '26px', maxWidth: '200px' },
              })
              : null,
            h('span', { style: s.meta }, `${nameOf(line.voiceId)} · ${line.emotion ?? ''}`),
          )),
        ),
        h('p', { style: s.meta }, `${t('bgm')}：${artifact.bgm?.mood ?? ''} ${artifact.bgm?.recommended ?? ''}${artifact.bgm?.bpm ? ` · ${artifact.bgm.bpm}bpm` : ''}`),
      );
    }

    function RenderView({ t, projectId, render, onRerender, running }) {
      const tasks = render?.tasks ?? [];
      if (tasks.length === 0) return h('p', { style: s.meta }, t('noArtifact'));
      const labels = {
        queued: t('renderQueued'), pending: t('renderQueued'), completed: t('renderCompleted'),
        failed: t('status_failed'), cancelled: t('renderCancelled'),
        processing: t('running'), running: t('running'), in_progress: t('running'),
      };
      const completed = tasks.filter((task) => task.status === 'completed' && task.file).length;
      return h('div', { style: { ...s.grid, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))' } },
        h('div', { style: { ...s.row, gridColumn: '1 / -1' } },
          h('progress', { 'aria-label': t('segment'), max: tasks.length, value: completed, style: { flex: 1, accentColor: 'var(--dsw-alias-state-business-primary)' } }),
          h('span', { style: s.meta }, `${completed} / ${tasks.length}`),
        ),
        ...tasks.map((task) => h('div', { key: task.segmentId, style: { ...s.card, ...s.cardTight } },
          h('div', { style: s.row },
            h('strong', { style: { fontSize: '12px' } }, task.segmentId),
            Badge({ tone: TONE[task.status === 'completed' ? 'done' : task.status === 'failed' ? 'failed' : 'running'] ?? 'dim', children: labels[task.status] ?? task.status }),
            h('span', { style: s.meta }, `${task.duration ?? task.seconds ?? '?'}s${task.providerLabel ? ` · ${task.providerLabel}` : ''}`),
            task.referenceCount == null ? null : h('span', { style: s.meta },
              task.referenceCount > 0 ? fill(t('renderReferenceCount'), { n: task.referenceCount }) : t('renderTextOnly')),
            task.progress ? h('span', { style: s.meta }, `${task.progress}%`) : null,
            onRerender && !running && tasks.every((other) => other.segmentId === task.segmentId || other.status === 'completed' && other.file)
              ? h('button', { type: 'button', style: s.btnGhost, onClick: () => onRerender(task.segmentId) }, t('retakeSegment'))
              : null,
          ),
          task.error ? h('p', { style: s.err }, task.error) : null,
          task.file
            ? h('video', { style: { ...s.video, width: 'auto', height: '280px', maxWidth: '100%', alignSelf: 'center' }, src: `${FILE}?id=${encodeURIComponent(projectId)}&kind=segment&segmentId=${encodeURIComponent(task.segmentId)}`, controls: true, preload: 'metadata' })
            : null,
        )),
      );
    }

    function EditView({ t, projectId, edl, project, config }) {
      const order = edl?.order ?? [];
      const visual = project.stages?.edit?.visual ?? null;
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        project.finalFile
          ? h('div', { style: s.card },
            h('div', { style: s.row },
              h('span', { style: s.sectionTitle }, t('final')),
              h('span', { style: s.meta }, project.stages?.edit?.duration ? `${project.stages.edit.duration}s` : ''),
              h('div', { style: s.spacer }),
              h('button', {
                type: 'button', style: s.btnGhost,
                onClick: () => navigator.clipboard?.writeText(project.finalFile).catch(() => {}),
              }, t('copy')),
            ),
            h('video', { style: s.video, src: `${FILE}?id=${encodeURIComponent(projectId)}&kind=final`, controls: true, preload: 'metadata' }),
            h('span', { style: s.mono }, project.finalFile),
          )
          : h('p', { style: s.meta }, t('noFinal')),
        visual
          ? h('div', { style: { ...s.card, ...s.cardTight } },
            h('div', { style: s.row },
              h('span', { style: s.sectionTitle }, t('visualCheck')),
              Badge({
                tone: visual.error ? 'warn' : visual.pass ? 'good' : 'bad',
                children: visual.error ? t('visualUnavailable') : visual.pass ? t('visualPass') : fill(t('visualIssues'), { n: (visual.issues ?? []).length }),
              }),
              visual.error ? h('span', { style: s.meta }, visual.error) : null,
            ),
            visual.summary ? h('p', { style: visual.pass ? s.meta : s.warnText }, visual.summary) : null,
            ...(visual.issues ?? []).slice(0, 6).map((issue, index) => h('p', { key: index, style: issue.severity === 'blocker' ? s.err : s.warnText },
              `[${issue.severity}] ${issue.where ? `${issue.where}：` : ''}${issue.problem}${issue.fix ? ` → ${issue.fix}` : ''}`)),
            h('div', { style: { display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '4px' } },
              ...['check-12.jpg', 'check-50.jpg', 'check-88.jpg'].map((name) => h('img', {
                key: name,
                src: `${FILE}?id=${encodeURIComponent(projectId)}&kind=check&name=${name}`,
                alt: name,
                style: { width: '120px', borderRadius: RADIUS_MD, flex: 'none', background: 'var(--dsw-alias-bg-layer-3)' },
              }))),
          )
          : null,
        edl
          ? h('div', { style: { ...s.card, ...s.cardTight } },
            h('div', { style: s.row }, h('span', { style: s.sectionTitle }, t('edl'))),
            ...order.map((entry, index) => h('div', { key: `${entry.segmentId}-${index}`, style: s.row },
              h('span', { style: s.num }, String(index + 1)),
              h('strong', { style: { fontSize: '12px' } }, entry.segmentId),
              h('span', { style: s.meta }, `${t('transition')} ${entry.transition ?? 'cut'}${entry.trimStart ? ` · ${fill(t('trimHead'), { n: entry.trimStart })}` : ''}${entry.trimEnd ? ` · ${fill(t('trimTail'), { n: entry.trimEnd })}` : ''}`),
              h('span', { style: { ...s.meta, flex: 1, minWidth: '120px' } }, entry.reason ?? ''),
            )),
            h('div', { style: s.row },
              h('span', { style: s.meta }, `${t('bgm')}：${edl.audio?.bgm ?? '—'} · ${edl.audio?.gainDb ?? ''}dB · ${edl.audio?.lufs ?? ''} LUFS`),
            ),
            edl.packaging
              ? h('div', { style: { ...s.card, ...s.cardTight } },
                h('span', { style: s.sectionTitle }, t('publish')),
                h('strong', null, edl.packaging.title ?? ''),
                h('p', { style: { margin: 0 } }, edl.packaging.description ?? ''),
                h('p', { style: s.meta }, (edl.packaging.hashtags ?? []).join(' ')),
              )
              : null,
            edl.rationale ? h('p', { style: s.meta }, edl.rationale) : null,
          )
          : null,
      );
    }

    const reviewStyles = {
      layout: {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
        gap: '16px', alignItems: 'start',
      },
      title: { fontSize: '16px', lineHeight: '24px', fontWeight: 600, margin: 0 },
      player: {
        display: 'block', width: 'auto', height: 'clamp(220px, 46vh, 480px)', maxWidth: '100%',
        margin: '0 auto', borderRadius: RADIUS_MD, background: '#111',
      },
      track: { display: 'flex', gap: '4px', overflowX: 'auto', padding: '2px' },
      comparison: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: '12px' },
    };

    function reviewTime(seconds) {
      const tenths = Math.round(Math.max(0, Number(seconds) || 0) * 10);
      return `${String(Math.floor(tenths / 600)).padStart(2, '0')}:${(tenths % 600 / 10).toFixed(1).padStart(4, '0')}`;
    }

    function ReviewDesk({ t, data, running, onRun, onRerender, onChoose, onDecide }) {
      const { project, plan = [], timeline = [], versions = {}, render, artifacts = {} } = data;
      const edit = project.stages?.edit ?? {};
      const tasks = render?.tasks ?? [];
      const player = useRef(null);
      const left = useRef(null);
      const right = useRef(null);
      const pendingSeek = useRef(0);
      const [selectedId, setSelectedId] = useState(null);
      const [alternateId, setAlternateId] = useState(null);
      const [activeIssue, setActiveIssue] = useState(null);
      const [sourceTime, setSourceTime] = useState(0);
      const [retakeDraft, setRetakeDraft] = useState({});
      const [comparisonDuration, setComparisonDuration] = useState({});
      const selection = plan.find((segment) => segment.id === selectedId) ?? plan[0];
      const task = tasks.find((item) => item.segmentId === selection?.id);
      const takes = versions[selection?.id] ?? [];
      const current = takes.find((item) => item.current);
      const other = takes.find((item) => !item.current && item.id === alternateId) ?? takes.find((item) => !item.current);
      const cutUrl = `${FILE}?id=${encodeURIComponent(project.id)}&kind=final&v=${encodeURIComponent(edit.outputAt ?? edit.review?.at ?? '')}`;
      const ready = plan.length > 0 && ['storyboard', 'characters', 'voice'].every((stage) => ['done', 'skipped'].includes(project.stages?.[stage]?.status));
      const allRendered = plan.length > 0 && plan.every((segment) => tasks.some((item) => item.segmentId === segment.id && item.status === 'completed' && item.file));
      const pending = project.pendingReview?.stage === 'edit' ? project.pendingReview : null;
      const visual = edit.visual?.issues ?? [];
      const issues = [...visual.map((issue) => ({ ...issue, visual: true })), ...(pending?.issues ?? []).filter((issue) =>
        !visual.some((item) => item.where === issue.where && item.problem === issue.problem),
      )].slice(0, 14);
      const setVideoTime = (video, time) => {
        if (!video || !Number.isFinite(video.duration)) return;
        video.currentTime = Math.min(video.duration, Math.max(0, time));
      };
      const seekComparison = (time) => {
        setSourceTime(time);
        for (const ref of [left, right]) {
          ref.current?.pause();
          setVideoTime(ref.current, time);
        }
      };
      const seekCut = (time, span, index = null) => {
        const segmentChanged = span && span.segmentId !== selection?.id;
        setActiveIssue(index);
        if (span) {
          setSelectedId(span.segmentId);
          const nextTime = span.sourceStart + Math.max(0, time - span.start);
          if (segmentChanged) {
            setSourceTime(nextTime);
            setComparisonDuration({});
          } else seekComparison(nextTime);
        }
        pendingSeek.current = time;
        setVideoTime(player.current, time);
      };
      const canRetake = !running && Boolean(selection && task) && plan.every((segment) =>
        segment.id === selection.id || tasks.some((item) => item.segmentId === segment.id && item.status === 'completed' && item.file),
      );
      const displayCheck = (label, state) => Badge({
        tone: state == null ? 'dim' : state ? 'good' : 'bad',
        children: `${t(label)} · ${t(state == null ? 'notChecked' : state ? 'passed' : 'failedCheck')}`,
      });
      const takeVideo = (take, ref, label) => take ? h('div', { key: take.id, style: { ...s.card, ...s.cardTight } },
        h('strong', { style: s.label }, t(label)),
        h('video', {
          ref, controls: true, preload: 'metadata',
          src: `${FILE}?id=${encodeURIComponent(project.id)}&kind=segment-version&segmentId=${encodeURIComponent(selection.id)}&version=${encodeURIComponent(take.id)}`,
          style: { ...reviewStyles.player, height: '240px' },
          onLoadedMetadata: (event) => {
            setVideoTime(event.currentTarget, sourceTime);
            const duration = event.currentTarget.duration;
            setComparisonDuration((previous) => ({ ...previous, [take.id]: duration }));
          },
        }),
      ) : null;
      const duration = Number(edit.duration) || timeline.at(-1)?.end || 0;
      const locateIssue = (issue) => {
        const where = issue.where ?? '';
        const sequence = (/第\s*([123])\s*张/u.exec(where) ?? /(?:frame|image)\s*([123])/i.exec(where))?.[1];
        const frame = Number(/check-(12|50|88)/i.exec(where)?.[1]) || [0, 12, 50, 88][Number(sequence)];
        const timestamp = frame && duration ? Math.min(duration, Math.max(0.1, duration * frame / 100)) : null;
        const span = timestamp == null ? null : timeline.find((item) => timestamp >= item.start && timestamp < item.end) ?? timeline.at(-1);
        return { frame, timestamp, span };
      };
      const issueForSegment = issues[activeIssue];
      const issueNote = issueForSegment && issueForSegment.action !== 'edit' && locateIssue(issueForSegment).span?.segmentId === selection?.id
        ? [issueForSegment.problem, issueForSegment.fix].filter(Boolean).join('\n') : '';
      const suggestedNote = retakeDraft[selection?.id] ?? issueNote;
      const markers = [...new Map(issues.map((issue, index) => ({ ...locateIssue(issue), index }))
        .filter((marker) => marker.timestamp != null).map((marker) => [marker.frame, marker])).values()];
      const comparisonLimit = Math.min(...[current, other].filter(Boolean).map((take) => Number(comparisonDuration[take.id]) || Infinity));
      const renderSeconds = plan.reduce((sum, item) => sum + (item.generationSeconds ?? item.seconds), 0);

      return h('div', { style: { display: 'grid', gap: '16px' } },
        h('div', { style: reviewStyles.layout },
          h('section', { style: s.card },
            h('div', { style: s.row },
              h('h3', { style: reviewStyles.title }, t('reviewDesk')),
              displayCheck('techCheck', edit.openfilm?.ok),
              displayCheck('finalCheck', edit.review?.pass),
              displayCheck('humanCheck', edit.status === 'done' && edit.note ? true : null),
            ),
            edit.stale ? h('p', { style: s.warnText }, t('staleCut')) : null,
            project.finalFile ? h('video', {
              key: cutUrl, ref: player, src: cutUrl, controls: true, preload: 'metadata',
              style: reviewStyles.player,
              onLoadedMetadata: (event) => setVideoTime(event.currentTarget, pendingSeek.current),
            }) : h('p', { style: s.meta }, t('noFinal')),
            timeline.length ? h('div', { role: 'group', 'aria-label': t('editTimeline'), style: reviewStyles.track },
              ...timeline.map((span, index) => h('button', {
                key: `${span.segmentId}-${index}`, type: 'button',
                'aria-pressed': selection?.id === span.segmentId,
                onClick: () => seekCut(span.start, span),
                style: {
                  ...(selection?.id === span.segmentId ? s.btn : s.btnGhost),
                  flex: `${Math.max(1, span.end - span.start)} 0 104px`, whiteSpace: 'nowrap',
                },
              }, `${reviewTime(span.start)} · ${span.segmentId}`)),
            ) : null,
            markers.length ? h('div', { style: { position: 'relative', height: '24px', margin: '0 24px' } },
              ...markers.map(({ frame, timestamp, span, index }) => h('button', {
                key: frame, type: 'button', style: {
                  ...(activeIssue === index ? s.btn : s.btnGhost), position: 'absolute', top: 0,
                  left: `${100 * timestamp / duration}%`, transform: 'translateX(-50%)', whiteSpace: 'nowrap',
                },
                'aria-label': `${t('inspectIssue')} ${reviewTime(timestamp)}`,
                onClick: () => seekCut(timestamp, span, index),
              }, reviewTime(timestamp))),
            ) : null,
            h('div', { style: s.row },
              allRendered ? h('button', { type: 'button', style: s.btn, disabled: running, onClick: () => onRun('edit') }, t('assemble')) : null,
              pending && project.finalFile && !edit.stale ? h('button', {
                type: 'button', style: s.btnGhost, disabled: running,
                onClick: () => onDecide('approve', t('approveCut'), 'edit'),
              }, t('approveCut')) : null,
            ),
          ),
          h('section', { style: s.card },
            h('h3', { style: reviewStyles.title }, t('visualCheck')),
            issues.length === 0 ? h('p', { style: s.meta }, t('reviewNoIssues')) : null,
            ...issues.map((issue, index) => {
              const { frame, timestamp, span } = locateIssue(issue);
              const action = issue.action ?? (issue.visual ? 'inspect' : 'edit');
              return h('div', { key: index, style: { ...s.card, ...s.cardTight } },
                h('div', { style: s.row },
                  timestamp != null ? h('button', {
                    type: 'button', style: activeIssue === index ? s.btn : s.btnGhost,
                    onClick: () => seekCut(timestamp, span, index),
                  }, `${reviewTime(timestamp)}${span ? ` · ${span.segmentId}` : ''}`) : null,
                  issue.visual && frame ? h('a', {
                    style: s.label, target: '_blank', rel: 'noopener noreferrer',
                    href: `${FILE}?id=${encodeURIComponent(project.id)}&kind=check&name=check-${frame}.jpg&v=${encodeURIComponent(edit.outputAt ?? '')}`,
                  }, t('checkFrame')) : null,
                ),
                h('strong', { style: s.label }, issue.problem || issue.where),
                issue.fix ? h('p', { style: { ...s.meta, margin: 0 } }, issue.fix) : null,
                action === 'edit' && allRendered ? h('button', {
                  type: 'button', style: { ...s.btnGhost, alignSelf: 'flex-start' }, disabled: running,
                  onClick: () => onRun('edit', [issue.problem, issue.fix].filter(Boolean).join('\n')),
                }, t('editIssue')) : null,
                action === 'segment' && span ? h('button', {
                  type: 'button', style: { ...s.btnGhost, alignSelf: 'flex-start' },
                  onClick: () => seekCut(timestamp, span, index),
                }, t('inspectIssue')) : null,
              );
            }),
          ),
        ),
        h('section', { style: s.card },
          h('div', { style: s.row },
            h('h3', { style: reviewStyles.title }, t('planDesk')),
            plan.length ? h('span', { style: s.meta }, fill(t('preflightDuration'), { n: Number(renderSeconds.toFixed(2)) })) : null,
            h('div', { style: s.spacer }),
            !allRendered && ready ? h('button', {
              type: 'button', style: s.btn, disabled: running, onClick: () => onRun('render'),
            }, t('startRendering')) : null,
          ),
          !ready && !allRendered ? h('p', { style: s.meta }, t('preflightWait')) : null,
          plan.length > 0 ? h('div', { style: reviewStyles.track },
            ...plan.map((item) => h('button', {
              key: item.id, type: 'button', style: selection?.id === item.id ? s.btn : s.btnGhost,
              'aria-pressed': selection?.id === item.id,
              onClick: () => {
                const span = timeline.find((entry) => entry.segmentId === item.id);
                if (span) seekCut(span.start, span);
                else { setSelectedId(item.id); setSourceTime(0); setComparisonDuration({}); }
              },
            }, `${item.id} · ${item.seconds}s`)),
          ) : null,
          selection ? h('div', { style: reviewStyles.layout },
            h('div', { style: { display: 'grid', gap: '8px' } },
              h('span', { style: s.label }, selection.people.join(' · ')),
              ...[['openingFrame', selection.opening], ['endingFrame', selection.ending]]
                .map(([label, value]) => h('div', { key: label }, h('strong', { style: s.label }, t(label)), h('p', { style: { ...s.meta, margin: 0 } }, value || '—'))),
              selection.props.length ? h('details', null,
                h('summary', { style: s.label }, t('criticalProps')),
                ...selection.props.map((text) => h('p', { key: text, style: s.meta }, text)),
              ) : null,
            ),
            h('div', null,
              h('strong', { style: s.label }, t(Array.isArray(task?.referenceNames) ? 'actualReferences' : 'plannedReferences')),
              h('div', { style: s.row },
                ...(task?.referenceNames ?? selection.references).map((name) => h('figure', {
                  key: name, style: { margin: 0 },
                }, h('img', {
                  src: `${FILE}?id=${encodeURIComponent(project.id)}&kind=portrait&name=${encodeURIComponent(name)}`,
                  alt: name, loading: 'lazy', style: { width: '64px', height: '64px', objectFit: 'cover', borderRadius: RADIUS_MD },
                }), h('figcaption', { style: s.meta }, name))),
              ),
              task?.referenceCount === 0 ? h('p', { style: s.meta }, t('renderTextOnly'))
                : task?.file && !Array.isArray(task.referenceNames) ? h('p', { style: s.meta },
                  task.referenceCount == null ? t('unknownReferences') : fill(t('renderReferenceCount'), { n: task.referenceCount }))
                  : !(task?.referenceNames ?? selection.references).length ? h('p', { style: s.meta }, t('noReferences')) : null,
              canRetake ? h('div', { style: { display: 'grid', gap: '8px', justifyItems: 'start' } },
                h('textarea', {
                  style: s.textarea, 'aria-label': t('retakeNotes'), placeholder: t('retakeNotes'),
                  value: suggestedNote, maxLength: 2000,
                  onChange: (event) => {
                    const note = event.target.value;
                    setRetakeDraft((previous) => ({ ...previous, [selection.id]: note }));
                  },
                }),
                h('button', { type: 'button', style: s.btnGhost, onClick: () => onRerender(selection.id, suggestedNote) }, t('retakeIssue')),
              ) : null,
            ),
          ) : null,
        ),
        current ? h('section', { style: s.card },
          h('div', { style: s.row },
            h('h3', { style: reviewStyles.title }, t('segmentCompare')),
            other ? h('select', {
              style: { ...s.input, flex: 1, minWidth: '160px', maxWidth: '100%' }, 'aria-label': t('alternateVersion'), value: other.id,
              onChange: (event) => setAlternateId(event.target.value),
            }, takes.filter((take) => !take.current).map((take, index) =>
              h('option', { value: take.id, key: take.id }, `${t('alternateVersion')} ${index + 1} · ${take.id}`),
            )) : null,
            other ? h('button', {
              type: 'button', style: s.btnGhost, disabled: running, onClick: () => onChoose(selection.id, other.id),
            }, t('useVersion')) : null,
          ),
          other && Number.isFinite(comparisonLimit) ? h('label', { style: s.row },
            h('span', { style: s.mono }, reviewTime(sourceTime)),
            h('input', {
              type: 'range', min: 0, max: comparisonLimit, step: 0.1, value: Math.min(sourceTime, comparisonLimit),
              'aria-label': t('segmentCompare'), style: { flex: 1 }, onChange: (event) => seekComparison(Number(event.target.value)),
            }),
          ) : null,
          h('div', { style: reviewStyles.comparison }, takeVideo(current, left, 'currentVersion'), takeVideo(other, right, 'alternateVersion')),
        ) : null,
        artifacts.edit ? h('details', { style: s.card },
          h('summary', { style: s.label }, t('viewDetails')),
          h(EditView, { t, projectId: project.id, edl: artifacts.edit, project }),
        ) : null,
      );
    }

    function StageDetail({ t, stage, ctx, config }) {
      if (stage === 'idea') return h(IdeaView, { t, artifact: ctx.artifacts.idea, project: ctx.project, onChoose: ctx.chooseIdea, onRerun: () => ctx.run('story') });
      if (stage === 'story') return h(StoryView, { t, artifact: ctx.artifacts.story });
      if (stage === 'storyboard') return h(StoryboardView, { t, artifact: ctx.artifacts.storyboard, gate: ctx.project.stages.storyboard?.gate, onEdit: ctx.editStoryboard });
      if (stage === 'characters') return h(CharactersView, { t, projectId: ctx.project.id, artifact: ctx.artifacts.characters, style: config });
      if (stage === 'voice') return h(VoiceView, { t, projectId: ctx.project.id, artifact: ctx.artifacts.voice, catalog: config?.voices, audio: ctx.project.stages.voice?.audio });
      if (stage === 'render') return h(RenderView, { t, projectId: ctx.project.id, render: ctx.render, onRerender: ctx.rerenderSegment, running: ctx.running });
      return h(EditView, { t, projectId: ctx.project.id, edl: ctx.artifacts.edit, project: ctx.project, config });
    }

    // ---------------------------------------------------------------------
    // 流水线
    // ---------------------------------------------------------------------
    function Pipeline({ t, data, config, onRun, onDecide, onRerender, onOpenReview, running }) {
      const [open, setOpen] = useState('');
      const [note, setNote] = useState('');
      const project = data.project;
      const stages = config?.stages ?? [];
      const completed = stages.filter((stage) => ['done', 'skipped'].includes(project.stages?.[stage.id]?.status)).length;
      const next = stages.find((stage) => stage.id === (project.running?.stage || project.pendingReview?.stage))
        ?? stages.find((stage) => !['done', 'skipped'].includes(project.stages?.[stage.id]?.status));
      const ctx = {
        project,
        artifacts: data.artifacts ?? {},
        render: data.render,
        running,
        rerenderSegment: onRerender,
        chooseIdea: async (index) => {
          try {
            await call('chooseIdea', { id: project.id, index });
          } catch (error) {
            /* 面板会由下一次轮询覆盖 */
          }
        },
        run: (stage) => onRun(stage),
        editStoryboard: async (patch) => {
          const response = await call('updateStoryboard', { id: project.id, ...patch });
          return response?.value ?? response;
        },
      };

      return h('div', { style: s.card },
        h('div', { style: s.row },
          h('h3', { style: { margin: 0, fontSize: '16px' } }, t('pipeline')),
          next ? Badge({ tone: project.pendingReview ? 'bad' : project.running ? 'warn' : 'dim', children: next.label }) : null,
          h('div', { style: s.spacer }),
          h('button', {
            type: 'button',
            style: { ...s.btn, ...(running ? s.disabled : {}) },
            disabled: running,
            onClick: () => ['render', 'edit'].includes(next?.id) ? onOpenReview() : onRun(),
          }, running ? t('running') : ['render', 'edit'].includes(next?.id) ? t('openReview') : t('runAll')),
        ),
        stages.length > 0 ? h('div', { style: s.row },
          h('progress', { 'aria-label': t('pipeline'), value: completed, max: stages.length, style: { flex: 1, minWidth: 100, accentColor: 'var(--dsw-alias-state-business-primary)' } }),
          h('span', { style: s.meta }, `${completed} / ${stages.length}`),
        ) : null,
        ...stages.map((stage, index) => {
          const record = project.stages?.[stage.id] ?? { status: 'empty' };
          const tone = TONE[record.status] ?? 'dim';
          const isOpen = open === stage.id;
          const pending = project.pendingReview?.stage === stage.id;
          return h('div', { key: stage.id, style: { ...s.stageRow, ...(record.status === 'running' ? s.stageRowActive : {}) } },
            h('div', { style: s.row },
              h('span', { style: s.num }, String(index + 1)),
              h('span', { style: { ...s.dot, background: DOT_COLOR[tone] } }),
              h('span', { style: s.stageName }, stage.label),
              Badge({ tone: 'dim', children: agentLabel(t, stage.agent) }),
              Badge({ tone, children: statusLabel(t, record.status) ?? record.status }),
              record.status === 'done' && record.note
                ? Badge({ tone: 'good', children: t('manualReviewPassed') })
                : record.review?.score != null ? Badge({ tone: record.review.pass ? 'good' : 'warn', children: fill(t('score'), { n: record.review.score }) }) : null,
              record.review?.accepted === 'with-notes' ? Badge({ tone: 'dim', children: t('passedWithNotes') }) : null,
              record.attempts > 1 ? h('span', { style: s.meta }, fill(t('attempt'), { n: record.attempts })) : null,
              record.gate?.ok === false ? h('span', { style: s.meta }, fill(t('gateFail'), { n: (record.gate.failures ?? []).length })) : null,
              h('div', { style: s.spacer }),
              h('button', {
                type: 'button', style: s.btnGhost,
                'aria-expanded': isOpen,
                onClick: () => setOpen(isOpen ? '' : stage.id),
              }, isOpen ? t('hideDetail') : t('viewDetail')),
              h('button', {
                type: 'button', style: { ...s.btnGhost, ...(running ? s.disabled : {}) },
                disabled: running,
                onClick: () => stage.id === 'render' || stage.id === 'edit' ? onOpenReview() : onRun(stage.id),
              }, stage.id === 'render' || stage.id === 'edit' ? t('openReview') : t('runStage')),
            ),
            record.error ? h('p', { style: s.err }, `${t('error')}：${record.error}`) : null,
            !pending && (record.issues ?? []).length > 0
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                h('span', { style: s.label }, t('issues')),
                ...(record.issues ?? []).slice(0, 4).map((issue, issueIndex) => h('p', { key: issueIndex, style: s.warnText }, `· ${issue}`)),
              )
              : null,
            pending
              ? h('div', { style: s.banner },
                h('div', { style: s.row },
                  h('strong', { style: { fontSize: '12px' } }, t('reviewPending')),
                  h('span', { style: s.meta }, fill(t('reviewWhy'), { stage: stage.label, reason: project.pendingReview.reason })),
                ),
                (project.pendingReview.gateFailures ?? []).length > 0
                  ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                    ...project.pendingReview.gateFailures.slice(0, 4).map((failure, failureIndex) => h('p', { key: failureIndex, style: s.warnText }, `· ${failure}`)),
                  )
                  : null,
                (project.pendingReview.issues ?? []).length > 0
                  ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                    ...project.pendingReview.issues.slice(0, 4).map((issue, issueIndex) => h('p', { key: issueIndex, style: s.warnText },
                      `· ${issue.where ? `${issue.where}：` : ''}${issue.problem ?? ''}${issue.fix ? ` → ${issue.fix}` : ''}`)),
                  )
                  : null,
                h('textarea', {
                  style: { ...s.textarea, minHeight: '46px' },
                  value: note,
                  placeholder: t('reworkHint'),
                  onChange: (event) => setNote(event.target.value),
                }),
                h('div', { style: s.row },
                  h('button', { type: 'button', style: s.btn, onClick: () => onDecide('approve', note, stage.id) }, t('approve')),
                  h('button', { type: 'button', style: s.btnGhost, onClick: () => { onDecide('rework', note, stage.id); setNote(''); } }, t('rework')),
                  h('button', { type: 'button', style: s.btnGhost, onClick: () => onDecide('skip', note, stage.id) }, t('skip')),
                ),
              )
              : null,
            isOpen ? h(StageDetail, { t, stage: stage.id, ctx, config }) : null,
          );
        }),
      );
    }

    // ---------------------------------------------------------------------
    // 环境自检
    // ---------------------------------------------------------------------
    function DoctorCard({ t }) {
      const [report, setReport] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const run = async () => {
        setBusy(true);
        setError('');
        try {
          const result = await call('doctor', {});
          setReport(result);
        } catch (caught) {
          setError(String(caught.message ?? caught));
        } finally {
          setBusy(false);
        }
      };
      const colorOf = (status) => (status === 'fail' ? 'var(--dsw-alias-state-error-primary)' : status === 'warn' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)');
      return h('section', { style: s.card },
        h('div', { style: s.row },
          h('h3', { style: { margin: 0, fontSize: '16px' } }, t('doctorTitle')),
          h('div', { style: s.spacer }),
          h('button', { type: 'button', style: { ...s.btnGhost, ...(busy ? s.disabled : {}) }, disabled: busy, onClick: () => void run() }, busy ? t('doctorRunning') : t('doctorRun')),
        ),
        h('p', { style: s.meta }, t('doctorHint')),
        error ? h('p', { style: s.err }, error) : null,
        report
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            h('div', { style: s.row },
              Badge({ tone: report.ok ? 'good' : 'bad', children: fill(t('doctorSummary'), { ok: report.summary.ok, warn: report.summary.warn, fail: report.summary.fail }) }),
            ),
            ...report.items.map((item, index) => h('div', { key: index, style: { display: 'flex', flexDirection: 'column', gap: '1px' } },
              h('span', { style: { ...s.meta, fontSize: '12px', color: colorOf(item.status) } },
                `${item.status === 'ok' ? '✓' : item.status === 'warn' ? '!' : '✗'} ${item.name}：${item.detail}`),
              item.fix && item.status !== 'ok' ? h('span', { style: { ...s.meta, paddingLeft: '14px' } }, `→ ${item.fix}`) : null,
            )),
          )
          : null,
      );
    }

    // ---------------------------------------------------------------------
    // 提示词模板
    // ---------------------------------------------------------------------
    function PromptsEditor({ t }) {
      const names = ['idea', 'story', 'storyboard', 'characters', 'voice', 'edit', 'reviewer'];
      const [items, setItems] = useState([]);
      const [name, setName] = useState('story');
      const [text, setText] = useState('');
      const [notice, setNotice] = useState('');
      const [busy, setBusy] = useState(false);
      useEffect(() => {
        void (async () => {
          try {
            const result = await call('prompts', {});
            setItems(result?.items ?? []);
          } catch (error) {
            setNotice(fill(t('noticeReadFailed'), { msg: error.message ?? error }));
          }
        })();
      }, []);
      useEffect(() => {
        const item = items.find((row) => row.name === name);
        setText(item?.content ?? '');
      }, [items, name]);
      const save = async (content) => {
        setBusy(true);
        try {
          await call('savePrompt', { name, content });
          const result = await call('prompts', {});
          setItems(result?.items ?? []);
          setNotice(content.trim() ? t('promptSaved') : t('promptResetDone'));
        } catch (error) {
          setNotice(fill(t('noticeSaveFailed'), { msg: error.message ?? error }));
        } finally {
          setBusy(false);
        }
      };
      return h('section', { style: s.card },
        h('h3', { style: { margin: 0, fontSize: '16px' } }, t('promptTab')),
        h('p', { style: s.meta }, t('promptHint')),
        h('div', { style: s.row },
          h('span', { style: s.label }, t('promptName')),
          h('select', {
            style: { ...s.input, width: '200px' },
            value: name,
            onChange: (event) => setName(event.target.value),
          }, ...names.map((key) => h('option', { key, value: key }, `${key}${items.find((row) => row.name === key)?.custom ? t('customSuffix') : ''}`))),
          h('div', { style: s.spacer }),
          h('button', { type: 'button', style: { ...s.btn, ...(busy ? s.disabled : {}) }, disabled: busy, onClick: () => void save(text) }, t('promptSave')),
          h('button', { type: 'button', style: { ...s.btnGhost, ...(busy ? s.disabled : {}) }, disabled: busy, onClick: () => void save('') }, t('promptReset')),
        ),
        notice ? h('p', { style: { ...s.meta, fontSize: '12px' } }, notice) : null,
        h('textarea', {
          style: { ...s.textarea, minHeight: '260px', fontFamily: MONO },
          value: text,
          placeholder: t('promptPlaceholder'),
          onChange: (event) => setText(event.target.value),
        }),
      );
    }

    // ---------------------------------------------------------------------
    // 主面板
    // ---------------------------------------------------------------------
    function Panel({ t, host }) {
      const wide = host === 'main';
      const pageStyle = wide ? { ...s.page, ...s.pageWide } : s.page;
      const [config, setConfig] = useState(null);
      const [projects, setProjects] = useState([]);
      const [workspaceTab, setWorkspaceTab] = useState('production');
      const [selected, setSelected] = useState('');
      const [data, setData] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const alive = useRef(true);
      const notified = useRef(0);
      const selectedRef = useRef('');
      const audioCtx = useRef(null);
      const [notifyAllowed, setNotifyAllowed] = useState(() => {
        try {
          return window.Notification?.permission === 'granted';
        } catch {
          return false;
        }
      });

      useEffect(() => () => {
        alive.current = false;
      }, []);

      const pick = useCallback(async (id) => {
        selectedRef.current = id;
        setSelected(id);
        try {
          window.localStorage?.setItem('creative-studio.project', id);
        } catch {
          /* 存不了就存不了 */
        }
        const state = await call('state', { id });
        if (alive.current) setData(state);
      }, []);

      /** 列表 + 选中项一起刷新；selected 走 ref，避免这个回调随选中项变化而重建。 */
      const loadProjects = useCallback(async (prefer) => {
        const { projects: rows } = await call('projects');
        if (!alive.current) return;
        setProjects(rows);
        const keep = prefer || selectedRef.current || rows[0]?.id || '';
        if (keep && rows.some((row) => row.id === keep)) await pick(keep);
        else if (rows.length === 0) {
          selectedRef.current = '';
          setSelected('');
          setData(null);
        } else await pick(rows[0].id);
      }, [pick]);

      useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const info = await call('config');
            if (cancelled) return;
            setConfig(info);
            const stored = window.localStorage?.getItem('creative-studio.project') || '';
            await loadProjects(stored);
          } catch (err) {
            if (!cancelled) setError(err.message);
          }
        })();
        return () => { cancelled = true; };
      }, [loadProjects]);

      const refresh = useCallback(async (id) => {
        const target = id || selected;
        if (!target) return;
        try {
          const state = await call('state', { id: target });
          if (alive.current) setData(state);
        } catch (err) {
          if (alive.current) setError(err.message);
        }
      }, [selected]);

      // 轮询：跑起来的时候 3 秒一次，闲的时候 9 秒一次。
      useEffect(() => {
        if (!selected) return undefined;
        let timer = null;
        let cancelled = false;
        const tick = async () => {
          const running = Boolean(data?.project?.running) || data?.project?.stages?.render?.status === 'running';
          await refresh(selected);
          if (!cancelled) timer = setTimeout(tick, running ? 3000 : 9000);
        };
        timer = setTimeout(tick, 3000);
        return () => { cancelled = true; if (timer) clearTimeout(timer); };
      }, [selected, data?.project?.running, data?.project?.stages?.render?.status, refresh]);

      // 待复核提醒：新的一条进来就响一声 + 发一条系统通知。
      useEffect(() => {
        const pending = data?.project?.pendingReview;
        if (!pending) return;
        if (notified.current === pending.at) return;
        notified.current = pending.at;
        try {
          audioCtx.current ??= new (window.AudioContext || window.webkitAudioContext)();
          const audio = audioCtx.current;
          const osc = audio.createOscillator();
          const gain = audio.createGain();
          osc.connect(gain);
          gain.connect(audio.destination);
          osc.frequency.value = 880;
          gain.gain.setValueAtTime(0.05, audio.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.5);
          osc.start();
          osc.stop(audio.currentTime + 0.5);
        } catch {
          /* 浏览器不让响就算了 */
        }
        try {
          if (window.Notification && window.Notification.permission === 'granted') {
            new window.Notification(fill(t('notifyTitle'), { title: pending.projectTitle ?? '' }), {
              body: `${pending.stageLabel ?? ''}：${pending.reason ?? ''}`,
              tag: `creative-${pending.at}`,
            });
          }
        } catch {
          /* 通知失败不影响面板 */
        }

      }, [data?.project?.pendingReview, t]);

      const remember = (id) => {
        selectedRef.current = id;
        setSelected(id);
        try {
          window.localStorage?.setItem('creative-studio.project', id);
        } catch {
          /* 存不了就存不了 */
        }
      };

      const guard = async (fn) => {
        setError('');
        setBusy(true);
        try {
          await fn();
        } catch (err) {
          if (alive.current) setError(err.message);
        } finally {
          if (alive.current) setBusy(false);
        }
      };

      const create = (form, startNow) => guard(async () => {
        if (!form.productName.trim()) throw new Error(t('needBrief'));
        const created = await call('create', {
          title: form.title || form.productName,
          platform: form.platform,
          targetSeconds: Number(form.targetSeconds) || 45,
          aspect: form.aspect,
          brief: {
            productName: form.productName,
            category: form.category,
            audience: form.audience,
            sellingPoints: form.sellingPoints.split('\n').map((line) => line.trim()).filter(Boolean),
            tone: form.tone,
            priceBand: form.priceBand,
            forbidden: form.forbidden.split(/[,，、]/).map((word) => word.trim()).filter(Boolean),
            extra: form.extra,
            audioMode: form.audioMode,
            projectMode: form.projectMode,
          },
        });
        remember(created.id);
        await loadProjects(created.id);
        if (startNow) await call('run', { id: created.id, stopBeforeRender: true });
        setNotice(startNow ? t('noticeStarted') : '');
      });

      const loadDemo = () => guard(async () => {
        const created = await call('createDemo', {});
        remember(created.id);
        await loadProjects(created.id);
        setWorkspaceTab('production');
        setNotice(t('demoLoaded'));
      });

      const removeProject = () => guard(async () => {
        if (!selected) return;
        if (!window.confirm(t('removeConfirm'))) return;
        await call('remove', { id: selected });
        try {
          window.localStorage?.removeItem('creative-studio.project');
        } catch {
          /* 存不了就存不了 */
        }
        selectedRef.current = '';
        setSelected('');
        setData(null);
        await loadProjects();
        setNotice(t('removed'));
      });

      const run = (stage, note) => guard(async () => {
        if (!selected) return;
        // 单个阶段按钮 = 只跑这一阶段（看清一步再走下一步）；顶部大按钮 = 一路跑到成片。
        await call('run', { id: selected, ...(stage ? { stage, only: true, note } : { stopBeforeRender: true }) });
        await refresh(selected);
      });

      const rerenderSegment = (segmentId, note) => guard(async () => {
        if (!selected) return;
        await call('rerenderSegment', { id: selected, segmentId, compare: true, note });
        await refresh(selected);
      });

      const chooseVersion = (segmentId, version) => guard(async () => {
        if (!selected) return;
        await call('chooseSegmentVersion', { id: selected, segmentId, version });
        await refresh(selected);
      });

      const decide = (decision, note, stage) => guard(async () => {
        if (!selected) return;
        await call('decide', { id: selected, decision, note, ...(stage ? { stage } : {}) });
        await refresh(selected);
      });

      const saveBrief = (payload) => guard(async () => {
        await call('updateBrief', { id: selected, ...payload });
        await refresh(selected);
        setNotice(t('saved'));
      });

      const grabHotspots = () => guard(async () => {
        const result = await call('hotspots', { id: selected });
        await refresh(selected);
        setNotice(fill(t('noticeHotspots'), { n: result.hotspots.length }));
      });

      const runReference = (payload) => guard(async () => {
        if (!selected) return;
        await call('reference', { id: selected, ...payload });
        await refresh(selected);
        setNotice(t('refRunning'));
      });

      const addHotspot = (title) => guard(async () => {        const current = data?.project?.brief?.hotspots ?? [];
        await call('updateBrief', { id: selected, brief: { hotspots: [{ title, source: t('sourceManual'), at: new Date().toISOString() }, ...current] } });
        await refresh(selected);
      });

      const enableNotify = () => {
        try {
          const result = window.Notification?.requestPermission?.();
          if (result?.then) result.then((state) => setNotifyAllowed(state === 'granted')).catch(() => {});
          setNotice(t('notifyOn'));
        } catch {
          /* 忽略 */
        }
      };

      const header = h('div', { style: s.head },
        h('h2', { style: s.headTitle }, t('title')),
        h('span', { style: s.headMeta }, config ? fill(t('projectCount'), { n: projects.length }) : ''),
        h('div', { style: s.spacer }),
        projects.length > 0
          ? h('select', {
            style: { ...s.input, width: 'auto', maxWidth: '260px' },
            value: selected,
            onChange: async (event) => {
              const id = event.target.value;
              remember(id);
              try {
                await pick(id);
              } catch (err) {
                setError(err.message);
              }
            },
          }, projects.map((row) => h('option', { key: row.id, value: row.id }, `${row.title}${row.pendingReview ? ' ⚠' : ''}`)))
          : null,
        h('button', { type: 'button', style: s.btnIcon, title: t('refresh'), onClick: () => loadProjects(selected) }, '↻'),
        selected && data?.project
          ? h('button', {
            type: 'button',
            style: s.btnGhost,
            title: t('removeProject'),
            disabled: Boolean(data?.project?.running),
            onClick: removeProject,
          }, t('removeProject'))
          : null,
        h('button', {
          type: 'button', style: s.btnGhost,
          onClick: () => { selectedRef.current = ''; setSelected(''); setData(null); setWorkspaceTab('production'); },
        }, t('newProject')),
        h('button', { type: 'button', style: s.btnGhost, onClick: enableNotify }, notifyAllowed ? t('notifyOn') : t('notifyOff')),
      );

      if (!config && !error) return h('div', { style: pageStyle }, header, h('p', { style: s.meta }, t('loading')));
      if (!config && error) return h('div', { style: pageStyle }, header, h('p', { style: s.err }, error));

      const running = Boolean(data?.project?.running);
      const project = data?.project;

      return h('div', { style: pageStyle },
        header,
        error ? h('p', { style: s.err }, error) : null,
        notice ? h('p', { style: s.ok }, notice) : null,
        project ? h('section', { style: { ...s.card, borderTop: '2px solid var(--dsw-alias-state-business-primary)' } },
          h('h3', { style: { margin: 0, fontSize: '20px', lineHeight: '28px', overflowWrap: 'anywhere' } }, project.title),
          h('div', { style: s.row },
            ...[project.platform, project.aspect, project.resolution, project.brief?.projectMode === 'story' ? t('projectStory') : null, project.brief?.audioMode === 'no-dialogue' ? t('noDialogueAudio') : null, project.targetSeconds ? `${project.targetSeconds}s` : null]
              .filter(Boolean).map((value) => h('span', { key: value, style: s.chip }, value)),
          ),
          data?.runtime
            ? h('p', { style: { ...s.meta, fontSize: '12px' } },
              `${t('runtimeUsed')}：${[
                data.runtime.llm ? `${data.runtime.llm.provider}/${data.runtime.llm.model}` : '',
                data.runtime.video?.model ?? '',
                data.runtime.image?.backend ?? '',
              ].filter(Boolean).join(' · ')}`)
            : null,
        ) : null,
        h('nav', { 'aria-label': t('title'), style: s.row },
          ...[
            ['production', t('pipeline')],
            ...(project ? [['review', t('reviewDesk')], ['brief', t('projectBriefTab')]] : []),
            ['prompts', t('promptTab')],
            ['library', t('referenceLibraryTab')],
          ].map(([key, label]) => h('button', {
            key,
            type: 'button',
            'aria-pressed': workspaceTab === key,
            style: workspaceTab === key ? s.btn : s.btnGhost,
            onClick: () => setWorkspaceTab(key),
          }, label)),
        ),
        workspaceTab === 'prompts'
          ? h(React.Fragment, null,
            h(DoctorCard, { t }),
            h(PromptsEditor, { t }),
          )
          : workspaceTab === 'library'
          ? h(ReferenceStudio, {
            t,
            onOpenProject: async (newId) => {
              remember(newId);
              setWorkspaceTab('production');
              await loadProjects(newId);
            },
          })
          : !project
            ? h(NewProject, { t, config, onCreate: create, onDemo: loadDemo, busy })
            : workspaceTab === 'brief'
              ? h(React.Fragment, null,
                h(ReferenceCard, { key: project.id, t, project, config, onRun: runReference }),
                h(BriefCard, { key: project.id, t, project, config, onSave: saveBrief, onHotspots: grabHotspots, onAddHotspot: addHotspot, busy }),
              )
              : workspaceTab === 'review'
                ? h(ReviewDesk, { key: project.id, t, data, running: running || busy, onRun: run, onRerender: rerenderSegment, onChoose: chooseVersion, onDecide: decide })
                : h(React.Fragment, null,
            h(Pipeline, { key: project.id, t, data, config, onRun: run, onDecide: decide, onRerender: rerenderSegment, onOpenReview: () => setWorkspaceTab('review'), running: running || busy }),
            h('details', { style: { ...s.card, ...s.cardTight } },
              h('summary', { style: s.sectionTitle }, t('events')),
              h('div', { style: s.row },
                h('div', { style: s.spacer }),
                h('span', { style: s.mono }, data?.dir ?? ''),
              ),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', maxHeight: '200px', overflowY: 'auto' } },
                (project.events ?? []).slice(-40).reverse().map((entry, index) => h('div', { key: index, style: s.row },
                  h('span', { style: { ...s.meta, fontFamily: MONO } }, timeText(entry.at)),
                  h('span', { style: s.meta }, entry.text),
                )),
              ),
            ),
            h('p', { style: s.meta }, t('runHint')),
          ),
      );
    }

    function PanelIcon(props) {
      const size = props?.size ?? 16;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.25, 'aria-hidden': true,
      },
        h('rect', { x: 1.8, y: 3.2, width: 12.4, height: 9.6, rx: 1.6 }),
        h('path', { d: 'M6.4 8.1l3.4-1.9v4l-3.4-1.9z', fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M6.4 1.8l1.1 1.6M9.6 1.8L8.5 3.4' }),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
  text = (key, vars) => fill(t(key), vars);
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'creative-studio: copy');
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: ID, order: 38, label: () => t('title'), locale: NS,
        }, (props) => PanelIcon({ size: props?.size }))), 'creative-studio: left entry');
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: ID, locale: NS,
        }, (props) => h(Panel, { ...props, t, host: 'main' }))), 'creative-studio: main page');
      },
    };
  },
});
