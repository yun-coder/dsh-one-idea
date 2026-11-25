# 创意工作台（dsh-one-idea）

DeepSeek Harness 插件。把「产品画像 + 实时热点」做成一条能交付的短视频生产线：

```
创意 idea → 故事剧情 → 分镜脚本 → 人物形象六维 → 配音方案 → 分段出片 → 成片剪辑
```

**开工只要一句话。** 新建项目只有一个大输入框：丢一句想法，或把整段剧本贴进来。

- **有想法**：导演 Agent 读完自己补画像（产品/人群/调性/时长…），只挑真正影响成片的 1–4 件事问你，
  每条都带一个推荐值，点一下就算答，也可以「全部用默认」。
- **有剧本**：跳过创意发散，剧情阶段按你的场次和台词原文整理，不重写剧情、不换台词。
- 答完才开跑；没答完，面板和宿主调 `creative_studio_run` 都只会把问题交回来，不会带着半份画像一路跑到出片。
- **创意方向要你拍板**：三条 idea 过门后会停下来（`reviewIdea`，默认开），在创意卡片里选一个方向、点「通过」再跑剧情；设 `reviewIdea: false` 就一路自动跑。

三个角色各干各的，不是同一次调用换个提示词：

| 角色 | 负责 | 产出 |
|---|---|---|
| **导演 Agent** | 读一句话想法 / 整段剧本，补画像，只问真正影响成片的 1–4 件事 | `project.source` + `project.intake` |
| **生产 Agent** | 创意 / 剧情 / 分镜 / 人物 / 配音方案 | `01-idea.json` … `05-voice.json` |
| **剪辑团队 Agent** | 节奏、切点、声音、包装 | `06-edl.json` + 发布包 |
| **审核 Agent** | 每阶段打分、指出具体问题 | 分数 + 问题清单（不合格自动打回重做） |

每个阶段都过**确定性质量门**（不是模型自评）：分镜用的是 shot-contract 的 13 道门，
成片用 ffprobe 实测时长卡 ±10%，出片后还会**抽帧给能看图的模型做画面验收**，
查到物体变形 / 乱码 / 产品认不出就判不过。重试用完仍不达标 → 停下来通知人工复核。

分镜可以**只改一镜或一句台词**：面板里就地编辑，或调 `creative_studio_edit_shot`，
改完立刻重跑 13 道门、不重新生成整条分镜；改台词会自动同步进认领它的镜头提示词。

每个阶段的指令可以**外置追加**（面板「提示词模板」或 `<dataDir>/prompts/<stage>.md`），改完下一阶段生效。
面板里会先把这一段的**内置指令原文**摊开给你看，你写的内容追加在它后面、冲突时以你写的为准；
同一页顶部就是**运行自检**（装完 / 换模型 / 换接口后点一下，缺什么一条条列出来）。
配置与任务队列都落盘，宿主重启后卡住的阶段会标成「已中断」并告诉你怎么续跑。

配音不只是「方案」：过门后逐句合成 mp3（默认免费 edge，可切云知声 U2-TTS 的 12 个真音色），
台词比镜头长会自动加速，加速到头仍装不下就停下来等你改台词或加长镜头；对白会真的混进成片，
有人说话时 BGM 自动让路。面板里每句都能单独试听。

也自带一个**拉片台**：贴抖音链接或本机 mp4，拆出逐镜时间线、联系表、台词、
制作方式判定（实拍 / AI / 代码渲染）与复刻分镜。

**长视频不用先自己剪。** 片长超过 `referenceMaxSeconds`（默认 120 秒）时，拉片台会先截出
「起始秒 + 时长」这一段再拆（面板上填两个数，留空就是前 120 秒），记录里会写明原片多长、
只拆了哪一段。53 分钟 1080p 的片子整片解码光切点就要十分钟，先截一段是唯一跑得完的方式。

## 安装

要求：DSH ≥ 0.2.1-rc.2、Node 20+（DSH 自带）。

仓库：<https://github.com/yun-coder/dsh-one-idea>

```bash
# 直接从 GitHub 装
dsh plugin --profile <profile> add https://github.com/yun-coder/dsh-one-idea

# 或本地目录（开发时）
dsh plugin --profile <profile> add /path/to/dsh-one-idea
```

也可以在 **插件 → 添加插件** 里填仓库地址或本地目录。装完刷新页面，左侧栏出现「创意工作台」。

装完先跑一次自检，缺什么会一条条列出来（面板「提示词模板」页也有同一个按钮）：

```bash
dsh ... # 或直接在包目录
npm run doctor
```

### 可选依赖（缺了会降级，不会崩）

| 组件 | 用途 | 没装时 |
|---|---|---|
| [shot-contract](https://github.com/) 技能 | 分镜 13 道门 | 分镜阶段会判「没有找到技能」并阻止出片——**建议必装** |
| [rea-video](https://github.com/JuneYaooo/rea-video)（Apache-2.0） | 逐镜判定实拍/AI/代码 | 跳过逐镜判定，只做基础拉片 |
| douyin-teardown 技能脚本 | 下载 / 切点 / 语音转写 | 拉片台不可用，其余照常 |
| FFmpeg 6.1+ | 剪辑、拼接、混音、抽帧 | 出片能跑，剪辑阶段失败 |
| OpenFilm（可选） | 成片收尾（字幕带 / LUT / 4K / 逐帧体检） | 自动退回 FFmpeg |
| 生图工作台（推荐） | 人物定妆图（用它配置的接口与图片模型） | 退回 Codex，再退回 HTTP 端点 |
| Codex 桌面版（可选） | 人物定妆图（`image_generation`） | 退回 HTTP 生图端点；都没有就跳过定妆图 |

### 生图后端

`imageBackend: auto` 时按这个顺序选，读不到就往下退：

1. **「生图工作台」配置的接口**——直接读 `~/.dsh/image-workbench/server/config.local.json`
   里的 Base URL / Key / 图片模型（`config.local.json` 或 `DSH_IMAGE_SERVER_DIR` 可覆盖路径）；
2. 本机 Codex 的 `image_generation`（自动从 `~/.codex/config.toml` 找 `codex.exe`）；
3. 插件自己的 `imageBaseUrl` + `imageKey`。

也可以强制 `workbench` / `codex` / `http`。**模型不是写死的**：工作台换接口、换模型，下一次出图就跟着换。

## 配置

**仓库里不放任何密钥和本机路径。** 插件配置留空时依次回落：

1. 本机私有文件 `~/.dsh/creative-studio/machine.json`（推荐，不进仓库）
2. 环境变量
3. 代码默认值（项目与数据都在 `~/.dsh/creative-studio` 下）

`machine.json` 示例：

```json
{
  "projectDir": "D:\\work\\creative\\projects",
  "dataDir": "D:\\work\\creative\\data",
  "easyframeApiKey": "...",
  "mnmxCardKey": "...",
  "imageKey": "...",
  "ffmpegPath": "D:\\tools\\ffmpeg\\bin\\ffmpeg.exe",
  "skillDir": "C:\\Users\\you\\.dsh\\skills\\shot-contract",
  "scriptsDir": "C:\\Users\\you\\.dsh\\skills\\douyin-teardown\\scripts",
  "reaVideoCmd": "D:\\tools\\rea-video\\.venv\\Scripts\\rea-video.exe"
}
```

包里带了一份可直接复制的模板：[machine.json.example](machine.json.example)。

对应的环境变量：`EASYFRAME_API_KEY`、`MNMX_CARD_KEY`、`IMAGE_API_KEY`、
`FFMPEG_PATH`、`CREATIVE_STUDIO_DATA`、`CREATIVE_STUDIO_PROJECTS`。

关键项：`reviewThreshold`（默认 80）、`maxRework`（默认 2）、`aspectRatio`、
`resolution`、`videoModel`、`finisher`。

## 它会读什么、发什么

- **读本机文件**：项目目录、你贴进去的视频路径、人物定妆图、FFmpeg。
- **发网络请求**：EasyFrame / 鼠鼠工具（出片）、你的 OpenAI 兼容生图端点（定妆图）、
  宿主自己的检索与模型服务（热点与三个 Agent）。没有自建服务器，不上报使用数据。
- **会写盘**：`<projectDir>/<项目 id>/` 下的 JSON、分段 mp4、成片、审核记录。
- **HTTP 路由**只监听宿主自己的 Web 端口，并复用宿主的登录与来源校验。

### 删除会清掉什么

一个项目的数据分两处落盘：项目目录，和项目之外的关联记录（`<dataDir>/inbox.json` 复核通知、
`<dataDir>/queue.json` 运行队列）。删项目时两边一起清，不会留下指向已删项目的条目：

| 动作 | 清掉 | 保留 |
|---|---|---|
| 「删除项目」 | 该项目目录（含分段/成片/审核记录）+ 它的复核通知与队列行 | 别的项目；独立出片与生图产物 |
| 拉片台的「删除这条拉片记录」 | 该拉片目录（原片/联系表/逐帧/报告/复刻分镜）+ 关联记录 | 别的记录 |
| 顶部的「清空全部」 | 所有创意项目 + 拉片记录 + 关联记录 | 正在跑的项目（会跳过并提示） |

插件启动时也会顺手清一遍指向「已经不存在的项目」的历史残留。
报错文案在写盘和展示两侧都会压成一句人话（命令行、堆栈、上游日志不再铺到面板上）。

## 已知限制

- **审核看的是文本 + 三帧抽检**，不是逐帧美术评审；最终能不能发仍要人看。
- **AI 生成的解剖与文字不可靠**：手脚、衣服印字、瓶身标签经常出错。产品特写建议实拍或用图生视频。
- **配音已落地，默认是免费音色**：方案过门后逐句合成 mp3（edge-tts），台词比镜头长会自动加速、加速到头仍装不下就停下等人改。想换真·音色区分，把 `ttsProvider` 设成 `unisound` 并配 `ttsApiKey`（云知声 U2-TTS：官方只有 4 个中文女声、4 个男声变体，所以长辈用温厚声 + `pitch=偏低`、年轻角色用明亮/俏皮声 + 偏高，靠音色和音高一起拉开）。不做口型同步。
- **OpenFilm 收尾需要 Playwright Chromium**：没装时会在渲染现场下载浏览器（网络一卡就是几十分钟）；现在会先检查，缺浏览器就直接退回 ffmpeg。想用 OpenFilm 就先跑一次 `playwright install chromium-headless-shell`，或把 `finisher` 设成 `ffmpeg`。
- 单项目成本大约是几十次文本调用 + 每段一次视频生成（按秒计费）。
- **长片分镜走「省字模式」**：目标超过 60 秒时，模型只填现场表（动作/台词/机位/光线），镜头提示词由插件重建并补锁行，输出体积小一半，避免撞上模型输出上限被截断；失败时模型的原始输出会留在 `<项目>/review/storyboard-raw-N.txt`。
- **分镜进门前会确定性修门**：台词节拍按「字数/4.5 + 0.3 秒」补齐、纯对白镜补一个动作拍、镜长按节拍合计重算、段落按 ≤15 秒均分——只动结构和时长，不改台词与画面内容。

## 开发

```bash
node test/doctor.mjs        # 环境自检：Node/目录/ffmpeg/分镜技能/密钥/生图后端，缺什么给修复提示
node test/selftest.mjs      # 门禁 / JSON / 仓库 / ffmpeg 剪辑管线 / 提示词覆盖 / 导演确认
node test/panel-smoke.mjs   # 面板整棵树渲染 + 中英文案一一对应（不需要浏览器）
node test/panel-api.mjs     # 删项目/清空：目录与关联记录一起清，接口不返回裸报错
node test/intake-api.mjs   # 一句话/剧本开工：导演问题、确认门控、全部用默认、提示词内置指令
node test/reference-api.mjs # 长视频先截高光段再拉：截取、镜表、联系表、报告
node test/voice-smoke.mjs   # 配音落地：音色映射 / 时间轴 / 铺轨 / 混音 / film.html（不联网）
node test/eval.mjs          # 门禁评测集：17 条好/坏样例回归（改提示词或门禁后跑）
```

界面中英双语：`npm run i18n` 可以查两个语言包里有没有漏翻的键。

`tools/` 下是运维脚本与配音适配器（`unisound_tts.py`），后者参与运行时。

## 许可

MIT。第三方组件见 [NOTICE](NOTICE)。
