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
				"upload.renderFailed": "This settings section could not be rendered."
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
				"upload.renderFailed": "这个设置区块无法渲染。"
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
			maxBytes: 8388608
		});
		/** Host route serving the upload ledger (docs/state-channel.md §4). */
		const LEDGER_PATH = "/api/session-log-upload.ledger";
		/**
		 * The same route in the document-relative form the page must fetch, exactly as the
		 * shipped `dsh-session-log-export` client builds it (`"/api/session.markdown".slice(1)`):
		 * no leading slash, so the page's own mount decides the base. In this build the page's
		 * origin *is* the Host web server, and the route sits behind its browser authentication.
		 */
		const LEDGER_ROUTE = LEDGER_PATH.slice(1);
		/** Host route reporting the live Sessions' working directories, for the folder chooser. */
		const SCAN_PATH = "/api/session-log-upload.scan";
		const SCAN_ROUTE = SCAN_PATH.slice(1);
		/** Host route reporting and recording the liability-notice acknowledgement. */
		const NOTICE_PATH = "/api/session-log-upload.notice";
		const NOTICE_ROUTE = NOTICE_PATH.slice(1);
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
/* The liability notice: wider than the consent dialog and scrolling, because it is four paragraphs
   a user is meant to actually read. */
.slu-noticePanel{width:min(560px,calc(100vw - 48px))}
.slu-noticeBody{display:flex;flex-direction:column;gap:8px;max-height:44vh;overflow:auto}
.slu-noticeCheck{display:flex;align-items:flex-start;gap:8px;padding:10px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);font-size:14px;line-height:20px;cursor:pointer}
.slu-noticeCheck input{flex:none;margin:2px 0 0;cursor:pointer}
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
		 * The only fields the settings page edits directly. `mode` is deliberately absent: it has
		 * its own consent-gated path, and this list is what makes it impossible for the field
		 * editor to widen the mode by accident.
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
				let response;
				try {
					response = await fetcher(LEDGER_ROUTE, { headers: { accept: "application/json" } });
				} catch (_error) {
					return LEDGER_FAILED;
				}
				if (response === null || response === undefined || response.ok !== true) {
					const status = response !== null && response !== undefined && typeof response.status === "number" ? response.status : 0;
					if (status === 401 || status === 403) return ledgerState("unauthorized");
					if (status === 404) return ledgerState("missing");
					return LEDGER_FAILED;
				}
				let body;
				try {
					body = await response.json();
				} catch (_error) {
					return ledgerState("malformed");
				}
				return normalizeLedger(body);
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
					response = await fetcher(SCAN_ROUTE, { headers: { accept: "application/json" } });
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
			 * Read whether the liability notice has been acknowledged.
			 *
			 * Total: an absent route, a refused credential, an unreadable body and a transport failure
			 * all resolve to `false`, because the safe direction is to SHOW the notice again. The cost
			 * of showing it twice is one click; the cost of not showing it is a user who never saw it.
			 *
			 * @returns `true` only when the Host positively says it was acknowledged.
			 */
			async function readNotice() {
				const fetcher = pageFetcher();
				if (fetcher === null) return false;
				let response;
				try {
					response = await fetcher(NOTICE_ROUTE, { headers: { accept: "application/json" } });
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
			 * Record the acknowledgement. A POST, so it is not a cacheable read and cannot be replayed
			 * by a prefetch.
			 * @returns `true` only when the Host confirms it stored the acknowledgement.
			 */
			async function writeNotice() {
				const fetcher = pageFetcher();
				if (fetcher === null) return false;
				let response;
				try {
					response = await fetcher(NOTICE_ROUTE, { method: "POST", headers: { accept: "application/json" } });
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

			return { getForm: getForm, formState: formState, readDocument: readDocument, readLedger: readLedger, readScan: readDirectoryScan, readNotice: readNotice, writeNotice: writeNotice, writeField: writeField, writeMode: writeMode };
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
		 * Deliberately NOT a variant of {@link ConfirmDialog}: that one is cancellable, and this one must
		 * not be. There is no backdrop dismiss and no Escape handler — the only controls are the
		 * checkbox and the acknowledge button, which stays disabled until the box is ticked. A dialog
		 * you can click away is a dialog you can dismiss without reading, which is exactly the
		 * acknowledgement this is asking for.
		 */
		function NoticeDialog(props) {
			const panelRef = React.useRef(null);
			const checkRef = React.useRef(null);
			const buttonRef = React.useRef(null);
			const titleId = useStableId();
			const bodyId = useStableId();
			const [ checked, setChecked ] = React.useState(false);
			const [ busy, setBusy ] = React.useState(false);

			React.useEffect(function () {
				const target = checkRef.current;
				if (target !== null && target !== undefined && typeof target.focus === "function") {
					try {
						target.focus();
					} catch (_error) {}
				}
			}, []);

			// Contain focus inside the dialog: there is nothing behind it the user may operate.
			const onPanelKeyDown = function (event) {
				if (event.key !== "Tab") return;
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
				let attempt;
				try {
					attempt = Promise.resolve(props.onAccept());
				} catch (_error) {
					attempt = Promise.resolve(false);
				}
				void attempt.then(function (ok) {
					// On failure the dialog stays up and the button returns, so the user is never left
					// believing they acknowledged something the Host did not record.
					if (ok !== true) setBusy(false);
				}, function () {
					setBusy(false);
				});
			};

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
			},
				React.createElement("h2", { id: titleId, className: "slu-panelTitle" }, props.title),
				React.createElement("div", { id: bodyId, className: "slu-noticeBody" }, props.paragraphs.map(function (text, index) {
					return React.createElement("p", { key: "p" + index, className: "slu-panelBody" }, text);
				})),
				React.createElement("label", { className: "slu-noticeCheck" },
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
				React.createElement("div", { className: "slu-panelActions" },
					React.createElement("button", {
						ref: buttonRef,
						type: "button",
						className: "slu-btn slu-btnPrimary slu-noticeAccept",
						disabled: checked !== true || busy,
						onClick: accept
					}, busy ? props.busyLabel : props.acceptLabel)
				)
			);

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
				const [ fieldBusy, setFieldBusy ] = React.useState(null);
				const [ fieldState, setFieldState ] = React.useState(null);
				const optionRefs = React.useRef([]);
				// The liability notice. `null` means "not read yet"; the dialog only appears once the
				// Host has answered `false`, so it never flashes up before the acknowledgement is known.
				const [ noticeAcknowledged, setNoticeAcknowledged ] = React.useState(null);

				React.useEffect(function () {
					let alive = true;
					let attempt;
					try {
						attempt = Promise.resolve(bridge.readNotice());
					} catch (_error) {
						attempt = Promise.resolve(false);
					}
					void attempt.then(function (acknowledged) {
						if (alive) setNoticeAcknowledged(acknowledged === true);
					}, function () {
						// A failed read shows the notice: the safe direction.
						if (alive) setNoticeAcknowledged(false);
					});
					return function () {
						alive = false;
					};
				}, [ bridge ]);

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
					const selectedKeys = Object.create(null);
					for (const entry of selected) {
						const key = normalizeDirectoryPath(entry);
						if (key !== null) selectedKeys[key] = true;
					}
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
						)
					));

					if (pickerOpen) {
						// Two INDEPENDENT sets. A workspace row ticks its DIRECTORY (written to
						// uploadDirectories); a Session row ticks that one SESSION (written to
						// uploadSessionIds). They are ORed on the Host, so ticking a single conversation
						// uploads it even when its workspace is unticked — which is the reason to offer
						// Session-level rows at all. Sharing one key here (the earlier version) made a
						// Session impossible to select on its own.
						const tickRow = function (kind, key, checked, label, extraClass, dataAttrs) {
							const attrs = Object.assign({
								type: "checkbox",
								checked: checked === true,
								disabled: !live ? true : undefined,
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
							return React.createElement("label", { key: kind + "-" + String(key), className: "slu-check " + (extraClass || "") },
								React.createElement("input", attrs),
								React.createElement("span", { className: "slu-checkPath" }, label)
							);
						};

						const rows = [];
						for (const workspace of directoryOptions) {
							const workspaceKey = normalizeDirectoryPath(workspace.path);
							if (workspaceKey !== null) {
								rows.push(tickRow("workspace", workspaceKey, picked[workspaceKey] === true || selectedKeys[workspaceKey] === true,
									workspace.title || workspace.path || workspaceKey, "slu-checkWorkspace", { "data-workspace": workspaceKey }));
							}
							for (const session of workspace.sessions) {
								const label = session.title && session.title.length > 0 ? session.title : session.id;
								rows.push(tickRow("session", session.id, pickedSessions[session.id] === true || selectedSessionIds[session.id] === true,
									label, "slu-checkSession", { "data-session": session.id }));
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
										// directories and the ticked Sessions. Each keeps the spelling the user
										// saw where we have one, so the saved value stays readable.
										const chosenDirectories = [];
										for (const key of Object.keys(picked)) {
											if (picked[key] !== true) continue;
											const found = directoryOptions.find(function (workspace) { return normalizeDirectoryPath(workspace.path) === key; });
											chosenDirectories.push(found !== undefined && found.path ? found.path : key);
										}
										const chosenSessions = Object.keys(pickedSessions).filter(function (id) { return pickedSessions[id] === true; });
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

				// The liability notice. Shown whenever the Host has NOT recorded an acknowledgement —
				// including while the read is still in flight as `null`? No: `null` renders nothing, so
				// the dialog never flashes for a user who already accepted on a previous visit. A failed
				// read resolves to `false` and therefore does show it.
				const noticeDialog = noticeAcknowledged === false ? React.createElement(NoticeDialog, {
					title: t("upload.noticeTitle"),
					paragraphs: [ t("upload.noticeP1"), t("upload.noticeP2"), t("upload.noticeP3"), t("upload.noticeP4") ],
					checkboxLabel: t("upload.noticeCheck"),
					acceptLabel: t("upload.noticeAccept"),
					busyLabel: t("upload.noticeBusy"),
					onAccept: async function () {
						let ok = false;
						try {
							ok = (await bridge.writeNotice()) === true;
						} catch (_error) {
							ok = false;
						}
						// Only dismiss on a confirmed write. Otherwise the dialog stays up, because a
						// dismissed dialog over an unrecorded acknowledgement would show the notice again
						// on the next visit with no explanation.
						if (ok) setNoticeAcknowledged(true);
						return ok;
					}
				}) : null;

				return React.createElement(React.Fragment, null,
					React.createElement("div", { className: "slu-section" }, children),
					dialog,
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
