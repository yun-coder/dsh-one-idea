# 创意工作台（dsh-creative-studio）

DeepSeek Harness 插件。把「产品画像 + 实时热点」做成一条能交付的短视频生产线：

```
创意 idea → 故事剧情 → 分镜脚本 → 人物形象六维 → 配音方案 → 分段出片 → 成片剪辑
```

三个角色各干各的，不是同一次调用换个提示词：

| 角色 | 负责 | 产出 |
|---|---|---|
| **生产 Agent** | 创意 / 剧情 / 分镜 / 人物 / 配音方案 | `01-idea.json` … `05-voice.json` |
| **剪辑团队 Agent** | 节奏、切点、声音、包装 | `06-edl.json` + 发布包 |
| **审核 Agent** | 每阶段打分、指出具体问题 | 分数 + 问题清单（不合格自动打回重做） |

每个阶段都过**确定性质量门**（不是模型自评）：分镜用的是 shot-contract 的 13 道门，
成片用 ffprobe 实测时长卡 ±10%，出片后还会**抽帧给能看图的模型做画面验收**，
查到物体变形 / 乱码 / 产品认不出就判不过。重试用完仍不达标 → 停下来通知人工复核。

分镜可以**只改一镜或一句台词**：面板里就地编辑，或调 `creative_studio_edit_shot`，
改完立刻重跑 13 道门、不重新生成整条分镜；改台词会自动同步进认领它的镜头提示词。

每个阶段的指令可以**外置改写**（面板「提示词模板」或 `<dataDir>/prompts/<stage>.md`），
改完下一阶段生效；配置与任务队列都落盘，宿主重启后卡住的阶段会标成「已中断」并告诉你怎么续跑。

也自带一个**拉片台**：贴抖音链接或本机 mp4，拆出逐镜时间线、联系表、台词、
制作方式判定（实拍 / AI / 代码渲染）与复刻分镜。

## 安装

要求：DSH ≥ 0.2.1-rc.2、Node 20+（DSH 自带）。

```bash
# 本地目录
dsh plugin --profile <profile> add /path/to/dsh-creative-studio
# 或 GitHub 仓库 / Release tarball
dsh plugin --profile <profile> add https://github.com/<you>/dsh-creative-studio
```

也可以在 **插件 → 添加插件** 里填本地目录。装完刷新页面，左侧栏出现「创意工作台」。

装完先跑一次自检，缺什么会一条条列出来（面板「提示词模板」页也有同一个按钮）：

```bash
dsh ... # 或直接在包目录
npm run doctor
```

第一次用可以点 **「载入示例项目」**：会带出一条 10 秒成品示例（两个镜头、已剪好、可直接播放），
从任意阶段重跑都行——先看结果，再看过程。

### 可选依赖（缺了会降级，不会崩）

| 组件 | 用途 | 没装时 |
|---|---|---|
| [shot-contract](https://github.com/) 技能 | 分镜 13 道门 | 分镜阶段会判「没有找到技能」并阻止出片——**建议必装** |
| [rea-video](https://github.com/JuneYaooo/rea-video)（Apache-2.0） | 逐镜判定实拍/AI/代码 | 跳过逐镜判定，只做基础拉片 |
| douyin-teardown 技能脚本 | 下载 / 切点 / 语音转写 | 拉片台不可用，其余照常 |
| FFmpeg 6.1+ | 剪辑、拼接、混音、抽帧 | 出片能跑，剪辑阶段失败 |
| OpenFilm（可选） | 成片收尾（字幕带 / LUT / 4K / 逐帧体检） | 自动退回 FFmpeg |
| Codex 桌面版（可选） | 人物定妆图（`image_generation`） | 退回 HTTP 生图端点；都没有就跳过定妆图 |

### 生图后端

`imageBackend: auto` 时优先用本机 Codex 的 `image_generation`（自动从
`~/.codex/config.toml` 找 `codex.exe`），否则走 `imageBaseUrl` + `imageKey` 的
OpenAI 兼容端点。也可以强制 `codex` 或 `http`。

注意：Codex 用你自己的额度，单张图大约 40k tokens、耗时 1–2 分钟。

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

## 已知限制

- **审核看的是文本 + 三帧抽检**，不是逐帧美术评审；最终能不能发仍要人看。
- **AI 生成的解剖与文字不可靠**：手脚、衣服印字、瓶身标签经常出错。产品特写建议实拍或用图生视频。
- **配音是方案不是合成**：给音色、情绪、语速与 BGM 方案，不本地 TTS。
- 单项目成本大约是几十次文本调用 + 每段一次视频生成（按秒计费）。

## 开发

```bash
node test/doctor.mjs        # 环境自检：Node/目录/ffmpeg/分镜技能/密钥/生图后端，缺什么给修复提示
node test/selftest.mjs      # 门禁 / JSON / 仓库 / ffmpeg 剪辑管线 / 提示词覆盖
node test/panel-smoke.mjs   # 面板整棵树渲染（不需要浏览器）
node test/eval.mjs          # 门禁评测集：17 条好/坏样例回归（改提示词或门禁后跑）
```

`tools/` 下是运维脚本（修分镜、重建锁行），不参与运行时。

## 许可

MIT。第三方组件见 [NOTICE](NOTICE)。
