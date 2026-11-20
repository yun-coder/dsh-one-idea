# 创意工作台（dsh-one-idea）

把「分镜出片」和「爆款复刻」合并成一条**从创意到成片**的生产线，并在中间插进两道人工闸门：
确定性质量门（脚本判定）+ 审核 Agent（模型打分）。不过就自动打回重做，重试用完停下来等你复核。

## 目录布局（一个文件夹装完）

```
D:\智贸\10-创意工作台\
  app\                       插件源码（通过 link 安装到 DSH profile）
    demo\                    示例项目模板与 10 秒成片（面板「载入示例项目」用）
    machine.json.example     本机配置模板（复制到 ~/.dsh/creative-studio/machine.json）
  projects\                  项目产物：一条项目一个子目录
  data\                      独立出片任务索引 + 生图（h3_* 工具、拉片台共用）
  tools\rea-video\           拉片引擎（git clone + .venv）
  archive\old-teardowns\     旧拉片链路的产物
  archive\old-plugins\       「分镜出片」「爆款复刻」两个旧插件源码（已卸载，仅留档）
```

配置里对应的三项：`projectDir` → `projects`，`dataDir` → `data`，`reaVideoCmd` → `tools\rea-video\.venv\Scripts\rea-video.exe`。

## 一条链路，七个阶段

| # | 阶段 | 谁负责 | 产出 | 怎么判过关 |
|---|---|---|---|---|
| 0 | 产品画像 + 实时热点 | 你 / 宿主检索 | `brief`：产品名、品类、人群、卖点、调性、禁用词；热点清单 | 热点是创意的依据，不是装饰 |
| 1 | 创意 idea | 生产 Agent | `01-idea.json`：3 个方向 + 评分 + 推荐 | ≥3 个方向、每方向挂到真实热点、钩子能拍、禁用词不出现 |
| 2 | 故事剧情 | 生产 Agent | `02-story.json`：logline、人物、三幕节拍、落点 | ≥3 幕、≥6 拍、节拍合计贴近目标时长 |
| 3 | 分镜脚本 | 生产 Agent | `03-storyboard.json`（shot-contract 结构） | **shot-contract 的 13 道门**，逐字判定 |
| 4 | 人物形象六维 | 生产 Agent + 生图 | `04-characters.json`：六维档案 + 定妆图 | 六维每维写具体、定妆提示词覆盖 ≥4 维、分镜里出场的人一个不少 |
| 5 | 配音方案 | 生产 Agent | `05-voice.json`：人物音色、每句台词的情绪/语速、BGM | 台词逐条覆盖、音色在音色表内、说话人都有音色 |
| 6 | 分段出片 | 宿主 + H3 | `segments/*.mp4` | 每段 5–15 秒、全部落盘 |
| 7 | 成片剪辑 | 剪辑团队 Agent + 宿主 ffmpeg | `06-edl.json`、`07-final.mp4`、`08-publish.md` | 剪辑清单覆盖每段、成片实测时长在目标 ±10%、响度合理、终审打分过线 |

### 人物形象的六维

不是「写一段人设」，而是六个能被画出来的维度，缺一维就过不了门：

1. **骨相与脸型** —— 脸型、骨相、年龄感、面部比例
2. **五官与妆容** —— 眼睛、眉毛、鼻子、嘴唇、妆感与肤色
3. **发型与发色** —— 长度、结构、颜色、蓬松度、发质
4. **服装与配饰** —— 上装、下装、材质、颜色、配饰与鞋
5. **体态与动作习惯** —— 身高体型、站姿、手势、习惯小动作
6. **气质与记忆点** —— 气场、说话方式、标志物、惯用光影

过了门之后宿主会用这六维拼一条定妆提示词去生图，定妆图会在出片时作为**多参考图**喂给 H3，
让同一个人在不同段里长得一样。

### 配音：方案 + 落地

配音阶段分两步，方案由生产 Agent 出，声音由宿主合成：

- **方案**（`05-voice.json`）：音色只能从内置音色表（12 个）里选，每个说话人一个，同一人物全片不变；
  每句台词带情绪与语速，逐条对应分镜里的台词节拍（`beatId` 一一对上）；再加一条 BGM 方案（情绪 + 编制 + BPM）。
- **落地**（`engine/voice.js`）：方案过门后逐句调 TTS 合成 mp3，落在 `<项目>/voice/<beatId>.mp3`，
  `beatId → 音色/语速/时长` 写进 `voice/manifest.json`（同文本同音色不重复合成）。
  面板的配音表每句带试听按钮，源文件走 `/creative-studio/file?kind=voice&beatId=…`。
- **音色映射**：`VOICE_TTS` 把 12 个审美 id（`v_f_warm` 等）映射到 edge 音色，`UNISOUND_VOICES` 映射到云知声音色
  （温暖/知性/苍老/沉稳都有真音色，比 edge 的 6 个中文音色分得开）。`ttsProvider: 'unisound'` 时走
  `tools/unisound_tts.py`（异步任务：创建 → 轮询 → 下载），情绪词按枚举下发，音色不支持时自动去掉重试。
- **时长门**：每句合成后和它所在镜头的计划时长比。超了就按比例加速（上限 `ttsMaxRate`，默认 1.3 倍）再合成一次；
  加速到上限仍超出 0.6 秒的，配音阶段停下、进人工复核，提示「缩短台词或把这一镜加长」（`creative_studio_edit_shot` 能改时长）。
  小溢出（≤0.6 秒）只记警告，混音时贴着段尾收。
- **铺轨**：剪辑阶段拿到**真实段长 + EDL 的段重排/裁切**后才定最终时间轴；被剪掉的镜头里的台词直接丢掉。

## 参考爆款（可选，来自「爆款复刻」）

热点之外还能喂一条**已经火过的片子**。两种用法：

**1）拉片台（不建项目也能用）** —— 面板最上面一块：「拉片台（爆款复刻）」。
贴抖音分享文案/链接，或填一个本机 mp4 路径 → 开始拉片。跑完就能看：
联系表（12 格）、逐镜帧（可横向翻）、镜表、台词/字幕、拆解报告、**复刻分镜**（shot-contract 结构，
生成后自动补锁行并过一遍 13 道门，门禁结果显示在按钮旁边）。
记录会一直留在「拉片记录」下拉里；填一个产品名点「用它开一个项目」，就会用这份报告开一个创意项目。

**2）项目内参考** —— 创意项目里的「参考爆款（拉片）」卡片，拉完直接作为这个项目的创意证据。

拉片本身不重写：调用 `douyin-teardown` 技能里已经验证过的三个脚本。

```
fetch.mjs   链接 → video.mp4 / meta.json（yt-dlp；被挡时按脚本提示换完整链接或本机视频）
frames.mjs  视频 → shots.json / frames/*.jpg / contact-sheet.jpg / audio.wav
asr.py      音频 → transcript.json（faster-whisper，转写失败不影响继续）
```

报告进入创意阶段的证据，并在提示词里硬性要求：至少一个方向要借用它验证过的结构，
但人物、场景、台词必须换掉。

### 接入 rea-video（可选：逐镜判定「实拍 / AI / 代码」，并给复刻路线）

[rea-video](https://github.com/JuneYaooo/rea-video)（Apache-2.0）不是渲染器，是**逆向拆解器**：
逐镜判断画面是实拍、AI 生成、3D/代码渲染还是静态图推拉，给出证据与置信度，并给出每镜的复刻路线；
还能拆字幕时间轴、花字贴纸、声音来源（人声/BGM/音效）、拍摄布光与调色。

接法（一次性）：

```bash
git clone https://github.com/JuneYaooo/rea-video.git D:\智贸\10-创意工作台\tools\rea-video
cd D:\智贸\10-创意工作台\tools\rea-video
python -m venv .venv
.venv\Scripts\python -m pip install -e .
```

然后把这个路径填进配置 `reaVideoCmd`：`.venv\Scripts\rea-video.exe`。装好之后，每次拉片会多跑一遍：

```
rea-video decompose <video> -o <reference>/rea --lang zh --no-packaging
rea-video summary   <reference>/rea/breakdown.json
```

- 逐镜判定（含次选概率、置信度）写进报告的「制作方式判定」一节；
- `video/timeline.md`（一行一镜）和 `VIDEO.md` 会一起作为复刻分镜的证据；
- 复刻分镜的每个镜头多两个字段：`origin`（live/ai/code/still/unknown）和 `route`（这一镜怎么复刻）；
- 面板上能直接看摘要、逐镜时间线和 `report.html` 路径。

不装也能用（拉片走自己的镜头检测 + 转写 + 报告）。装但跑失败时不影响基础拆解，
只在面板上记一行 `reaError`。两个已知坑插件已经处理：Windows 中文环境必须 `PYTHONUTF8=1`
（否则 ffprobe 的 JSON 会被 cp936 解坏）；首次运行要下模型（人脸 ~10MB、人声分离 ~67MB、音效 ~149MB），
下载失败会自动降级成「没有分轨/人脸证据」，不影响逐镜判定。

### 看图复核（agent 当 VLM）

工具只能测帧率、噪声、AIGC 标识；「这一镜画面里到底是什么」得有人看。所以跑完 `decompose` 之后，
插件会调 `rea-video review` 生成逐镜看图任务，再**把每个镜头的关键帧图交给宿主当前能看图的模型**：

1. 逐镜问 11 类画面（实拍 / AI / 数字人 / 3D / 代码渲染 / 录屏 / 静态图推拉 / 静帧 / 2D 动画 / 定格 / 影视片段），
   要它给概率分布、证据、画面描述、以及这一镜在叙事里的作用；
2. 整片再给一次联系表，让它补「核心看点 / 角色 / 场景 / 道具」；
3. 答案写回 `review_answers.json` → `rea-video apply-review` 并入结论（工具证据与画面判断融合，冲突会被记下来）；
4. 融合后的 `summary` 与逐镜时间线再进报告和复刻分镜。

面板上会显示「看图复核 N/M 镜」。配置项：`reaVision`（默认开，关掉就只跑工具判定）、
`reaVisionShots`（一次最多看几个镜头，低置信的优先，默认 12）。模型看不了图时会记 `visionError` 并自动降级。

## 三个 Agent 怎么协作

```
           ┌──────────── 生产 Agent（Producer）────────────┐
产品画像 ──►│ idea → story → storyboard → characters → voice │──► 门禁 ──► 审核 Agent ──┐
热点清单   └──────────────────────────────────────────────┘         ▲                 │
                                                                   │ 打回（带问题清单）│
           ┌──────────── 剪辑团队 Agent ────────────┐                 │                 │
分片 ─────►│ 节奏剪辑师 / 声音设计师 / 包装师 → EDL  │──► EDL 门禁 ──► ffmpeg ──► 审核 Agent ──┐
           └────────────────────────────────────────┘                                    │
                                                                        重试用完 ──► 待你复核 ◄┘
```

三个 Agent 是**三次独立的模型调用**，各自独立上下文、独立角色提示、独立产出契约：

- **生产 Agent**：只写内容，不做出片调度，不做终审。每次被打回时，上一轮的门禁失败项与审核意见会逐条塞回它的提示词。
- **剪辑团队 Agent**：一个提示里坐三个人——节奏剪辑师定顺序与切点，声音设计师定 BGM 与响度，包装师定标题与话题。它只出「剪辑清单（EDL）」，真正动手剪的是宿主的 ffmpeg。
- **审核 Agent**：只做质检。五维各 0–20 分（钩子力 / 叙事完整 / 可执行性 / 一致性 / 合规），有 blocker 或总分低于阈值就判 rework。每条问题必须指到具体位置并给可执行修法。

模型走宿主自己的 `ctx.llm`，跟随当前默认模型；不需要在这个插件里再配一套模型 Key。

## 打回重做与「通知我复核」

每个阶段都是同一个循环：

1. 生产 → 写产物文件
2. 跑确定性门禁（分镜阶段直接用 shot-contract 技能里的 `check.mjs`，和技能是同一份判定）
3. 交给审核 Agent 打分
4. 任一不过 → 把「门禁失败项 + 审核意见」拼成问题清单，重新生成（默认最多重做 2 次）
5. 重试用完仍不过 → 阶段置为 `待人工复核`，并**通知你**：
   - 面板上该阶段出现红色复核条，列出门禁失败与审核问题
   - 响一声 + 发一条浏览器系统通知（需要你点一次「开启通知」授权）
   - 写入 `inbox.json`，Agent 也能通过 `creative_studio_status` 看到
   - 配置了 `notifyWebhook` 的话再 POST 一条 JSON（飞书/钉钉机器人直接可用）

复核时你可以：**通过**（记为完成）、**打回重做**（把意见写进下一轮提示词）、**跳过**。

## 出片与剪辑

- **出片**：一段 = 一次生成任务。分镜里的每个 `segment` 提交一次，画幅跟项目一致，时长夹在 5–15 秒
  （两套上游接口的下限都是 5 秒，低于会被直接拒单）。
  后端两套并在一个引擎后面：`easyframe`（EasyFrame MiniMax-H3，文生/首帧/首尾帧/多参考）和 `mnmx`（鼠鼠工具 H3 v2）。
  `videoProvider: auto` 时先 EasyFrame，遇到鉴权/额度/维护/网络这类「换一家还有救」的错误再退到鼠鼠；提交成功之后不再换（查询和下载必须回到提交它的那一家）。
- **字幕带**：H3 有时会把提示词里引号内的台词烧成字幕，且不吃「不要字幕」的负向指令。
  所以留了一个开关 `trimSubtitleBand`（**默认关**）：打开后下载时裁掉底部 18%，原片保留。
  实测这一轮的生成并没有烧字幕，裁了反而把 9:16 变成 0.70 的画幅、剪辑时只能上下留黑边，
  所以默认不裁；真遇到烧字幕再打开。
- **时长是硬门**：剪辑清单会被按每段的**真实可用时长**算一遍总量，成片实测时长必须落在目标 ±10%，
  否则这份 EDL 直接被打回重算（不靠模型自己报数）。
- **剪辑**：EDL 只允许 `cut` / `fade` 两种转场。`fade` 由宿主在统一规格时给每段首尾各做 0.25 秒淡入淡出
  （等价于过黑切），不做 xfade 交叉溶解——这样每段的音频不会错位，也能全程用 concat 打通。
  统一规格：等比缩放 + 黑边补足到 `outWidth × outHeight`、30fps、aac 48k 立体声。
  最后混 BGM（`bgmDir` 里模糊匹配）+ 对白 + 响度归一（`loudnorm` 到 EDL 指定的 LUFS，默认 -14），抽一帧当封面。
  对白铺轨：OpenFilm 路径每句一条 `<audio at="…">`（声音 clip 由 OpenFilm 混在一起）；
  ffmpeg 路径用 `adelay` + `amix` 铺开，BGM 过 `sidechaincompress`——有人说话就自动让路。

### 收尾器：ffmpeg 或 OpenFilm（`finisher`）

同一个 EDL 有两条收尾路径，默认 `auto`：装得上 OpenFilm 就用它，任何一步失败就退回 ffmpeg，
不会因为收尾器把整轮剪辑判死。

| | ffmpeg（原路径） | OpenFilm（`finisher: 'auto'` / `'openfilm'`） |
|---|---|---|
| 怎么做 | 逐段重编码统一规格 → concat → 混 BGM → loudnorm | 片段原样写进 `film.html`，`#t=in,out` 裁剪，画幅靠 CSS 消化 |
| 成片 | 只有 `07-final.mp4` | 同一份 `film.html` + `07-final.mp4`，片子之后还能手改 |
| 时长 | 探针读 | 探针读（实测与 ffmpeg 路径差 0.02s 以内） |
| 额外能力 | — | 字幕带（`captions.vtt`）、LUT 调色、4K、硬件编码、Studio 里手改 |
| 代价 | — | 机器上要有 Node + ffmpeg + 一次性的 Chromium（约 114 MB） |

走 OpenFilm 时：

- 项目根会多一个 `film.html`——就是这部片子的工程。`openfilm open <项目目录>` 能在 Studio 里打开手改，
  改完 `openfilm render` 重渲；反过来说，agent 重跑也不会覆盖人手改过的 `overrides`。
- `--loudness` 取 EDL 的 `audio.lufs`；BGM 用 `audio.gainDb` 换算成线性音量，比成片短就首尾相接地铺满。
- 渲染完自动跑一遍 `openfilm look --full --loudness=…`：**硬问题（✗）一票否决**（和画面验收同级），
  提醒（!）进审核证据、不单独判死；体检结果落在 `project.json` 的 `stages.edit.openfilm`。
- 项目里放一份 `captions.vtt` 就会被当字幕带烧进画面（样式写在 `film.html` 的 `::cue` 里）。

配置：`finisher`（默认 `auto`）、`openfilmCmd`（留空自动找：npm 全局包 → PATH 上的 shim → 裸命令）、
`openfilmWorkers`（并发浏览器数，0 让 OpenFilm 自己定）、`openfilmLook`（默认开）。

OpenFilm 本身用 `npm i -g openfilm` 装就行（约 265 MB，含打包好的 Studio），不需要源码检出；
只有想改 OpenFilm 本身时才用 `openfilmCheckouts` 指到 `packages/openfilm/bin/openfilm.mjs`。

**画质**：OpenFilm 的 render 没有码率参数——它优先用硬件编码器的「高质量」档，1080×1920 大约 1.2 Mbps，
平台投递偏软。所以给了一档超采样：

| `openfilmQuality` | 怎么渲 | 1080×1920 实测 | 适用 |
|---|---|---|---|
| `native`（默认） | 直接渲 | 28.8s / 4.77 MB（1.19 Mbps）/ 55s | 预览、内部看片 |
| `high` | 先渲 2160×3840，再用 lanczos 降到交付尺寸 | 6.4s 片子 27s 渲 + 降采样，8 Mbps 时 4.55 MB | 交付、投流 |

`high` 时用 `openfilmBitrate`（Mbps）定码率，0 则 CRF 18 自动。放大约 4 倍时间，换来明显更实的高光、
字幕边缘和雾气细节（同一帧对比：原生 1.19 Mbps 的字边缘有明显块状，超采样后没有）。


验收这套接法不用花额度：

```bash
node test/openfilm.test.mjs              # 合成片段：film.html 结构 / 渲染 / 体检 / BGM 铺满 / 重渲一致（11 项）
node test/real-project.mjs <项目目录>     # 真实项目：拿已有的 06-edl.json + segments 再收一次尾，和旧成片比时长
```


## 产物目录

```
<projectDir>/<项目 id>/
  project.json          项目与七个阶段的状态（唯一真相）
  01-idea.json          创意
  02-story.json         剧情
  03-storyboard.json    分镜（可单独拿去过 shot-contract 的 13 道门）
  04-characters.json    人物六维 + 定妆图
  05-voice.json         配音方案
  voice/                逐句合成的配音（<beatId>.mp3 + manifest.json）
  06-edl.json           剪辑清单 + 发布包
  07-final.mp4          成片
  08-publish.md         发布包（标题/文案/话题/剪辑判断）
  segments/             分段成品（含 *.trimmed.mp4）
  portraits/            定妆图
  edit/                 归一后的中间片段与拼接结果
  review/               每次审核的完整记录（产物 + 门禁 + 评分）
```

## 面板

左侧栏「创意工作台」一行，点开在主区域整页打开：

- 顶部：项目下拉（有 ⚠ 的项目在等复核）、新建、刷新
- 产品画像卡：折叠编辑 + 热点区（一键抓热点 / 手填）
- 流水线：七个阶段逐行显示「谁负责 / 状态 / 审核分 / 第几版 / 门禁失败数」，展开看产物
  （创意卡片可换方向、剧情大纲、镜表与每镜提示词、人物六维与定妆图、配音表、出片任务与预览、剪辑清单与成片）
- 底部落盘日志：每个动作一行，带时间

面板本身不碰文件系统、密钥和 ffmpeg，所有请求都走宿主侧的私有前缀路由 `/creative-studio/api`，
鉴权和宿主一致（`connection.requestRejection`）。成片用 `/creative-studio/file` 流式播放，支持拖进度条。

## Agent 工具

| 工具 | 用途 |
|---|---|
| `creative_studio_new` | 建项目（产品画像 + 目标），返回项目 id |
| `creative_studio_status` | 看阶段状态、审核分、门禁失败、待复核项 |
| `creative_studio_run` | 跑流水线（可指定从哪个阶段开始、`only` 只跑一个阶段、可把意见带进这一轮） |
| `creative_studio_decide` | 对待复核项裁决：通过 / 打回（带意见）/ 跳过 |
| `creative_studio_edit_shot` | 改一个镜头（提示词/动作/时长）或一句台词，改完重跑 13 道门；改台词会自动同步进认领它的镜头提示词 |

原来两个插件的工具名**原样保留**，实现已经换成工作台自己的引擎，技能里的老调用不会失效：

| 工具 | 用途 |
|---|---|
| `h3_generate_video` | 文生视频 / 首帧 / 首尾帧 / 多参考（5–15 秒，480p/720p，9 种画幅） |
| `h3_generate_image` | 生图：默认走「生图工作台」配置的接口，读不到再退 Codex，最后退 HTTP 端点 |
| `h3_concat_videos` | 按顺序把已完成的任务拼成一条 MP4 |
| `h3_video_tasks` | 查独立出片任务（持久化索引，重载插件后还在） |
| `h3_remix_video` | 拉片 + 报告（`replicate: true` 时连复刻分镜一起出） |

## 配置

全部在这一行 `config` 里，改完重载插件生效：

| 字段 | 说明 |
|---|---|
| `projectDir` | 项目落盘目录 |
| `dataDir` | 独立出片任务、生图与拉片任务索引（默认 `~/.dsh/creative-studio`） |
| `llmTimeoutMs` / `llmMaxTokens` | 三个 Agent 的单次调用上限与输出预算 |
| `reviewThreshold` | 审核通过线（0–100），默认 80 |
| `reviewPolicy` | `balanced`（默认）：门禁过、无 blocker、分数 ≥ 阈值−12 就带建议收下；`strict`：必须审核说 pass 且到阈值 |
| `promptsDir` | 阶段提示词外置目录，默认 `<dataDir>/prompts`；`<stage>.md` 存在就追加到内置指令后面 |

### 环境自检

`npm run doctor` 或面板「提示词模板」页的「运行自检」：检查 Node、`machine.json`、项目/数据目录可写、ffmpeg、shot-contract、拉片脚本、rea-video、Codex、OpenFilm、出片密钥、生图后端与包内文件，逐项给修复提示；有失败项时退出码 1。
| `maxRework` | 单阶段自动重做次数，默认 2 |
| `aspectRatio` / `resolution` / `videoModel` | 出片默认档位 |
| `videoProvider` | `auto` / `easyframe` / `mnmx` |
| `easyframeApiKey` / `easyframeBaseUrl` | EasyFrame 出片 |
| `mnmxBaseUrl` / `mnmxCardKey` | 鼠鼠工具出片 |
| `trimSubtitleBand` / `subtitleBandRatio` | 下载后裁字幕带 |
| `imageBaseUrl` / `imageKey` / `imageModel` | 定妆图（OpenAI 兼容端点，默认本机号池） |
| `ffmpegPath` / `outWidth` / `outHeight` | 剪辑 |
| `bgmDir` | BGM 目录（EDL 按情绪描述模糊匹配文件名） |
| `ttsScript` / `ttsPython` | 配音落地的 TTS 脚本与解释器（默认指向 Easel 的 `skills/shared/scripts/tts.py`；留空 = 只出方案不出声） |
| `ttsProvider` | `edge`（免费，默认）/ `unisound`（云知声 U2-TTS，要 key；异步任务，内置 `tools/unisound_tts.py` 适配） |
| `ttsApiKey` / `ttsBaseUrl` | 云知声的 API key 与接口地址（key 只写在本机 `machine.json`，不进仓库） |
| `ttsEngine` | 兼容旧字段：`ttsProvider` 留空时用它（`edge` / `closed`） |
| `ttsMaxRate` | 台词超镜头时自动加速的上限，默认 1.3（= 最多快 30%） |
| `skillDir` | shot-contract 技能目录（分镜门禁直接 import 它的 `check.mjs`） |
| `scriptsDir` / `nodePath` / `pythonPath` / `asrModel` | 参考爆款的拉片脚本与解释器（默认指向 `douyin-teardown` 技能） |
| `reaVideoCmd` | 可选：rea-video 可执行文件。填了就在拉片时多跑一遍逐镜判定；留空跳过 |
| `reaVision` / `reaVisionShots` | 拉完用当前能看图的模型做逐镜看图复核；一次最多看几个镜头（默认开 / 12） |
| `notifyWebhook` | 需要复核时的额外推送地址（留空不推） |
| `finisher` | 收尾器：`auto`（有 OpenFilm 就用）/ `openfilm` / `ffmpeg` |
| `openfilmCmd` / `openfilmCheckouts` | OpenFilm 命令行的位置；留空依次试检出目录与 PATH |
| `openfilmWorkers` / `openfilmLook` | 渲染并发浏览器数；渲染完是否跑逐帧体检（默认 0 / 开） |
| `openfilmQuality` / `openfilmBitrate` | 画质档 `native` / `high`（2 倍画再降采样）；`high` 时的目标码率（Mbps，0=CRF 18） |

密钥写进 `cordis.patch.yml` 就是明文；对外分发请改成环境变量（`EASYFRAME_API_KEY` / `MNMX_CARD_KEY` / `FFMPEG_PATH`）。

## 限制与提醒

- **审核 Agent 看的是文本证据**：它读产物 JSON 与剪辑清单，不逐帧看画面。画面的最终判断仍然要你点开成片看。
- **审核有阶段边界**：每次只审当前阶段的产物，「缺分镜 / 缺台词 / 缺时长」这类跨阶段缺失不会被扣分。
- **禁用词按字面匹配**：写 `最` 会连「最后」一起拦，把禁用词写成完整的词（`最好`、`第一`）更准。
- **BGM 不联网找曲子**：只在 `bgmDir` 里按 EDL 的情绪描述匹配文件名；没有就只做配音轨。
- **配音默认走 edge**：免费、要外网；edge 只有 6 个大陆中文音色，音色表里 5 个女声会靠语速微调拉开，听起来仍是同一副嗓子。要真区分音色得配闭源 provider（CosyVoice2 等）。
- **配音不做口型同步**：H3 出的是「演」，不是唇形对口型。旁白/内心独白/口播没问题，正面特写说话会显假；原片自带人声的复刻场景不要叠配音。
- **任务进度在内存里**：重载插件会清掉进行中的轮询，但已落盘的成片与所有 JSON 仍在项目目录里。
- **成本**：一次完整跑 = 若干次文本模型调用 + 每段一次 H3 生成（按时长×分辨率计费）+ 若干次生图。重做会重复花文本与生图的钱，但已完成的分段出片不会重复提交。
