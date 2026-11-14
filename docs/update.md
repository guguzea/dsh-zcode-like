# 插件自更新：接口契约

参考 `dsh-our-free-model` 的应用内升级（下载 → SHA-256 校验 → 备份 → 原子替换 → 回读校验 → 失败回滚），
按本插件的规模裁剪。没有签名链：信任根是本机到清单地址的 HTTPS，这一点必须写进界面，不许含糊。

## 发布物

仓库根目录的 `update-manifest.json`：

```json
{
  "schema": 1,
  "version": "1.1.0",
  "files": [
    { "path": "index.js", "bytes": 12345, "sha256": "64位小写十六进制" }
  ],
  "notes": "一句话说明这版改了什么"
}
```

- `files` 由 `verify/build-update-manifest.mjs` 按 `package.json` 的 `files` 列表生成，不要手写。清单里**始终包含
  `package.json` 本身**（没有 glob 覆盖到它）：版本号随包一起更新，否则升级完成后 `readCurrentVersion` 读到的还是旧
  版本，页面会一直提示有同一个更新。
- 清单自身、`.git`、`node_modules`、`update-backup*`、`update-staging*`、`verify/`、`docs/` 不进 `files`。
- `version` 必须与 `package.json` 的 `version` 相同，构建脚本会检查。

默认清单地址（`host/config.js` 里的 `DEFAULT_UPDATE_URL`）：

```
https://raw.githubusercontent.com/guguzea/dsh-zcode-like/main/update-manifest.json
```

raw 失败时回退（仅在用默认地址时回退；用户自己填的地址不回退）：

```
https://cdn.jsdelivr.net/gh/guguzea/dsh-zcode-like@main/update-manifest.json
```

文件本身按相对清单地址解析：`new URL(path, manifestUrl)`，所以镜像地址下的文件也走镜像。

清单地址必须**匿名可读**。私有仓库、改名、文件只在别的分支，这三种情况 GitHub 都会对匿名请求返回 404，
检查会报 `not-public`；401/403 报 `unauthorized`。jsDelivr 的回退也只服务公开仓库。

## 模块契约（adapters 之外，updater 实现）

新文件 `host/update.js`，全部函数**永不抛异常**。

```js
export const DEFAULT_UPDATE_URL
export const FALLBACK_UPDATE_URL
export const UPDATE_MANIFEST_SCHEMA = 1
export const MAX_MANIFEST_BYTES = 256 * 1024
export const MAX_FILE_BYTES = 4 * 1024 * 1024
export const MAX_TOTAL_BYTES = 16 * 1024 * 1024

/** 读插件目录下 package.json 的 version；读不到返回 null。 */
export function readCurrentVersion(directory)

/** 严格比较两个版本号，返回 -1 | 0 | 1；不认识的形状返回 null。 */
export function compareVersions(left, right)

/** 解析并校验清单文本；失败返回 {ok:false, error}。 */
export function parseManifest(text, manifestUrl)

/**
 * 只检查，不写盘。
 * @returns {Promise<{
 *   ok: boolean, current: string|null, latest: string|null, available: boolean,
 *   notes: string, manifestUrl: string, source: 'primary'|'fallback'|'custom',
 *   files: Array<{path:string, bytes:number, sha256:string}>, error: string|null
 * }>}
 */
export function checkUpdate({ fetchImpl, manifestUrl, directory, signal })

/**
 * 下载 + 校验 + 备份 + 替换 + 回读；任一步失败就恢复。
 * 成功后返回 {ok:true, from, to, files:[path], backupDir, reload:'restart-required'}。
 * 成功后不自行热重载：本插件的宿主不会因为包内文件变化而重载，重启 DSH 才生效。
 */
export function applyUpdate({ fetchImpl, manifestUrl, directory, signal })
```

实现约束：

- 清单校验：`schema` 必须是 1；`version` 可比较；`files` 非空数组；每项 `path` 是相对路径、只允许
  `[A-Za-z0-9._/-]`、不允许 `..`、不允许绝对路径、不允许空段；`bytes` 为安全整数；
  `sha256` 为 64 位小写十六进制。任一不符即整体拒绝。
- 下载上限：单文件 `MAX_FILE_BYTES`，总计 `MAX_TOTAL_BYTES`；先全部下到内存并逐个校验，全通过了才动盘。
  「边下边覆盖」不允许：半截文件比不更新更糟。
- 写盘顺序：`.update-staging-<时间戳>/` 写入全部文件 → `.update-backup-<旧版本>-<时间戳>/` 复制被替换的原文件
  → 逐个 `rename` 覆盖 → 逐个回读校验 sha256 → 删掉 staging。回读失败则用备份逐个还原，并返回失败。
- 只替换清单里列出的文件。清单里没有的旧文件不删（删除由人工决定，插件不替用户删东西）。
- 并发：模块内一个 `applying` 标志，第二次调用直接返回 `{ok:false, error:'already-running'}`。
- 目录不可写、staging 建不出来、备份失败，都要在动原文件之前返回失败。
- 检测到 `directory` 不是插件目录（没有 package.json）时一律拒绝。
- `applyUpdate` 在下载并校验完全部文件之后、第一次写盘之前，还要求清单 `files` 里包含 `package.json`，并且其中 `version` 与清单的 `version` 严格相等：缺少 `package.json` 返回 `missing-package-json`，版本不一致（包括 `package.json` 读不出版本）返回 `version-mismatch`。检查对象是真正将要写入的字节，不是清单自己的声明。

## 路由契约（lead 实现，client-ui 消费）

```js
export const UPDATE_CHECK_ROUTE_PATH = '/api/session-log-upload.update-check'   // GET
export const UPDATE_APPLY_ROUTE_PATH = '/api/session-log-upload.update-apply'   // POST
```

`GET update-check`：

```json
{ "ok": true, "current": "1.0.0", "latest": "1.1.0", "available": true,
  "notes": "…", "manifestUrl": "https://…", "source": "primary",
  "files": [{ "path": "index.js", "bytes": 123, "sha256": "…" }], "error": null }
```

`POST update-apply`：body `{}`。返回

```json
{ "ok": true, "from": "1.0.0", "to": "1.1.0", "files": ["index.js"], "backupDir": "…", "reload": "restart-required", "error": null }
```

两个路由都走 `connection.fetch.register`（和 ledger 一样带浏览器凭据校验）。检查是 GET，替换是 POST：
一个 GET 不许改盘。

## 配置字段（lead 实现）

```
updateUrl: z.string().default(DEFAULT_UPDATE_URL).volatile()
```

volatile，这样页面能显示"更新来自哪里"，也能改成自己的镜像或 fork。空的或非 http(s) 的值由
`resolveConfig` 收窄回默认值；模块内部还会再拒一次非 http(s) 地址（与 `endpoint` 同样的两道闸）。

## 界面契约（client-ui 实现）

设置页新增一个「插件更新」区块：

- 显示当前版本（Host 报告的值；没报告就说没报告，不要编）、清单地址。
- 「检查更新」按钮。结果三种：已是最新、有新版本（版本号 + notes + 文件数）、检查失败（原因）。
- 有新版本时出现「立即升级」按钮。点击前弹现有 `ConfirmDialog`（`data-dialog="consent"`），正文写明：
  会下载并替换插件目录下的文件、失败会自动回滚、升级完成后需要重启 DSH 才生效、以及这个清单没有签名。
- 升级过程显示进度状态（检查/下载/写入/完成/失败），完成后显示新版本、备份目录、重启提示。
- 所有新文案进 `locale/en.json`、`locale/zh.json`，键名以 `update` 开头。

## 测试契约

- `verify/update.mjs`（updater 自己写）：本地 HTTP 服务提供清单与文件，覆盖：有新版本、已最新、
  清单 schema 错、版本号不可比较、路径逃逸、sha256 不符、字节数不符、清单里两个文件一个坏、
  并发调用、成功后的备份与回读、失败后原文件未变。全部用临时目录，测完删除。
- `verify/build-update-manifest.mjs`：生成清单并 `--check` 校验，纳入 run-all。
- `verify/client-check.mjs`：`update-*` 检查，驱动真实 React 树。
- `verify/host-unit.mjs`（lead）：路由注册、配置字段、GET/POST 语义。
