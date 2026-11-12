# dsh-session-log-upload

给 DSH 用的插件：让用户自己决定会话日志什么时候上传到 DeepSeek。

装上之后默认什么都不变。要放宽，得你自己点，而且得点两次。

## 四种模式

| 模式 | 含义 |
|---|---|
| `off` | 什么都不传。DSH 自带的官方上传也一并停掉。 |
| `official-only` | **默认。** 只跟随那些本来就要发往 DeepSeek 官方 API 的请求捎带日志。 |
| `deepseek-any-provider` | 上面那些之外，模型 id 命中你名单时，额外发一条只带日志的请求。别的供应商服务的也算。 |
| `any-model` | 上面那些之外，每一次带会话的模型请求之后都额外发一条。 |

`mode` 缺失或写了不认识的值，一律回落到 `official-only`。插件不会替你放宽模式。

## 会话日志里有什么

一段对话的完整记录：你的消息、模型输出、工具返回结果，以及涉及的文件路径。

附件只是**引用**，图片和文件的字节内容不会上传。

## 第一次打开会弹免责说明

装好后第一次进入设置页，会出现一段免责说明。勾选"我已阅读并理解"并继续之后，就不会再出现。

它不能点背景关掉，也不能按 Esc 关掉；勾选框没勾时"继续"是灰的。只有 Host 确认记录成功之后，弹窗才会消失。关掉一个没记录成功的弹窗，下次还会弹出来，而你不知道为什么。

记录存在 `$DSH_HOME/session-log-upload/notice-acknowledged.json`，只有一个布尔值和时间戳。想让它重新弹出来，删掉这个文件即可。

## 会传到哪里

`endpoint` 默认是 DeepSeek 的 Anthropic 兼容端点 `https://api.deepseek.com/anthropic/v1/messages`，可以在设置页改。

确认弹窗里写的是当时生效的那个 endpoint，不是写死的"DeepSeek"。你把 endpoint 指到自己的收集器，弹窗就说数据发到你的收集器。说不出真实去向的同意弹窗没有意义。

## 安装

在 profile 的目录下：

```powershell
cd C:\Users\<you>\.dsh\profiles\desktop
```

然后任选一种。

**A. 插件管理器（推荐）**

在 DSH 设置里的插件页安装，或者：

```
plugin_manager install_bundle, target = <bundle-root>
```

它会把 `@local/dsh-session-log-upload` 写进 profile 的 `package.json`，作为 `link:` 依赖并加入 `dsh.profile.bundles`。

**B. 手动挂载**

不想走插件管理器的话，把包链接进 profile 的 `node_modules`，然后自己加一条 patch 行：

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

改了插件源码不会热重载。 改动 profile 的 `cordis.patch.yml`（哪怕只改一行注释）会让这一行重启并加载新代码；重启 DSH 同理。

## 配置

所有键都可选。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `mode` | enum | `official-only` | 见上表 |
| `deepseekModelPatterns` | `string[]` | `['deepseek']` | 大小写不敏感的子串，只匹配模型 id。见下面「反代改了模型名怎么办」。 |
| `uploadDirectories` | `string[]` | `[]` | 空 = 所有工作区的会话都上传。填了目录就只上传这些目录（含子目录）里的会话。见下面「只上传指定目录」。 |
| `uploadSessionIds` | `string[]` | `[]` | 单独勾选的 DSH 会话 id，和目录白名单是「或」的关系。 |
| `foreignSessionIds` | `string[]` | `[]` | 从其他 harness 导入时勾选的会话，值形如 `zcode/sess_xxx`。见下面「从其他 harness 导入」。 |
| `endpoint` | string | DeepSeek 官方端点 | 只带日志的那条请求发往哪里。必须是绝对 `http(s)` URL，否则回落到默认值。 |
| `uploadModel` | string | `deepseek-flash` | 那条请求的 `model` 字段。必须是官方 API 认识的名字（`deepseek-flash` 或 `deepseek-v4-pro`）。 |
| `credentialRef` | string | `DEEPSEEK_API_KEY` | 通过 `ctx.credentials.resolve(ref)` 解析。 |
| `maxBytes` | int ≥ 1 | `20971520` | 单次请求里 `dsh_session_log` 字段的最大字节数。 |

`mode`、`deepseekModelPatterns`、`uploadDirectories`、`uploadSessionIds`、`foreignSessionIds`、`endpoint`、`maxBytes` 都是 **volatile**，所以设置页能读能写。

### 反代改了模型名怎么办

`deepseek-any-provider` 靠模型 id 里有没有你配的子串来判断"算不算 DeepSeek"。

反代如果把 DeepSeek 命名成 `dfmodel`，这个名字里没有 `deepseek`，这个模式就认不出来。它会跳过，不传也不报错。失败记录也是空的，因为没走到上传这一步。

在设置页的「把这些模型当作 DeepSeek」里加一行 `dfmodel` 就行。这个名单只在 `deepseek-any-provider` 下出现，其他模式看不到它。

### 只上传指定目录

**默认所有工作区的会话都上传。** 想收窄，在设置页勾上「选择指定目录」，点扫描，然后勾选你要的目录。

勾了之后只上传这些目录（含子目录）里的会话，DSH 自带的上传也一并受限。不区分大小写，`\` 和 `/` 视为相同。清空选择就回到默认的「全部上传」。

## 从其他 harness 导入

设置 → 会话日志上传 → 「从其他 HARNESS 导入」。点扫描，它读本机上其他 agent 工具记下的会话：ZCode、Qoder、Cursor、WorkBuddy、Cline。勾选要发的会话，点发送，每个会话单独发一次，失败只影响那一行，其余照发。

发出去的东西是一段 DSH 会话记录，不是原来的格式：

- 会话 id 是合成的，形如 `foreign-zcode-a1b2c3d4e5f6`。同一个原始会话每次算出同一个 id，所以重复发送会从上次停下的位置接着发，不会整段重发。
- 第一条事件是来源标记：`Source: harness=zcode provider=… model=… session=…`。原始供应商和模型只出现在这一行里。
- 之后每条消息一个事件，用户和助手分开。
- 助手消息的模型一律写 `deepseek-flash`，供应商写 `deepseek`。

这么做的原因是接收方只认 DSH 的格式：外部会话没有 DSH 的会话 id，也没有 DSH 的事件序号，想发就得造一套。造出来的记录在接收方看来就是一个普通的 DSH 会话，唯一的痕迹是开头那行来源标记。

三条边界：

- 目录和会话白名单只管 DSH 会话，管不到导入。导入也不改变四种模式，它是另一条独立的路径。
- 扫描只读元数据：标题、目录、模型、消息数。正文只有在你点发送、并且目标会话就是那一行时才会被读出来。
- 外部日志比 DSH 的脏。里面有整条命令的输出、文件内容，可能带着密钥。发之前先想清楚这一条要发给谁。

单个会话的读取上限是 64 MiB。超过就只发送前面的部分，这一行会写"只发送了这段对话的前一部分"，不会假装整段都发了。按本机的数据，594 段里 10 段会触发这个上限。

支持范围随各 harness 自己的存储格式走。它们改版本可能就扫不出来，扫不出来会报错而不是静默少列。

## 不用界面切换模式

```
/session-log-upload                      报告当前模式和目标，不写任何东西
/session-log-upload off                  缩小范围，立刻生效
/session-log-upload official-only        缩小范围，立刻生效
/session-log-upload any-model            打印披露提示，什么都不写
/session-log-upload any-model confirm    真正执行放宽
/session-log-upload uploaded             列出已上传的会话
```

放宽模式必须带 `confirm`。少这个参数就只是打印提示。

## 已上传的会话

设置 → 会话日志上传 → 详细日志 列出每个上传过的会话：会话 id、传到第几个事件、时间、格式版本。

同一个列表也能在会话里看：

```
/session-log-upload uploaded
```

它还会报两件事：这次加载以来有没有成功上传过，以及 attribution 头在当前安装里能不能解析。

名字叫"详细日志"，但里面是索引，不是日志内容。每个会话只有 id、传到哪、什么时候、格式版本。没有提示词、没有标题、没有文件路径、没有消息正文。这个文件不会变成你数据的第二份拷贝。

会话标题默认不显示。标题是从对话内容生成的，所以设置页里那个开关要你自己打开。

两条限制：

- 它只记录**本插件**发起的上传。`off` 或 `official-only` 下它本来就是空的，DSH 自带的上传不会出现在这里。空的等于没上传过。
- 上传是**至少一次**语义：服务端接受之后、水印写入之前如果崩溃，这段范围会重发。可能重复，不会跳过。

## 传的是什么

只带日志的那条请求，形状和 DSH 自带的官方上传器一致：

- 同一个端点，同一套认证头（`x-api-key`；账号路由用 `x-dsh-auth-token`，且只发给官方域名）
- 同一套 attribution 头：`user-agent`、`x-deepseek-harness-user-id`（匿名 id）、`x-deepseek-harness-session-id`
- `dsh_session_log` 字段与官方格式逐字节一致

不同的是：`model` 是个占位值（`deepseek-flash`），`max_tokens` 是 1，`messages` 里只有一条载体消息而不是整段对话。那条消息的内容会写明触发这次上传的 provider 和 model：

```
DSH session-log upload. Source: provider=acme-relay model=deepseek-v4-pro. The Session log is carried in the dsh_session_log field.
```

这样接收方看到的不只是一个占位模型名。

attribution 头都是**尽力而为**：拿不到就省略，不会自己编一个 id，头出错也不会让上传失败。那两个值来自运行中安装里的模块，只在 Electron 下能解析。

## 上传失败了怎么看

设置页的详细日志会显示上一次失败：哪一类（没有凭据 / 端点被拒 / HTTP 错误 / 传输失败 / 单条事件超过字节上限 / 未知）、HTTP 状态码、时间、哪个会话、是否会自动重试，以及具体诊断。

成功上传之后这条记录会被清掉。`payload-too-large` 单独标出来，因为它不会自己恢复。单条事件就超过 `maxBytes` 时，不把上限调大，那个会话会一直卡在那里。

失败记录在 `$DSH_HOME/session-log-upload/last-failure.json`，只存诊断，不存会话内容。

## 文件在哪

都跟着 `$DSH_HOME` 走（非空的 `DSH_HOME` 优先，`~` 会展开，否则 `~/.dsh`）：

- `session-log-upload/watermarks.json` — 每个会话传到哪了（导入的外部会话按合成 id 记在里面）
- `session-log-upload/last-failure.json` — 上次失败
- `session-log-upload/notice-acknowledged.json` — 免责说明点过没有

删掉水印文件不会损坏会话，只是让插件忘记进度、下次重发。

## 开发

```
node verify/run-all.mjs
```

九套检查：host 单测、client 检查、其他 harness 适配器、信封伪造、payload 与官方上传器的差分保真、两套对抗测试、对着 `app.asar` 里真实 schemastery 的 schema 检查、主题令牌检查。

`verify/REPORT.md` 是独立验收报告，写清了哪些结论被驱动验证过、哪些没有。

## 卸载

插件管理器里移除 `@local/dsh-session-log-upload`。

手动挂载的话：删掉 profile patch 里的 `insert` 段和设置页写入的覆盖行，再删掉 `node_modules\@local\dsh-session-log-upload` 这个链接。

## 许可

MIT
