<div align="center">
    
# 肥鱼云盘

`dsh-session-log-upload` 
`dsh-zcode-like`

**让用户自己决定会话日志什么时候上传到 DeepSeek。**

**让你的DSH会和zcode一样偷代码!**
</div>
装上之后默认什么都不变。

## 安装

**插件管理器**：在 DSH 设置里的插件页安装。

**手动挂载**：把包链接进 profile 的 `node_modules`，再加一条 patch 行：

```powershell
cmd /c mklink /J "C:\Users\<you>\.dsh\profiles\desktop\node_modules\@local\dsh-session-log-upload" "<bundle-root>"
```

```yaml
- insert:
    - id: session-log-upload
      name: '@local/dsh-session-log-upload'
      config:
        mode: official-only
```

改了插件源码不会热重载。改动 profile 的 `cordis.patch.yml`（哪怕只改一行注释）会让这一行重启并加载新代码，重启 DSH 同理。

## 四种模式

| 模式 | 含义 |
|---|---|
| `off` | 什么都不传，DSH 自带的官方上传也一并停掉 |
| `official-only` | 默认。只跟随本来要发往 DeepSeek 官方 API 的请求捎带日志 |
| `deepseek-any-provider` | 在上面基础上，模型 id 命中名单时额外发一条只带日志的请求，别的供应商服务的也算 |
| `any-model` | 在上面基础上，每次带会话的模型请求之后再额外发一条 |

`mode` 缺失或取值不认识时回落到 `official-only`。

## 配置

所有键都可选。设置页在「设置 → 会话日志上传」。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `mode` | enum | `official-only` | 见上表 |
| `deepseekModelPatterns` | `string[]` | `['deepseek']` | 模型 id 的子串，不区分大小写 |
| `uploadDirectories` | `string[]` | `[]` | 空表示所有工作区，填了目录就只上传这些目录（含子目录）里的会话 |
| `uploadSessionIds` | `string[]` | `[]` | 单独勾选的 DSH 会话 id，和目录白名单是「或」的关系 |
| `foreignSessionIds` | `string[]` | `[]` | 导入时勾选的会话，形如 `zcode/sess_xxx` |
| `endpoint` | string | DeepSeek 官方端点 | 只带日志那条请求的目的地。必须是绝对 http(s) URL，否则回落默认值 |
| `uploadModel` | string | `deepseek-flash` | 那条请求的 `model` 字段，需为官方 API 认识的名字（`deepseek-flash` 或 `deepseek-v4-pro`） |
| `credentialRef` | string | `DEEPSEEK_API_KEY` | 通过 `ctx.credentials.resolve(ref)` 解析 |
| `maxBytes` | int ≥ 1 | `134217728`（128 MiB） | 单次请求里 `dsh_session_log` 字段的字节上限。本机最大的会话整段约 51 MiB，128 MiB 基本一次就能发完 |
| `updateUrl` | string | 本仓库的 GitHub raw 清单地址 | 更新清单地址，必须是绝对 http(s) URL，否则回落默认值 |

`mode`、`deepseekModelPatterns`、`uploadDirectories`、`uploadSessionIds`、`foreignSessionIds`、`endpoint`、`maxBytes`、`updateUrl` 能在设置页直接读写；`uploadModel` 和 `credentialRef` 只能改 `cordis.patch.yml`。

### 反代改了模型名怎么办

`deepseek-any-provider` 按模型 id 的子串判断，默认名单 `['deepseek']`，不区分大小写。反代把 DeepSeek 命名成 `dfmodel` 时，名字里没有 `deepseek`，这个模式会跳过，不传也不报错。在设置页「把这些模型当作 DeepSeek」里加一行 `dfmodel` 即可；这个名单只在该模式下出现。

### 只上传指定目录

默认所有工作区的会话都上传。想收窄，在设置页勾「选择指定目录」，点扫描，再勾选目录。之后只上传这些目录（含子目录）里的会话，DSH 自带的上传也一并受限。路径比较不区分大小写，`\` 和 `/` 视为相同；清空选择就回到全部上传。

目录已经放行，单独取消某个会话不生效。要单独控制某个会话，先取消那个目录。

## 会上传什么，传到哪

会话日志是一段对话的完整记录：消息、模型输出、工具返回结果，以及涉及的文件路径。附件只是引用，图片和文件的字节内容不上传。

`endpoint` 默认是 DeepSeek 的 Anthropic 兼容端点 `https://api.deepseek.com/anthropic/v1/messages`，可以在设置页改；只要对方接受同样的请求格式，也可以指向其他服务商的端点或自己的收集器。确认弹窗里写的是当时生效的 endpoint，不是写死的 "DeepSeek"。装好后第一次进入设置页会弹一次免责说明，勾选「我已阅读并理解」并继续之后不再出现。

只带日志的那条请求，形状和 DSH 自带的官方上传器一致：

- 同一个端点，同一套认证头（`x-api-key`；账号路由用 `x-dsh-auth-token`，且只发给官方域名）
- 同一套 attribution 头：`user-agent`、`x-deepseek-harness-user-id`（匿名 id）、`x-deepseek-harness-session-id`
- `dsh_session_log` 字段与官方格式逐字节一致

不同的是 `model` 用占位值（`deepseek-flash`）、`max_tokens` 为 1、`messages` 里只有一条载体消息，内容写明触发这次上传的 provider 和 model：

```
DSH session-log upload. Source: provider=acme-relay model=deepseek-v4-pro. The Session log is carried in the dsh_session_log field.
```

attribution 头取不到就省略，不编造 id，也不会因此让上传失败。这两个值来自运行中安装里的模块，只在 Electron 下能解析。

## 从其他 harness 导入

设置 → 会话日志上传 →「从其他 HARNESS 导入」。扫描读取本机 ZCode、Qoder、Cursor、WorkBuddy、Cline 、Codex等harness记下的会话，勾选后点发送，每个会话单独发一次，某一行失败不影响其余。

发出去的是 DSH 格式的会话记录

- 会话 id 合成，形如 `foreign-zcode-a1b2c3d4e5f6`。同一原始会话每次算出同一个 id，重复发送从上次停下的位置接着发。
- 第一条事件是来源标记,例如: `Source: harness=zcode provider=… model=… session=…`，原始供应商和模型只出现在这一行。
- 之后每条消息一个事件，用户和助手分开；助手消息的模型写 `deepseek-flash`，供应商写 `deepseek`。

目录和会话白名单只管 DSH 会话，管不到导入；导入也不改变四种模式，是另一条独立的路径。扫描只读元数据（标题、目录、模型、消息数），正文在点发送时才读取。外部日志里常有整条命令的输出和文件内容，可能带密钥，发之前先确认目标。各 harness 改了存储格式可能扫不出来，这时会报错而不是静默少列。

扫描结果按文件大小和修改时间缓存到磁盘，第二次扫描和重启 DSH 后都直接命中，文件变了才重读那一个。子代理会话缩进显示在父会话下面，默认折叠，按钮上写着隐藏了多少条；勾一个父会话会带上所有子代理。

## 插件更新

设置 → 会话日志上传 →「插件更新」显示当前版本和清单地址，点「检查更新」比对远端清单，有新版本时可以一键升级。
下载到的版本号等于清单声明的版本号，并核对每个目标路径的上级目录落在插件目录内（指向外面的目录联接会被拒）。升级后需重启 DSH，插件不改 profile、不热重载。

清单没有签名，信任的是本机到清单地址的 HTTPS。地址默认指向本仓库，可以改成自己的镜像或 fork，升级确认框里也写明这一点。清单地址由 `updateUrl` 指定，默认 `https://raw.githubusercontent.com/guguzea/dsh-zcode-like/main/update-manifest.json`，raw 拉不到时自动回退到 jsDelivr；自己填的地址不回退。备份目录形如 `.update-backup-<旧版本>-<时间戳>`

## 已上传的会话

设置 → 会话日志上传 →「详细日志」列出每个上传过的会话：会话 id、传到第几个事件、时间、格式版本。同一个列表也能在会话里用 `/session-log-upload uploaded` 查看，它还会报本次加载以来有没有成功上传过，以及 attribution 头在当前安装里能不能解析。

里面是索引，不含提示词、标题、文件路径或消息正文。
会话标题默认不显示，需要自己在设置页打开开关。它只记录本插件发起的上传，`off` 或 `official-only` 下是空的，**DSH 自带的上传不出现在这里**。上传是至少一次语义：服务端接受之后、水印写入之前如果崩溃，这段范围会重发，因此可能重复。

## 上传失败了怎么看

设置页的详细日志会显示上一次失败：类型（没有凭据 / 端点被拒 / HTTP 错误 / 传输失败 / 单条事件超过字节上限 / 未知）、HTTP 状态码、时间、会话、是否自动重试和具体诊断。成功上传后清空。`payload-too-large` 不会自行恢复，单条事件超过 `maxBytes` 时需要调大上限，否则那个会话会一直卡住。

失败记录在 `$DSH_HOME/session-log-upload/last-failure.json`，只存诊断，不存会话内容。

## 文件在哪

都跟着 `$DSH_HOME`（非空的 `DSH_HOME` 优先，`~` 会展开，否则 `~/.dsh`）：

- `session-log-upload/watermarks.json` — 每个会话传到哪了（导入的外部会话按合成 id 记在里面）
- `session-log-upload/foreign-scan-cache.json` — 其他 harness 的扫描缓存
- `session-log-upload/last-failure.json` — 上次失败
- `session-log-upload/notice-acknowledged.json` — 免责说明点过没有

扫描缓存只存索引：文件路径、标题、模型、消息条数。删掉它只会让下次扫描变慢。删掉水印文件不会损坏会话，只是下次重发。

## 卸载

插件管理器里移除 `@local/dsh-session-log-upload`。手动挂载的话，删掉 profile patch 里的 `insert` 段和设置页写入的覆盖行，再删掉 `node_modules\@local\dsh-session-log-upload` 这个链接。

## 许可

MIT
