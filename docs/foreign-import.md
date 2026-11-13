# 其他 harness 导入：接口契约

这份文档是并行开发的唯一依据。各方只改自己名下的文件，跨文件改动先找 Lead。

## 目标

插件设置页多一个入口：把其他 agent harness（ZCode、Qoder、Cursor、WorkBuddy、Cline）的会话，按 DSH 的
`dsh_session_log` 信封发到当前配置的目标。流程三段：

1. 扫描各 harness 的会话，列出来
2. 用户勾选要发的会话（和现有目录/会话选择器一样的感觉）
3. 把勾选的会话伪造成一个正常的 DSH 会话记录，发出去

## 文件归属

| 谁 | 独占写权 |
|---|---|
| adapters | `host/foreign/`（新目录）、`verify/foreign-adapters.mjs`（新文件） |
| forge | `host/foreign-forge.js`（新文件）、`verify/foreign-forge.mjs`（新文件） |
| client-ui | `client.js`、`locale/en.json`、`locale/zh.json`、`verify/client-check.mjs` |
| lead | `index.js`、`host/config.js`、`README.md`、`cordis.patch.yml`、`verify/host-unit.mjs`、`verify/adversarial-*.mjs`、`verify/run-all.mjs` |

不要用 `git commit`。不要改 profile 目录下的任何文件（`C:\Users\zzrCN\.dsh\profiles\`）。不要跑
`# reload-tick`，热重载由 Lead 统一做。

## 适配器契约（adapters 实现，其他人只消费）

每个 harness 一个模块，另加一个注册表。全部函数**永不抛异常**，失败一律走 `error` 字段。

```js
// host/foreign/zcode.js
export const harness = 'zcode'          // 稳定 id，进配置值和 URL 前缀
export const label = 'ZCode'            // 界面显示名

/**
 * @param {{ home: string, signal?: AbortSignal }} options
 *   home 是用户主目录，测试用它指向 fixture，不要直接读 process.env
 * @returns {Promise<{
 *   available: boolean,                  // 这个 harness 装没装
 *   error: string | null,
 *   sessions: Array<{
 *     id: string,                        // 该 harness 自己的会话 id，不带前缀
 *     parentId?: string,                 // 可选：委派出来的子会话所指向的父会话 id
 *     title: string,                     // 拿不到就给 ''
 *     cwd: string,                       // 拿不到就给 ''
 *     createdAt: number,                 // 毫秒；拿不到给 0
 *     updatedAt: number,
 *     messageCount: number,              // 计入用户+助手消息
 *     provider: string,                  // 观测到的原始供应商，拿不到给 ''
 *     model: string,                     // 观测到的原始模型，拿不到给 ''
 *     bytes: number                      // 粗估原始数据字节数，用于界面提示
 *   }>
 * }>}
 */
export async function scan(options)

/**
 * @returns {Promise<{
 *   error: string | null,
 *   title: string, cwd: string, createdAt: number,
 *   provider: string, model: string,
 *   truncated: boolean,                  // 是否因为字节预算截断
 *   messages: Array<{
 *     role: 'user' | 'assistant',
 *     time: number,
 *     blocks: Array<{ type: 'text' | 'reasoning', text: string }>
 *   }>
 * }>}
 */
export async function readSession(id, options)
```

注册表 `host/foreign/index.js`：

```js
export const ADAPTERS = [zcode, qoder, cursor, workbuddy, cline]   // 顺序即界面顺序
export function adapterFor(harness)                                 // -> adapter | undefined
export async function scanAll(options)                              // -> { harnesses: [ { harness, label, available, error, sessions } ] }
export async function readForeignSession(compositeId, options)      // 'zcode/sess_x' -> { adapter, raw, error }
```

复合 id 的格式固定为 `${harness}/${原始 id}`，只有注册表负责拆和拼，其他文件不要自己拼。

## 信封契约（forge 实现）

```js
// host/foreign-forge.js
/**
 * 把一个外部会话变成一个 DSH 会话的样子。
 * @returns {{
 *   base: object,        // { version: 1, sessionFormatVersion: 4, session: {...} }，不含 afterSeq/throughSeq/events
 *   events: object[]     // 已 wire 化的事件，seq 从 0 连续
 * }}
 */
export function forgeSession({ harness, label, raw })

/**
 * 按字节上限切片，和 host/logfield.js 的 buildLogField 同形状。
 * @returns {{ field: object|null, throughSeq: number|null, reason?: string, overCap?: boolean }}
 */
export function buildForeignField({ forged, afterSeq, maxBytes })
```

`forgeSession` 必须做到的细节：

- `session.id` 用确定性合成 id：`foreign-<harness>-<原始 id 的短哈希>`，同一个原始会话每次算出同一个 id
  （水位和去重都靠它）。只保留 `[A-Za-z0-9_.-]`，长度上限 80。
- `session.version` = 4，`session.type` = `'session'`，带 `createdAt`、`cwd`、`isSeeded: false`。
- 第一个事件是 `system/message`，内容就是来源标记，例如
  `Source: harness=zcode provider=cline-pass model=deepseek-v4.1-flash session=sess_xxx.`，
  长度不超过 300 字符。这就是"在内容前面加模型与供应商标记"。
- 之后每条外部消息一个事件：用户是 `user/message`，助手是 `assistant/message`，都带 `surfaceOp: 'append'`。
- 助手消息的 `source` 一律写 `{ kind: 'model', provider: 'deepseek', model: 'deepseek-flash' }`：
  伪装成正常的 DSH 会话，原始模型只出现在开头的标记里。
- 事件 `seq` 从 0 连续，`time` 用原始时间戳（没有就给 0）。
- 内容块：外部的 text 映射成 `{type:'text', text}`，reasoning 映射成 `{type:'reasoning', text}`。
- 没有消息的会话返回 `events: []`，`buildForeignField` 返回 `reason: 'no-messages'` 和 `field: null`。
- 任何异常都不许抛，`forgeSession` 包住自己，出错返回 `{ base: null, events: [], error }`。

`buildForeignField` 复用 `host/logfield.js` 的 `jsonBytes`，行为对齐 `buildLogField`：
`afterSeq` 之后的事件、容量超限就截断、第一个事件就超限返回 `overCap: true`。

## 路由契约（lead 实现，client-ui 消费）

```js
// 常量从 index.js 导出，client 通过 bridge 调
export const FOREIGN_SCAN_ROUTE_PATH = '/api/session-log-upload.foreign-scan'
export const FOREIGN_UPLOAD_ROUTE_PATH = '/api/session-log-upload.foreign-upload'
```

`GET FOREIGN_SCAN_ROUTE_PATH`，无参数：

```json
{
  "harnesses": [
    {
      "harness": "zcode", "label": "ZCode", "available": true, "error": null,
      "sessions": [
        { "id": "zcode/sess_abc", "parentId": "zcode/sess_root", "title": "…", "cwd": "F:\\x", "createdAt": 0,
          "updatedAt": 0, "messageCount": 42, "provider": "…", "model": "…", "bytes": 1234 }
      ]
    }
  ]
}
```

`POST FOREIGN_UPLOAD_ROUTE_PATH`，body `{ "id": "zcode/sess_abc" }`，可选 `"dryRun": true`（只转换不发送，
测试用）。一次一个会话，客户端自己串行循环，这样进度和错误都能落到具体会话上。

```json
{ "ok": true, "id": "zcode/sess_abc", "requests": 2, "bytes": 1234, "throughSeq": 120, "error": null }
```

dryRun 时返回 `{ "ok": true, "id": …, "dryRun": true, "events": 121, "requests": 2, "bytes": 1234 }`。

## 配置字段（lead 实现）

只加一个，volatile：

```js
foreignSessionIds: z.array(z.string()).default([]).volatile()
```

语义：勾选过的外部会话，值是复合 id。空数组表示一个都没选。字段必须保持宽松（元素是普通字符串），
因为严格校验一旦拒了 patch 里的旧值，整行会失效，插件就不加载了。

## 界面契约（client-ui 实现）

- 一个入口区块，标题「从其他 HARNESS 导入」，下面一个按钮「扫描」。点了才请求 scan（不要一进页面就扫）。
- 扫描结果按 harness 分组，每组标题带名称和数量，组内每行一个会话：标题、目录、模型、消息数。
- 每行一个复选框，tick 集合写入 `foreignSessionIds`，和现有目录选择器一样：tick 状态是本地草稿，
  保存时才写配置（复用现有 `writeField`）。
- 一个「发送选中的 N 个会话」按钮，点击前弹现有 `ConfirmDialog`（`data-dialog="consent"` 那套），
  正文必须写明：这些不是 DSH 会话；发出去的内容会被包装成一段 DSH 会话记录；以及当前 endpoint。
- 发送时串行 POST，一行一行更新状态：等待/发送中/成功（几次请求）/失败（原因）。
- 全部新文案进 `locale/en.json` 和 `locale/zh.json`，键名以 `foreign` 开头。

## 测试契约

- adapters：`verify/foreign-adapters.mjs`，用 `verify/.tmp-*/` 下的 fixture（自己造，测完删），
  不依赖本机真实数据。覆盖：扫描出会话、时间戳、模型标签、空目录、文件缺失、JSONL 截断、SQLite 只读打开。
- forge：`verify/foreign-forge.mjs`，覆盖信封形状、系统消息标记、伪造模型、seq 连续、切片的
  afterSeq/overCap 行为、超大单事件、无消息会话。
- client：在 `verify/client-check.mjs` 里加 `foreign-*` 检查，驱动真实 React 树，至少覆盖：扫描按钮、
  tick 独立、保存写 `foreignSessionIds`、发送前的确认弹窗、串行进度。
- lead 在 `verify/host-unit.mjs` 里补路由与配置的检查，并在 `verify/run-all.mjs` 注册两个新套件。

风格照现有文件：断言用 `node:assert`，输出 `ok <描述>` / `FAIL <描述>`，退出码非零表示失败。
