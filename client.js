/**
 * 创意工作台的浏览器侧：左侧栏一个入口，主区域整页工作台。
 *
 * 面板不做任何重活：跑阶段、审核、出片、剪辑、通知都在宿主侧（见 index.js），
 * 这里只负责把「产品画像 + 热点 → 七个阶段 → 成片」画清楚，并把人的裁决送回去。
 */
window.__ModuleLoader__.load({
  id: 'dsh-creative-studio',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const ID = 'dsh-creative-studio';
    const NS = 'creativeStudio';
    const API = '/creative-studio/api';
    const FILE = '/creative-studio/file';
    const DIM_KEYS = ['face', 'features', 'hair', 'costume', 'posture', 'motif'];

    const zh = {
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
      runAll: '一键跑到成片',
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
      runAll: 'Run through to the final cut',
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

    /** 角色与状态用固定标签：locale 里只放字符串，避免依赖嵌套对象的取值行为。 */
    const AGENT_LABEL = { producer: '生产 Agent', editor: '剪辑团队 Agent', reviewer: '审核 Agent' };
    const STATUS_LABEL = {
      empty: '未开始', running: '进行中', done: '已完成', rework: '打回重做中',
      needs_review: '待人工复核', failed: '失败', skipped: '已跳过',
    };

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
        throw new Error(`宿主没有返回 JSON（HTTP ${response.status}）`);
      }
      if (!body || body.ok !== true) throw new Error(body?.error?.message ?? `请求失败（HTTP ${response.status}）`);
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
      headTitle: { margin: 0, fontSize: '15px', fontWeight: 650, letterSpacing: '0.01em' },
      headMeta: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      spacer: { flex: 1, minWidth: '8px' },
      card: {
        display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 14px', minWidth: 0,
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
      empty: 'dim', running: 'warn', rework: 'warn', needs_review: 'bad', failed: 'bad', done: 'good', skipped: 'dim',
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
      forbidden: '', extra: '', targetSeconds: '45', platform: 'douyin', aspect: '9:16',
    });

    function NewProject({ t, config, onCreate, busy }) {
      const [form, setForm] = useState(emptyForm);
      const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));
      const submit = (startNow) => onCreate(form, startNow);

      return h('div', { style: s.card },
        h('div', { style: s.row },
          h('strong', { style: { fontSize: '13px' } }, t('emptyTitle')),
        ),
        h('p', { style: s.meta }, t('emptyBody')),
        h('div', { style: s.grid },
          h(Field, { label: t('titleField') }, h('input', { style: s.input, value: form.title, onChange: set('title'), placeholder: '清汤面 · 深夜面馆 45 秒' })),
          h(Field, { label: t('productName') }, h('input', { style: s.input, value: form.productName, onChange: set('productName') })),
          h(Field, { label: t('category') }, h('input', { style: s.input, value: form.category, onChange: set('category') })),
          h(Field, { label: t('audience') }, h('input', { style: s.input, value: form.audience, onChange: set('audience') })),
          h(Field, { label: t('tone') }, h('input', { style: s.input, value: form.tone, onChange: set('tone'), placeholder: '克制的温情，不要叫卖' })),
          h(Field, { label: t('priceBand') }, h('input', { style: s.input, value: form.priceBand, onChange: set('priceBand') })),
        ),
        h(Field, { label: t('sellingPoints') },
          h('textarea', { style: s.textarea, value: form.sellingPoints, onChange: set('sellingPoints'), placeholder: '一碗面一碗汤\n凌晨十二点还开门\n老板记得每个老客的口味' }),
        ),
        h(Field, { label: t('forbidden') }, h('input', { style: s.input, value: form.forbidden, onChange: set('forbidden'), placeholder: '最,第一,国家级' })),
        h(Field, { label: t('extra') }, h('textarea', { style: { ...s.textarea, minHeight: '42px' }, value: form.extra, onChange: set('extra') })),
        h('div', { style: s.row },
          h(Field, { label: t('targetSeconds') }, h('input', { style: { ...s.input, width: '100px' }, type: 'number', min: 10, max: 180, value: form.targetSeconds, onChange: set('targetSeconds') })),
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
    function ReferenceCard({ t, project, onRun }) {
      const [url, setUrl] = useState('');
      const [local, setLocal] = useState('');
      const ref = project.reference ?? null;
      const busy = Boolean(ref && ['running', 'analyzing', 'fetching', 'framing', 'asr', 'reviewing'].includes(ref.status));
      const canRun = Boolean(url.trim() || local.trim()) && !busy;
      return h('div', { style: s.card },
        h('div', { style: s.row },
          h('span', { style: s.sectionTitle }, t('refTitle')),
          ref?.summary
            ? h('span', { style: s.meta }, `${ref.summary.title || ''}${ref.summary.uploader ? ` · ${ref.summary.uploader}` : ''} · ${ref.shotCount ?? ref.summary.shotCount ?? '?'} 镜 · ${ref.duration ?? ref.summary.duration ?? '?'}s`)
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
            onClick: () => onRun({ url: url.trim(), localPath: local.trim() }),
          }, busy ? t('refRunning') : t('refRun')),
        ),
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
        if (!['running', 'analyzing', 'fetching', 'framing', 'asr', 'reviewing'].includes(status)) return undefined;
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
        setNotice(`已开项目：${created.id}`);
        onOpenProject(created.id);
      });

      const running = ['running', 'analyzing', 'fetching', 'framing', 'asr', 'reviewing'].includes(ev?.status ?? '');
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
                summary ? h('span', { style: s.meta }, `${summary.title || '—'}${summary.uploader ? ` · ${summary.uploader}` : ''} · ${summary.shotCount ?? ev.frames?.length ?? '?'} 镜 · ${summary.duration ?? '?'}s`) : null,
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
                      ? h('p', { style: s.meta }, `${t('reaVision')}：${ev.rea.vision.reviewed}/${ev.rea.vision.total} 镜`)
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
                  ev.replicateSummary ? h('span', { style: s.meta }, `${ev.replicateSummary.shots} 镜 / ${ev.replicateSummary.segments} 段`) : null,
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
              h('span', { style: s.label }, '一句话'),
              h('span', null, idea.oneLiner),
              h('span', { style: s.label }, t('whyNow')),
              h('span', null, idea.whyNow),
              h('span', { style: s.label }, t('risk')),
              h('span', null, idea.risk),
            ),
            h('div', { style: s.row },
              h('span', { style: s.meta }, `钩子 ${idea.score?.hook ?? '?'} · 契合 ${idea.score?.fit ?? '?'} · 可拍 ${idea.score?.feasible ?? '?'}`),
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
        h('p', { style: { margin: 0 } }, `结局：${artifact.ending ?? '—'}`),
      );
    }

    function StoryboardView({ t, artifact, gate }) {
      if (!artifact) return h('p', { style: s.meta }, t('noArtifact'));
      const shots = artifact.shots ?? [];
      const segments = [];
      for (const shot of shots) {
        const key = shot.segment ?? shot.scene ?? 'seg';
        let bucket = segments.find((item) => item.id === key);
        if (!bucket) {
          bucket = { id: key, shots: [], seconds: 0 };
          segments.push(bucket);
        }
        bucket.shots.push(shot);
        bucket.seconds += Number(shot.durationSec) || 0;
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { style: s.row },
          h('strong', null, artifact.title ?? ''),
          h('span', { style: s.meta }, `${artifact.targetSeconds ?? '?'}s · ${shots.length} 镜 · ${segments.length} 段`),
          gate?.ok ? Badge({ tone: 'good', children: t('gateOk') }) : gate ? Badge({ tone: 'bad', children: fill(t('gateFail'), { n: (gate.failures ?? []).length }) }) : null,
        ),
        ...segments.map((segment) => h('div', { key: segment.id, style: { ...s.card, ...s.cardTight } },
          h('div', { style: s.row },
            h('strong', { style: { fontSize: '12px' } }, `${t('segment')} ${segment.id}`),
            h('span', { style: s.meta }, `${Math.round(segment.seconds * 10) / 10}s · ${segment.shots.length} ${t('shots')}`),
          ),
          ...segment.shots.map((shot) => h('div', { key: shot.id, style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
            h('span', { style: s.meta }, `${shot.id} · ${shot.kind ?? ''} · ${shot.durationSec}s · ${(shot.inFrame ?? []).map((person) => person.who).join('、')}`),
            h('span', { style: s.mono }, shot.action),
            h('details', null,
              h('summary', { style: { ...s.meta, cursor: 'pointer' } }, '提示词'),
              h('pre', { style: s.pre }, shot.prompt ?? ''),
            ),
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

    function VoiceView({ t, artifact, catalog }) {
      if (!artifact) return h('p', { style: s.meta }, t('noArtifact'));
      const nameOf = (id) => (catalog ?? []).find((voice) => voice.id === id)?.name ?? id;
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { style: s.row }, (artifact.characters ?? []).map((row, index) =>
          h('span', { key: index, style: s.chip }, `${row.name} · ${nameOf(row.voiceId)} · ×${row.rate ?? 1}`))),
        artifact.narration?.enabled
          ? h('p', { style: s.meta }, `旁白：${nameOf(artifact.narration.voiceId)} · ${artifact.narration.emotion ?? ''}`)
          : null,
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          (artifact.lines ?? []).map((line, index) => h('div', { key: index, style: s.row },
            h('span', { style: s.meta }, line.beatId),
            h('span', { style: { fontWeight: 500 } }, `${line.speaker}：`),
            h('span', { style: { flex: 1, minWidth: 0 } }, line.text),
            h('span', { style: s.meta }, `${nameOf(line.voiceId)} · ${line.emotion ?? ''}`),
          )),
        ),
        h('p', { style: s.meta }, `${t('bgm')}：${artifact.bgm?.mood ?? ''} ${artifact.bgm?.recommended ?? ''}${artifact.bgm?.bpm ? ` · ${artifact.bgm.bpm}bpm` : ''}`),
      );
    }

    function RenderView({ t, projectId, render }) {
      const tasks = render?.tasks ?? [];
      if (tasks.length === 0) return h('p', { style: s.meta }, t('noArtifact'));
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        ...tasks.map((task) => h('div', { key: task.segmentId, style: { ...s.card, ...s.cardTight } },
          h('div', { style: s.row },
            h('strong', { style: { fontSize: '12px' } }, task.segmentId),
            Badge({ tone: TONE[task.status === 'completed' ? 'done' : task.status === 'failed' ? 'failed' : 'running'] ?? 'dim', children: task.status }),
            h('span', { style: s.meta }, `${task.duration ?? task.seconds ?? '?'}s${task.providerLabel ? ` · ${task.providerLabel}` : ''}`),
            task.progress ? h('span', { style: s.meta }, `${task.progress}%`) : null,
          ),
          task.error ? h('p', { style: s.err }, task.error) : null,
          task.file
            ? h('video', { style: { ...s.video, maxHeight: '260px' }, src: `${FILE}?id=${encodeURIComponent(projectId)}&kind=segment&segmentId=${encodeURIComponent(task.segmentId)}`, controls: true, preload: 'metadata' })
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
                tone: visual.pass ? 'good' : 'bad',
                children: visual.pass ? t('visualPass') : fill(t('visualIssues'), { n: (visual.issues ?? []).length }),
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
              h('span', { style: s.meta }, `${t('transition')} ${entry.transition ?? 'cut'}${entry.trimStart ? ` · 裁头 ${entry.trimStart}s` : ''}${entry.trimEnd ? ` · 裁尾 ${entry.trimEnd}s` : ''}`),
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

    function StageDetail({ t, stage, ctx, config }) {
      if (stage === 'idea') return h(IdeaView, { t, artifact: ctx.artifacts.idea, project: ctx.project, onChoose: ctx.chooseIdea, onRerun: () => ctx.run('story') });
      if (stage === 'story') return h(StoryView, { t, artifact: ctx.artifacts.story });
      if (stage === 'storyboard') return h(StoryboardView, { t, artifact: ctx.artifacts.storyboard, gate: ctx.project.stages.storyboard?.gate });
      if (stage === 'characters') return h(CharactersView, { t, projectId: ctx.project.id, artifact: ctx.artifacts.characters, style: config });
      if (stage === 'voice') return h(VoiceView, { t, artifact: ctx.artifacts.voice, catalog: config?.voices });
      if (stage === 'render') return h(RenderView, { t, projectId: ctx.project.id, render: ctx.render });
      return h(EditView, { t, projectId: ctx.project.id, edl: ctx.artifacts.edit, project: ctx.project, config });
    }

    // ---------------------------------------------------------------------
    // 流水线
    // ---------------------------------------------------------------------
    function Pipeline({ t, data, config, onRun, onDecide, running }) {
      const [open, setOpen] = useState('');
      const [note, setNote] = useState('');
      const project = data.project;
      const stages = config?.stages ?? [];
      const ctx = {
        project,
        artifacts: data.artifacts ?? {},
        render: data.render,
        chooseIdea: async (index) => {
          try {
            await call('chooseIdea', { id: project.id, index });
          } catch (error) {
            /* 面板会由下一次轮询覆盖 */
          }
        },
        run: (stage) => onRun(stage),
      };

      return h('div', { style: s.card },
        h('div', { style: s.row },
          h('span', { style: s.sectionTitle }, t('pipeline')),
          h('div', { style: s.spacer }),
          h('button', {
            type: 'button',
            style: { ...s.btn, ...(running ? s.disabled : {}) },
            disabled: running,
            onClick: () => onRun(),
          }, running ? t('running') : t('runAll')),
        ),
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
              Badge({ tone: 'dim', children: AGENT_LABEL[stage.agent] ?? stage.agent }),
              Badge({ tone, children: STATUS_LABEL[record.status] ?? record.status }),
              record.review?.score !== undefined && record.review?.score !== null ? Badge({ tone: record.review.pass ? 'good' : 'warn', children: fill(t('score'), { n: record.review.score }) }) : null,
              record.attempts > 1 ? h('span', { style: s.meta }, fill(t('attempt'), { n: record.attempts })) : null,
              record.gate?.ok === false ? h('span', { style: s.meta }, fill(t('gateFail'), { n: (record.gate.failures ?? []).length })) : null,
              h('div', { style: s.spacer }),
              h('button', {
                type: 'button', style: s.btnGhost,
                disabled: running,
                onClick: () => setOpen(isOpen ? '' : stage.id),
              }, isOpen ? t('hideDetail') : t('viewDetail')),
              h('button', {
                type: 'button', style: { ...s.btnGhost, ...(running ? s.disabled : {}) },
                disabled: running,
                onClick: () => onRun(stage.id),
              }, t('runStage')),
            ),
            record.error ? h('p', { style: s.err }, `${t('error')}：${record.error}`) : null,
            (record.issues ?? []).length > 0
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
    // 主面板
    // ---------------------------------------------------------------------
    function Panel({ t, host }) {
      const wide = host === 'main';
      const pageStyle = wide ? { ...s.page, ...s.pageWide } : s.page;
      const [config, setConfig] = useState(null);
      const [projects, setProjects] = useState([]);
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
            new window.Notification(`创意工作台需要复核：${pending.projectTitle ?? ''}`, {
              body: `${pending.stageLabel ?? ''}：${pending.reason ?? ''}`,
              tag: `creative-${pending.at}`,
            });
          }
        } catch {
          /* 通知失败不影响面板 */
        }
        setNotice(`${t('reviewPending')}：${pending.stageLabel ?? ''}`);
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
          },
        });
        remember(created.id);
        await loadProjects(created.id);
        if (startNow) await call('run', { id: created.id });
        setNotice(startNow ? '已开跑：创意 → 剧情 → 分镜 → 人物 → 配音 → 出片 → 剪辑' : '');
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

      const run = (stage) => guard(async () => {
        if (!selected) return;
        // 单个阶段按钮 = 只跑这一阶段（看清一步再走下一步）；顶部大按钮 = 一路跑到成片。
        await call('run', { id: selected, ...(stage ? { stage, only: true } : {}) });
        setNotice(t('running'));
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
        setNotice(`抓到 ${result.hotspots.length} 条热点`);
      });

      const runReference = (payload) => guard(async () => {
        if (!selected) return;
        await call('reference', { id: selected, ...payload });
        await refresh(selected);
        setNotice(t('refRunning'));
      });

      const addHotspot = (title) => guard(async () => {        const current = data?.project?.brief?.hotspots ?? [];
        await call('updateBrief', { id: selected, brief: { hotspots: [{ title, source: '手动', at: new Date().toISOString() }, ...current] } });
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
        h('span', { style: s.headMeta }, config ? `${projects.length} 个项目` : ''),
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
          onClick: () => { selectedRef.current = ''; setSelected(''); setData(null); },
        }, t('newProject')),
        h('button', { type: 'button', style: s.btnGhost, onClick: enableNotify }, notifyAllowed ? t('notifyOn') : t('notifyOff')),
      );

      if (!config && !error) return h('div', { style: pageStyle }, header, h('p', { style: s.meta }, t('loading')));
      if (!config && error) return h('div', { style: pageStyle }, header, h('p', { style: s.err }, error));

      const running = Boolean(data?.project?.running) || Object.values(data?.project?.stages ?? {}).some((stage) => stage?.status === 'running');
      const project = data?.project;

      return h('div', { style: pageStyle },
        header,
        error ? h('p', { style: s.err }, error) : null,
        notice ? h('p', { style: s.ok }, notice) : null,
        h(ReferenceStudio, {
          t,
          onOpenProject: async (newId) => {
            remember(newId);
            await loadProjects(newId);
          },
        }),
        !selected || !project
          ? h(NewProject, { t, config, onCreate: create, busy })
          : h(React.Fragment, null,
            h(BriefCard, { t, project, config, onSave: saveBrief, onHotspots: grabHotspots, onAddHotspot: addHotspot, busy }),
            h(ReferenceCard, { t, project, onRun: runReference }),
            h(Pipeline, { t, data, config, onRun: run, onDecide: decide, running }),
            h('div', { style: { ...s.card, ...s.cardTight } },
              h('div', { style: s.row },
                h('span', { style: s.sectionTitle }, t('events')),
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
