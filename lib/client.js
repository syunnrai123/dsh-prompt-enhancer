/**
 * dsh-prompt-enhancer — client half (web GUI).
 *
 * Two surfaces:
 * 1. Composer accessory button (`conversation.input.right`): reads the current
 *    draft, invokes the host `/enhance` command through `ctx.remote.commands`,
 *    and streams the settled result into the result panel.
 * 2. Result panel above the composer (`conversation.input.overlay`): opens for
 *    both the button path and the typed `/enhance` path (`command/executed`),
 *    with slide-in animation, enhanced-text preview, and
 *    [复制] [替换草稿] [关闭] actions.
 *
 * Hand-written in the DSH client-module factory format
 * (window.__ModuleLoader__.load) so no build step is required.
 * React resolves from the platform baseline module table.
 */

window.__ModuleLoader__.load({
	id: "dsh-prompt-enhancer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		const { useEffect, useRef, useState } = react;

		// ── per-session state store (tiny pub/sub, no deps) ───────────────────
		/**
		 * Entry kinds:
		 *  - { kind: "pending" }                     enhancement in flight
		 *  - { kind: "success", enhanced, meta }     settled result
		 *  - { kind: "error", message }              failure
		 *  - { kind: "closed" }                      dismissed / applied
		 */
		const state = new Map();
		const listeners = new Set();
		let seq = 0;

		function publish(sessionId, entry) {
			state.set(sessionId, { seq: ++seq, ...entry });
			for (const fn of listeners) {
				try { fn(sessionId); } catch { /* contained */ }
			}
		}

		function clearPending(sessionId) {
			if (state.get(sessionId)?.kind === "pending") publish(sessionId, { kind: "closed" });
		}

		/** Split the host result text into enhanced body + meta line. */
		function parseResult(text) {
			const marker = "\n---\n";
			const idx = text.lastIndexOf(marker);
			if (idx === -1) return { enhanced: text, meta: "" };
			return { enhanced: text.slice(0, idx), meta: text.slice(idx + marker.length).trim() };
		}

		// ── styles (injected once at materialization) ────────────────────────
		const STYLE_ID = "dsh-prompt-enhancer-style";
		if (typeof document !== "undefined" && !document.getElementById(STYLE_ID)) {
			const style = document.createElement("style");
			style.id = STYLE_ID;
			// Color scheme: panel and button share the composer input card's own
			// surface token (--dsw-specific-input-major) so the base color is
			// identical to the input box; the spark glyph uses the send button's
			// saturated info-fill blue family so it reads clearly on that base.
			// Panel stays anchored above the composer like the slash menu
			// (position:absolute; bottom:calc(100% + 4px); z-index:100); the
			// ::after hairline keeps the same-color panel edge defined.
			style.textContent = `
.dpenh-panel{isolation:isolate;position:absolute;bottom:calc(100% + 4px);left:0;right:0;z-index:100;box-sizing:border-box;border-radius:var(--dsw-radius-lg,10px);box-shadow:var(--dsw-elevation-panel,0 4px 12px rgba(0,0,0,.18));color:var(--dsw-alias-label-primary,#e4e4e7);font-size:12.5px;overflow:hidden;animation:dpenh-in .28s cubic-bezier(.2,.9,.3,1.2)}
.dpenh-panel:before{z-index:-1;border-radius:inherit;background:var(--dsw-specific-input-major,#1d1d20);content:"";pointer-events:none;position:absolute;inset:0}
.dpenh-panel:after{border:.5px solid var(--dsw-alias-border-l1,#3f3f46);border-radius:inherit;content:"";pointer-events:none;position:absolute;inset:0}
.dpenh-head{display:flex;align-items:center;gap:8px;padding:9px 14px;font-weight:600;color:var(--dsw-alias-label-primary,#e4e4e7)}
.dpenh-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e);box-shadow:0 0 0 0 rgba(34,197,94,.7);animation:dpenh-pulse 1.6s ease-out 2;flex:none}
.dpenh-dot--err{background:var(--dsw-alias-state-error-primary,#f87171);box-shadow:none;animation:none}
.dpenh-spin{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l1,#52525b);border-top-color:var(--dsw-alias-brand-primary,#6366f1);animation:dpenh-rot .8s linear infinite;flex:none}
.dpenh-meta{font-weight:400;color:var(--dsw-alias-label-secondary,#a1a1aa);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.dpenh-body{max-height:220px;overflow:auto;padding:4px 14px 10px;white-space:pre-wrap;word-break:break-word;line-height:1.55;font-family:inherit;margin:0;color:var(--dsw-alias-label-primary,#e4e4e7)}
.dpenh-body--error{color:var(--dsw-alias-state-error-primary,#f87171)}
.dpenh-actions{display:flex;gap:8px;padding:9px 14px;border-top:.5px solid var(--dsw-alias-border-l1,#3f3f46)}
.dpenh-btn{appearance:none;border:.5px solid var(--dsw-alias-border-l1,#52525b);border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,#d4d4d8);padding:4px 14px;font-size:12.5px;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
.dpenh-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#fff)}
.dpenh-btn:disabled{opacity:.5;cursor:default}
.dpenh-btn--primary{border-color:var(--dsw-alias-brand-primary,#6366f1);color:var(--dsw-alias-label-primary,#e4e4e7)}
.dpenh-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:999px;background:var(--dsw-specific-input-major,#1d1d20);color:#C7DAE1;cursor:pointer;transition:background .15s,color .15s;box-shadow:var(--dsw-shadow-lv1,0 1px 4px rgba(0,0,0,.2))}
.dpenh-iconbtn.dpenh-iconbtn--filled{color:#E31D34}
.dpenh-iconbtn:hover:not(:disabled){background:var(--dsw-alias-button-tool-bar-hover,rgba(128,128,128,.5))}
.dpenh-iconbtn:active:not(:disabled){background:var(--dsw-alias-button-tool-bar-hover,rgba(128,128,128,.5))}
.dpenh-iconbtn:disabled{opacity:.3;cursor:default}
.dpenh-iconbtn svg{pointer-events:none}
@keyframes dpenh-in{from{opacity:0;transform:translateY(-10px) scale(.985)}to{opacity:1;transform:none}}
@keyframes dpenh-pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.7)}70%{box-shadow:0 0 0 7px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
@keyframes dpenh-rot{to{transform:rotate(360deg)}}
`;
			document.head.appendChild(style);
		}

		/** Shared 16x16 sparkles glyph. */
		function SparkIcon({ busy }) {
			return react.createElement("svg", {
				viewBox: "0 0 16 16", width: "15", height: "15", "aria-hidden": true,
				className: busy ? "dpenh-spin" : undefined,
				...(busy ? {} : {
					children: [
						react.createElement("path", {
							key: "a", fill: "currentColor",
							d: "M6.5 1.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9zM12 8l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6zM3.2 9.5l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z",
						}),
					],
				}),
			});
		}

		// ── result panel (conversation.input.overlay) ─────────────────────────
		function EnhancePanel(props) {
			const sessionId = props.sessionId ?? props["dpenh-sessionId"];
			const setDraft = props.inputActions?.setDraft;
			const [entry, setEntry] = useState(() => (sessionId ? state.get(sessionId) : undefined));
			const [copied, setCopied] = useState(false);
			const copyTimer = useRef(undefined);

			useEffect(() => {
				if (!sessionId) return undefined;
				const sync = () => setEntry(state.get(sessionId));
				sync();
				listeners.add(sync);
				return () => {
					listeners.delete(sync);
					if (copyTimer.current !== undefined) clearTimeout(copyTimer.current);
				};
			}, [sessionId]);

			if (entry === undefined || entry.kind === "closed") return null;

			if (entry.kind === "pending") {
				return react.createElement("div", { className: "dpenh-panel", key: entry.seq },
					react.createElement("div", { className: "dpenh-head" },
						react.createElement("span", { className: "dpenh-spin" }),
						react.createElement("span", null, "提示词增强中"),
						react.createElement("span", { className: "dpenh-meta" }, "模型改写草稿，完成后此处显示结果"),
					),
				);
			}

			if (entry.kind === "error") {
				return react.createElement("div", { className: "dpenh-panel", key: entry.seq },
					react.createElement("div", { className: "dpenh-head" },
						react.createElement("span", { className: "dpenh-dot dpenh-dot--err" }),
						react.createElement("span", null, "增强失败"),
					),
					react.createElement("pre", { className: "dpenh-body dpenh-body--error" }, entry.message ?? "未知错误"),
					react.createElement("div", { className: "dpenh-actions" },
						react.createElement("button", {
							className: "dpenh-btn", type: "button", onClick: () => publish(sessionId, { kind: "closed" }),
						}, "关闭"),
					),
				);
			}

			const enhanced = entry.enhanced ?? "";
			if (enhanced.length === 0) return null;

			const onCopy = async () => {
				try {
					await navigator.clipboard.writeText(enhanced);
					setCopied(true);
					if (copyTimer.current !== undefined) clearTimeout(copyTimer.current);
					copyTimer.current = setTimeout(() => setCopied(false), 1600);
				} catch { /* clipboard unavailable */ }
			};

			const onApply = () => {
				try {
					if (setDraft?.(enhanced) !== false) publish(sessionId, { kind: "closed" });
				} catch { /* input unavailable */ }
			};

			return react.createElement("div", { className: "dpenh-panel", key: entry.seq },
				react.createElement("div", { className: "dpenh-head" },
					react.createElement("span", { className: "dpenh-dot" }),
					react.createElement("span", null, "提示词增强完成"),
					react.createElement("span", { className: "dpenh-meta" }, entry.meta ?? ""),
				),
				react.createElement("pre", { className: "dpenh-body" }, enhanced),
				react.createElement("div", { className: "dpenh-actions" },
					react.createElement("button", {
						className: "dpenh-btn dpenh-btn--primary", type: "button", onClick: onCopy,
					}, copied ? "已复制" : "复制"),
					setDraft !== undefined ? react.createElement("button", {
						className: "dpenh-btn", type: "button", onClick: onApply,
					}, "替换草稿") : null,
					react.createElement("button", {
						className: "dpenh-btn", type: "button", onClick: () => publish(sessionId, { kind: "closed" }),
					}, "关闭"),
				),
			);
		}

		// ── composer accessory button (conversation.input.right) ──────────────
		function EnhanceButton(props) {
			const sessionId = props.sessionId ?? props["dpenh-sessionId"];
			const useInput = props.useInput;
			// Draft may be unreadable when the hook prop is absent; then stay
			// enabled and let the host validate emptiness with a clear usage error.
			const canReadDraft = typeof useInput === "function";
			const draft = canReadDraft ? (useInput((s) => s?.draft ?? "") ?? "") : "";
			const [busy, setBusy] = useState(false);
			const remote = props["dpenh-remote"];

			const onClick = async () => {
				const text = draft.trim();
				if (busy || remote === undefined || sessionId === undefined) return;
				if (canReadDraft && text.length === 0) return;
				const line = canReadDraft ? `/enhance ${text}` : "/enhance";
				setBusy(true);
				publish(sessionId, { kind: "pending" });
				try {
					const result = await remote.commands.execute(sessionId, line, []);
					if (result.ok && result.value?.result?.kind === "success") {
						const parsed = parseResult(result.value.result.text);
						publish(sessionId, { kind: "success", ...parsed });
					} else if (result.ok && result.value?.result?.kind === "error") {
						publish(sessionId, { kind: "error", message: result.value.result.text ?? "增强失败" });
					} else if (!result.ok) {
						publish(sessionId, { kind: "error", message: `${result.error?.code ?? "ERROR"}: ${result.error?.message ?? "命令调用失败"}` });
					} else {
						publish(sessionId, { kind: "error", message: "命令未被识别" });
					}
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					publish(sessionId, { kind: "error", message: `增强请求失败：${detail}\n原始草稿未被修改。` });
				} finally {
					setBusy(false);
				}
			};

			const hasWords = canReadDraft && draft.trim().length > 0;
			return react.createElement("button", {
				className: "dpenh-iconbtn" + (hasWords ? " dpenh-iconbtn--filled" : ""), type: "button",
				title: busy ? "增强中" : "提示词增强（改写当前草稿）",
				"aria-label": "提示词增强",
				"data-busy": busy ? "1" : undefined,
				disabled: canReadDraft && !hasWords && !busy,
				onClick,
			}, react.createElement(SparkIcon, { busy }));
		}

		// ── plugin entry ──────────────────────────────────────────────────────
		// NOTE: remote sub-namespaces are separate inject entries (each dotted
		// path resolves independently in the cordis fiber) — declaring only
		// "remote" throws "cannot get property remote.commands without inject".
		const inject = ["slots", "remote", "remote.commands"];

		function apply(ctx) {
			// Typed `/enhance <draft>` path: the ui-commands runtime broadcasts the settled result.
			ctx.on("command/executed", (sessionId, commandName, result) => {
				if (commandName !== "enhance" || result?.kind !== "success" || typeof result.text !== "string") return;
				clearPending(String(sessionId));
				const parsed = parseResult(result.text);
				publish(String(sessionId), { kind: "success", ...parsed });
			});
			ctx.on("command/executed", (sessionId, commandName, result) => {
				if (commandName !== "enhance" || result?.kind !== "error") return;
				clearPending(String(sessionId));
				publish(String(sessionId), { kind: "error", message: result.text ?? "增强失败" });
			});

			// Result panel above the composer.
			ctx.slots.inject("conversation.input.overlay", () => ctx.slots.register({
				name: "conversation.input.overlay",
				id: "prompt-enhancer-result",
				order: 20,
				inject: (sessionId) => ({ "dpenh-sessionId": String(sessionId) }),
			}, EnhancePanel));

			// Accessory button in the composer toolbar.
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "prompt-enhancer-button",
				order: 10,
				inject: (sessionId) => ({
					"dpenh-sessionId": sessionId,
					"dpenh-remote": ctx.remote,
				}),
			}, EnhanceButton));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
