/**
 * @local/dsh-session-log-upload — browser half.
 *
 * Self-contained Client module loaded by the Harness Web module loader:
 * `window.__ModuleLoader__.load({ id: <package name>, factory(require) {...} })`.
 *
 * Rules this file follows (INTERFACES.md §6, references/practices.md):
 * - No `@deepseek-ai/*` module is required; only `react` (and `react-dom`, optionally,
 *   for the confirm-dialog portal). Every control is ours.
 * - No JSX: this file is shipped verbatim, not built.
 * - Styling uses `--dsw-alias-*` theme tokens only; the only colour source outside the
 *   tokens is `currentColor` inside the navigation icon.
 * - Nothing throws out of `apply` or out of a component: every host service is probed
 *   defensively and the section degrades to a read-only report instead of blanking the
 *   slot entry.
 */
window.__ModuleLoader__.load({
	id: "@local/dsh-session-log-upload",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		let ReactDOM = null;
		try {
			ReactDOM = require("react-dom");
		} catch (_error) {
			ReactDOM = null;
		}

		//#region locale dictionaries
		/**
		 * Dictionaries registered through `ctx.locale.register`. Keys are FLAT dotted
		 * strings, matching the shipped Client packages (`"general.currentVersion"`), and
		 * they are kept byte-identical to `locale/en.json` / `locale/zh.json`
		 * (verify/client-check.mjs fails the build when they drift).
		 *
		 * Plain JSON object literals on purpose: the verifier extracts this block and
		 * parses it, so it must stay JSON-compatible (double quotes, no trailing commas).
		 */
		const DICTIONARIES = {
			"en": {
				"upload.sectionTitle": "Session log upload",
				"upload.sectionDescription": "A Session log is the durable record of one conversation: your messages, model output, tool results, and the file paths involved. This setting decides when DSH sends that record to the destination below.",
				"upload.modeGroupLabel": "Upload mode",
				"upload.modeUnknown": "The Host has not reported the current mode.",
				"upload.destinationLabel": "Destination",
				"upload.valueUnknown": "Not reported by the Host",
				"upload.modes.off.label": "Never upload",
				"upload.modes.off.detail": "Nothing is sent, and DSH's built-in official-API upload is switched off too.",
				"upload.modes.officialOnly.label": "Only the official DeepSeek API",
				"upload.modes.officialOnly.detail": "DSH's built-in behaviour. The log rides along with requests that were already going to DeepSeek.",
				"upload.modes.deepseekAnyProvider.label": "Any provider's DeepSeek models",
				"upload.modes.deepseekAnyProvider.detail": "Also uploads when a DeepSeek model is served by a different provider.",
				"upload.modes.anyModel.label": "Any model",
				"upload.modes.anyModel.detail": "Uploads after every model request, whichever provider answered it.",
				"upload.warnTitle": "Send this Session log to the destination below?",
				"upload.warnBody": "The log is sent to the destination below. That includes your messages, tool output, file paths, and conversations you held with other model providers. It leaves this machine, it may be used to improve and train models, and it cannot be undone.",
				"upload.warnConfirm": "Enable upload",
				"upload.warnCancel": "Cancel",
				"upload.noticeTitle": "Before you use this plugin",
				"upload.noticeP1": "This plugin sends your Session logs to DeepSeek’s official API by default, or to whatever destination is shown in the settings below. You decide when that happens; on the default setting it sends nothing beyond what DSH already sends.",
				"upload.noticeP2": "By ticking the box and continuing, you confirm that you understand what this plugin does and that you take responsibility for the data you choose to send.",
				"upload.noticeP3": "To the extent the law allows, you waive any right to hold DeepSeek, the operator of the destination you configured, or the author of this plugin liable for the consequences of that choice.",
				"upload.noticeP4": "If you do not agree, close this page and do not use the plugin.",
				"upload.noticeCheck": "I have read and understood the above",
				"upload.noticeAccept": "Continue",
				"upload.noticeBusy": "Recording…",
				"upload.noticeFailed": "The acknowledgement could not be recorded. This page will keep showing this notice until it is. Try Continue again.",
				"upload.noticeReadFailed": "The Host could not be reached to read the acknowledgement, so this notice is shown. Continue will try to record it again.",
				"upload.noticeRetry": "Try again",
				"upload.noticeDismiss": "Close and show this again next time",
				"upload.byteCapLabel": "Byte cap per request",
				"upload.patternsLabel": "Models to treat as DeepSeek",
				"upload.patternsHelp": "Matched against the model id, ignoring case. Add a name here if a provider serves DeepSeek under a different one, such as dfmodel.",
				"upload.patternsEmpty": "Nothing added yet. Only the default deepseek pattern is used.",
				"upload.directoriesLabel": "Only upload sessions from these folders",
				"upload.directoriesHelp": "By default every session is uploaded, whichever workspace it came from. Tick folders to upload only those; subfolders are included.",
				"upload.directoriesEmpty": "Everything is uploaded (no restriction).",
				"upload.directoriesScan": "Scan folders",
				"upload.directoriesScanning": "Scanning…",
				"upload.directoriesNoSessions": "No sessions found to choose from.",
				"upload.directoriesChoose": "Choose specific folders",
				"upload.directoriesAdjust": "Adjust folders",
				"upload.coveredByFolder": "Covered by the ticked folder",
				"upload.unitMiB": "MiB",
				"upload.unitKiB": "KiB",
				"upload.unitBytes": "bytes",
				"upload.endpointUnknown": "Not reported by the Host",
				"upload.endpointEditLabel": "Change destination",
				"upload.capEditLabel": "Change byte cap (bytes)",
				"upload.fieldSave": "Save",
				"upload.fieldSaved": "Saved.",
				"upload.endpointInvalid": "Not saved: the destination must be an http:// or https:// address.",
				"upload.capInvalid": "Not saved: the byte cap must be a whole number of bytes, 1 or more.",
				"upload.ledger.title": "Uploaded Sessions",
				"upload.ledger.description": "An index of the Session logs this plugin has uploaded: session id, how far each was uploaded, when, and the format version. It does not contain the log content itself.",
				"upload.ledger.refresh": "Refresh",
				"upload.ledger.titlesLabel": "Show session names",
				"upload.ledger.titlesDetail": "A session name comes from the conversation itself, so turning this on shows a slice of its content on this page. Off by default; the detailed log is otherwise metadata only.",
				"upload.ledger.loading": "Reading the detailed log…",
				"upload.ledger.total": "Sessions recorded:",
				"upload.ledger.columnSession": "Session",
				"upload.ledger.columnRange": "Uploaded through",
				"upload.ledger.columnTime": "Time",
				"upload.ledger.columnVersion": "Format version",
				"upload.ledger.columnsHint": "“Uploaded through” is the sequence number of the last session event this plugin has sent for that session; session events are numbered as the conversation grows. “Format version” identifies the session-log format generation, so a format change makes the plugin resend rather than mix incompatible records.",
				"upload.ledger.directoryLabel": "Detailed log folder",
				"upload.ledger.skipped": "Records without a session id were skipped:",
				"upload.ledger.empty": "Nothing recorded yet. This detailed log covers uploads made by this plugin only: in “Never upload” or “Only the official DeepSeek API” mode it stays empty by design, and uploads made by DSH's built-in official-API uploader are never listed here.",
				"upload.ledger.stateMissing": "The Host does not serve the detailed log at this address, so there is nothing to show.",
				"upload.ledger.stateUnauthorized": "The request was refused: this page is not authorized to read the detailed log.",
				"upload.ledger.stateMalformed": "The Host answered, but the detailed log could not be read.",
				"upload.ledger.stateFailed": "The detailed log could not be read.",
				"upload.ledger.failureTitle": "Last upload failure",
				"upload.ledger.failureUnreported": "The Host did not report the last upload failure, so this page cannot say whether an upload is failing.",
				"upload.ledger.failureNone": "No upload failure has been recorded.",
				"upload.ledger.failureRetryable": "This failure is retried automatically, but nothing has been delivered yet.",
				"upload.ledger.failureNotRetryable": "This failure is not retried automatically.",
				"upload.ledger.failurePersistent": "This is not a one-off: the same problem has repeated.",
				"upload.ledger.failureCount": "Consecutive failures:",
				"upload.ledger.failureUnresolved": "This will not clear on its own: until the byte cap changes, every upload stays too large.",
				"upload.ledger.failureDetail": "Host detail",
				"upload.ledger.failureStatus": "HTTP status",
				"upload.ledger.failureKindNoCredential": "No usable API credential was found for the upload.",
				"upload.ledger.failureKindEndpointRefused": "The destination is not a usable http:// or https:// address, so nothing was sent.",
				"upload.ledger.failureKindHttpError": "The destination answered with an error.",
				"upload.ledger.failureKindTransportError": "The request could not reach the destination (network or DNS).",
				"upload.ledger.failureKindPayloadTooLarge": "The log is larger than the byte cap, so it was not sent.",
				"upload.ledger.failureKindUnknown": "The Host reported a failure it could not classify.",
				"upload.saveFailed": "The setting could not be saved.",
				"upload.savingLabel": "Saving…",
				"upload.manualTitle": "Set the mode by hand",
				"upload.manualHint": "This browser could not write the setting. Add the configuration below to cordis.patch.yml, or run the command in a Session.",
				"upload.manualPatchLabel": "cordis.patch.yml",
				"upload.manualCommandLabel": "Command",
				"upload.renderFailed": "This settings section could not be rendered.",
				"foreign.title": "Import from other HARNESSES",
				"foreign.description": "Scan the conversations other agent harnesses recorded on this machine, tick the ones to send, then send them. Nothing is scanned until you click Scan.",
				"foreign.scan": "Scan",
				"foreign.scanning": "Scanning…",
				"foreign.scanFailed": "The scan could not be read.",
				"foreign.empty": "No conversations were found in any other harness.",
				"foreign.groupEmpty": "No conversations found.",
				"foreign.unavailable": "Not found on this machine.",
				"foreign.harnessError": "Scan error:",
				"foreign.untitled": "Untitled conversation",
				"foreign.cwdUnknown": "No folder reported",
				"foreign.modelUnknown": "Model not reported",
				"foreign.messages": "messages",
				"foreign.save": "Save ticks",
				"foreign.send": "Send {count} selected sessions",
				"foreign.expandChildren": "Show delegated conversations ({count})",
				"foreign.collapseChildren": "Hide delegated conversations",
				"foreign.statusWaiting": "Waiting",
				"foreign.statusSending": "Sending…",
				"foreign.statusStopped": "Stopped",
				"foreign.stop": "Stop sending",
				"foreign.stopping": "Stopping…",
				"foreign.summary": "Sent {sent}, not sent {notSent}.",
				"foreign.statusOk": "Sent ({requests} requests)",
		"foreign.statusOkTruncated": "Sent ({requests} requests; only the first part of this conversation was sent)",
				"foreign.statusFailed": "Failed: {error}",
				"foreign.statusUnknown": "unknown error",
				"foreign.warnTitle": "Send these conversations to the destination?",
				"foreign.warnBody": "These are not DSH sessions. Their content will be wrapped as a DSH session record and sent to the destination below. It leaves this machine and cannot be undone.",
				"foreign.warnConfirm": "Send",
				"update.title": "Plugin update",
				"update.currentVersion": "Current version",
				"update.manifestUrl": "Manifest address",
				"update.notReported": "Not reported by the Host",
				"update.check": "Check for updates",
				"update.checking": "Checking…",
				"update.upToDate": "Already up to date ({version}).",
		"update.manifestOlder": "The manifest lists {version}, which is older than the installed {current}. The published copy is probably still cached; try again in a few minutes.",
				"update.available": "Version {version} is available.",
				"update.notes": "Notes",
				"update.fileCount": "Files: {count}",
				"update.checkFailed": "Update check failed:",
				"update.checkUnreadable": "the Host's answer could not be read.",
				"update.upgrade": "Upgrade now",
				"update.warnTitle": "Upgrade the plugin now?",
				"update.warnBody": "The plugin's own files will be downloaded and replaced. If the update fails it rolls back automatically. DSH must be restarted afterwards for the new version to take effect. The manifest is not signed; the trust root is HTTPS to the manifest address.",
				"update.warnConfirm": "Upgrade",
				"update.phaseDownloading": "Downloading the update…",
				"update.phaseWriting": "Writing the files…",
				"update.done": "Updated to version {version}.",
				"update.backupDir": "Backup folder",
				"update.restartHint": "Restart DSH for the new version to take effect.",
				"update.applyFailed": "Update failed:",
				"update.applyErrorUnknown": "unknown error"
			},
			"zh": {
				"upload.sectionTitle": "会话日志上传",
				"upload.sectionDescription": "会话日志是一次对话的完整记录：你的消息、模型输出、工具结果，以及涉及的文件路径。这里决定 DSH 何时把这份记录发到下面填写的目标。",
				"upload.modeGroupLabel": "上传方式",
				"upload.modeUnknown": "宿主还没有报告当前的上传方式。",
				"upload.destinationLabel": "上传目标",
				"upload.valueUnknown": "宿主未提供",
				"upload.modes.off.label": "不上传",
				"upload.modes.off.detail": "什么都不发送，DSH 自带的「官方 API 上传」也会一并关掉。",
				"upload.modes.officialOnly.label": "只上传官方 API",
				"upload.modes.officialOnly.detail": "DSH 原本的行为。日志搭在本来就要发给 DeepSeek 的请求上一并送出。",
				"upload.modes.deepseekAnyProvider.label": "上传任何供应商的 deepseek",
				"upload.modes.deepseekAnyProvider.detail": "当 DeepSeek 模型由别的供应商提供时也上传。",
				"upload.modes.anyModel.label": "上传任何模型",
				"upload.modes.anyModel.detail": "每一次模型请求之后都上传，不管这次是哪个供应商回答的。",
				"upload.warnTitle": "要把这次会话日志发送到下面的目标吗？",
				"upload.warnBody": "会话日志会发送到下面写明的目标，包括你的消息、工具输出、文件路径，以及你与其他模型供应商的对话。它会离开这台机器，可能被用于改进和训练模型，且无法撤回。",
				"upload.warnConfirm": "开启上传",
				"upload.warnCancel": "取消",
				"upload.noticeTitle": "使用前请阅读",
				"upload.noticeP1": "本插件默认把会话日志发送到 DeepSeek 官方 API，或发送到下方设置里写明的那一个目标。什么时候发送由你决定；默认设置下，除了 DSH 本来就会发的，不会多发任何东西。",
				"upload.noticeP2": "勾选下面的选项并继续，表示你明白本插件在做什么，并为你自己选择发送的数据负责。",
				"upload.noticeP3": "在法律允许的范围内，你放弃就这一选择造成的后果，向 DeepSeek、你所配置目标的运营方，或本插件作者追责的权利。",
				"upload.noticeP4": "如果你不同意，请关闭此页面并不要使用本插件。",
				"upload.noticeCheck": "我已阅读并理解以上内容",
				"upload.noticeAccept": "继续",
				"upload.noticeBusy": "正在记录…",
				"upload.noticeFailed": "确认没能记录下来。在记录成功之前，这一页会一直显示这段提示。可以再点一次「继续」重试。",
				"upload.noticeReadFailed": "没能从宿主读到确认状态，所以这里仍然显示提示。点「继续」会再次尝试记录。",
				"upload.noticeRetry": "重试",
				"upload.noticeDismiss": "关闭，下次再提示",
				"upload.byteCapLabel": "每次请求的字节上限",
				"upload.patternsLabel": "把这些模型当作 DeepSeek",
				"upload.patternsHelp": "按模型 id 匹配，不区分大小写。供应商用别的名字（比如 dfmodel）提供 DeepSeek 时，把那个名字加进来。",
				"upload.patternsEmpty": "还没有添加。只使用默认的 deepseek 匹配。",
				"upload.directoriesLabel": "只上传这些目录下的会话",
				"upload.directoriesHelp": "默认所有工作区的会话都会上传。勾选目录后，只上传这些目录（含子目录）里的会话。",
				"upload.directoriesEmpty": "全部上传（没有限制）。",
				"upload.directoriesScan": "扫描目录",
				"upload.directoriesScanning": "正在扫描…",
				"upload.directoriesNoSessions": "没有可选的会话。",
				"upload.directoriesChoose": "选择指定目录",
				"upload.directoriesAdjust": "调整目录",
				"upload.coveredByFolder": "已包含在勾选的目录里",
				"upload.unitMiB": "MiB",
				"upload.unitKiB": "KiB",
				"upload.unitBytes": "字节",
				"upload.endpointUnknown": "宿主未提供",
				"upload.endpointEditLabel": "修改上传目标",
				"upload.capEditLabel": "修改字节上限（字节）",
				"upload.fieldSave": "保存",
				"upload.fieldSaved": "已保存。",
				"upload.endpointInvalid": "未保存：上传目标必须是 http:// 或 https:// 地址。",
				"upload.capInvalid": "未保存：字节上限必须是不小于 1 的整数（字节）。",
				"upload.ledger.title": "已上传的会话",
				"upload.ledger.description": "本插件已上传的会话日志的索引：会话 id、每个会话上传到哪、时间、格式版本。它不含日志内容本身。",
				"upload.ledger.refresh": "刷新",
				"upload.ledger.titlesLabel": "显示会话名",
				"upload.ledger.titlesDetail": "会话名来自对话内容本身，打开后这一页会显示内容片段。默认关闭；关闭时详细日志只有元数据。",
				"upload.ledger.loading": "正在读取详细日志…",
				"upload.ledger.total": "已记录的会话数：",
				"upload.ledger.columnSession": "会话",
				"upload.ledger.columnRange": "已上传至",
				"upload.ledger.columnTime": "时间",
				"upload.ledger.columnVersion": "格式版本",
				"upload.ledger.columnsHint": "「已上传至」是本插件为该会话已发送的最后一个会话事件的序号；会话事件随对话增长而编号。「格式版本」标识会话日志的格式代次，格式变化时本插件会重新上传，而不是把不兼容的记录混在一起。",
				"upload.ledger.directoryLabel": "详细日志所在目录",
				"upload.ledger.skipped": "因缺少会话 id 而跳过的记录数：",
				"upload.ledger.empty": "还没有记录。这份详细日志只统计本插件的上传：在「不上传」或「只上传官方 API」模式下它本来就是空的，而 DSH 自带的「官方 API 上传」不会出现在这里。",
				"upload.ledger.stateMissing": "宿主没有在这个地址提供详细日志，暂时没有内容可以显示。",
				"upload.ledger.stateUnauthorized": "请求被拒绝：当前页面无权读取详细日志。",
				"upload.ledger.stateMalformed": "宿主已响应，但这份详细日志无法解析。",
				"upload.ledger.stateFailed": "无法读取详细日志。",
				"upload.ledger.failureTitle": "最近一次上传失败",
				"upload.ledger.failureUnreported": "宿主没有报告最近一次上传失败，因此这一页无法说明上传是否正在失败。",
				"upload.ledger.failureNone": "没有记录到上传失败。",
				"upload.ledger.failureRetryable": "这次失败会自动重试，但目前还没有任何内容送达。",
				"upload.ledger.failureNotRetryable": "这次失败不会自动重试。",
				"upload.ledger.failurePersistent": "这不是偶发问题：同一个问题在反复出现。",
				"upload.ledger.failureCount": "连续失败次数：",
				"upload.ledger.failureUnresolved": "这个问题不会自行消失：在字节上限改变之前，每次上传都会因为过大而失败。",
				"upload.ledger.failureDetail": "宿主说明",
				"upload.ledger.failureStatus": "HTTP 状态码",
				"upload.ledger.failureKindNoCredential": "找不到可用于上传的 API 凭据。",
				"upload.ledger.failureKindEndpointRefused": "上传目标不是可用的 http:// 或 https:// 地址，因此没有发送。",
				"upload.ledger.failureKindHttpError": "上传目标返回了错误。",
				"upload.ledger.failureKindTransportError": "请求无法到达上传目标（网络或 DNS）。",
				"upload.ledger.failureKindPayloadTooLarge": "日志超过字节上限，因此没有发送。",
				"upload.ledger.failureKindUnknown": "宿主报告了一次无法归类的失败。",
				"upload.saveFailed": "设置没能保存。",
				"upload.savingLabel": "正在保存…",
				"upload.manualTitle": "手动设置",
				"upload.manualHint": "这个浏览器无法写入该设置。请把下面的配置加进 cordis.patch.yml，或在会话里运行这条命令。",
				"upload.manualPatchLabel": "cordis.patch.yml",
				"upload.manualCommandLabel": "命令",
				"upload.renderFailed": "这个设置区块无法渲染。",
				"foreign.title": "从其他 HARNESS 导入",
				"foreign.description": "扫描其他 agent harness 在这台机器上记录下的会话，勾选要发送的，然后发送。只有点击「扫描」之后才会开始扫描。",
				"foreign.scan": "扫描",
				"foreign.scanning": "正在扫描…",
				"foreign.scanFailed": "扫描结果读取失败。",
				"foreign.empty": "其他 harness 里没有找到会话。",
				"foreign.groupEmpty": "没有会话。",
				"foreign.unavailable": "这台机器上没有找到。",
				"foreign.harnessError": "扫描出错：",
				"foreign.untitled": "未命名会话",
				"foreign.cwdUnknown": "未提供目录",
				"foreign.modelUnknown": "未提供模型",
				"foreign.messages": "条消息",
				"foreign.save": "保存勾选",
				"foreign.send": "发送选中的 {count} 个会话",
				"foreign.expandChildren": "展开子代理（{count}）",
				"foreign.collapseChildren": "折叠子代理",
				"foreign.statusWaiting": "等待中",
				"foreign.statusSending": "发送中…",
				"foreign.statusStopped": "已停止",
				"foreign.stop": "停止发送",
				"foreign.stopping": "正在停止…",
				"foreign.summary": "已发送 {sent} 个，未发送 {notSent} 个。",
				"foreign.statusOk": "发送成功（{requests} 次请求）",
		"foreign.statusOkTruncated": "发送成功（{requests} 次请求，只发送了这段对话的前一部分）",
				"foreign.statusFailed": "失败：{error}",
				"foreign.statusUnknown": "未知错误",
				"foreign.warnTitle": "要把这些会话发送到下面的目标吗？",
				"foreign.warnBody": "这些不是 DSH 会话。发出去的内容会被包装成一段 DSH 会话记录，发送到下面写明的目标。它会离开这台机器，且无法撤回。",
				"foreign.warnConfirm": "发送",
				"update.title": "插件更新",
				"update.currentVersion": "当前版本",
				"update.manifestUrl": "清单地址",
				"update.notReported": "宿主未报告",
				"update.check": "检查更新",
				"update.checking": "正在检查…",
				"update.upToDate": "已是最新版本（{version}）。",
		"update.manifestOlder": "清单里是 {version}，比已安装的 {current} 还旧。多半是发布副本还在缓存里，过几分钟再检查一次。",
				"update.available": "发现新版本 {version}。",
				"update.notes": "更新说明",
				"update.fileCount": "文件数：{count}",
				"update.checkFailed": "检查更新失败：",
				"update.checkUnreadable": "没有读到宿主的结果。",
				"update.upgrade": "立即升级",
				"update.warnTitle": "要立即升级插件吗？",
				"update.warnBody": "会下载并替换插件自己的文件。升级失败会自动回滚。升级完成后需要重启 DSH，新版本才会生效。这个清单没有签名，信任根是本机到清单地址的 HTTPS。",
				"update.warnConfirm": "立即升级",
				"update.phaseDownloading": "正在下载更新…",
				"update.phaseWriting": "正在写入文件…",
				"update.done": "已升级到 {version}。",
				"update.backupDir": "备份目录",
				"update.restartHint": "重启 DSH 后新版本才会生效。",
				"update.applyFailed": "升级失败：",
				"update.applyErrorUnknown": "未知错误"
			}
		};
		//#endregion

		//#region constants
		const PLUGIN_ID = "@local/dsh-session-log-upload";
		/** Host entry id == settings namespace (INTERFACES.md §2). */
		const NAMESPACE = "session-log-upload";
		/** Dictionary namespace used for `t` and for the nav label thunk. */
		const LOCALE_NAMESPACE = "settings.sessionLogUpload";
		const CSS_MARKER = PLUGIN_ID + "/client.css";
		/** Frozen mode ids, in display order (INTERFACES.md §1). */
		const MODES = [ "off", "official-only", "deepseek-any-provider", "any-model" ];
		/** Modes whose selection must pass the confirmation gate. */
		const CONFIRM_MODES = [ "deepseek-any-provider", "any-model" ];
		/** Locale key suffix per mode id. */
		const MODE_COPY = {
			"off": { label: "upload.modes.off.label", detail: "upload.modes.off.detail" },
			"official-only": { label: "upload.modes.officialOnly.label", detail: "upload.modes.officialOnly.detail" },
			"deepseek-any-provider": { label: "upload.modes.deepseekAnyProvider.label", detail: "upload.modes.deepseekAnyProvider.detail" },
			"any-model": { label: "upload.modes.anyModel.label", detail: "upload.modes.anyModel.detail" }
		};
		/** Mode the manual fallback prints when the Host has not reported one. */
		const DEFAULT_COMMAND_MODE = "official-only";
		/**
		 * The profile row this bundle is mounted by, key for key (`cordis.patch.yml`). The
		 * manual fallback prints this exact row with the selected mode, so what a user pastes
		 * is the row the Host already carries instead of an invented subset of it.
		 */
		const PATCH_ROW = Object.freeze({
			deepseekModelPatterns: Object.freeze([ "deepseek" ]),
			endpoint: "https://api.deepseek.com/anthropic/v1/messages",
			// Must stay a name `GET /models` lists (deepseek-flash | deepseek-v4-pro). This row is what a
			// user pastes into cordis.patch.yml, so a stale name here would put an undocumented legacy
			// alias into their config by hand — the one place the Host cannot narrow it for them.
			// Kept in step with host/config.js DEFAULT_UPLOAD_MODEL by verify/host-unit.mjs §15.
			uploadModel: "deepseek-flash",
			credentialRef: "DEEPSEEK_API_KEY",
			maxBytes: 134217728
		});
		/** Host route serving the upload ledger (docs/state-channel.md §4). */
		const LEDGER_PATH = "/plugins/@local/dsh-session-log-upload/ledger";
		/**
		 * Host routes are fetched from the Host, never from whatever scheme the page was loaded under.
		 *
		 * This was a real bug with a measured cause. The routes used to be fetched in the
		 * document-relative form (`"/api/x".slice(1)`), which is what the shipped export client does and
		 * which is correct only while the page's base URL is the Host's own HTTP origin. The desktop shell
		 * loads the UI from a custom scheme, so that form resolved to
		 * `dsh-app://app/api/session-log-upload.ledger` — a URL no HTTP server can answer, so every route
		 * read came back 404 while the very same routes answered 200 to any HTTP caller. Diagnosed from
		 * the page itself, which reported `url=dsh-app://app/api/... status=404`.
		 *
		 * So each request now goes to an absolute URL built from a real HTTP origin when one can be
		 * determined, and falls back to the document base only when nothing better exists.
		 */
		const SCAN_PATH = "/plugins/@local/dsh-session-log-upload/scan";
		const NOTICE_PATH = "/plugins/@local/dsh-session-log-upload/notice";
		const FOREIGN_SCAN_PATH = "/plugins/@local/dsh-session-log-upload/foreign-scan";
		const FOREIGN_UPLOAD_PATH = "/plugins/@local/dsh-session-log-upload/foreign-upload";
		const UPDATE_CHECK_PATH = "/plugins/@local/dsh-session-log-upload/update-check";
		const UPDATE_APPLY_PATH = "/plugins/@local/dsh-session-log-upload/update-apply";
		/**
		 * Resolve one route to the exact string the page must fetch.
		 *
		 * The routes live under `/plugins/<package>/...`, which is the prefix the desktop shell forwards to
		 * its Host with the Host credential attached. That is why a root-absolute path is correct here and
		 * a document-relative one is not: the page is loaded from the shell's custom scheme, so a bare
		 * `plugins/...` would resolve to `dsh-app://app/plugins/...` (which is what actually happened
		 * before this was root-absolute) while `/plugins/...` resolves to the same origin and gets
		 * forwarded.
		 *
		 * `document.baseURI` is still consulted, because a Host served behind a sub-path needs the prefix
		 * that the page's own base carries.
		 *
		 * @param path - the Host route path, always starting with `/`.
		 * @returns a root-relative path, or the path unchanged when the base cannot be resolved.
		 */
		function hostRoute(path) {
			try {
				if (typeof document !== "undefined" && document !== null && typeof document.baseURI === "string") {
					const base = new URL(document.baseURI)
					// Only a path-bearing base needs prefixing; the shell's `dsh-app://app/` base has a
					// root pathname, so the route stays exactly as declared.
					const prefix = base.pathname === "/" ? "" : base.pathname.replace(/\/+$/, "")
					if (prefix.length > 0 && !path.startsWith(prefix)) return prefix + path
				}
			} catch (_error) {
				/* fall through to the declared path */
			}
			return path
		}
		const LEDGER_ROUTE = LEDGER_PATH;
		const SCAN_ROUTE = SCAN_PATH;
		const NOTICE_ROUTE = NOTICE_PATH;
		const FOREIGN_SCAN_ROUTE = FOREIGN_SCAN_PATH;
		const FOREIGN_UPLOAD_ROUTE = FOREIGN_UPLOAD_PATH;
		const UPDATE_CHECK_ROUTE = UPDATE_CHECK_PATH;
		const UPDATE_APPLY_ROUTE = UPDATE_APPLY_PATH;
		/**
		 * How long into an in-flight apply the page switches its phase label from "downloading" to
		 * "writing". The apply route reports only completion, so this is a best-effort indication of
		 * the phase the Host is likely in; completion clears it either way.
		 */
		const UPDATE_WRITE_DELAY_MS = 600;
		/** Session ids longer than this are shortened in the middle; the full value stays in `title`. */
		const LEDGER_ID_LIMIT = 28;
		/** The state a ledger read publishes when nothing at all could be read. */
		/**
		 * One ledger state that carries no payload fields, so the failure block is not rendered for it.
		 * @param status - `missing`, `unauthorized`, `malformed` or `failed`.
		 */
		function ledgerState(status) {
			return {
				status: status,
				sessions: [],
				skipped: 0,
				total: null,
				directory: null,
				failureReported: false,
				failure: null,
				consecutiveFailures: null
			};
		}
		const LEDGER_FAILED = Object.freeze(ledgerState("failed"));
		/** Stable empty snapshot: a fresh object every render loops React. */
		const EMPTY_SNAPSHOT = Object.freeze({});

		/** `t` replacement when the locale service is absent: show the key, never throw. */
		function identityT(key) {
			return key;
		}

		const STYLES = `
.slu-section{display:flex;flex-direction:column;gap:20px;width:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.slu-title{margin:0;font-size:16px;line-height:24px;font-weight:600}
.slu-description{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.slu-field{display:flex;flex-direction:column;gap:6px}
.slu-fieldLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.slu-value{color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.slu-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.slu-options{display:flex;flex-direction:column;gap:8px}
.slu-option{display:flex;align-items:flex-start;gap:12px;width:100%;box-sizing:border-box;margin:0;padding:12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);color:inherit;font:inherit;text-align:left;cursor:pointer}
@media (hover:hover){.slu-option:hover{border-color:var(--dsw-alias-border-l4);background-color:var(--dsw-alias-interactive-bg-hover)}}
.slu-option:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}
.slu-option[aria-checked="true"]{border-color:var(--dsw-alias-label-primary)}
.slu-option[aria-disabled="true"]{cursor:default;opacity:.6}
.slu-dot{position:relative;flex:none;width:16px;height:16px;margin-top:3px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l4);border-radius:50%}
.slu-option[aria-checked="true"] .slu-dot{border-color:var(--dsw-alias-label-primary)}
.slu-option[aria-checked="true"] .slu-dot::after{content:"";position:absolute;inset:3px;border-radius:50%;background-color:var(--dsw-alias-label-primary)}
.slu-optionText{display:flex;flex-direction:column;gap:2px;min-width:0}
.slu-optionLabel{font-size:14px;line-height:20px}
.slu-optionDetail{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.slu-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.slu-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.slu-manual{display:flex;flex-direction:column;gap:8px;padding:12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.slu-manualTitle{font-size:14px;line-height:20px;cursor:pointer}
.slu-manualBody{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.slu-ledger{display:flex;flex-direction:column;gap:8px;padding:12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.slu-ledgerHeader{display:flex;align-items:center;justify-content:space-between;gap:12px}
.slu-ledgerTitle{font-size:14px;line-height:20px}
.slu-ledgerScroll{overflow:auto;max-height:260px}
.slu-ledgerTable{width:100%;border-collapse:collapse;font-size:12px;line-height:18px}
.slu-ledgerTable th{padding:4px 8px 4px 0;color:var(--dsw-alias-label-secondary);font-weight:400;text-align:left;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.slu-ledgerTable td{padding:4px 8px 4px 0;vertical-align:top;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.slu-ledgerMono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.slu-ledgerPath{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.slu-ledgerFailure{display:flex;flex-direction:column;gap:4px;padding:12px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.slu-ledgerFailureTitle{font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}
.slu-ledgerFailureSummary{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}
.slu-ledgerPersistent{font-size:12px;line-height:18px}
.slu-ledgerDetail{margin:0;padding:8px;box-sizing:border-box;max-height:120px;overflow:auto;border-radius:var(--dsw-radius-sm);background-color:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;unicode-bidi:isolate;direction:ltr}
.slu-ledgerSessionTitle{display:block;font-weight:600}
.slu-ledgerId{display:block;color:var(--dsw-alias-label-secondary)}
.slu-fieldRow{display:flex;align-items:center;gap:8px}
.slu-input{box-sizing:border-box;flex:1;min-width:0;height:32px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background-color:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px}
.slu-input:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}
.slu-toggle{display:flex;flex-direction:column;gap:4px}
.slu-toggleLabel{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;cursor:pointer}
/* The folder chooser. Without these rules the checkboxes and their labels collapse into one
   unpunctuated run of text, which is what the first version rendered. */
.slu-help{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.slu-picker{display:flex;flex-direction:column;gap:8px;padding:12px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.slu-checks{display:flex;flex-direction:column;gap:2px;max-height:280px;overflow:auto}
.slu-check{display:flex;align-items:center;gap:8px;padding:3px 4px;box-sizing:border-box;border-radius:var(--dsw-radius-sm);font-size:12px;line-height:18px;cursor:pointer}
.slu-check:hover{background-color:var(--dsw-alias-bg-layer-2)}
.slu-check input{flex:none;margin:0;cursor:pointer}
.slu-checkPath{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.slu-checkWorkspace{font-weight:600;color:var(--dsw-alias-label-primary)}
.slu-checkSession{padding-left:24px;color:var(--dsw-alias-label-secondary)}
/* A delegated child conversation: one more indent than a session row, so the lineage is visible.
   No literal colour here; the row keeps the colours of its base classes. */
.slu-checkSessionChild{padding-left:48px}
/* The per-row explanation for a Session covered by a ticked folder. */
.slu-checkHint{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
/* The liability notice: wider than the consent dialog and scrolling, because it is four paragraphs
   a user is meant to actually read. */
.slu-noticePanel{width:min(560px,calc(100vw - 48px))}
.slu-noticeBody{display:flex;flex-direction:column;gap:8px;max-height:44vh;overflow:auto}
.slu-noticeCheck{display:flex;align-items:flex-start;gap:8px;padding:10px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);font-size:14px;line-height:20px;cursor:pointer}
.slu-noticeCheck input{flex:none;margin:2px 0 0;cursor:pointer}
/* The in-flow banner used when the notice READ failed: the same notice and controls, but the
   settings page behind it stays usable. An unknown acknowledgement state must not block the page. */
.slu-noticeBanner{display:flex;flex-direction:column;gap:8px;padding:12px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.slu-noticeBannerTitle{margin:0;font-size:16px;line-height:24px;font-weight:600}
.slu-noticeBanner .slu-noticeBody{max-height:none}
.slu-noticeFailure{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.slu-noticeRetry{height:24px;padding:0 8px;font-size:12px}
.slu-fieldState{font-size:12px;line-height:18px}
.slu-saved{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.slu-pre{margin:0;padding:12px;box-sizing:border-box;border-radius:var(--dsw-radius-sm);background-color:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;max-height:220px}
.slu-overlay{position:fixed;inset:0;z-index:1100;display:flex;align-items:center;justify-content:center}
.slu-mask{position:absolute;inset:0;background-color:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.slu-panel{position:relative;z-index:1;display:flex;flex-direction:column;gap:12px;box-sizing:border-box;width:min(440px,calc(100vw - 48px));max-height:calc(100vh - 96px);overflow:auto;padding:20px;border-radius:var(--dsw-radius-panel);background-color:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}
.slu-panel:focus{outline:none}
.slu-panelTitle{margin:0;font-size:16px;line-height:24px;font-weight:600}
.slu-panelBody{margin:0;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}
.slu-panelEndpoint{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.slu-panelActions{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}
.slu-btn{box-sizing:border-box;height:32px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;cursor:pointer}
@media (hover:hover){.slu-btn:hover{border-color:var(--dsw-alias-border-l4);background-color:var(--dsw-alias-interactive-bg-hover)}}
.slu-btn:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}
.slu-btnPrimary{border-color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-interactive-bg-hover)}
/* The other-harness import: its own panel, groups and rows. Rows reuse the chooser's .slu-check
   base so the two pickers look like the same control; the text column is what is new. */
.slu-foreign{display:flex;flex-direction:column;gap:8px;padding:12px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.slu-foreignTitle{margin:0;font-size:14px;line-height:20px;font-weight:600}
.slu-foreignGroups{display:flex;flex-direction:column;gap:12px}
.slu-foreignGroup{display:flex;flex-direction:column;gap:4px}
.slu-foreignGroupTitle{color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;font-weight:600}
.slu-foreignRows{display:flex;flex-direction:column;gap:2px}
.slu-foreignRow{align-items:flex-start}
.slu-foreignText{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0}
.slu-foreignName{font-size:14px;line-height:20px;overflow-wrap:anywhere}
.slu-foreignMeta{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.slu-foreignStatus{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.slu-foreignStatus.slu-error{color:var(--dsw-alias-state-error-primary)}
/* The plugin self-update block: its own panel so it reads as a separate action from the upload
   settings. Same border/radius tokens as the other panels; no literal colour. */
.slu-update{display:flex;flex-direction:column;gap:8px;padding:12px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.slu-updateTitle{margin:0;font-size:14px;line-height:20px;font-weight:600}
.slu-updateValue{margin:0;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;overflow-wrap:anywhere}
`;

		//#region style registration
		/**
		 * Install the section stylesheet once per activation and remove it again on dispose.
		 * @returns the disposer for `ctx.effect`.
		 */
		function registerStyles() {
			if (typeof document === "undefined" || document === null || !document.head) return function () {};
			const tag = document.createElement("style");
			tag.setAttribute("data-plugin", PLUGIN_ID);
			tag.setAttribute("data-plugin-css", CSS_MARKER);
			tag.textContent = STYLES;
			document.head.appendChild(tag);
			return function () {
				try {
					if (tag.parentNode) tag.parentNode.removeChild(tag);
				} catch (_error) {}
			};
		}
		//#endregion

		//#region small helpers
		/** @returns the value when it is a non-null object, else null. */
		function asObject(value) {
			return value !== null && value !== undefined && typeof value === "object" ? value : null;
		}
		/**
		 * Unwrap one settings field. A schema field marked volatile reaches the browser as a
		 * live reference (`{ get: () => value }`) rather than as a plain value, and reading it
		 * as-is would silently lose the current value.
		 *
		 * Arrays are returned as-is, NOT treated as "not a plain value": a list field
		 * (`deepseekModelPatterns`, `uploadDirectories`) is legitimately an array, and the
		 * earlier `return null` for every object turned a successfully-saved list into "nothing
		 * reported" on the page — the write went through and the control still showed the old value.
		 * @returns the plain value, or null when this is a reference that cannot be read.
		 */
		function fieldValue(value) {
			if (value === null || value === undefined) return null;
			if (typeof value !== "object") return value;
			// A list is a value in its own right.
			if (Array.isArray(value)) return value;
			try {
				if (typeof value.get === "function") return fieldValue(value.get());
			} catch (_error) {}
			// A plain object with no accessor is also a value (a projection may hand one back).
			return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null ? value : null;
		}
		/** @returns the first argument that is a non-empty string, else null. */
		function firstString() {
			for (let index = 0; index < arguments.length; index++) {
				const value = arguments[index];
				if (typeof value === "string" && value.length > 0) return value;
			}
			return null;
		}
		/**
		 * The Host's endpoint predicate, exactly as `host/config.js` `normalizeEndpoint` (and
		 * `host/upload.js` `isAbsoluteHttpEndpoint`) apply it: a non-empty string whose first
		 * characters are `http://` or `https://`, case-insensitively. Nothing else is checked —
		 * no trimming, no `new URL` parse. Both the display narrowing and the input validation go
		 * through this one function so they cannot drift.
		 * @param value - candidate value.
		 * @returns whether the Host would use it as the destination.
		 */
		function isAbsoluteHttpEndpoint(value) {
			return typeof value === "string" && value.length > 0 && /^https?:\/\//i.test(value);
		}
		/**
		 * The Host's byte-cap predicate, exactly as `host/config.js` `normalizeMaxBytes` applies
		 * it: a safe integer ≥ 1. `Number.isSafeInteger` is the load-bearing half — the schema
		 * accepts larger integers that the Host refuses to use.
		 * @param value - candidate value.
		 * @returns whether the Host would use it as the cap.
		 */
		function isUsableByteCap(value) {
			return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
		}
		/**
		 * The only fields the generic settings field editor edits directly. `mode` is deliberately
		 * absent: it has its own consent-gated path, and this list is what makes it impossible for
		 * the field editor to widen the mode by accident. The other-harness tick set is written by
		 * the import block's own Save control, so it is not listed here either (see `writeField`) —
		 * the generic editor must never offer a control for it.
		 */
		const EDITABLE_FIELDS = Object.freeze([ "endpoint", "maxBytes", "deepseekModelPatterns", "uploadDirectories", "uploadSessionIds" ]);
		/**
		 * The destination the Host will actually POST to, for one reported value.
		 *
		 * The settings wire reports the *stored* value, while the Host narrows it before use, so a
		 * value the Host would refuse (a bare host, a relative path, `file:`, `javascript:`,
		 * `data:`, `ftp:`, `ws:`, a protocol-relative `//host`, any non-string, the empty string,
		 * a missing value) must display as the default instead of naming a destination the plugin
		 * never posts to.
		 *
		 * @param value - the reported value, already unwrapped by `fieldValue`.
		 * @returns the endpoint the Host will use.
		 */
		function endpointInUse(value) {
			return isAbsoluteHttpEndpoint(value) ? value : PATCH_ROW.endpoint;
		}
		/**
		 * The byte cap the Host will actually apply, for one reported value: the value when the
		 * Host would use it, the default otherwise.
		 * @param value - the reported value, already unwrapped by `fieldValue`.
		 * @returns the byte cap the Host will use.
		 */
		function maxBytesInUse(value) {
			return isUsableByteCap(value) ? value : PATCH_ROW.maxBytes;
		}
		/**
		 * The model-pattern list the Host will actually match with, for one reported value: the
		 * entries it would keep, or the shipped default otherwise. Mirrors `host/config.js`'s
		 * `normalizePatterns` — a scalar string is a one-element list, arrays keep their non-empty
		 * string entries, anything else falls back.
		 * @param value - the reported value, already unwrapped by `fieldValue`.
		 * @returns the patterns the Host will use.
		 */
		function patternsInUse(value) {
			if (value === undefined || value === null) return PATCH_ROW.deepseekModelPatterns.slice();
			if (typeof value === "string") return value.length > 0 ? [ value ] : [];
			if (Array.isArray(value)) return value.filter(function (entry) { return typeof entry === "string" && entry.length > 0; });
			return PATCH_ROW.deepseekModelPatterns.slice();
		}
		/**
		 * The excluded-directory list the Host will actually compare against, normalized the same
		 * way `host/config.js` normalizes it (case-insensitive, forward slashes, no trailing slash),
		 * so what the page shows is what the Host matches.
		 * @param value - the reported value, already unwrapped by `fieldValue`.
		 * @returns the normalized directories the Host will use.
		 */
		function directoriesInUse(value) {
			const raw = typeof value === "string" ? [ value ] : Array.isArray(value) ? value : [];
			const seen = Object.create(null);
			const out = [];
			for (let index = 0; index < raw.length; index++) {
				const normalized = normalizeDirectoryPath(raw[index]);
				if (normalized !== null && seen[normalized] !== true) {
					seen[normalized] = true;
					out.push(normalized);
				}
			}
			return out;
		}
		/**
		 * The per-Session allowlist the Host will use, for one reported value.
		 *
		 * Session ids are OPAQUE: unlike a directory path they are never lower-cased, trimmed or
		 * separator-folded. Doing so would silently match a Session the user did not tick, so this
		 * keeps exactly the non-empty strings the Host would keep — and nothing else.
		 * @param value - the reported value, already unwrapped by `fieldValue`.
		 * @returns the Session ids the Host will use.
		 */
		function sessionIdsInUse(value) {
			const raw = typeof value === "string" ? [ value ] : Array.isArray(value) ? value : [];
			const seen = Object.create(null);
			const out = [];
			for (let index = 0; index < raw.length; index++) {
				const id = raw[index];
				if (typeof id !== "string" || id.length === 0 || seen[id] === true) continue;
				seen[id] = true;
				out.push(id);
			}
			return out;
		}
		/**
		 * Normalize one directory path exactly as the Host does.
		 * @param value - a candidate path.
		 * @returns the normalized form, or null when unusable.
		 */
		function normalizeDirectoryPath(value) {
			if (typeof value !== "string") return null;
			const trimmed = value.trim();
			if (trimmed.length === 0) return null;
			const slashed = trimmed.replace(/\\/g, "/");
			const collapsed = slashed.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
			if (collapsed.length === 0) return null;
			return collapsed.toLowerCase();
		}
		/**
		 * Turn one list draft into the array to write: one entry per line, trimmed, blanks dropped.
		 *
		 * De-duplication uses the **host's own normalization** as the key, so two spellings of the same
		 * directory (`D:\secret` and `d:/secret`) collapse to one entry — otherwise the list would show
		 * duplicates for a single exclusion, and the user would have no way to tell they were the same.
		 * The first spelling as typed is what gets written, so the user's own form survives.
		 *
		 * An empty list is a legitimate value (it means "nothing"), so this never returns null.
		 * @param text - what the user typed, one entry per line.
		 * @returns the array to write.
		 */
		function listToWrite(text) {
			const lines = String(text).split(/\r?\n/);
			const seen = Object.create(null);
			const out = [];
			for (let index = 0; index < lines.length; index++) {
				const trimmed = lines[index].trim();
				if (trimmed.length === 0) continue;
				const key = normalizeDirectoryPath(trimmed);
				if (key !== null) {
					if (seen[key] === true) continue;
					seen[key] = true;
					out.push(trimmed);
					continue;
				}
				// Not a path (a bare model-id pattern): compare case-insensitively, then stop trying
				// to interpret it as a directory.
				const lowered = trimmed.toLowerCase();
				if (seen[lowered] === true) continue;
				seen[lowered] = true;
				out.push(trimmed);
			}
			return out;
		}
		/**
		 * Validate one endpoint draft for a write.
		 * @param text - what the user typed.
		 * @returns the exact string to write, or null when the Host would not use it.
		 */
		function endpointToWrite(text) {
			return isAbsoluteHttpEndpoint(text) ? text : null;
		}
		/**
		 * Validate one byte-cap draft for a write. The field is text, so the draft is parsed as a
		 * number first; the value that is written is that exact byte count, never a rounded size.
		 * @param text - what the user typed.
		 * @returns the exact byte count to write, or null when the Host would not use it.
		 */
		function capToWrite(text) {
			if (typeof text !== "string") return null;
			const trimmed = text.trim();
			if (trimmed.length === 0) return null;
			const parsed = Number(trimmed);
			return isUsableByteCap(parsed) ? parsed : null;
		}
		/** @returns a finite number, else null. */
		function numberOrNull(value) {
			return typeof value === "number" && Number.isFinite(value) ? value : null;
		}
		/**
		 * The page's own `fetch`, captured the way the shipped export client captures it
		 * (`dsh-session-log-export/lib/client.js`: `(input, init) => fetch(input, init)`), so a
		 * Host route is read with the page's own credential and same-origin base.
		 * @returns a fetch function, or null when the page exposes none.
		 */
		function pageFetcher() {
			if (typeof fetch !== "function") return null;
			return function (input, init) {
				return fetch(input, init);
			};
		}
		/**
		 * Shorten a long identifier in the middle, keeping both ends recognisable.
		 * @param value - the identifier.
		 * @param limit - the length at which shortening starts.
		 */
		function truncateMiddle(value, limit) {
			if (value.length <= limit) return value;
			const tail = Math.max(1, Math.floor((limit - 1) / 3));
			const head = Math.max(1, limit - 1 - tail);
			return value.slice(0, head) + "…" + value.slice(value.length - tail);
		}
		/** @returns the browser's local time for a timestamp, or null when it is not a time. */
		function humanTime(milliseconds) {
			const date = new Date(milliseconds);
			if (!Number.isFinite(date.getTime())) return null;
			try {
				return date.toLocaleString();
			} catch (_error) {
				return null;
			}
		}
		/**
		 * Turn one other-harness scan payload into the groups the section renders.
		 *
		 * The payload is untrusted: a group needs a name (a row without one could not be labelled),
		 * and a session needs a composite id (without one it could not be ticked or sent), so
		 * anything else is dropped instead of becoming an invented row. Every other field is
		 * optional and is kept as `null` when the Host did not report it, so the renderer can say
		 * "not reported" rather than printing the word "undefined".
		 *
		 * @param body - the parsed GET payload.
		 * @returns `{harnesses, error}`, or null when the payload has no harness list at all.
		 */
		function normalizeForeignScan(body) {
			const root = asObject(body);
			if (root === null || !Array.isArray(root.harnesses)) return null;
			const harnesses = [];
			for (const rawGroup of root.harnesses) {
				const group = asObject(rawGroup);
				if (group === null) continue;
				const harness = firstString(group.harness);
				const label = firstString(group.label, harness);
				if (label === null) continue;
				const sessions = [];
				if (Array.isArray(group.sessions)) {
					for (const rawSession of group.sessions) {
						const record = asObject(rawSession);
						if (record === null) continue;
						const id = firstString(record.id);
						if (id === null) continue;
						const messageCount = numberOrNull(record.messageCount);
						sessions.push({
							id: id,
							// A session with no title is still a row; the renderer substitutes readable copy.
							title: firstString(record.title),
							cwd: firstString(record.cwd),
							provider: firstString(record.provider),
							model: firstString(record.model),
							// Optional lineage, composite form. `""`/absent is "no lineage reported",
							// which is different from a parent id this payload does not contain.
							parentId: firstString(record.parentId),
							messageCount: messageCount !== null && messageCount >= 0 ? messageCount : null
						});
					}
				}
				harnesses.push({
					harness: harness === null ? label : harness,
					label: label,
					available: group.available === true,
					error: firstString(group.error),
					sessions: sessions
				});
			}
			// Lineage is only a parent when the named row is in this payload. A parentId that is
			// missing, empty, names this row itself, or names a row the payload does not carry
			// leaves the row at top level; it never becomes a parent it cannot point at.
			const known = Object.create(null);
			for (const group of harnesses) {
				for (const session of group.sessions) known[session.id] = true;
			}
			for (const group of harnesses) {
				for (const session of group.sessions) {
					session.child = session.parentId !== null
						&& session.parentId !== session.id
						&& known[session.parentId] === true;
				}
			}
			return { harnesses: harnesses, error: firstString(root.error) };
		}
		/**
		 * Order one harness group for rendering so a delegated child row appears immediately after
		 * the row its `parentId` names, when that parent is in the same group. Rows whose parent is
		 * in another group still carry the child class, but stay in their own group; rows with no
		 * resolvable parent stay in payload order. The walk emits each row at most once, so a
		 * cyclic or self-referential lineage terminates instead of hanging.
		 *
		 * @param group - one normalized harness group.
		 * @returns the sessions in render order.
		 */
		function orderForeignSessions(group) {
			const inGroup = Object.create(null);
			for (const session of group.sessions) {
				if (inGroup[session.id] === undefined) inGroup[session.id] = session;
			}
			const children = Object.create(null);
			const tops = [];
			for (const session of group.sessions) {
				if (session.parentId !== null && session.parentId !== session.id && inGroup[session.parentId] !== undefined) {
					if (children[session.parentId] === undefined) children[session.parentId] = [];
					children[session.parentId].push(session);
				} else {
					tops.push(session);
				}
			}
			const ordered = [];
			const seen = Object.create(null);
			const emit = function (session) {
				if (seen[session.id] === true) return;
				seen[session.id] = true;
				ordered.push(session);
				const kids = children[session.id];
				if (kids === undefined) return;
				for (const child of kids) emit(child);
			};
			for (const session of tops) emit(session);
			// Anything still unemitted sits in a cycle; emit it in payload order so it is still shown.
			for (const session of group.sessions) emit(session);
			return ordered;
		}
		/**
		 * Every id in the lineage subtree rooted at one row: the row itself plus all of its
		 * descendants, transitively, in payload order. Ticking a conversation in this list means
		 * "this conversation and the ones it spawned", so a parent tick has to reach a grandchild.
		 *
		 * Descendants are resolved across the whole payload, not one harness group: a delegated
		 * child still belongs to the conversation that started it. The walk is bounded by a visited
		 * set, so a cyclic lineage cannot loop, and a `parentId` naming no row in the payload
		 * contributes no edge at all (it cannot pull an unrelated row into the cascade).
		 *
		 * @param groups - the normalized harness groups from the scan.
		 * @param rootId - the id whose subtree is wanted.
		 * @returns the ids to update, root first then descendants.
		 */
		function foreignCascadeIds(groups, rootId) {
			const known = Object.create(null);
			for (const group of groups) {
				for (const session of group.sessions) {
					if (known[session.id] === undefined) known[session.id] = true;
				}
			}
			const children = Object.create(null);
			for (const group of groups) {
				for (const session of group.sessions) {
					if (session.parentId === null || session.parentId === session.id) continue;
					if (known[session.parentId] !== true) continue;
					if (children[session.parentId] === undefined) children[session.parentId] = [];
					children[session.parentId].push(session.id);
				}
			}
			const ids = [];
			const seen = Object.create(null);
			const visit = function (id) {
				if (seen[id] === true) return;
				seen[id] = true;
				ids.push(id);
				const kids = children[id];
				if (kids === undefined) return;
				for (const child of kids) visit(child);
			};
			visit(rootId);
			return ids;
		}
		/**
		 * The second line of one scanned-session row: folder, provider/model, message count.
		 * Each absent fact is named as unreported instead of being printed as an empty string.
		 * @param session - one normalized session.
		 * @param t - bound dictionary lookup.
		 */
		function foreignRowMeta(session, t) {
			const parts = [ session.cwd === null ? t("foreign.cwdUnknown") : session.cwd ];
			if (session.provider !== null && session.model !== null) parts.push(session.provider + "/" + session.model);
			else if (session.model !== null) parts.push(session.model);
			else if (session.provider !== null) parts.push(session.provider);
			else parts.push(t("foreign.modelUnknown"));
			parts.push(session.messageCount === null
				? t("upload.valueUnknown")
				: String(session.messageCount) + " " + t("foreign.messages"));
			return parts.join(" · ");
		}
		/**
		 * The placeholder text of one row's send state: waiting / sending / sent with a request
		 * count / failed with the reason. A row the current send has not touched has no state and
		 * therefore no line, which is different from the waiting state.
		 * @param status - the row's state, or undefined.
		 * @param t - bound dictionary lookup.
		 * @returns the text, or null when there is nothing to report yet.
		 */
		function foreignStatusText(status, t) {
			const state = asObject(status);
			if (state === null) return null;
			if (state.kind === "waiting") return t("foreign.statusWaiting");
			if (state.kind === "sending") return t("foreign.statusSending");
			// A stopped row was never attempted: it must not read as waiting (still queued) or as
			// failed (the Host said nothing about it). "Stopped" is its own honest outcome.
			if (state.kind === "stopped") return t("foreign.statusStopped");
			if (state.kind === "ok") {
				const requests = numberOrNull(state.requests);
				// A truncated import is still a success, but saying only "sent" would hide that the tail of
				// the conversation never left the machine. The two readings must differ.
				const template = state.truncated === true ? "foreign.statusOkTruncated" : "foreign.statusOk";
				return t(template).replace("{requests}", requests === null ? t("upload.valueUnknown") : String(requests));
			}
			const detail = firstString(state.error);
			if (detail !== null) return t("foreign.statusFailed").replace("{error}", detail);
			if (numberOrNull(state.status) !== null) return t("foreign.statusFailed").replace("{error}", "HTTP " + String(state.status));
			return t("foreign.statusFailed").replace("{error}", t("foreign.statusUnknown"));
		}
		/**
		 * The end-of-batch line: how many rows were actually sent and how many were not (failed or
		 * stopped). Rendered in an aria-live region so a screen reader hears the stop, not just the
		 * sighted user who watched the row statuses change.
		 * @param summary - `{sent, notSent}`.
		 * @param t - bound dictionary lookup.
		 */
		function foreignSummaryText(summary, t) {
			const state = asObject(summary);
			if (state === null) return null;
			const sent = numberOrNull(state.sent);
			const notSent = numberOrNull(state.notSent);
			return t("foreign.summary")
				.replace("{sent}", sent === null ? t("upload.valueUnknown") : String(sent))
				.replace("{notSent}", notSent === null ? t("upload.valueUnknown") : String(notSent));
		}
		/**
		 * The send label with the number of ticked sessions substituted. The locale files carry
		 * the sentence, so both languages keep their own word order around the number.
		 * @param t - bound dictionary lookup.
		 * @param count - how many sessions are ticked.
		 */
		function foreignSendLabel(t, count) {
			return t("foreign.send").replace("{count}", String(count));
		}
		/**
		 * Compare two dotted numeric versions, the way the Host's own `compareVersions` does.
		 *
		 * Only used to say whether the published manifest is older than what is installed, so it does
		 * not need the Host's full SemVer handling: missing segments count as 0, a non-numeric segment
		 * ends the comparison, and an unparseable pair returns 0 (meaning "cannot tell", which renders
		 * as the ordinary up-to-date line rather than inventing a problem).
		 *
		 * @param left - one version string.
		 * @param right - the version to compare against.
		 * @returns -1 when left is older, 1 when newer, 0 when equal or not comparable.
		 */
		function compareVersionStrings(left, right) {
			if (typeof left !== "string" || typeof right !== "string") return 0;
			const parse = function (text) {
				const head = text.trim().replace(/^v/i, "").split(/[-+]/)[0];
				const parts = head.split(".");
				const numbers = [];
				for (const part of parts) {
					if (!/^\d+$/.test(part)) break;
					numbers.push(Number(part));
				}
				return numbers;
			};
			const a = parse(left);
			const b = parse(right);
			if (a.length === 0 || b.length === 0) return 0;
			const length = Math.max(a.length, b.length);
			for (let index = 0; index < length; index += 1) {
				const one = index < a.length ? a[index] : 0;
				const other = index < b.length ? b[index] : 0;
				if (one < other) return -1;
				if (one > other) return 1;
			}
			return 0;
		}
		/**
		 * Turn one Host update-check payload into the fields the block renders.
		 *
		 * The payload is untrusted and every field is optional. `current` and `latest` are kept as
		 * reported strings or null: the block says "not reported" instead of naming a version the
		 * Host did not report. `files` is only counted, never read for content, because the page
		 * shows how many files an update replaces and never touches the file data itself.
		 *
		 * @param body - the parsed GET payload.
		 * @returns the normalized check, or null when the body is not an object at all.
		 */
		function normalizeUpdateCheck(body) {
			const root = asObject(body);
			if (root === null) return null;
			let fileCount = 0;
			if (Array.isArray(root.files)) {
				for (const raw of root.files) {
					if (asObject(raw) !== null) fileCount++;
				}
			}
			return {
				ok: root.ok === true,
				current: firstString(root.current),
				latest: firstString(root.latest),
				available: root.available === true,
				notes: firstString(root.notes),
				manifestUrl: firstString(root.manifestUrl),
				source: firstString(root.source),
				fileCount: fileCount,
				error: firstString(root.error)
			};
		}
		/**
		 * Turn one Host ledger payload into the rows the section renders.
		 *
		 * The payload is untrusted: every field is optional, and a record without a session id has
		 * no identity to render, so it is counted as skipped rather than becoming a row. Nothing is
		 * invented, and only the four metadata fields are read — the ledger is not a channel for
		 * Session content, and no content is requested anywhere.
		 *
		 * @param body - the parsed response body.
		 * @returns `{status, sessions, skipped, total, directory}`.
		 */
		function normalizeLedger(body) {
			const root = asObject(body);
			if (root === null || !Array.isArray(root.sessions)) return ledgerState("malformed");
			const sessions = [];
			let skipped = 0;
			for (let index = 0; index < root.sessions.length; index++) {
				const record = asObject(root.sessions[index]);
				const sessionId = record === null ? null : firstString(record.sessionId);
				if (sessionId === null) {
					skipped++;
					continue;
				}
				sessions.push({
					sessionId: sessionId,
					afterSeq: numberOrNull(record.afterSeq),
					sessionFormatVersion: numberOrNull(record.sessionFormatVersion),
					updatedAt: numberOrNull(record.updatedAt)
				});
			}
			// Newest first. A record with no usable time sorts last, and equal times keep the
			// Host's own order because `sort` is stable.
			sessions.sort(function (left, right) {
				const leftTime = left.updatedAt === null ? -Infinity : left.updatedAt;
				const rightTime = right.updatedAt === null ? -Infinity : right.updatedAt;
				if (leftTime === rightTime) return 0;
				return rightTime - leftTime;
			});
			// An absent `lastFailure` is "the Host did not report this"; a present `null` is "no
			// failure". Those are different claims, so presence is recorded separately from value.
			const failureReported = Object.prototype.hasOwnProperty.call(root, "lastFailure");
			const failures = numberOrNull(root.consecutiveFailures);
			return {
				status: "ready",
				sessions: sessions,
				skipped: skipped,
				total: numberOrNull(root.total),
				directory: firstString(root.directory),
				failureReported: failureReported,
				failure: failureReported ? normalizeFailure(root.lastFailure) : null,
				consecutiveFailures: failures !== null && failures >= 0 ? failures : null
			};
		}
		/** @returns the locale key explaining one non-ready ledger state. */
		function ledgerStateKey(status) {
			if (status === "missing") return "upload.ledger.stateMissing";
			if (status === "unauthorized") return "upload.ledger.stateUnauthorized";
			if (status === "malformed") return "upload.ledger.stateMalformed";
			return "upload.ledger.stateFailed";
		}
		/** The closed set of upload-failure kinds the Host may report. */
		const FAILURE_KINDS = Object.freeze([
			"no-credential",
			"endpoint-refused",
			"http-error",
			"transport-error",
			"payload-too-large",
			"unknown"
		]);
		/**
		 * The locale key for one failure kind. The wire ids carry hyphens and no locale key may, so
		 * they are mapped explicitly; an id outside the closed set is reported as `unknown` rather
		 * than invented.
		 * @param kind - the Host's `kind` value, already narrowed to the closed set.
		 */
		function failureKindKey(kind) {
			if (kind === "no-credential") return "upload.ledger.failureKindNoCredential";
			if (kind === "endpoint-refused") return "upload.ledger.failureKindEndpointRefused";
			if (kind === "http-error") return "upload.ledger.failureKindHttpError";
			if (kind === "transport-error") return "upload.ledger.failureKindTransportError";
			if (kind === "payload-too-large") return "upload.ledger.failureKindPayloadTooLarge";
			return "upload.ledger.failureKindUnknown";
		}
		/**
		 * Read one `lastFailure` record. Only the six contract fields are read, and the caller
		 * decides whether the field was reported at all: an absent field means "the Host did not
		 * report this", which is a different claim from a reported `null` ("no failure").
		 *
		 * `detail` is untrusted English text from the Host: it is kept as a string and rendered as a
		 * text node, never as markup.
		 *
		 * @param value - the raw `lastFailure` value.
		 * @returns the record to render, or null when the Host reported no failure.
		 */
		function normalizeFailure(value) {
			const record = asObject(value);
			if (record === null) return null;
			const kind = typeof record.kind === "string" && FAILURE_KINDS.indexOf(record.kind) >= 0 ? record.kind : "unknown";
			const detail = record.detail;
			return {
				at: numberOrNull(record.at),
				sessionId: firstString(record.sessionId),
				retryable: record.retryable === true,
				kind: kind,
				status: numberOrNull(record.status),
				detail: typeof detail === "string" && detail.length > 0 ? detail : null
			};
		}
		/**
		 * The "why is nothing arriving" block: the last upload failure, or an honest statement that
		 * the Host recorded none — or never reported the field, which is a different claim. A run of
		 * failures is stated as persistent, because one failure is a blip and a stall is not.
		 * @param ledger - the normalized ledger.
		 * @param t - bound dictionary lookup.
		 */
		function ledgerFailure(ledger, t) {
			const children = [];
			children.push(React.createElement("div", { key: "title", className: "slu-ledgerFailureTitle" }, t("upload.ledger.failureTitle")));
			const count = ledger.consecutiveFailures === null ? 0 : ledger.consecutiveFailures;
			if (ledger.failureReported !== true) {
				children.push(React.createElement("div", { key: "unreported", className: "slu-note" }, t("upload.ledger.failureUnreported")));
			} else if (ledger.failure === null) {
				children.push(React.createElement("div", { key: "none", className: "slu-note" }, t("upload.ledger.failureNone")));
			} else {
				const failure = ledger.failure;
				const meta = [];
				if (failure.sessionId !== null) meta.push(t("upload.ledger.columnSession") + ": " + failure.sessionId);
				if (failure.at !== null) {
					const at = humanTime(failure.at);
					if (at !== null) meta.push(t("upload.ledger.columnTime") + ": " + at);
				}
				// An HTTP status is meaningful only for a status-bearing failure; any other kind
				// carries none, so a stray value is not shown as if it explained the failure.
				if (failure.kind === "http-error" && failure.status !== null) {
					meta.push(t("upload.ledger.failureStatus") + ": " + String(failure.status));
				}
				children.push(React.createElement("div", { key: "summary", className: "slu-ledgerFailureSummary" }, t(failureKindKey(failure.kind))));
				if (meta.length > 0) children.push(React.createElement("div", { key: "meta", className: "slu-note" }, meta.join(" · ")));
				children.push(React.createElement("div", { key: "retry", className: "slu-status" },
					t(failure.retryable ? "upload.ledger.failureRetryable" : "upload.ledger.failureNotRetryable")
				));
				// The one kind that cannot clear itself: the log stays over the cap until it changes.
				if (failure.kind === "payload-too-large") {
					children.push(React.createElement("div", { key: "unresolved", className: "slu-note" }, t("upload.ledger.failureUnresolved")));
				}
				if (failure.detail !== null) {
					children.push(React.createElement("div", { key: "detailLabel", className: "slu-fieldLabel" }, t("upload.ledger.failureDetail")));
					children.push(React.createElement("div", { key: "detail", className: "slu-ledgerDetail" }, failure.detail));
				}
			}
			// One failure is a blip; a run of them is a stall. Stated whenever the Host counted more
			// than one, even if it reported no detail for the latest.
			if (count > 1) {
				children.push(React.createElement("div", { key: "persistent", className: "slu-error slu-ledgerPersistent" }, t("upload.ledger.failurePersistent")));
				children.push(React.createElement("div", { key: "count", className: "slu-status" }, t("upload.ledger.failureCount") + " " + String(count)));
			}
			return React.createElement("div", { key: "failure", className: "slu-ledgerFailure" }, children);
		}
		/**
		 * A stable stand-in for a slot that hands the section no session store. It has the same
		 * arity as the real selector hook and selects nothing, so a ledger row can call whichever
		 * session function it resolved without a conditional call site and without reading a store.
		 * @returns undefined.
		 */
		const NO_SESSIONS = function () {
			return undefined;
		};
		/**
		 * One ledger row.
		 *
		 * A component rather than a mapped `<tr>` because resolving a session name means calling the
		 * slot's own `useSessions` selector hook, and hooks cannot be called in a loop. The section
		 * hands every row the function it resolved for its own mount, so the call below is
		 * unconditional and always the same arity: the choice happens before the call, never inside
		 * it, and the row's hook order cannot move between renders.
		 *
		 * The selector returns nothing while the toggle is off, so a name never leaves the sessions
		 * store unless the user asked for it. An unknown id, a non-string or empty title and a
		 * throwing hook all fall back to the id.
		 *
		 * @param props - `{session, t, useSessions, showSessionNames}`.
		 */
		function LedgerRow(props) {
			const session = props.session;
			const t = props.t;
			const sessionId = session.sessionId;
			const useSessions = typeof props.useSessions === "function" ? props.useSessions : NO_SESSIONS;
			let title = null;
			try {
				// `state.byId[id].title` is where the shell keeps a session's own name.
				const selected = useSessions(function (state) {
					if (props.showSessionNames !== true) return undefined;
					const byId = state !== null && state !== undefined && typeof state === "object" ? state.byId : null;
					const entry = byId !== null && byId !== undefined ? byId[sessionId] : null;
					const value = entry !== null && entry !== undefined ? entry.title : null;
					return typeof value === "string" && value.length > 0 ? value : undefined;
				});
				if (typeof selected === "string" && selected.length > 0) title = selected;
			} catch (_error) {
				title = null;
			}
			const nameChildren = [];
			if (title !== null) nameChildren.push(React.createElement("span", { key: "title", className: "slu-ledgerSessionTitle" }, title));
			nameChildren.push(React.createElement("span", { key: "id", className: "slu-ledgerId" }, truncateMiddle(sessionId, LEDGER_ID_LIMIT)));
			const time = session.updatedAt === null ? null : humanTime(session.updatedAt);
			return React.createElement("tr", null,
				React.createElement("td", { className: "slu-ledgerMono", title: sessionId }, nameChildren),
				React.createElement("td", { className: "slu-ledgerMono" }, session.afterSeq === null ? t("upload.valueUnknown") : String(session.afterSeq)),
				React.createElement("td", null, time === null ? t("upload.valueUnknown") : time),
				React.createElement("td", { className: "slu-ledgerMono" }, session.sessionFormatVersion === null ? t("upload.valueUnknown") : String(session.sessionFormatVersion))
			);
		}
		/**
		 * The detailed log's table: session id (or its name), uploaded-through position, time,
		 * format version. Metadata only — the file holds an index of what was uploaded, not the
		 * uploaded content, and none is requested.
		 * @param sessions - normalized rows.
		 * @param t - bound dictionary lookup.
		 * @param useSessions - the slot's session-store selector hook, or undefined.
		 * @param showSessionNames - whether the user asked for session names.
		 */
		function ledgerTable(sessions, t, useSessions, showSessionNames) {
			const header = React.createElement("tr", null,
				React.createElement("th", null, t("upload.ledger.columnSession")),
				React.createElement("th", null, t("upload.ledger.columnRange")),
				React.createElement("th", null, t("upload.ledger.columnTime")),
				React.createElement("th", null, t("upload.ledger.columnVersion"))
			);
			const rows = sessions.map(function (session, index) {
				return React.createElement(LedgerRow, {
					key: "ledger-row-" + index,
					session: session,
					t: t,
					useSessions: useSessions,
					showSessionNames: showSessionNames
				});
			});
			return React.createElement("table", { className: "slu-ledgerTable" },
				React.createElement("thead", null, header),
				React.createElement("tbody", null, rows)
			);
		}
		/**
		 * Human byte size. Unit words come from the dictionary; no string is hardcoded.
		 * @param bytes - non-negative byte count.
		 * @param t - bound dictionary lookup.
		 */
		function formatBytes(bytes, t) {
			if (bytes >= 1048576) return String(Math.round(bytes / 1048576 * 10) / 10) + " " + t("upload.unitMiB");
			if (bytes >= 1024) return String(Math.round(bytes / 1024)) + " " + t("upload.unitKiB");
			return String(bytes) + " " + t("upload.unitBytes");
		}
		/**
		 * The exact `cordis.patch.yml` row a user can paste to reach a mode by hand: the same
		 * id, name, and six config keys this profile's row carries, with the selected mode.
		 * @param mode - selected or last-attempted mode id.
		 */
		function patchSnippet(mode) {
			const lines = [
				"- insert:",
				"    - id: " + NAMESPACE,
				"      name: '" + PLUGIN_ID + "'",
				"      config:",
				"        mode: " + mode
			];
			lines.push("        deepseekModelPatterns:");
			for (let index = 0; index < PATCH_ROW.deepseekModelPatterns.length; index++) {
				lines.push("          - " + PATCH_ROW.deepseekModelPatterns[index]);
			}
			lines.push("        endpoint: " + PATCH_ROW.endpoint);
			lines.push("        uploadModel: " + PATCH_ROW.uploadModel);
			lines.push("        credentialRef: " + PATCH_ROW.credentialRef);
			lines.push("        maxBytes: " + PATCH_ROW.maxBytes);
			return lines.join("\n");
		}
		/** @returns the slash command that reaches a mode from inside a Session. */
		function patchCommand(mode) {
			return "/" + NAMESPACE + " " + mode;
		}
		//#endregion

		//#region settings document decoding
		/** Plausible descriptor containers, because the remote response shape is unverified. */
		function pickDescriptorList(value) {
			if (Array.isArray(value)) return value;
			const object = asObject(value);
			if (object === null) return null;
			if (Array.isArray(object.descriptors)) return object.descriptors;
			if (Array.isArray(object.value)) return object.value;
			const nested = asObject(object.value);
			if (nested !== null && Array.isArray(nested.descriptors)) return nested.descriptors;
			// The shared `configForms.describe()` face is the Describe mirror, whose snapshot
			// carries the served namespaces under `view.namespaces`.
			const view = asObject(object.view);
			if (view !== null && Array.isArray(view.namespaces)) return view.namespaces;
			return null;
		}
		/** @returns the descriptor for `ns`, accepting an array or any wrapped form. */
		function findDescriptor(value, ns) {
			const list = pickDescriptorList(value);
			if (list !== null) {
				for (let index = 0; index < list.length; index++) {
					const entry = asObject(list[index]);
					if (entry === null) continue;
					if (entry.ns === ns || entry.namespace === ns) return entry;
				}
				return null;
			}
			const single = asObject(value);
			if (single !== null && (single.ns === ns || single.namespace === ns)) return single;
			return null;
		}
		/** @returns the displayable subset of a settings descriptor value, or null. */
		function descriptorToDocument(descriptor) {
			const value = asObject(descriptor.value);
			if (value === null) return null;
			const mode = fieldValue(value.mode);
			const endpoint = fieldValue(value.endpoint);
			const maxBytes = fieldValue(value.maxBytes);
			return {
				mode: typeof mode === "string" ? mode : null,
				endpoint: typeof endpoint === "string" ? endpoint : null,
				maxBytes: typeof maxBytes === "number" && Number.isFinite(maxBytes) ? maxBytes : null
			};
		}
		//#endregion

		//#region host bridge
		/**
		 * Every host interaction the section needs, each step wrapped so that a missing or
		 * unusual service degrades instead of throwing.
		 *
		 * Write order (INTERFACES.md §6): served `configForms` form → `remote.settings.mutate`
		 * with the revision from `describe` → report that neither is available.
		 *
		 * @param ctx - the Client plugin context.
		 */
		function createBridge(ctx) {
			let formCache;
			let formLookedUp = false;

			/** @returns the shared config form for our namespace, or null. */
			function getForm() {
				if (!formLookedUp) {
					formLookedUp = true;
					formCache = null;
					try {
						const forms = ctx.configForms;
						if (forms !== null && forms !== undefined && typeof forms.get === "function") {
							formCache = forms.get(NAMESPACE) || null;
						}
					} catch (_error) {
						formCache = null;
					}
				}
				return formCache;
			}
			/** @returns the `remote.settings` service face, or null. */
			function getSettings() {
				try {
					const remote = ctx.remote;
					if (remote === null || remote === undefined) return null;
					const settings = remote.settings;
					if (settings === null || settings === undefined || typeof settings !== "object") return null;
					return settings;
				} catch (_error) {
					return null;
				}
			}
			/** @returns the shared form's snapshot object, or null when nothing is served. */
			function formSnapshot() {
				const form = getForm();
				if (form === null || typeof form.getSnapshot !== "function") return null;
				try {
					return asObject(form.getSnapshot());
				} catch (_error) {
					return null;
				}
			}
			/**
			 * What the Host reports for our namespace, as the shared form sees it.
			 * `"ready"` — the Host serves the namespace and its document validated;
			 * `"loading"` — the Describe mirror has not answered yet;
			 * `"unavailable"` — the Host does not expose the namespace at all.
			 * @returns `{status, writable}`.
			 */
			function formState() {
				const snapshot = formSnapshot();
				let status = "unavailable";
				if (snapshot !== null) {
					if (snapshot.status === "ready") status = "ready";
					else if (snapshot.status === "loading") status = "loading";
				}
				// Only a served document counts as live. `remote.settings.mutate` is still tried
				// as the contract's second write path, but its mere existence must not make the
				// section look operational: that is what let a click end in a bare save error.
				return { status: status, writable: status === "ready" && snapshot !== null && snapshot.writable !== false };
			}
			/**
			 * Read the displayable settings document for our namespace.
			 * @returns a document object, or null when nothing is served.
			 */
			async function readDocument() {
				try {
					const forms = ctx.configForms;
					if (forms !== null && forms !== undefined && typeof forms.describe === "function") {
						const face = forms.describe();
						const snapshot = face !== null && face !== undefined && typeof face.getSnapshot === "function" ? face.getSnapshot() : null;
						const found = findDescriptor(snapshot, NAMESPACE);
						if (found !== null) return descriptorToDocument(found);
					}
				} catch (_error) {}
				const settings = getSettings();
				if (settings !== null && typeof settings.describe === "function") {
					try {
						const described = await settings.describe();
						const found = findDescriptor(described, NAMESPACE);
						if (found !== null) return descriptorToDocument(found);
					} catch (_error) {}
				}
				return null;
			}
			/**
			 * Persist one configuration field through the strongest available write path: the
			 * served shared form first, then the settings remote (the contract's second path,
			 * which this profile's Host refuses for an entry whose namespace it does not serve),
			 * then nothing.
			 * @param field - the configuration field name.
			 * @param value - the exact value to store.
			 * @returns `{ok, path, doc}`; `path` names the write path that was actually
			 *   exercised (`"form" | "remote" | "none"`), so the caller can tell a refused write
			 *   from the absence of any write path at all. `doc` is whatever document the
			 *   attempt managed to read.
			 */
			async function persistField(field, value) {
				const state = formState();
				const form = getForm();
				const formUsable = state.status === "ready" && state.writable && form !== null && typeof form.set === "function";
				if (formUsable) {
					try {
						const accepted = await form.set(field, value);
						if (accepted !== false) return { ok: true, path: "form", doc: null };
					} catch (_error) {}
				}
				const settings = getSettings();
				if (settings === null || typeof settings.mutate !== "function") {
					return { ok: false, path: formUsable ? "form" : "none", doc: null };
				}
				let revision;
				let document = null;
				try {
					if (typeof settings.describe === "function") {
						const described = await settings.describe();
						const found = findDescriptor(described, NAMESPACE);
						if (found !== null) {
							document = descriptorToDocument(found);
							if (typeof found.revision === "number" && Number.isFinite(found.revision)) revision = found.revision;
						}
					}
				} catch (_error) {}
				try {
					const response = await settings.mutate(NAMESPACE, [ { op: "set", path: [ field ], value: value } ], revision);
					if (response !== null && response !== undefined && response.ok === false) return { ok: false, path: "remote", doc: document };
					return { ok: true, path: "remote", doc: null };
				} catch (_error) {
					return { ok: false, path: "remote", doc: document };
				}
			}

			/**
			 * Read the Host's upload ledger over the page's own fetch, the way the shipped
			 * `dsh-session-log-export` client reads its Markdown route: a document-relative path
			 * (`"api/…"`, no leading slash), so the page's own mount decides the base.
			 *
			 * Every failure is a state, never an exception: an absent route (404), a refused
			 * credential (401/403), an unreadable body, a missing `sessions` array and a transport
			 * failure are reported distinctly, so the section can say which one happened instead of
			 * showing an invented row.
			 *
			 * @returns `{status, sessions, skipped, total, directory, failureReported, failure, consecutiveFailures}`.
			 */
			async function readLedger() {
				const fetcher = pageFetcher();
				if (fetcher === null) return LEDGER_FAILED;
				// Same credential race as the notice read: the first mount after a DSH restart can fire
				// before the browser has stored the cookie for the (possibly new) port, and the request
				// fails. Retrying a couple of times before reporting keeps a startup race from reading as
				// "the Host does not serve this route". A 401/403/404 is only reported once it is stable.
				const delays = [0, 120, 400];
				let lastFailure = LEDGER_FAILED;
				for (const delay of delays) {
					if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
					let response;
					try {
						response = await fetcher(hostRoute(LEDGER_ROUTE), { headers: { accept: "application/json" } });
					} catch (error) {
						lastFailure = LEDGER_FAILED;
						continue;
					}
					if (response === null || response === undefined || response.ok !== true) {
						const status = response !== null && response !== undefined && typeof response.status === "number" ? response.status : 0;
						lastFailure = status === 401 || status === 403
							? ledgerState("unauthorized")
							: status === 404
								? ledgerState("missing")
								: LEDGER_FAILED;
						continue;
					}
					let body;
					try {
						body = await response.json();
					} catch (_error) {
						lastFailure = ledgerState("malformed");
						continue;
					}
					return normalizeLedger(body);
				}
				return lastFailure;
			}

			/**
			 * Fetch the working directories of the live Sessions, for the folder chooser.
			 *
			 * Best-effort and total: an absent route, a refused credential, an unreadable body and a
			 * transport failure all resolve to an empty list, and the chooser then offers only what is
			 * already selected. A scan is a convenience; it must never make the section fail, and it
			 * must never be read as "there are no workspaces to upload" — the page's copy is what says
			 * an empty list means "everything".
			 *
			 * The shape comes from the Host's own `workspaceRegistry` + `sessionQuery` projections, the
			 * same two services the sidebar reads, so this lists what DSH lists.
			 *
			 * @returns `[{id, path, title, sessions: [{id, title}]}]`, possibly empty.
			 */
			async function readDirectoryScan() {
				const fetcher = pageFetcher();
				if (fetcher === null) return [];
				let response;
				try {
					response = await fetcher(hostRoute(SCAN_ROUTE), { headers: { accept: "application/json" } });
				} catch (_error) {
					return [];
				}
				if (response === null || response === undefined || response.ok !== true) return [];
				let body;
				try {
					body = await response.json();
				} catch (_error) {
					return [];
				}
				const root = asObject(body);
				if (root === null || !Array.isArray(root.workspaces)) return [];
				const out = [];
				for (const entry of root.workspaces) {
					const record = asObject(entry);
					if (record === null) continue;
					const path = typeof record.path === "string" ? record.path : null;
					const title = typeof record.title === "string" ? record.title : "";
					const workspaceId = typeof record.id === "string" ? record.id : "";
					if ((path === null || path.length === 0) && title.length === 0) continue;
					const sessions = [];
					if (Array.isArray(record.sessions)) {
						for (const raw of record.sessions) {
							const session = asObject(raw);
							if (session === null) continue;
							const id = typeof session.id === "string" ? session.id : null;
							if (id === null || id.length === 0) continue;
							sessions.push({ id: id, title: typeof session.title === "string" ? session.title : "" });
						}
					}
					out.push({ id: workspaceId, path: path === null ? "" : path, title: title, sessions: sessions });
				}
				return out;
			}

			/**
			 * Read what the other-harness adapters can see right now.
			 *
			 * Total: the section normalizes the payload and turns every failure into one error
			 * line, so a missing route, a refused credential, an unreadable body and a transport
			 * failure all resolve to `null` here rather than throwing out of a component.
			 *
			 * @returns the parsed GET payload, or null when it could not be read.
			 */
			async function readForeignScan() {
				const fetcher = pageFetcher();
				if (fetcher === null) return null;
				let response;
				try {
					response = await fetcher(hostRoute(FOREIGN_SCAN_ROUTE), { headers: { accept: "application/json" } });
				} catch (_error) {
					return null;
				}
				if (response === null || response === undefined || response.ok !== true) return null;
				try {
					return await response.json();
				} catch (_error) {
					return null;
				}
			}

			/**
			 * Send exactly one other-harness conversation, as a forged DSH session record.
			 *
			 * One POST per id on purpose: the page drives the loop serially so a failure can be
			 * attributed to one row. The request body is exactly `{id}` (docs/foreign-import.md
			 * §路由契约); no other field is invented.
			 *
			 * Never throws: a transport failure, a non-2xx answer and an unreadable body each
			 * become a result record the row can display.
			 *
			 * @param id - the composite id from the scan payload.
			 * @returns `{ok, id, requests, bytes, truncated, error, status}`.
			 */
			async function uploadForeign(id) {
				const failed = function (status) {
					return { ok: false, id: typeof id === "string" && id.length > 0 ? id : null, requests: null, bytes: null, error: null, status: numberOrNull(status) };
				};
				if (typeof id !== "string" || id.length === 0) return failed(null);
				const fetcher = pageFetcher();
				if (fetcher === null) return failed(null);
				let response;
				try {
					response = await fetcher(hostRoute(FOREIGN_UPLOAD_ROUTE), {
						method: "POST",
						headers: { accept: "application/json", "content-type": "application/json" },
						body: JSON.stringify({ id: id })
					});
				} catch (_error) {
					return failed(null);
				}
				const status = response !== null && response !== undefined && typeof response.status === "number" ? response.status : null;
				let body = null;
				try {
					body = response !== null && response !== undefined && typeof response.json === "function" ? await response.json() : null;
				} catch (_error) {
					body = null;
				}
				const record = asObject(body);
				if (record === null) return failed(status);
				return {
					ok: record.ok === true && response.ok === true,
					id: firstString(record.id, id),
					requests: numberOrNull(record.requests),
					bytes: numberOrNull(record.bytes),
					// The Host reports whether the read budget cut the conversation short. Dropping this flag
					// here would make a partial import read as a complete one on the row.
					truncated: record.truncated === true,
					error: firstString(record.error),
					status: status
				};
			}

			/**
			 * Ask the Host what version is available. This is a GET and the ONLY network call the
			 * update block makes on a check: it never runs on mount, and it never writes anything.
			 *
			 * Total: a missing route, a refused credential, an unreadable body and a transport
			 * failure each become a record with an error string the block can show, so the component
			 * never throws. A non-2xx response is reported as `HTTP <status>`.
			 *
			 * @returns a normalized check record, or null when nothing could be read at all.
			 */
			async function readUpdateCheck() {
				const fetcher = pageFetcher();
				if (fetcher === null) return null;
				let response;
				try {
					response = await fetcher(hostRoute(UPDATE_CHECK_ROUTE), { headers: { accept: "application/json" } });
				} catch (_error) {
					return null;
				}
				const status = response !== null && response !== undefined && typeof response.status === "number" ? response.status : null;
				let body = null;
				try {
					body = response !== null && response !== undefined && typeof response.json === "function" ? await response.json() : null;
				} catch (_error) {
					body = null;
				}
				const record = asObject(body);
				if (record === null || response === null || response === undefined || response.ok !== true) {
					return {
						ok: false,
						current: null,
						latest: null,
						available: false,
						notes: null,
						manifestUrl: null,
						source: null,
						files: [],
						error: status !== null ? "HTTP " + String(status) : null
					};
				}
				return record;
			}

			/**
			 * Download, verify, back up and replace the plugin's files. A POST, because it changes
			 * the filesystem; the request body is exactly `{}` per docs/update.md.
			 *
			 * Never throws: a transport failure, a non-2xx answer and an unreadable body each become
			 * a failure record the block can show. The Host is the one that rolls back on failure,
			 * so the page only reports what the Host says happened.
			 *
			 * @returns `{ok, from, to, files, backupDir, reload, error, status}`.
			 */
			async function applyUpdate() {
				const failed = function (status, error) {
					return { ok: false, from: null, to: null, files: [], backupDir: null, reload: null, error: firstString(error), status: numberOrNull(status) };
				};
				const fetcher = pageFetcher();
				if (fetcher === null) return failed(null, null);
				let response;
				try {
					response = await fetcher(hostRoute(UPDATE_APPLY_ROUTE), {
						method: "POST",
						headers: { accept: "application/json", "content-type": "application/json" },
						body: "{}"
					});
				} catch (_error) {
					return failed(null, null);
				}
				const status = response !== null && response !== undefined && typeof response.status === "number" ? response.status : null;
				let body = null;
				try {
					body = response !== null && response !== undefined && typeof response.json === "function" ? await response.json() : null;
				} catch (_error) {
					body = null;
				}
				const record = asObject(body);
				if (record === null) return failed(status, null);
				const files = [];
				if (Array.isArray(record.files)) {
					for (const entry of record.files) if (typeof entry === "string" && entry.length > 0) files.push(entry);
				}
				return {
					ok: record.ok === true && response.ok === true,
					from: firstString(record.from),
					to: firstString(record.to),
					files: files,
					backupDir: firstString(record.backupDir),
					reload: firstString(record.reload),
					error: firstString(record.error),
					status: status
				};
			}

			/**
			 * Read whether the liability notice has been acknowledged.
			 *
			 * Total: a missing route, a refused credential, an unreadable body and a transport failure
			 * all resolve to "not acknowledged, and the read itself failed", because the safe direction
			 * is to SHOW the notice again. The safe direction is the only direction: this never reports
			 * an acknowledgement the Host did not state.
			 *
			 * The two facts are kept apart on purpose. `acknowledged: false` from a healthy read means
			 * "the user has not accepted yet"; `failed: true` means "the page could not ask". The dialog
			 * says the second one out loud instead of showing the same silent notice.
			 *
			 * @returns `{acknowledged, failed}`; a bare `false` would not be able to tell those apart.
			 */
			async function readNotice() {
				const failedRead = { acknowledged: false, failed: true };
				const fetcher = pageFetcher();
				if (fetcher === null) return failedRead;
				// The first mount after DSH restarts can lose this race. DSH names its browser cookie
				// after `host:port`, so a fresh launch issues a NEW cookie name; the settings page can
				// render and call this before the browser has stored it, and that one request 401s.
				// The user then sees the notice, opens the page again a moment later, and it is gone —
				// which is exactly the "first time it pops, second time it does not" report. Three
				// attempts with a short backoff covers the window without making the page wait: a
				// successful read returns immediately on attempt one.
				const delays = [0, 120, 400];
				for (const delay of delays) {
					if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
					let response;
					try {
						response = await fetcher(hostRoute(NOTICE_ROUTE), { headers: { accept: "application/json" } });
					} catch (_error) {
						continue;
					}
					if (response === null || response === undefined || response.ok !== true) continue;
					let body;
					try {
						body = await response.json();
					} catch (_error) {
						continue;
					}
					const root = asObject(body);
					if (root === null || typeof root.acknowledged !== "boolean") continue;
					return { acknowledged: root.acknowledged === true, failed: false };
				}
				return failedRead;
			}

			/**
			 * Record the acknowledgement. A POST, so it is not a cacheable read and cannot be replayed
			 * by a prefetch.
			 * @returns `true` only when the Host confirms it stored the acknowledgement.
			 */
			async function writeNotice() {
				const fetcher = pageFetcher();
				if (fetcher === null) return false;
				let response;
				try {
					response = await fetcher(hostRoute(NOTICE_ROUTE), { method: "POST", headers: { accept: "application/json" } });
				} catch (_error) {
					return false;
				}
				if (response === null || response === undefined || response.ok !== true) return false;
				let body;
				try {
					body = await response.json();
				} catch (_error) {
					return false;
				}
				const root = asObject(body);
				return root !== null && root.acknowledged === true;
			}

			/**
			 * Write one editable field. Anything outside {@link EDITABLE_FIELDS} is refused without
			 * touching the host, so this path cannot write `mode` and cannot bypass the consent gate.
			 * @param field - the field the user edited.
			 * @param value - the exact value to store.
			 * @returns `{ok, path, doc}`.
			 */
			async function writeField(field, value) {
				// The other-harness tick set is owned by the import block's own control, not by the
				// generic field editor, so it is admitted here instead of in EDITABLE_FIELDS. It still
				// goes through the one persist path, and `mode`/`uploadModel`/`credentialRef` stay
				// unreachable from both.
				if (field === "foreignSessionIds") return persistField(field, value);
				if (EDITABLE_FIELDS.indexOf(field) < 0) return { ok: false, path: "none", doc: null };
				return persistField(field, value);
			}
			/**
			 * Persist the mode. Reached only from `select` (after the confirmation gate for a wide
			 * mode) and from `confirmPending`, so the mode never moves without the user's assent.
			 * @param nextMode - one of MODES.
			 * @returns `{ok, path, doc}`.
			 */
			async function writeMode(nextMode) {
				return persistField("mode", nextMode);
			}

			return { getForm: getForm, formState: formState, readDocument: readDocument, readLedger: readLedger, readScan: readDirectoryScan, readForeignScan: readForeignScan, uploadForeign: uploadForeign, readUpdateCheck: readUpdateCheck, applyUpdate: applyUpdate, readNotice: readNotice, writeNotice: writeNotice, writeField: writeField, writeMode: writeMode };
		}
		//#endregion

		//#region hooks
		let idCounter = 0;
		/** Fallback for a React without `useId`; a stable id per mount. */
		function fallbackIdHook() {
			const state = React.useState(function () {
				idCounter++;
				return "slu-" + idCounter;
			});
			return state[0];
		}
		/** `useId` when the module table provides it (React 18), else a counter. */
		const useStableId = typeof React.useId === "function" ? React.useId : fallbackIdHook;

		/**
		 * Subscribe to a snapshot store without assuming anything about it.
		 * @param store - a `{getSnapshot, subscribe}` store, or null.
		 * @returns the latest snapshot, or the shared empty snapshot.
		 */
		function useSnapshotStore(store) {
			const state = React.useState(EMPTY_SNAPSHOT);
			const snapshot = state[0];
			const setSnapshot = state[1];
			React.useEffect(function () {
				if (store === null || store === undefined) {
					setSnapshot(EMPTY_SNAPSHOT);
					return undefined;
				}
				let alive = true;
				const read = function () {
					let next = EMPTY_SNAPSHOT;
					try {
						if (typeof store.getSnapshot === "function") next = store.getSnapshot() || EMPTY_SNAPSHOT;
					} catch (_error) {
						next = EMPTY_SNAPSHOT;
					}
					if (alive) setSnapshot(next);
				};
				let unsubscribe;
				try {
					if (typeof store.subscribe === "function") unsubscribe = store.subscribe(read);
				} catch (_error) {
					unsubscribe = undefined;
				}
				read();
				return function () {
					alive = false;
					try {
						if (typeof unsubscribe === "function") unsubscribe();
					} catch (_error) {}
				};
			}, [ store ]);
			return snapshot;
		}
		//#endregion

		//#region error boundary
		let boundaryClass;
		/**
		 * A minimal boundary so a crash inside the section degrades to one line instead of
		 * blanking the slot entry. Built lazily: `React.Component` must not be touched at
		 * module scope.
		 * @returns a React component class, or null when React has no class base.
		 */
		function sectionBoundary() {
			if (boundaryClass === undefined) {
				boundaryClass = null;
				const Base = React.Component;
				if (typeof Base === "function") {
					boundaryClass = class SectionBoundary extends Base {
						constructor(props) {
							super(props);
							this.state = { failed: false };
						}
						static getDerivedStateFromError() {
							return { failed: true };
						}
						componentDidCatch() {}
						render() {
							if (this.state.failed) {
								return React.createElement("div", { className: "slu-error", role: "alert" }, this.props.fallbackText);
							}
							return this.props.children;
						}
					};
				}
			}
			return boundaryClass;
		}
		//#endregion

		//#region confirm dialog
		/**
		 * Confirmation gate for the two wide modes. Escape and backdrop clicks cancel; focus
		 * moves inside on open and returns to the invoking control on close.
		 */
		function ConfirmDialog(props) {
			const panelRef = React.useRef(null);
			const cancelRef = React.useRef(null);
			const confirmRef = React.useRef(null);
			const restoreRef = React.useRef(null);
			const titleId = useStableId();
			const bodyId = useStableId();
			const cancel = props.onCancel;

			React.useEffect(function () {
				if (typeof document !== "undefined" && document !== null) restoreRef.current = document.activeElement;
				const target = cancelRef.current;
				if (target !== null && target !== undefined && typeof target.focus === "function") {
					try {
						target.focus();
					} catch (_error) {}
				}
				return function () {
					const previous = restoreRef.current;
					if (previous === null || previous === undefined || typeof previous.focus !== "function") return;
					try {
						if (typeof document === "undefined" || document === null || document.contains === undefined || document.contains(previous)) previous.focus();
					} catch (_error) {}
				};
			}, []);

			React.useEffect(function () {
				if (typeof window === "undefined" || window === null || typeof window.addEventListener !== "function") return undefined;
				const onKeyDown = function (event) {
					if (event === null || event === undefined || event.key !== "Escape") return;
					// Capture on window: the settings panel is itself a modal with a
					// document-level Escape, and Escape here must cancel this dialog only.
					try {
						event.preventDefault();
						event.stopPropagation();
					} catch (_error) {}
					cancel();
				};
				window.addEventListener("keydown", onKeyDown, true);
				return function () {
					try {
						window.removeEventListener("keydown", onKeyDown, true);
					} catch (_error) {}
				};
			}, [ cancel ]);

			const onPanelKeyDown = function (event) {
				if (event.key !== "Tab") return;
				const focusables = [];
				if (cancelRef.current) focusables.push(cancelRef.current);
				if (confirmRef.current) focusables.push(confirmRef.current);
				if (focusables.length === 0) return;
				const active = typeof document !== "undefined" && document !== null ? document.activeElement : null;
				const first = focusables[0];
				const last = focusables[focusables.length - 1];
				if (event.shiftKey) {
					if (active === first || focusables.indexOf(active) < 0) {
						event.preventDefault();
						try {
							last.focus();
						} catch (_error) {}
					}
				} else if (active === last || focusables.indexOf(active) < 0) {
					event.preventDefault();
					try {
						first.focus();
					} catch (_error) {}
				}
			};

			const panel = React.createElement("div", {
				ref: panelRef,
				className: "slu-panel",
				role: "dialog",
				"data-dialog": "consent",
				"aria-modal": "true",
				"aria-labelledby": titleId,
				"aria-describedby": bodyId,
				tabIndex: -1,
				onKeyDown: onPanelKeyDown
			},
				React.createElement("h2", { id: titleId, className: "slu-panelTitle" }, props.title),
				React.createElement("p", { id: bodyId, className: "slu-panelBody" }, props.body),
				React.createElement("p", { className: "slu-panelEndpoint" }, props.endpointLabel + ": " + props.endpoint),
				React.createElement("div", { className: "slu-panelActions" },
					React.createElement("button", {
						ref: cancelRef,
						type: "button",
						className: "slu-btn",
						onClick: props.onCancel
					}, props.cancelLabel),
					React.createElement("button", {
						ref: confirmRef,
						type: "button",
						className: "slu-btn slu-btnPrimary",
						onClick: props.onConfirm
					}, props.confirmLabel)
				)
			);

			const overlay = React.createElement("div", { className: "slu-overlay", role: "presentation" },
				React.createElement("div", { className: "slu-mask", "aria-hidden": "true", onClick: props.onCancel }),
				panel
			);

			// Portal when react-dom is on the module table and offers createPortal; otherwise
			// render in place, which still shows a usable dialog.
			if (ReactDOM !== null && typeof ReactDOM.createPortal === "function" && typeof document !== "undefined" && document !== null && document.body) {
				try {
					return ReactDOM.createPortal(overlay, document.body);
				} catch (_error) {}
			}
			return overlay;
		}
		//#endregion

		//#region liability notice
		/**
		 * The liability notice, shown on every visit until the user acknowledges it.
		 *
		 * Two shapes, chosen by the section:
		 * - `variant: "dialog"` when the Host READ SUCCEEDED and said "not acknowledged". That is a
		 *   genuine "not agreed yet", so it is modal, has no backdrop dismiss and no Escape handler.
		 * - `variant: "inline"` when the READ FAILED. An unknown state must never block the settings
		 *   page, so the same notice renders as an in-flow banner at the top of the section, with the
		 *   rest of the page usable behind it.
		 *
		 * Both shapes carry the tick-gate, the honest failure lines, a retry for a failed read, and a
		 * clearly labelled escape. The escape is NOT consent: it writes nothing, only hides the notice
		 * for this mount, and the notice returns on the next mount.
		 */
		function NoticeDialog(props) {
			const inline = props.variant === "inline";
			const panelRef = React.useRef(null);
			const checkRef = React.useRef(null);
			const buttonRef = React.useRef(null);
			const titleId = useStableId();
			const bodyId = useStableId();
			const [ checked, setChecked ] = React.useState(false);
			const [ busy, setBusy ] = React.useState(false);
			// A failed write is NOT silent: the notice stays up, the box stays ticked, the button
			// stays usable for one-click retry, and this flag adds the honest line explaining why
			// nothing appeared to happen. The cause is never invented: a throw, a refused response
			// and an unconfirmed body all get the same statement because the page cannot tell them
			// apart and the Host reports no reason here.
			const [ writeFailed, setWriteFailed ] = React.useState(false);

			React.useEffect(function () {
				// Only the modal may take focus: the banner is part of the page the user is using.
				if (inline) return;
				const target = checkRef.current;
				if (target !== null && target !== undefined && typeof target.focus === "function") {
					try {
						target.focus();
					} catch (_error) {}
				}
			}, [ inline ]);

			// Contain focus inside the MODAL. The banner deliberately keeps the page reachable.
			const onPanelKeyDown = function (event) {
				if (inline || event.key !== "Tab") return;
				const focusables = [ checkRef.current, buttonRef.current ].filter(function (node) {
					return node !== null && node !== undefined;
				});
				if (focusables.length === 0) return;
				const active = typeof document !== "undefined" && document !== null ? document.activeElement : null;
				const first = focusables[0];
				const last = focusables[focusables.length - 1];
				if (event.shiftKey && (active === first || focusables.indexOf(active) < 0)) {
					event.preventDefault();
					try { last.focus(); } catch (_error) {}
					return;
				}
				if (!event.shiftKey && active === last) {
					event.preventDefault();
					try { first.focus(); } catch (_error) {}
				}
			};

			const accept = function () {
				if (checked !== true || busy) return;
				setBusy(true);
				setWriteFailed(false);
				let attempt;
				try {
					attempt = Promise.resolve(props.onAccept());
				} catch (_error) {
					attempt = Promise.resolve(false);
				}
				void attempt.then(function (ok) {
					// On failure the notice stays up and the button returns, so the user is never left
					// believing they acknowledged something the Host did not record. The failure line
					// is what turns that silence into feedback; the tick stays so a retry is one click.
					setBusy(false);
					if (ok !== true) setWriteFailed(true);
				}, function () {
					setBusy(false);
					setWriteFailed(true);
				});
			};

			const content = [
				React.createElement("h2", { key: "title", id: titleId, className: inline ? "slu-noticeBannerTitle" : "slu-panelTitle" }, props.title),
				React.createElement("div", { key: "body", id: bodyId, className: "slu-noticeBody" }, props.paragraphs.map(function (text, index) {
					return React.createElement("p", { key: "p" + index, className: "slu-panelBody" }, text);
				})),
				// A failed mount read is said out loud, and the retry is right beside it: clicking it
				// re-reads the Host and the line disappears when the read succeeds.
				props.readFailed === true
					? React.createElement("div", { key: "readFailed", className: "slu-error slu-noticeFailure", role: "alert", "data-notice-read-failed": "true" },
						React.createElement("span", { className: "slu-noticeFailureText" }, props.readFailedText),
						React.createElement("button", {
							type: "button",
							className: "slu-btn slu-noticeRetry",
							"data-notice-retry": "true",
							onClick: function () { if (typeof props.onRetry === "function") props.onRetry(); }
						}, props.retryLabel)
					)
					: null,
				writeFailed === true
					? React.createElement("div", { key: "writeFailed", className: "slu-error slu-noticeFailure", role: "alert", "data-notice-write-failed": "true" }, props.writeFailedText)
					: null,
				React.createElement("label", { key: "check", className: "slu-noticeCheck" },
					React.createElement("input", {
						ref: checkRef,
						type: "checkbox",
						"data-notice-ack": "true",
						checked: checked === true,
						onChange: function (event) {
							const target = event !== null && event !== undefined ? event.target : null;
							setChecked(target !== null && target !== undefined && target.checked === true);
						}
					}),
					React.createElement("span", null, props.checkboxLabel)
				),
				React.createElement("div", { key: "actions", className: "slu-panelActions" },
					// The escape: dismisses the notice for THIS MOUNT ONLY and never writes. The user is
					// never trapped out of the settings page by a notice they cannot record.
					React.createElement("button", {
						type: "button",
						className: "slu-btn slu-noticeDismiss",
						"data-notice-dismiss": "true",
						onClick: function () { if (typeof props.onDismiss === "function") props.onDismiss(); }
					}, props.dismissLabel),
					React.createElement("button", {
						ref: buttonRef,
						type: "button",
						className: "slu-btn slu-btnPrimary slu-noticeAccept",
						disabled: checked !== true || busy,
						onClick: accept
					}, busy ? props.busyLabel : props.acceptLabel)
				)
			];

			if (inline) {
				return React.createElement("div", {
					ref: panelRef,
					className: "slu-noticeBanner",
					role: "region",
					"data-notice": "banner",
					"aria-labelledby": titleId,
					"aria-describedby": bodyId
				}, content);
			}

			const panel = React.createElement("div", {
				ref: panelRef,
				className: "slu-panel slu-noticePanel",
				role: "dialog",
				"data-dialog": "notice",
				"aria-modal": "true",
				"aria-labelledby": titleId,
				"aria-describedby": bodyId,
				tabIndex: -1,
				onKeyDown: onPanelKeyDown
			}, content);

			const overlay = React.createElement("div", { className: "slu-overlay", role: "presentation" },
				// No onClick: the mask is decorative and dismisses nothing.
				React.createElement("div", { className: "slu-mask", "aria-hidden": "true" }),
				panel
			);

			if (ReactDOM !== null && typeof ReactDOM.createPortal === "function" && typeof document !== "undefined" && document !== null && document.body) {
				try {
					return ReactDOM.createPortal(overlay, document.body);
				} catch (_error) {}
			}
			return overlay;
		}
		//#endregion

		//#region the settings section
		/**
		 * Build the `settings.section` component for one activation. The host services are
		 * captured in the closure instead of injected through the unverified slot `inject`
		 * option, so an unexpected option shape cannot fail the registration.
		 *
		 * @param bridge - the host bridge built in `apply`.
		 */
		function createSection(bridge) {
			/**
			 * The nav page: four modes as an accessible radio group, the destination and the
			 * byte cap read-only, and a manual fallback when nothing can write.
			 */
			function Section(props) {
				const t = typeof props.t === "function" ? props.t : identityT;
				const titleId = useStableId();
				const groupId = useStableId();

				const formState = React.useState(null);
				const form = formState[0];
				const setForm = formState[1];
				React.useEffect(function () {
					let next = null;
					try {
						next = bridge.getForm();
					} catch (_error) {
						next = null;
					}
					setForm(next);
				}, [ bridge ]);

				const formSnapshot = useSnapshotStore(form);
				const formValue = asObject(formSnapshot.value);
				const hasFormValue = formValue !== null && (typeof fieldValue(formValue.mode) === "string" || typeof fieldValue(formValue.endpoint) === "string");

				const docState = React.useState(null);
				const doc = docState[0];
				const setDoc = docState[1];
				React.useEffect(function () {
					if (hasFormValue) return undefined;
					let alive = true;
					let pendingRead;
					try {
						pendingRead = Promise.resolve(bridge.readDocument());
					} catch (_error) {
						return undefined;
					}
					pendingRead.then(function (value) {
						if (alive) setDoc(asObject(value));
					}, function () {});
					return function () {
						alive = false;
					};
				}, [ bridge, hasFormValue ]);

				const [ pendingMode, setPendingMode ] = React.useState(null);
				const [ busy, setBusy ] = React.useState(false);
				const [ failed, setFailed ] = React.useState(false);
				const [ lastAttempt, setLastAttempt ] = React.useState(null);
				const [ focusIndex, setFocusIndex ] = React.useState(null);
				// `null` means "being read": both the first mount read and every refresh publish it,
				// which is what the loading state shows.
				const [ ledger, setLedger ] = React.useState(null);
				// The slot's `useSessions` is resolved once for this mount and the same function is
				// handed to every row. A fallback is not a hook, so re-deciding per render would change
				// a row's hook count the moment the slot starts or stops passing the prop, and React
				// would throw "Rendered more hooks than during the previous render" and blank the
				// section. Pinned here, every row always calls a function; a hook that only appears
				// after the first render simply never shows names, and the ids stay.
				const sessionHook = React.useRef(undefined);
				if (sessionHook.current === undefined) {
					sessionHook.current = typeof props.useSessions === "function" ? props.useSessions : NO_SESSIONS;
				}
				// Session names are opt-in: a name is derived from the conversation itself, so showing
				// one puts a slice of content on a page that is otherwise metadata only.
				const [ showSessionNames, setShowSessionNames ] = React.useState(false);
				// Drafts for the two editable fields. `null` means "not edited": the input mirrors the
				// value the Host reported, so a change made elsewhere shows up until the user types.
				const [ endpointDraft, setEndpointDraft ] = React.useState(null);
				const [ capDraft, setCapDraft ] = React.useState(null);
				const [ patternsDraft, setPatternsDraft ] = React.useState(null);
				const [ directoriesDraft, setDirectoriesDraft ] = React.useState(null);
				// The directory chooser: whether the "choose folders" panel is open, the folders the
				// Host's scan reported, the boxes the user has ticked, and whether a scan is in flight.
				const [ pickerOpen, setPickerOpen ] = React.useState(false);
				const [ directoryOptions, setDirectoryOptions ] = React.useState([]);
				const [ picked, setPicked ] = React.useState(function () { return Object.create(null); });
				const [ pickedSessions, setPickedSessions ] = React.useState(function () { return Object.create(null); });
				const [ scanning, setScanning ] = React.useState(false);
				// The other-harness import. `foreignScan` is null until the user clicks Scan, so the
				// block shows only the button and its explanation before that. Ticks are a local
				// draft; `foreignStatus` is per row, so the section keeps rendering during a send.
				const [ foreignScan, setForeignScan ] = React.useState(null);
				const [ foreignScanning, setForeignScanning ] = React.useState(false);
				const [ foreignScanFailed, setForeignScanFailed ] = React.useState(false);
				const [ foreignPicked, setForeignPicked ] = React.useState(function () { return Object.create(null); });
				const [ foreignStatus, setForeignStatus ] = React.useState(function () { return Object.create(null); });
				const [ foreignConfirm, setForeignConfirm ] = React.useState(null);
				const [ foreignSending, setForeignSending ] = React.useState(false);
				// Stopping a batch is cooperative: a ref is checked at the top of each loop iteration,
				// so the POST already in flight finishes (the Host committed its watermark) and no new
				// one starts. The state copies drive the control and the end-of-batch summary.
				const [ foreignStopRequested, setForeignStopRequested ] = React.useState(false);
				const [ foreignSummary, setForeignSummary ] = React.useState(null);
				const foreignStopRef = React.useRef(false);
				// Delegated conversations are collapsed by default: a list of 366 conversations where
				// 316 are children is mostly noise. This only controls VISIBILITY; ticks, the cascade
				// and the send count always run over the whole payload.
				const [ foreignShowChildren, setForeignShowChildren ] = React.useState(false);
				// The plugin self-update block. Nothing is fetched on mount: `updateCheckPayload` stays
				// null until the user clicks Check. `updatePhase` tracks the observable phases
				// (checking / downloading / writing / done / failed) and keeps the block rendered.
				const [ updateCheckPayload, setUpdateCheckPayload ] = React.useState(null);
				const [ updateChecking, setUpdateChecking ] = React.useState(false);
				const [ updateReadFailed, setUpdateReadFailed ] = React.useState(false);
				const [ updateConfirm, setUpdateConfirm ] = React.useState(false);
				const [ updatePhase, setUpdatePhase ] = React.useState(null);
				const [ updateResult, setUpdateResult ] = React.useState(null);
				const [ updateError, setUpdateError ] = React.useState(null);
				const updateWriteTimer = React.useRef(null);
				React.useEffect(function () {
					// No timer may outlive the mount: a completion or a close clears its own timer, and
					// this covers the case where the page is left while an apply is still in flight.
					return function () {
						if (updateWriteTimer.current !== null && typeof clearTimeout === "function") {
							try {
								clearTimeout(updateWriteTimer.current);
							} catch (_error) {}
						}
						updateWriteTimer.current = null;
					};
				}, []);
				const [ fieldBusy, setFieldBusy ] = React.useState(null);
				const [ fieldState, setFieldState ] = React.useState(null);
				const optionRefs = React.useRef([]);
				// The liability notice. `null` means "not read yet"; the record keeps `failed` separate
				// from `acknowledged`, so a read the page could not make is said out loud instead of
				// looking like an ordinary unacknowledged visit. `noticeDismissed` is the escape: it
				// hides the notice for THIS MOUNT only, never writes, and is reset by the next mount.
				// `noticeAttempt` re-runs the read for the banner's Try again control.
				const [ noticeState, setNoticeState ] = React.useState(null);
				const [ noticeDismissed, setNoticeDismissed ] = React.useState(false);
				const [ noticeAttempt, setNoticeAttempt ] = React.useState(0);

				React.useEffect(function () {
					let alive = true;
					let retryTimer = null;
					// One delayed retry on top of the attempts inside `readNotice`. The first mount after
					// a DSH restart can call this before the browser has stored the credential for the
					// NEW port (DSH names its cookie after `host:port`), and the user's report is exactly
					// that: it pops the first time, and is gone the second. Waiting a moment and asking
					// again turns that into "it never popped", instead of showing a consent dialog over a
					// connection blip.
					const MAX_MOUNT_RETRIES = 2;
					let mountAttempt = 0;
					const run = function () {
						let attempt;
						try {
							attempt = Promise.resolve(bridge.readNotice());
						} catch (_error) {
							attempt = Promise.resolve(null);
						}
						void attempt.then(function (result) {
							if (!alive) return;
							const outcome = asObject(result);
							const settled = outcome === null
								? { acknowledged: false, failed: true }
								: { acknowledged: outcome.acknowledged === true, failed: outcome.failed === true };
							// A failed read is retried a couple of times before it is shown: a transient
							// credential race is not the same fact as "the Host cannot answer".
							if (settled.failed === true && mountAttempt < MAX_MOUNT_RETRIES) {
								mountAttempt += 1;
								retryTimer = setTimeout(run, 700 * mountAttempt);
								return;
							}
							// Never default to hiding the notice: only a positive acknowledgement hides it.
							setNoticeState(settled);
						}, function () {
							if (!alive) return;
							if (mountAttempt < MAX_MOUNT_RETRIES) {
								mountAttempt += 1;
								retryTimer = setTimeout(run, 700 * mountAttempt);
								return;
							}
							setNoticeState({ acknowledged: false, failed: true });
						});
					};
					run();
					return function () {
						alive = false;
						if (retryTimer !== null) clearTimeout(retryTimer);
					};
				}, [ bridge, noticeAttempt ]);

				/** Continue: the ONLY path that dismisses the notice for good, and only after a confirmed write. */
				const acceptNotice = async function () {
					let ok = false;
					try {
						ok = (await bridge.writeNotice()) === true;
					} catch (_error) {
						ok = false;
					}
					// Only a confirmed write counts. A failure keeps the notice up; the component shows
					// the failure line and lets the user retry.
					if (ok) setNoticeState({ acknowledged: true, failed: false });
					return ok;
				};

				/** Escape for this mount only. Never writes, never records consent. */
				const dismissNotice = function () {
					setNoticeDismissed(true);
				};

				/** Re-run a failed read. The failure line disappears if this read succeeds. */
				const retryNoticeRead = function () {
					setNoticeState(null);
					setNoticeAttempt(function (previous) { return previous + 1; });
				};

				React.useEffect(function () {
					let alive = true;
					// The initial state is already the loading state, so the mount read does not write it
					// back: a redundant state update would cost another render pass. `refreshLedger`
					// does reset it, because that is what shows a loading state on an explicit refresh.
					let attempt;
					try {
						attempt = Promise.resolve(bridge.readLedger());
					} catch (_error) {
						attempt = Promise.resolve(LEDGER_FAILED);
					}
					attempt.then(function (result) {
						if (alive) setLedger(asObject(result) || LEDGER_FAILED);
					}, function () {
						if (alive) setLedger(LEDGER_FAILED);
					});
					return function () {
						alive = false;
					};
				}, [ bridge ]);

				/** Re-read the ledger on an explicit gesture. */
				const refreshLedger = function () {
					setLedger(null);
					let attempt;
					try {
						attempt = Promise.resolve(bridge.readLedger());
					} catch (_error) {
						attempt = Promise.resolve(LEDGER_FAILED);
					}
					void attempt.then(function (result) {
						setLedger(asObject(result) || LEDGER_FAILED);
					}, function () {
						setLedger(LEDGER_FAILED);
					});
				};

				const mode = firstString(fieldValue(formValue && formValue.mode), fieldValue(doc && doc.mode));
				// The two disclosure rows are narrowed to what the Host will actually use: the wire
				// reports the stored value, which the Host may replace with its default. The served
				// form's snapshot speaks first, then the describe document (the same projection);
				// `null` means no channel reported the namespace at all, and the row then reports
				// that instead of asserting a value the page cannot know.
				const servedValue = formValue !== null ? formValue : asObject(doc);
				const endpoint = servedValue === null ? null : endpointInUse(fieldValue(servedValue.endpoint));
				const maxBytes = servedValue === null ? null : maxBytesInUse(fieldValue(servedValue.maxBytes));
				const patterns = servedValue === null ? null : patternsInUse(fieldValue(servedValue.deepseekModelPatterns));
				const directories = servedValue === null ? null : directoriesInUse(fieldValue(servedValue.uploadDirectories));
				// The per-Session allowlist. Read the same way as the directory one: an array of opaque
				// ids, reported as `null` when nothing described the namespace.
				const uploadSessionIds = servedValue === null ? null : sessionIdsInUse(fieldValue(servedValue.uploadSessionIds));
				// The other-harness allowlist, read the same way. It is the value the draft starts from.
				const savedForeignIds = servedValue === null ? null : sessionIdsInUse(fieldValue(servedValue.foreignSessionIds));
				// Every scanned session, in the Host's own group order, and the ticked subset of it.
				const foreignGroups = foreignScan === null ? [] : foreignScan.harnesses;
				const foreignIds = [];
				const selectedForeign = [];
				const seenForeign = Object.create(null);
				for (const group of foreignGroups) {
					for (const session of group.sessions) {
						if (seenForeign[session.id] === true) continue;
						seenForeign[session.id] = true;
						foreignIds.push(session.id);
						if (foreignPicked[session.id] === true) selectedForeign.push(session.id);
					}
				}
				// How many rows are delegated children (parent present in the payload), for the
				// show/hide control and the count it reports. Dangling parents are not children.
				const foreignChildSeen = Object.create(null);
				let foreignChildCount = 0;
				for (const group of foreignGroups) {
					for (const session of group.sessions) {
						if (session.child !== true || foreignChildSeen[session.id] === true) continue;
						foreignChildSeen[session.id] = true;
						foreignChildCount++;
					}
				}

				/**
				 * Validate one draft and, when the Host would accept it, write it. The write goes
				 * through the served form (`bridge.writeField`), which is the same path the mode
				 * uses; a rejection is shown, and a refusal never reports success.
				 * @param field - `endpoint` or `maxBytes`.
				 * @param parsed - the value to write, or null when the draft is invalid.
				 * @param invalidKey - locale key explaining why the draft was not written.
				 */
				const saveField = function (field, parsed, invalidKey, afterSuccess) {
					if (parsed === null) {
						setFieldState({ field: field, kind: "invalid", key: invalidKey });
						return;
					}
					setFieldBusy(field);
					setFieldState(null);
					let attempt;
					try {
						attempt = Promise.resolve(bridge.writeField(field, parsed));
					} catch (_error) {
						attempt = Promise.resolve({ ok: false, path: "none", doc: null });
					}
					void attempt.then(function (result) {
						const outcome = asObject(result) || {};
						const ok = outcome.ok === true;
						setFieldBusy(null);
						setFieldState({ field: field, kind: ok ? "saved" : "failed", key: ok ? "upload.fieldSaved" : "upload.saveFailed" });
						if (!ok) return;
						const nextDoc = outcome.doc ? asObject(outcome.doc) : null;
						if (nextDoc !== null) setDoc(nextDoc);
						// Clear the saved field's draft so the control returns to mirroring the
						// effective value; the other drafts are untouched.
						if (field === "endpoint") setEndpointDraft(null);
						else if (field === "maxBytes") setCapDraft(null);
						else if (field === "deepseekModelPatterns") setPatternsDraft(null);
						else if (field === "uploadDirectories") setDirectoriesDraft(null);
						// A second write chained by the caller (the chooser saves two config keys).
						if (typeof afterSuccess === "function") afterSuccess();
					}, function () {
						setFieldBusy(null);
						setFieldState({ field: field, kind: "failed", key: "upload.saveFailed" });
					});
				};

				/**
				 * Build one editable LIST field: the value in use (read-only, normalized exactly as
				 * the Host normalizes it) plus a textarea and a Save action.
				 *
				 * Deliberately mirrors {@link editableField}'s honesty rule: the read-only line shows
				 * the effective value, while the textarea may hold an unsaved draft, so nothing that
				 * describes behaviour can read a draft.
				 *
				 * @param field - the config key.
				 * @param label - localized label.
				 * @param help - localized explanation of what the list does and does not do.
				 * @param effective - the list the Host will use, or null when nothing reported one.
				 * @param draft - the current draft text, or null when the textarea mirrors the Host value.
				 * @param setDraft - the draft setter.
				 */
				const listField = function (field, label, help, effective, draft, setDraft) {
					const text = draft !== null ? draft : (effective === null ? "" : effective.join("\n"));
					const state = fieldState !== null && fieldState.field === field ? fieldState : null;
					const emptyKey = field === "deepseekModelPatterns" ? "upload.patternsEmpty" : "upload.directoriesEmpty";
					const shown = effective === null
						? t("upload.valueUnknown")
						: effective.length === 0
							? t(emptyKey)
							: effective.join(", ");
					return React.createElement("div", { key: field, className: "slu-field" },
						React.createElement("div", { className: "slu-fieldLabel" }, label),
						// Read-only: the list the Host will actually use.
						React.createElement("code", { className: "slu-value slu-listValue", "data-field": field }, shown),
						React.createElement("div", { className: "slu-help" }, help),
						React.createElement("div", { key: "row", className: "slu-fieldRow" },
							React.createElement("textarea", {
								key: "input",
								className: "slu-input slu-listInput",
								"data-field": field,
								rows: 3,
								value: text,
								disabled: !live ? true : undefined,
								"aria-label": label,
								onChange: function (event) {
									const target = event !== null && event !== undefined ? event.target : null;
									setDraft(target !== null && target !== undefined ? String(target.value) : "");
								}
							}),
							React.createElement("button", {
								key: "save",
								type: "button",
								className: "slu-btn slu-fieldSave",
								"data-field": field,
								disabled: !live || fieldBusy !== null ? true : undefined,
								onClick: function () {
									// A list draft is never invalid: a blank line is dropped, and an
									// empty list is a legitimate value meaning "nothing".
									saveField(field, listToWrite(text), null);
								}
							}, t("upload.fieldSave"))
						),
						state === null ? null : React.createElement(
							"div",
							{ className: state.kind === "failed" || state.kind === "invalid" ? "slu-error slu-fieldState" : "slu-note slu-fieldState", role: state.kind === "failed" ? "alert" : "status" },
							t(state.key)
						)
					);
				};

				/**
				 * The directory chooser: "everything is uploaded by default; tick the folders you want".
				 *
				 * Why a chooser rather than a text box. A list of *excluded* paths reads as "everything
				 * except these is being sent", which is the wrong thing to make a user work out — and it
				 * was, in an earlier revision, misread exactly that way. This shape states the default
				 * first ("all of it"), then lets the user narrow it by ticking folders, which is the
				 * mental model that matches what the Host actually does with a non-empty list.
				 *
				 * The folder options come from the Host's scan route, which reads the same
				 * `workspaceRegistry` + `sessionQuery` projections the sidebar reads. Ticking a workspace
				 * row restricts to that DIRECTORY; ticking a Session row restricts to that one SESSION.
				 * Both are ORed by the Host, and both are saved here.
				 *
				 * @param effective - the directory allowlist the Host will use, or null when unknown.
				 * @param effectiveSessions - the per-Session allowlist the Host will use, or null.
				 */
				const directoryChooser = function (effective, effectiveSessions) {
					const selected = effective === null ? [] : effective;
					const selectedSessionList = effectiveSessions === null ? [] : effectiveSessions;
					const restricted = selected.length > 0 || selectedSessionList.length > 0;
					const selectedSessionIds = Object.create(null);
					for (const id of selectedSessionList) if (typeof id === "string" && id.length > 0) selectedSessionIds[id] = true;
					const state = fieldState !== null && fieldState.field === "uploadDirectories" ? fieldState : null;

					const children = [
						React.createElement("div", { key: "label", className: "slu-fieldLabel" }, t("upload.directoriesLabel")),
						// Read-only: the allowlist the Host will actually apply.
						React.createElement("code", { key: "value", className: "slu-value slu-listValue", "data-field": "uploadDirectories" },
							effective === null ? t("upload.valueUnknown") : restricted ? selected.join(", ") : t("upload.directoriesEmpty")),
						React.createElement("div", { key: "help", className: "slu-help" }, t("upload.directoriesHelp"))
					];

					// The opt-in. Turning it on opens the picker (the list is still empty, which still means
					// "no restriction"); turning it off writes the empty list, which is "upload everything".
					// Once a selection is saved the box renders checked, so its ON branch can never run
					// again: the adjust control next to it is the entry point that reopens the picker for
					// an already-restricted page. Without it the only affordance after a save would be the
					// toggle's OFF branch, which clears the selection instead of adjusting it.
					children.push(React.createElement("div", { key: "choose", className: "slu-toggle" },
						React.createElement("label", { className: "slu-toggleLabel" },
							React.createElement("input", {
								type: "checkbox",
								"data-toggle": "restrict-directories",
								checked: restricted,
								disabled: !live ? true : undefined,
								onChange: function (event) {
									const target = event !== null && event !== undefined ? event.target : null;
									const on = target !== null && target !== undefined && target.checked === true;
									if (!on) saveField("uploadDirectories", [], null);
									else { setPickerOpen(true); refreshScan(selected); }
								}
							}),
							React.createElement("span", null, t("upload.directoriesChoose"))
						),
						restricted
							? React.createElement("button", {
								key: "adjust",
								type: "button",
								className: "slu-btn slu-directoriesAdjust",
								"data-action": "adjust-directories",
								disabled: !live ? true : undefined,
								onClick: function () { setPickerOpen(true); refreshScan(selected); }
							}, t("upload.directoriesAdjust"))
							: null
					));

					if (pickerOpen) {
						// Two INDEPENDENT sets. A workspace row ticks its DIRECTORY (written to
						// uploadDirectories); a Session row ticks that one SESSION (written to
						// uploadSessionIds). They are ORed on the Host, so ticking a single conversation
						// uploads it even when its workspace is unticked — which is the reason to offer
						// Session-level rows at all. Sharing one key here (the earlier version) made a
						// Session impossible to select on its own.
						const tickRow = function (kind, key, checked, label, extraClass, dataAttrs, extraDisabled, hint) {
							const attrs = Object.assign({
								type: "checkbox",
								checked: checked === true,
								disabled: !live || extraDisabled === true ? true : undefined,
								onChange: function (event) {
									const target = event !== null && event !== undefined ? event.target : null;
									const on = target !== null && target !== undefined && target.checked === true;
									const apply = function (previous) {
										const next = Object.assign(Object.create(null), previous);
										if (on) next[key] = true;
										else delete next[key];
										return next;
									};
									if (kind === "session") setPickedSessions(apply);
									else setPicked(apply);
								}
							}, dataAttrs || {});
							const rowChildren = [
								React.createElement("input", attrs),
								React.createElement("span", { className: "slu-checkPath" }, label)
							];
							// A Session row covered by a ticked folder says so, and is disabled because the
							// Host ORs the two lists: unticking it here could not take effect.
							if (hint !== null && hint !== undefined) rowChildren.push(React.createElement("span", { className: "slu-checkHint" }, hint));
							return React.createElement("label", {
								key: kind + "-" + String(key),
								className: "slu-check " + (extraClass || ""),
								// The row's identity, for the accessibility tree and for tests: the box itself
								// carries the per-kind attribute already.
								"data-check": kind + ":" + String(key)
							}, rowChildren);
						};

						const rows = [];
						for (const workspace of directoryOptions) {
							const workspaceKey = normalizeDirectoryPath(workspace.path);
							// A ticked folder covers every Session under it. The rows are rendered as checked
							// and disabled, which is the truth: a per-Session untick inside a ticked folder
							// is ignored by the Host, so offering it as a live control would be a lie.
							// The draft is the authority here: `refreshScan` seeds it from the saved
							// allowlist, so a saved folder is checked on open AND can be unticked again.
							const workspaceTicked = workspaceKey !== null && picked[workspaceKey] === true;
							if (workspaceKey !== null) {
								rows.push(tickRow("workspace", workspaceKey, workspaceTicked,
									workspace.title || workspace.path || workspaceKey, "slu-checkWorkspace", { "data-workspace": workspaceKey }));
							}
							for (const session of workspace.sessions) {
								const label = session.title && session.title.length > 0 ? session.title : session.id;
								const ownTicked = pickedSessions[session.id] === true || selectedSessionIds[session.id] === true;
								rows.push(tickRow("session", session.id, workspaceTicked === true ? true : ownTicked,
									label, "slu-checkSession", { "data-session": session.id },
									workspaceTicked === true,
									workspaceTicked === true ? t("upload.coveredByFolder") : null));
							}
						}

						children.push(React.createElement("div", { key: "picker", className: "slu-picker" },
							React.createElement("div", { key: "actions", className: "slu-fieldRow" },
								React.createElement("button", {
									key: "scan",
									type: "button",
									className: "slu-btn slu-scanBtn",
									disabled: !live || scanning ? true : undefined,
									onClick: function () { refreshScan(selected); }
								}, t(scanning ? "upload.directoriesScanning" : "upload.directoriesScan")),
								React.createElement("button", {
									key: "save",
									type: "button",
									className: "slu-btn slu-fieldSave",
									"data-field": "uploadDirectories",
									disabled: !live || fieldBusy !== null ? true : undefined,
									onClick: function () {
										// Two writes, because the two sets are separate config keys: the ticked
										// directories and the Sessions ticked INDIVIDUALLY. Sessions that are
										// merely covered by a ticked folder are not written to uploadSessionIds:
										// the Host ORs the two lists, so the folder already sends them, and an
										// id that is only covered is not an individual choice.
										const chosenDirectories = [];
										for (const key of Object.keys(picked)) {
											if (picked[key] !== true) continue;
											const found = directoryOptions.find(function (workspace) { return normalizeDirectoryPath(workspace.path) === key; });
											chosenDirectories.push(found !== undefined && found.path ? found.path : key);
										}
										const coveredSessions = Object.create(null);
										for (const workspace of directoryOptions) {
											const workspaceKey = normalizeDirectoryPath(workspace.path);
											if (workspaceKey === null || picked[workspaceKey] !== true) continue;
											for (const session of workspace.sessions) coveredSessions[session.id] = true;
										}
										// "Their own state" is the draft tick plus the saved individual allowlist;
										// the covered ones are removed from that union, never persisted by accident.
										const individuallyTicked = [];
										const seenSessions = Object.create(null);
										const addIndividual = function (id) {
											if (typeof id !== "string" || id.length === 0 || seenSessions[id] === true) return;
											seenSessions[id] = true;
											individuallyTicked.push(id);
										};
										for (const id of Object.keys(pickedSessions)) if (pickedSessions[id] === true) addIndividual(id);
										for (const id of Object.keys(selectedSessionIds)) if (selectedSessionIds[id] === true) addIndividual(id);
										const chosenSessions = individuallyTicked.filter(function (id) { return coveredSessions[id] !== true; });
										// One field is saved at a time through the same path the other fields use;
										// the directory write is the one that reports its own state, so a refusal on
										// either surfaces rather than being swallowed.
										saveField("uploadDirectories", chosenDirectories, null, function () {
											saveField("uploadSessionIds", chosenSessions, null);
										});
									}
								}, t("upload.fieldSave"))
							),
							rows.length === 0
								? React.createElement("div", { key: "none", className: "slu-note" }, t(scanning ? "upload.directoriesScanning" : "upload.directoriesNoSessions"))
								: React.createElement("div", { key: "list", className: "slu-checks" }, rows)
						));
					}

					if (state !== null) {
						children.push(React.createElement("div", {
							key: "state",
							className: state.kind === "failed" || state.kind === "invalid" ? "slu-error slu-fieldState" : "slu-note slu-fieldState",
							role: state.kind === "failed" ? "alert" : "status"
						}, t(state.key)));
					}
					return React.createElement("div", { key: "uploadDirectories", className: "slu-field" }, children);
				};

				/**
				 * Scan for live Session directories and refresh the chooser's options. Also seeds the
				 * ticked set from the current allowlist, so opening the chooser shows what is already
				 * selected rather than an empty panel over a restricted Host state.
				 */
				/**
				 * Scan the Host's workspaces and Sessions, then seed the ticked set from the saved
				 * allowlist. Seeding happens HERE rather than inside the render so the tick state is
				 * derived from the config once per scan, not recomputed (and possibly reset) on every
				 * keystroke or re-render.
				 *
				 * @param saved - the allowlist currently in force, so a reopened chooser shows the
				 *   existing restriction rather than an empty panel.
				 */
				const refreshScan = function (saved) {
					setScanning(true);
					let attempt;
					try {
						attempt = Promise.resolve(bridge.readScan());
					} catch (_error) {
						attempt = Promise.resolve([]);
					}
					void attempt.then(function (result) {
						setScanning(false);
						const workspaces = Array.isArray(result) ? result : [];
						setDirectoryOptions(workspaces);
						const keep = Object.create(null);
						for (const entry of Array.isArray(saved) ? saved : []) {
							const key = normalizeDirectoryPath(entry);
							if (key !== null) keep[key] = true;
						}
						// Merge rather than replace: a box the user ticked since the last scan stays ticked.
						setPicked(function (previous) {
							const next = Object.assign(Object.create(null), previous);
							for (const key of Object.keys(keep)) next[key] = true;
							return next;
						});
					}, function () {
						setScanning(false);
						setDirectoryOptions([]);
					});
				};

				/**
				 * Scan the other harnesses. This is the ONLY trigger: the section never scans on
				 * mount, so opening the page costs nothing. The result is normalized here, and a
				 * missing bridge method, an unreadable body and a transport failure all degrade to
				 * one error line instead of throwing out of the component.
				 */
				const scanForeign = function () {
					setForeignScanning(true);
					setForeignScanFailed(false);
					if (typeof bridge.readForeignScan !== "function") {
						setForeignScanning(false);
						setForeignScanFailed(true);
						return;
					}
					let attempt;
					try {
						attempt = Promise.resolve(bridge.readForeignScan());
					} catch (_error) {
						attempt = Promise.resolve(null);
					}
					void attempt.then(function (raw) {
						setForeignScanning(false);
						const normalized = normalizeForeignScan(raw);
						if (normalized === null) {
							setForeignScan(null);
							setForeignScanFailed(true);
							return;
						}
						setForeignScan(normalized);
						// A fresh scan starts collapsed again: the list the user opens is top-level rows.
						setForeignShowChildren(false);
						// Seed the draft from the saved allowlist, but only for sessions this scan
						// actually lists: an id this scan cannot see must not be counted or sent from
						// a row the user cannot inspect.
						const saved = savedForeignIds === null ? [] : savedForeignIds;
						setForeignPicked(function (previous) {
							const next = Object.assign(Object.create(null), previous);
							for (const group of normalized.harnesses) {
								for (const session of group.sessions) {
									if (saved.indexOf(session.id) >= 0) next[session.id] = true;
								}
							}
							return next;
						});
					}, function () {
						setForeignScanning(false);
						setForeignScan(null);
						setForeignScanFailed(true);
					});
				};

				/**
				 * Tick or untick one row in the local draft, together with its whole lineage subtree.
				 * A tick on `zcode/sess_root` means "this conversation and the ones it spawned", so it
				 * also ticks every descendant transitively; an untick is symmetric. Unticking a CHILD
				 * only reaches that child's own subtree, so it never moves the parent and each row
				 * stays individually controllable: unlike the folder cascade there is no OR
				 * semantics to protect, and nothing is disabled.
				 * @param id - the composite session id.
				 * @param on - whether the box is now ticked.
				 */
				const toggleForeign = function (id, on) {
					const cascade = foreignCascadeIds(foreignGroups, id);
					setForeignPicked(function (previous) {
						const next = Object.assign(Object.create(null), previous);
						for (const target of cascade) {
							if (on === true) next[target] = true;
							else delete next[target];
						}
						return next;
					});
				};

				/** Write the whole tick set into `foreignSessionIds` through the shared field path. */
				const saveForeign = function () {
					saveField("foreignSessionIds", selectedForeign.slice(), null);
				};

				/** Open the consent gate for the current tick set. Nothing is sent here. */
				const startForeignSend = function () {
					if (foreignSending === true || selectedForeign.length === 0) return;
					setForeignConfirm(selectedForeign.slice());
				};

				const cancelForeignSend = function () {
					setForeignConfirm(null);
				};

				/**
				 * Ask the running batch to stop. It is cooperative: the flag is checked at the top of
				 * the loop, so the POST already in flight finishes (the Host has committed it) and no
				 * new POST starts. Nothing is aborted and no settled result is rewritten.
				 */
				const stopForeignSend = function () {
					if (foreignSending !== true) return;
					foreignStopRef.current = true;
					setForeignStopRequested(true);
				};

				/**
				 * Send the confirmed tick set serially, one POST per id, writing each row's state as
				 * it goes. A failed row does not stop the loop, so one bad conversation cannot hide
				 * the rest. A stop request ends the loop BEFORE the next POST: every remaining row is
				 * marked stopped (never waiting, never failed) and the summary counts what was sent.
				 * The section is never unmounted, so the page keeps rendering throughout.
				 */
				const confirmForeignSend = function () {
					const ids = foreignConfirm === null ? [] : foreignConfirm;
					setForeignConfirm(null);
					if (ids.length === 0 || foreignSending === true) return;
					foreignStopRef.current = false;
					setForeignStopRequested(false);
					setForeignSummary(null);
					setForeignSending(true);
					const waiting = Object.create(null);
					for (const id of ids) waiting[id] = { kind: "waiting" };
					setForeignStatus(waiting);
					void (async function () {
						let sent = 0;
						let failed = 0;
						let stopped = 0;
						for (let index = 0; index < ids.length; index++) {
							const id = ids[index];
							if (foreignStopRef.current === true) {
								const remaining = ids.slice(index);
								stopped = remaining.length;
								setForeignStatus(function (previous) {
									const next = Object.assign(Object.create(null), previous);
									for (const pendingId of remaining) next[pendingId] = { kind: "stopped" };
									return next;
								});
								break;
							}
							setForeignStatus(function (previous) {
								const next = Object.assign(Object.create(null), previous);
								next[id] = { kind: "sending" };
								return next;
							});
							let result = null;
							try {
								result = typeof bridge.uploadForeign === "function" ? await bridge.uploadForeign(id) : null;
							} catch (_error) {
								result = null;
							}
							const outcome = asObject(result);
							const ok = outcome !== null && outcome.ok === true;
							if (ok) sent++;
							else failed++;
							setForeignStatus(function (previous) {
								const next = Object.assign(Object.create(null), previous);
								if (ok) {
									next[id] = { kind: "ok", requests: numberOrNull(outcome.requests), truncated: outcome.truncated === true };
								} else {
									next[id] = {
										kind: "failed",
										error: outcome === null ? null : firstString(outcome.error),
										status: outcome === null ? null : numberOrNull(outcome.status)
									};
								}
								return next;
							});
						}
						setForeignSending(false);
						foreignStopRef.current = false;
						setForeignStopRequested(false);
						setForeignSummary({ sent: sent, notSent: failed + stopped });
					})();
				};

				/**
				 * Ask the Host what version is available. Only the Check button reaches here: the
				 * block never fetches on mount, and this GET never writes anything.
				 */
				const checkForUpdate = function () {
					setUpdateReadFailed(false);
					if (typeof bridge.readUpdateCheck !== "function") {
						setUpdateReadFailed(true);
						return;
					}
					setUpdateChecking(true);
					let attempt;
					try {
						attempt = Promise.resolve(bridge.readUpdateCheck());
					} catch (_error) {
						attempt = Promise.resolve(null);
					}
					void attempt.then(function (raw) {
						setUpdateChecking(false);
						const normalized = normalizeUpdateCheck(raw);
						if (normalized === null) {
							setUpdateCheckPayload(null);
							setUpdateReadFailed(true);
							return;
						}
						setUpdateCheckPayload(normalized);
					}, function () {
						setUpdateChecking(false);
						setUpdateCheckPayload(null);
						setUpdateReadFailed(true);
					});
				};

				/** Clear the in-flight phase timer, if one is set. */
				const clearUpdateTimer = function () {
					if (updateWriteTimer.current === null) return;
					if (typeof clearTimeout === "function") {
						try {
							clearTimeout(updateWriteTimer.current);
						} catch (_error) {}
					}
					updateWriteTimer.current = null;
				};

				/** Open the consent gate. Nothing is downloaded or replaced before it is confirmed. */
				const startUpdate = function () {
					if (updatePhase === "downloading" || updatePhase === "writing") return;
					setUpdateConfirm(true);
				};

				const cancelUpdate = function () {
					setUpdateConfirm(false);
				};

				/**
				 * Run the confirmed upgrade. The block stays rendered through every phase: the apply
				 * route reports only completion, so the page labels the in-flight request as
				 * downloading and switches to writing after a short delay; both clear on completion.
				 * A failed apply is shown as the Host reported it and leaves the block usable to retry.
				 */
				const confirmUpdate = function () {
					setUpdateConfirm(false);
					setUpdateResult(null);
					setUpdateError(null);
					if (typeof bridge.applyUpdate !== "function") {
						setUpdatePhase("failed");
						return;
					}
					setUpdatePhase("downloading");
					if (typeof setTimeout === "function") {
						updateWriteTimer.current = setTimeout(function () {
							updateWriteTimer.current = null;
							setUpdatePhase(function (previous) {
								return previous === "downloading" ? "writing" : previous;
							});
						}, UPDATE_WRITE_DELAY_MS);
					}
					let attempt;
					try {
						attempt = Promise.resolve(bridge.applyUpdate());
					} catch (_error) {
						attempt = Promise.resolve(null);
					}
					void attempt.then(function (result) {
						clearUpdateTimer();
						const outcome = asObject(result);
						if (outcome !== null && outcome.ok === true) {
							setUpdatePhase("done");
							setUpdateResult({
								from: firstString(outcome.from),
								to: firstString(outcome.to),
								files: Array.isArray(outcome.files) ? outcome.files.length : 0,
								backupDir: firstString(outcome.backupDir),
								reload: firstString(outcome.reload)
							});
							return;
						}
						setUpdatePhase("failed");
						setUpdateError(outcome === null ? null : firstString(outcome.error));
					}, function () {
						clearUpdateTimer();
						setUpdatePhase("failed");
						setUpdateError(null);
					});
				};

				/**
				 * Build one editable field: the value in use (read-only, already narrowed) plus an
				 * input and a Save action for it.
				 * @param field - `endpoint` or `maxBytes`.
				 * @param effective - the value the Host will use, or null when nothing reported one.
				 * @param format - renders an effective value for display.
				 * @param draft - the current draft, or null when the input mirrors the Host value.
				 * @param setDraft - the draft setter.
				 * @param invalidKey - locale key explaining a rejected draft.
				 * @param parse - the Host's own validation, returning the value to write or null.
				 */
				const editableField = function (field, effective, format, draft, setDraft, invalidKey, parse) {
					const text = draft !== null ? draft : (effective === null ? "" : format(effective));
					const state = fieldState !== null && fieldState.field === field ? fieldState : null;
					const nodes = [
						React.createElement("div", { key: "row", className: "slu-fieldRow" },
							React.createElement("input", {
								key: "input",
								type: "text",
								className: "slu-input",
								"data-field": field,
								value: text,
								disabled: !live ? true : undefined,
								"aria-label": t(field === "endpoint" ? "upload.endpointEditLabel" : "upload.capEditLabel"),
								onChange: function (event) {
									const target = event !== null && event !== undefined ? event.target : null;
									setDraft(target !== null && target !== undefined ? String(target.value) : "");
								}
							}),
							React.createElement("button", {
								key: "save",
								type: "button",
								className: "slu-btn slu-fieldSave",
								"data-field": field,
								disabled: !live || fieldBusy !== null ? true : undefined,
								onClick: function () {
									saveField(field, parse(text), invalidKey);
								}
							}, t("upload.fieldSave"))
						)
					];
					if (state !== null) {
						nodes.push(React.createElement("div", {
							key: "state",
							className: (state.kind === "saved" ? "slu-saved" : "slu-error") + " slu-fieldState",
							role: state.kind === "saved" ? "status" : "alert"
						}, t(state.key)));
					}
					return nodes;
				};

				// The ledger is Host-side state, not configuration: it is read over its own route and
				// every failure is its own honest state, independent of the mode controls.
				const ledgerLoading = ledger === null;
				const ledgerStatus = ledgerLoading ? "loading" : (typeof ledger.status === "string" ? ledger.status : "failed");
				const ledgerSessions = !ledgerLoading && Array.isArray(ledger.sessions) ? ledger.sessions : [];
				const ledgerSkipped = !ledgerLoading && numberOrNull(ledger.skipped) !== null ? ledger.skipped : 0;
				// The Host's own total, or nothing: the count of rows this page happens to show is not
				// the same claim, so it is never presented as the ledger's total.
				const ledgerTotal = !ledgerLoading && numberOrNull(ledger.total) !== null && ledger.total >= 0 ? ledger.total : null;
				const ledgerDirectory = ledgerLoading ? null : firstString(ledger.directory);

				const commit = function (nextMode) {
					setBusy(true);
					setFailed(false);
					setLastAttempt(nextMode);
					let attempt;
					try {
						attempt = Promise.resolve(bridge.writeMode(nextMode));
					} catch (_error) {
						attempt = Promise.resolve({ ok: false, path: "none", doc: null });
					}
					return attempt.then(function (result) {
						const outcome = asObject(result) || {};
						const ok = outcome.ok === true;
						const path = typeof outcome.path === "string" ? outcome.path : "none";
						const nextDoc = outcome.doc ? asObject(outcome.doc) : null;
						if (nextDoc) setDoc(nextDoc);
						else if (ok) {
							// A committed write through `remote.settings` publishes no
							// document of its own (and the shared form, when there is one,
							// refreshes itself). Show the accepted value immediately rather
							// than leaving the previous selection on screen.
							setDoc(function (previous) {
								const base = asObject(previous);
								return base === null ? { mode: nextMode } : { mode: nextMode, endpoint: base.endpoint, maxBytes: base.maxBytes };
							});
						}
						setBusy(false);
						// A bare "could not be saved" is only honest when a write path was
						// actually exercised and refused. "No write path at all" is already
						// reported by the section's own state above, and repeating it as a save
						// failure is exactly the bare error this section used to show.
						setFailed(!ok && path !== "none");
						return ok;
					}, function () {
						setBusy(false);
						setFailed(true);
						return false;
					});
				};

				const select = function (nextMode, index) {
					if (typeof index === "number") setFocusIndex(index);
					if (busy) return;
					if (nextMode === mode) return;
					if (CONFIRM_MODES.indexOf(nextMode) >= 0) {
						setPendingMode(nextMode);
						return;
					}
					void commit(nextMode);
				};

				const confirmPending = function () {
					const target = pendingMode;
					setPendingMode(null);
					if (target !== null) void commit(target);
				};
				const cancelPending = function () {
					setPendingMode(null);
				};

				const handleOptionKeyDown = function (event, index) {
					const key = event ? event.key : null;
					let next = null;
					if (key === "ArrowDown" || key === "ArrowRight") next = (index + 1) % MODES.length;
					else if (key === "ArrowUp" || key === "ArrowLeft") next = (index - 1 + MODES.length) % MODES.length;
					else if (key === "Home") next = 0;
					else if (key === "End") next = MODES.length - 1;
					// Space and Enter are deliberately left to the button's native activation.
					// Arrow keys only move focus: selecting a wide mode must open the confirm
					// dialog, and arrowing across the group must not fire it four times.
					if (next === null) return;
					event.preventDefault();
					setFocusIndex(next);
					const target = optionRefs.current[next];
					if (target && typeof target.focus === "function") {
						try {
							target.focus();
						} catch (_error) {}
					}
				};

				let hostState = { status: "unavailable", writable: false };
				try {
					hostState = asObject(bridge.formState()) || hostState;
				} catch (_error) {}
				// Live means the Host serves a form for this namespace and that document accepts
				// writes. Anything else is reported as such: the radios are disabled, so a click
				// cannot end in a bare save failure, and `mode` stays unknown rather than
				// pretending the page is operational.
				const live = hostState.status === "ready" && hostState.writable === true;
				const blocked = busy || !live;
				const showManual = !live || failed;

				const checkedIndex = MODES.indexOf(mode);
				const tabbableIndex = focusIndex !== null ? focusIndex : checkedIndex >= 0 ? checkedIndex : 0;

				const children = [];
				children.push(React.createElement("h2", { key: "title", id: titleId, className: "slu-title" }, t("upload.sectionTitle")));
				children.push(React.createElement("p", { key: "description", className: "slu-description" }, t("upload.sectionDescription")));

				const options = MODES.map(function (modeId, index) {
					const copy = MODE_COPY[modeId];
					return React.createElement("button", {
						key: modeId,
						type: "button",
						role: "radio",
						"aria-checked": mode === modeId,
						"aria-disabled": blocked ? "true" : undefined,
						disabled: blocked ? true : undefined,
						"data-mode": modeId,
						tabIndex: index === tabbableIndex ? 0 : -1,
						className: "slu-option",
						ref: function (element) {
							optionRefs.current[index] = element;
						},
						onClick: function () {
							select(modeId, index);
						},
						onKeyDown: function (event) {
							handleOptionKeyDown(event, index);
						}
					},
						React.createElement("span", { className: "slu-dot", "aria-hidden": "true" }),
						React.createElement("span", { className: "slu-optionText" },
							React.createElement("span", { className: "slu-optionLabel" }, t(copy.label)),
							React.createElement("span", { className: "slu-optionDetail" }, t(copy.detail))
						)
					);
				});

				const modeChildren = [
					React.createElement("div", { key: "label", id: groupId, className: "slu-fieldLabel" }, t("upload.modeGroupLabel")),
					React.createElement("div", { key: "group", className: "slu-options", role: "radiogroup", "aria-labelledby": groupId }, options)
				];
				if (mode === null) modeChildren.push(React.createElement("div", { key: "unknown", className: "slu-note" }, t("upload.modeUnknown")));
				children.push(React.createElement("div", { key: "modes", className: "slu-field" }, modeChildren));

				if (busy) children.push(React.createElement("div", { key: "busy", className: "slu-status", role: "status" }, t("upload.savingLabel")));
				if (failed) children.push(React.createElement("div", { key: "failed", className: "slu-error", role: "alert" }, t("upload.saveFailed")));

				children.push(React.createElement("div", { key: "destination", className: "slu-field" },
					React.createElement("div", { className: "slu-fieldLabel" }, t("upload.destinationLabel")),
					// Read-only: the destination that will actually be used, already narrowed by the
					// Host's own rule. The input below edits the stored value.
					React.createElement("code", { className: "slu-value" }, endpoint === null ? t("upload.endpointUnknown") : endpoint),
					editableField("endpoint", endpoint, function (value) { return value; }, endpointDraft, setEndpointDraft, "upload.endpointInvalid", endpointToWrite)
				));

				children.push(React.createElement("div", { key: "cap", className: "slu-field" },
					React.createElement("div", { className: "slu-fieldLabel" }, t("upload.byteCapLabel")),
					React.createElement("code", { className: "slu-value" }, maxBytes === null ? t("upload.valueUnknown") : formatBytes(maxBytes, t)),
					editableField("maxBytes", maxBytes, function (value) { return String(value); }, capDraft, setCapDraft, "upload.capInvalid", capToWrite)
				));

				// The model-pattern list is shown ONLY in `deepseek-any-provider`, the one mode that
				// reads it. Hidden elsewhere rather than shown-and-disabled: a control that looks
				// live but changes nothing is how a user comes to believe they widened or narrowed
				// something they did not. `patterns === null` means nothing reported the config, in
				// which case the mode itself is unknown and a control would be a guess.
				if (mode === "deepseek-any-provider") {
					children.push(listField(
						"deepseekModelPatterns",
						t("upload.patternsLabel"),
						t("upload.patternsHelp"),
						patterns,
						patternsDraft,
						setPatternsDraft
					));
				}

				// The excluded working directories apply in every mode, so this one is always shown.
				// It is a chooser, not a text box: the default ("everything is uploaded") is stated
				// first, and narrowing it is an explicit act of ticking folders.
				children.push(directoryChooser(directories, uploadSessionIds));

				// ── other-harness import ───────────────────────────────────────────────────────
				// Scan other agent harnesses on this machine, tick the conversations to send, save the
				// tick set into `foreignSessionIds`, and send the ticked ones one POST at a time. Until
				// the user clicks Scan the block is just the title, one explanation line and the button.
				const foreignChildren = [];
				foreignChildren.push(React.createElement("h3", { key: "title", className: "slu-foreignTitle" }, t("foreign.title")));
				foreignChildren.push(React.createElement("p", { key: "description", className: "slu-description" }, t("foreign.description")));
				const foreignActions = [
					React.createElement("button", {
						key: "scan",
						type: "button",
						className: "slu-btn slu-foreignScan",
						"data-foreign-action": "scan",
						disabled: foreignScanning === true ? true : undefined,
						onClick: function () { scanForeign(); }
					}, t(foreignScanning === true ? "foreign.scanning" : "foreign.scan"))
				];
				// Only offered when the payload actually has delegated rows. The label carries the
				// hidden count while collapsed, so the size of the hidden part is never a mystery.
				if (foreignScan !== null && foreignChildCount > 0) {
					foreignActions.push(React.createElement("button", {
						key: "children",
						type: "button",
						className: "slu-btn slu-foreignChildren",
						"data-foreign-action": "children",
						disabled: foreignScanning === true ? true : undefined,
						onClick: function () {
							setForeignShowChildren(function (previous) { return previous !== true; });
						}
					}, foreignShowChildren === true
						? t("foreign.collapseChildren")
						: t("foreign.expandChildren").replace("{count}", String(foreignChildCount))));
				}
				if (foreignScan !== null) {
					foreignActions.push(React.createElement("button", {
						key: "save",
						type: "button",
						className: "slu-btn slu-foreignSave",
						"data-foreign-action": "save",
						disabled: !live || fieldBusy !== null || foreignSending === true ? true : undefined,
						onClick: function () { saveForeign(); }
					}, t("foreign.save")));
					foreignActions.push(React.createElement("button", {
						key: "send",
						type: "button",
						className: "slu-btn slu-btnPrimary slu-foreignSend",
						"data-foreign-action": "send",
						disabled: foreignSending === true || selectedForeign.length === 0 ? true : undefined,
						onClick: function () { startForeignSend(); }
					}, foreignSendLabel(t, selectedForeign.length)));
					// Only while a batch is in flight. Clicking it does not abort the current POST; it
					// stops the loop before the next one, which the label says.
					if (foreignSending === true) {
						foreignActions.push(React.createElement("button", {
							key: "stop",
							type: "button",
							className: "slu-btn slu-foreignStop",
							"data-foreign-action": "stop",
							disabled: foreignStopRequested === true ? true : undefined,
							onClick: function () { stopForeignSend(); }
						}, t(foreignStopRequested === true ? "foreign.stopping" : "foreign.stop")));
					}
				}
				foreignChildren.push(React.createElement("div", { key: "actions", className: "slu-fieldRow" }, foreignActions));
				if (foreignScanFailed === true) {
					foreignChildren.push(React.createElement("div", { key: "scanFailed", className: "slu-error", role: "alert" }, t("foreign.scanFailed")));
				}
				if (foreignScan !== null) {
					if (foreignScan.error !== null) {
						foreignChildren.push(React.createElement("div", { key: "hostError", className: "slu-error", role: "alert" }, t("foreign.scanFailed") + " " + foreignScan.error));
					}
					if (foreignIds.length === 0) {
						foreignChildren.push(React.createElement("div", { key: "empty", className: "slu-note" }, t("foreign.empty")));
					}
					const foreignGroupNodes = foreignGroups.map(function (group, groupIndex) {
						// Delegated children render immediately after the row they name, indented. While
						// collapsed they are hidden; their ticks and statuses stay in the draft, and the
						// parent cascade still reaches them because it walks the whole payload.
						const allSessions = orderForeignSessions(group);
						const orderedSessions = foreignShowChildren === true
							? allSessions
							: allSessions.filter(function (session) { return session.child !== true; });
						const rowNodes = orderedSessions.map(function (session, sessionIndex) {
							const status = foreignStatus[session.id] !== undefined ? asObject(foreignStatus[session.id]) : null;
							const statusText = foreignStatusText(status, t);
							const isFailed = status !== null && status.kind === "failed";
							return React.createElement("label", {
								key: "foreign-row-" + groupIndex + "-" + sessionIndex,
								className: session.child === true ? "slu-check slu-foreignRow slu-checkSessionChild" : "slu-check slu-foreignRow",
								"data-foreign-row": session.id,
								"data-foreign-child": session.child === true ? "true" : undefined
							},
								React.createElement("input", {
									type: "checkbox",
									"data-foreign-id": session.id,
									checked: foreignPicked[session.id] === true,
									disabled: !live || foreignSending === true ? true : undefined,
									onChange: function (event) {
										const target = event !== null && event !== undefined ? event.target : null;
										toggleForeign(session.id, target !== null && target !== undefined && target.checked === true);
									}
								}),
								React.createElement("span", { className: "slu-foreignText" },
									// A missing title is a readable fallback, never the string "undefined".
									React.createElement("span", { className: "slu-foreignName" }, session.title === null ? t("foreign.untitled") : session.title),
									React.createElement("span", { className: "slu-foreignMeta" }, foreignRowMeta(session, t)),
									statusText === null
										? null
										: React.createElement("span", {
											className: isFailed ? "slu-error slu-foreignStatus" : "slu-foreignStatus",
											"data-foreign-status": session.id
										}, statusText)
								)
							);
						});
						const groupNodes = [
							React.createElement("div", { key: "heading", className: "slu-foreignGroupTitle", "data-foreign-group": group.harness },
								group.label + " · " + String(group.sessions.length)),
							group.error === null ? null : React.createElement("div", { key: "error", className: "slu-error" }, t("foreign.harnessError") + " " + group.error),
							group.available === true ? null : React.createElement("div", { key: "unavailable", className: "slu-note" }, t("foreign.unavailable")),
							rowNodes.length === 0
								// A group whose only rows are hidden children is not "empty": saying so
								// would contradict the heading's count and the show/hide control.
								? (group.sessions.length === 0
									? React.createElement("div", { key: "groupEmpty", className: "slu-note" }, t("foreign.groupEmpty"))
									: null)
								: React.createElement("div", { key: "rows", className: "slu-foreignRows" }, rowNodes)
						];
						return React.createElement("div", { key: "foreign-group-" + groupIndex, className: "slu-foreignGroup" }, groupNodes);
					});
					foreignChildren.push(React.createElement("div", { key: "groups", className: "slu-foreignGroups" }, foreignGroupNodes));
					// The end-of-batch count lives in a region that EXISTS before the batch ends, so a
					// screen reader announces the text when it appears: inserting a fresh live region
					// with its content at the same moment is unreliable. Empty until a batch finishes.
					foreignChildren.push(React.createElement("div", {
						key: "summary",
						className: "slu-status slu-foreignSummary",
						role: "status",
						"aria-live": "polite",
						"data-foreign-summary": foreignSummary === null ? undefined : "true"
					}, foreignSummary === null ? null : foreignSummaryText(foreignSummary, t)));
				}
				const foreignState = fieldState !== null && fieldState.field === "foreignSessionIds" ? fieldState : null;
				if (foreignState !== null) {
					foreignChildren.push(React.createElement("div", {
						key: "state",
						className: (foreignState.kind === "saved" ? "slu-saved" : "slu-error") + " slu-fieldState",
						role: foreignState.kind === "saved" ? "status" : "alert"
					}, t(foreignState.key)));
				}
				children.push(React.createElement("div", { key: "foreign", className: "slu-foreign" }, foreignChildren));

				// ── upload ledger ──────────────────────────────────────────────────────────────
				// Which Session logs this plugin has uploaded: Host-side state read over its own
				// route. Metadata only, and every outcome is stated: empty is explained, and each
				// failure names itself instead of becoming an invented row.
				const ledgerChildren = [];
				ledgerChildren.push(React.createElement("div", { key: "head", className: "slu-ledgerHeader" },
					React.createElement("div", { className: "slu-ledgerTitle" }, t("upload.ledger.title")),
					React.createElement("button", {
						key: "refresh",
						type: "button",
						// Shares the button styling, but keeps its own hook: the mode section's
						// controls and the dialog must stay distinguishable from this one.
						className: "slu-btn slu-ledgerRefresh",
						disabled: ledgerLoading ? true : undefined,
						onClick: function () {
							refreshLedger();
						}
					}, t("upload.ledger.refresh"))
				));
				ledgerChildren.push(React.createElement("p", { key: "note", className: "slu-description" }, t("upload.ledger.description")));
				// Session names are off unless asked for: the label and its detail say where a name
				// comes from, so turning this on is an informed choice.
				ledgerChildren.push(React.createElement("div", { key: "titles", className: "slu-toggle" },
					React.createElement("label", { className: "slu-toggleLabel" },
						React.createElement("input", {
							type: "checkbox",
							"data-toggle": "session-names",
							checked: showSessionNames === true,
							onChange: function (event) {
								const target = event !== null && event !== undefined ? event.target : null;
								setShowSessionNames(target !== null && target !== undefined && target.checked === true);
							}
						}),
						React.createElement("span", null, t("upload.ledger.titlesLabel"))
					),
					React.createElement("div", { className: "slu-note" }, t("upload.ledger.titlesDetail"))
				));
				if (ledgerLoading) {
					ledgerChildren.push(React.createElement("div", { key: "loading", className: "slu-status", role: "status" }, t("upload.ledger.loading")));
				} else if (ledgerStatus === "ready") {
					ledgerChildren.push(React.createElement("div", { key: "total", className: "slu-status" },
						t("upload.ledger.total") + " " + (ledgerTotal === null ? t("upload.valueUnknown") : String(ledgerTotal))
					));
					if (ledgerSkipped > 0) {
						ledgerChildren.push(React.createElement("div", { key: "skipped", className: "slu-note" }, t("upload.ledger.skipped") + " " + String(ledgerSkipped)));
					}
					// The "why is nothing arriving" answer, above the list and never collapsed, so a
					// stalled upload is not mistaken for an empty one.
					ledgerChildren.push(ledgerFailure(ledger, t));
					if (ledgerSessions.length === 0) {
						ledgerChildren.push(React.createElement("p", { key: "empty", className: "slu-note" }, t("upload.ledger.empty")));
					} else {
						ledgerChildren.push(React.createElement("div", { key: "table", className: "slu-ledgerScroll" }, ledgerTable(ledgerSessions, t, sessionHook.current, showSessionNames === true)));
						// The two numeric columns, explained in place instead of behind a tooltip.
						ledgerChildren.push(React.createElement("p", { key: "columns", className: "slu-note" }, t("upload.ledger.columnsHint")));
					}
					if (ledgerDirectory !== null) {
						ledgerChildren.push(React.createElement("div", { key: "directory", className: "slu-field" },
							React.createElement("div", { className: "slu-fieldLabel" }, t("upload.ledger.directoryLabel")),
							React.createElement("code", { className: "slu-ledgerPath" }, ledgerDirectory)
						));
					}
				} else {
					ledgerChildren.push(React.createElement("div", { key: "state", className: "slu-error slu-ledgerState", role: "alert" }, t(ledgerStateKey(ledgerStatus))));
				}
				children.push(React.createElement("div", { key: "ledger", className: "slu-ledger" }, ledgerChildren));

				// ── plugin self-update ─────────────────────────────────────────────────────────
				// The current version and manifest address come from the Host's check payload; the
				// block says "not reported" instead of inventing a value. Nothing is fetched until
				// the Check button is clicked, and nothing is written until the consent dialog is
				// confirmed. Every phase keeps this block rendered.
				const updateCurrent = updateCheckPayload === null ? null : updateCheckPayload.current;
				const updateManifest = updateCheckPayload === null ? null : updateCheckPayload.manifestUrl;
				const updateAvailable = updateCheckPayload !== null
					&& updateCheckPayload.available === true
					&& updateCheckPayload.error === null;
				const updateBusy = updateChecking || updatePhase === "downloading" || updatePhase === "writing";
				const updateChildren = [];
				updateChildren.push(React.createElement("h3", { key: "title", className: "slu-updateTitle" }, t("update.title")));
				updateChildren.push(React.createElement("div", { key: "values", className: "slu-field" },
					React.createElement("div", { className: "slu-fieldLabel" }, t("update.currentVersion")),
					React.createElement("code", { className: "slu-updateValue", "data-update-field": "current" }, updateCurrent === null ? t("update.notReported") : updateCurrent),
					React.createElement("div", { className: "slu-fieldLabel" }, t("update.manifestUrl")),
					React.createElement("code", { className: "slu-updateValue", "data-update-field": "manifest" }, updateManifest === null ? t("update.notReported") : updateManifest)
				));
				const updateActions = [
					React.createElement("button", {
						key: "check",
						type: "button",
						className: "slu-btn slu-updateCheck",
						"data-update-action": "check",
						disabled: updateBusy ? true : undefined,
						onClick: function () { checkForUpdate(); }
					}, t(updateChecking ? "update.checking" : "update.check"))
				];
				// The upgrade action exists only when the Host says an update is available. After a
				// completed apply it is gone; after a failed one it stays, so the user can retry.
				if (updateAvailable && updatePhase !== "done") {
					updateActions.push(React.createElement("button", {
						key: "upgrade",
						type: "button",
						className: "slu-btn slu-btnPrimary slu-updateUpgrade",
						"data-update-action": "upgrade",
						disabled: updateBusy ? true : undefined,
						onClick: function () { startUpdate(); }
					}, t("update.upgrade")));
				}
				updateChildren.push(React.createElement("div", { key: "actions", className: "slu-fieldRow" }, updateActions));
				if (updateChecking) {
					updateChildren.push(React.createElement("div", { key: "checking", className: "slu-status", role: "status" }, t("update.checking")));
				} else if (updatePhase === "downloading") {
					updateChildren.push(React.createElement("div", { key: "downloading", className: "slu-status", role: "status" }, t("update.phaseDownloading")));
				} else if (updatePhase === "writing") {
					updateChildren.push(React.createElement("div", { key: "writing", className: "slu-status", role: "status" }, t("update.phaseWriting")));
				} else if (updatePhase === "done" && updateResult !== null) {
					updateChildren.push(React.createElement("div", { key: "done", className: "slu-status", role: "status" },
						t("update.done").replace("{version}", updateResult.to === null ? t("update.notReported") : updateResult.to)));
					if (updateResult.backupDir !== null) {
						updateChildren.push(React.createElement("div", { key: "backup", className: "slu-field" },
							React.createElement("div", { className: "slu-fieldLabel" }, t("update.backupDir")),
							React.createElement("code", { className: "slu-updateValue", "data-update-field": "backup" }, updateResult.backupDir)
						));
					}
					updateChildren.push(React.createElement("div", { key: "restart", className: "slu-note slu-updateRestart" }, t("update.restartHint")));
				} else if (updatePhase === "failed") {
					updateChildren.push(React.createElement("div", { key: "failed", className: "slu-error", role: "alert" },
						t("update.applyFailed") + " " + (updateError === null ? t("update.applyErrorUnknown") : updateError)));
				} else if (updateReadFailed) {
					updateChildren.push(React.createElement("div", { key: "readFailed", className: "slu-error", role: "alert" },
						t("update.checkFailed") + " " + t("update.checkUnreadable")));
				} else if (updateCheckPayload !== null) {
					if (updateCheckPayload.ok !== true || updateCheckPayload.error !== null) {
						updateChildren.push(React.createElement("div", { key: "checkFailed", className: "slu-error", role: "alert" },
							t("update.checkFailed") + " " + (updateCheckPayload.error === null ? t("update.checkUnreadable") : updateCheckPayload.error)));
					} else if (updateCheckPayload.available === true) {
						updateChildren.push(React.createElement("div", { key: "available", className: "slu-status", role: "status" },
							t("update.available").replace("{version}", updateCheckPayload.latest === null ? t("update.notReported") : updateCheckPayload.latest)));
						if (updateCheckPayload.notes !== null) {
							updateChildren.push(React.createElement("div", { key: "notes", className: "slu-note" }, t("update.notes") + ": " + updateCheckPayload.notes));
						}
						updateChildren.push(React.createElement("div", { key: "files", className: "slu-note", "data-update-files": "true" },
							t("update.fileCount").replace("{count}", String(updateCheckPayload.fileCount))));
					} else {
						// `available === false` covers two different facts, and conflating them is the bug the
						// user caught: the manifest can be the SAME version, or OLDER than what is installed
						// (GitHub's raw endpoint caches for a few minutes, so a release is briefly invisible).
						// Only the first is "up to date".
						const manifestOlder = updateCheckPayload.latest !== null
							&& updateCurrent !== null
							&& compareVersionStrings(updateCheckPayload.latest, updateCurrent) < 0;
						updateChildren.push(React.createElement("div", { key: "latest", className: "slu-status", role: "status", "data-update-state": manifestOlder ? "older" : "current" },
							manifestOlder
								? t("update.manifestOlder")
									.replace("{version}", updateCheckPayload.latest)
									.replace("{current}", updateCurrent)
								: t("update.upToDate").replace("{version}", updateCurrent === null ? t("update.notReported") : updateCurrent)));
					}
				}
				children.push(React.createElement("div", { key: "update", className: "slu-update" }, updateChildren));

				if (showManual) {
					const commandMode = lastAttempt || mode || DEFAULT_COMMAND_MODE;
					// A collapsed disclosure on purpose: the manual route is the last resort, not
					// the expected path, so it takes a deliberate second click to reveal. The row
					// it prints is the profile's own row, key for key, with the selected mode.
					children.push(React.createElement("div", { key: "manual", className: "slu-manual" },
						React.createElement("details", { className: "slu-manualDetails" },
							React.createElement("summary", { className: "slu-manualTitle" }, t("upload.manualTitle")),
							React.createElement("div", { className: "slu-manualBody" },
								React.createElement("p", { className: "slu-description" }, t("upload.manualHint")),
								React.createElement("div", { className: "slu-fieldLabel" }, t("upload.manualPatchLabel")),
								React.createElement("pre", { className: "slu-pre" }, patchSnippet(commandMode)),
								React.createElement("div", { className: "slu-fieldLabel" }, t("upload.manualCommandLabel")),
								React.createElement("pre", { className: "slu-pre" }, patchCommand(commandMode))
							)
						)
					));
				}

				const dialog = pendingMode === null ? null : React.createElement(ConfirmDialog, {
					title: t("upload.warnTitle"),
					body: t("upload.warnBody"),
					endpointLabel: t("upload.destinationLabel"),
					endpoint: endpoint === null ? t("upload.endpointUnknown") : endpoint,
					confirmLabel: t("upload.warnConfirm"),
					cancelLabel: t("upload.warnCancel"),
					onConfirm: confirmPending,
					onCancel: cancelPending
				});

				// The other-harness send gate. It is the existing consent dialog (data-dialog="consent"),
				// and its endpoint line is read exactly the way the mode gate reads it: the endpoint
				// the Host will actually POST to, never the stored value and never an unsaved draft.
				// The dialog's copy states that these are not DSH sessions and that each is wrapped as
				// a DSH session record. No POST happens until this dialog is confirmed.
				const foreignDialog = foreignConfirm === null ? null : React.createElement(ConfirmDialog, {
					title: t("foreign.warnTitle"),
					body: t("foreign.warnBody"),
					endpointLabel: t("upload.destinationLabel"),
					endpoint: endpoint === null ? t("upload.endpointUnknown") : endpoint,
					confirmLabel: t("foreign.warnConfirm"),
					cancelLabel: t("upload.warnCancel"),
					["onConfirm"]: confirmForeignSend,
					["onCancel"]: cancelForeignSend
				});

				// The plugin-update gate. Same consent dialog, and its endpoint line names the manifest
				// address the update is verified against, which is the trust root the body spells out.
				// No download or file replacement happens until this dialog is confirmed.
				const updateDialog = updateConfirm === true ? React.createElement(ConfirmDialog, {
					title: t("update.warnTitle"),
					body: t("update.warnBody"),
					endpointLabel: t("update.manifestUrl"),
					endpoint: updateManifest === null ? t("update.notReported") : updateManifest,
					confirmLabel: t("update.warnConfirm"),
					cancelLabel: t("upload.warnCancel"),
					["onConfirm"]: confirmUpdate,
					["onCancel"]: cancelUpdate
				}) : null;

				// The liability notice. `null` while reading renders nothing, so an acknowledged install
				// never flashes it. A FAILED read renders the notice as an in-flow banner at the top of
				// the section: an unknown acknowledgement state must not block the settings page. A
				// SUCCESSFUL read that says "not acknowledged" keeps the modal gate, because that is a
				// genuine "not agreed yet". The escape in both shapes only hides it for this mount.
				const noticeVisible = noticeDismissed !== true && noticeState !== null && noticeState.acknowledged !== true;
				const noticeReadFailed = noticeVisible && noticeState.failed === true;
				const noticeProps = {
					title: t("upload.noticeTitle"),
					paragraphs: [ t("upload.noticeP1"), t("upload.noticeP2"), t("upload.noticeP3"), t("upload.noticeP4") ],
					checkboxLabel: t("upload.noticeCheck"),
					acceptLabel: t("upload.noticeAccept"),
					busyLabel: t("upload.noticeBusy"),
					readFailed: noticeReadFailed,
					readFailedText: t("upload.noticeReadFailed"),
					writeFailedText: t("upload.noticeFailed"),
					retryLabel: t("upload.noticeRetry"),
					dismissLabel: t("upload.noticeDismiss"),
					onAccept: acceptNotice,
					onRetry: retryNoticeRead,
					onDismiss: dismissNotice
				};
				const noticeBanner = noticeReadFailed ? React.createElement(NoticeDialog, Object.assign({}, noticeProps, { variant: "inline" })) : null;
				const noticeDialog = noticeVisible && noticeReadFailed !== true ? React.createElement(NoticeDialog, noticeProps) : null;
				if (noticeBanner !== null) children.unshift(noticeBanner);

				return React.createElement(React.Fragment, null,
					React.createElement("div", { className: "slu-section" }, children),
					dialog,
					foreignDialog,
					updateDialog,
					noticeDialog
				);
			}

			return Section;
		}

		/**
		 * Boundary wrapper: the localized fallback text is resolved outside the boundary, and
		 * even that resolution cannot throw.
		 */
		function createSectionHost(bridge) {
			const Section = createSection(bridge);
			function SectionHost(props) {
				const rawT = props ? props.t : undefined;
				const t = typeof rawT === "function" ? rawT : identityT;
				let fallback = "upload.renderFailed";
				try {
					const message = t("upload.renderFailed");
					if (typeof message === "string" && message.length > 0) fallback = message;
				} catch (_error) {}
				const content = React.createElement(Section, props);
				const Boundary = sectionBoundary();
				if (Boundary === null) return content;
				return React.createElement(Boundary, { fallbackText: fallback }, content);
			}
			return SectionHost;
		}
		//#endregion

		//#region navigation icon
		/**
		 * `settings.section.icon` occupant. The shell passes `size` (px) and `active` and
		 * owns the surrounding button, so this renders a bare glyph in `currentColor`.
		 */
		function SectionIcon(props) {
			const size = props && typeof props.size === "number" ? props.size : 16;
			return React.createElement("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.5,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				focusable: "false"
			},
				React.createElement("path", { d: "M8 3.5v7" }),
				React.createElement("path", { d: "M5.2 6.3 8 3.5l2.8 2.8" }),
				React.createElement("path", { d: "M3.5 11.6v1.1h9v-1.1" })
			);
		}
		//#endregion

		//#region plugin
		const inject = [ "slots", "locale", "configForms", "remote", "remote.settings" ];

		/**
		 * Keep a registration alive only while the Host actually serves our namespace. The
		 * settings provider's `configForms.whileServed` runs `register` once the namespace is
		 * in the Describe mirror and tears it down when it leaves, which is what makes the page
		 * disappear instead of showing controls for a namespace nobody exposes (the shipped
		 * companion registers its row the same way). A host without `whileServed` registers
		 * immediately, so the page still exists there.
		 *
		 * @param ctx - the Client plugin context.
		 * @param register - registers the contribution and returns its disposer.
		 * @returns the disposer ending the watch and any live registration.
		 */
		function whileServedOn(ctx, register) {
			try {
				const forms = ctx.configForms;
				if (forms !== null && forms !== undefined && typeof forms.whileServed === "function") {
					return forms.whileServed([ NAMESPACE ], register);
				}
			} catch (_error) {}
			return register();
		}

		/**
		 * Register the dictionaries, the stylesheet, the nav page, and its icon. Everything is
		 * owned by `ctx.effect`, so unload removes it and reinstalls it on the next activation.
		 * @param ctx - the Client plugin context.
		 */
		function apply(ctx) {
			const bridge = createBridge(ctx);
			const SectionHost = createSectionHost(bridge);

			ctx.effect(registerStyles, "session-log-upload: styles");
			ctx.effect(function () {
				return ctx.locale.register(LOCALE_NAMESPACE, { en: DICTIONARIES.en, zh: DICTIONARIES.zh });
			}, "session-log-upload: dictionaries");

			let t = identityT;
			try {
				if (ctx.locale !== null && ctx.locale !== undefined && typeof ctx.locale.bind === "function") {
					const bound = ctx.locale.bind(LOCALE_NAMESPACE);
					if (typeof bound === "function") t = bound;
				}
			} catch (_error) {}

			ctx.effect(function () {
				return whileServedOn(ctx, function () {
					return ctx.slots.inject("settings.section", function () {
						return ctx.slots.register({
							name: "settings.section",
							id: NAMESPACE,
							order: 60,
							label: function () {
								return t("upload.sectionTitle");
							},
							locale: LOCALE_NAMESPACE
							// Deliberately no `children` declaration. This page hosts no rows of
							// its own, and the only child a settings page can declare is a
							// root-scoped list slot the General section already declares: a second
							// declaration is dead weight, and a rejected duplicate would make this
							// page vanish from the navigation.
						}, SectionHost);
					});
				});
			}, "session-log-upload: settings section");

			ctx.effect(function () {
				return whileServedOn(ctx, function () {
					return ctx.slots.inject("settings.section.icon", function () {
						return ctx.slots.register({
							name: "settings.section.icon",
							id: NAMESPACE,
							order: 60,
							locale: LOCALE_NAMESPACE
						}, SectionIcon);
					});
				});
			}, "session-log-upload: settings section icon");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
