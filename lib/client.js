window.__ModuleLoader__.load({
	id: "dsh-llm-oauth",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/api.ts
		const BASE = "/dsh-llm-oauth";
		async function wakeCodex() {
			const response = await fetch(`${BASE}/launch-codex`, {
				method: "POST",
				credentials: "same-origin",
				headers: {
					"content-type": "application/json",
					accept: "application/json"
				},
				body: "{}"
			});
			const body = await response.json();
			if (!response.ok || body.target !== "desktop" && body.target !== "web") throw new Error(body.error || `HTTP ${String(response.status)}`);
			return { target: body.target };
		}
		function isStatusSnapshot(body) {
			return typeof body === "object" && body !== null && Array.isArray(body.providers);
		}
		async function request(path, init) {
			const response = await fetch(`${BASE}${path}`, {
				credentials: "same-origin",
				...init,
				headers: {
					accept: "application/json",
					...init?.body === void 0 ? {} : { "content-type": "application/json" },
					...init?.headers
				}
			});
			const text = await response.text();
			let body;
			try {
				body = text.length === 0 ? {} : JSON.parse(text);
			} catch {
				throw new Error(text || `HTTP ${String(response.status)}`);
			}
			if (!response.ok) {
				if (isStatusSnapshot(body)) return body;
				const message = typeof body === "object" && body !== null && "error" in body ? String(body.error) : `HTTP ${String(response.status)}`;
				throw new Error(message);
			}
			return body;
		}
		function fetchOauthStatus() {
			return request("/status");
		}
		function refreshOauthModels() {
			return request("/refresh", {
				method: "POST",
				body: "{}"
			});
		}
		function enableOauthProvider(provider) {
			return request("/enable", {
				method: "POST",
				body: JSON.stringify({ provider })
			});
		}
		function disableOauthProvider(provider) {
			return request("/disable", {
				method: "POST",
				body: JSON.stringify({ provider })
			});
		}
		function loginOauthProvider(provider) {
			return request("/login", {
				method: "POST",
				body: JSON.stringify({ provider })
			});
		}
		function logoutOauthProvider(provider) {
			return request("/logout", {
				method: "POST",
				body: JSON.stringify({ provider })
			});
		}
		/**
		* Hand a running sign-in the value it waits for (the final redirect URL or
		* authorization code a browser callback could not deliver to this host).
		*/
		function submitOauthCode(provider, code) {
			return request("/code", {
				method: "POST",
				body: JSON.stringify({
					provider,
					code
				})
			});
		}
		//#endregion
		//#region src/client/OauthSection.module.css
		const css = ".NEsHCG_section{flex-direction:column;gap:12px;max-width:720px;padding:4px 0 24px;display:flex}.NEsHCG_title{color:inherit;margin:0;font-size:18px;font-weight:600}.NEsHCG_intro{color:color-mix(in srgb, currentColor 85%, transparent);margin:0;font-size:13px;line-height:1.5}.NEsHCG_meta{color:color-mix(in srgb, currentColor 70%, transparent);word-break:break-all;margin:0;font-size:12px}.NEsHCG_toolbar{flex-wrap:wrap;gap:8px;display:flex}.NEsHCG_launcher{border-top:1px solid color-mix(in srgb, currentColor 20%, transparent);flex-direction:column;gap:8px;margin-top:16px;padding-top:18px;display:flex}.NEsHCG_rows{flex-direction:column;gap:10px;margin:0;padding:0;list-style:none;display:flex}.NEsHCG_rowCard{border:1px solid color-mix(in srgb, currentColor 22%, transparent);background:color-mix(in srgb, currentColor 5%, transparent);border-radius:10px;flex-direction:column;gap:10px;padding:12px 14px;display:flex}.NEsHCG_rowHead{justify-content:space-between;align-items:flex-start;gap:12px;display:flex}.NEsHCG_rowIdentity{flex-direction:column;gap:4px;min-width:0;display:flex}.NEsHCG_rowName{font-size:14px;font-weight:600}.NEsHCG_rowId{color:color-mix(in srgb, currentColor 70%, transparent);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}.NEsHCG_badges{flex-wrap:wrap;gap:6px;display:flex}.NEsHCG_badge{border:1px solid #0000;border-radius:999px;align-items:center;padding:2px 8px;font-size:11px;line-height:1.4;display:inline-flex}.NEsHCG_badgeOn{color:inherit;background:#16a34a1f;border-color:#16a34a47}.NEsHCG_badgeOff{color:inherit;background:#64748b1f;border-color:#64748b3d}.NEsHCG_badgeOk{color:inherit;background:#2563eb1f;border-color:#2563eb47}.NEsHCG_badgeMissing{color:inherit;background:#dc26261a;border-color:#dc26263d}.NEsHCG_badgeWarn{color:inherit;background:#d977061f;border-color:#d9770647}.NEsHCG_rowActions{flex-wrap:wrap;gap:8px;display:flex}.NEsHCG_button,.NEsHCG_secondaryButton,.NEsHCG_dangerButton{appearance:none;border:1px solid color-mix(in srgb, currentColor 22%, transparent);background:color-mix(in srgb, currentColor 5%, transparent);color:inherit;cursor:pointer;border-radius:8px;padding:6px 10px;font-size:13px}.NEsHCG_button:disabled,.NEsHCG_secondaryButton:disabled,.NEsHCG_dangerButton:disabled{opacity:.55;cursor:not-allowed}.NEsHCG_button{color:#fff;background:#111;border-color:#0000}.NEsHCG_dangerButton{color:inherit;border-color:#dc262659}.NEsHCG_notice,.NEsHCG_error,.NEsHCG_command{white-space:pre-wrap;word-break:break-word;margin:0;font-size:12px;line-height:1.45}.NEsHCG_notice{color:color-mix(in srgb, currentColor 85%, transparent)}.NEsHCG_notice a{color:inherit;text-underline-offset:3px;text-decoration:underline}.NEsHCG_error{color:inherit}.NEsHCG_command{color:color-mix(in srgb, currentColor 85%, transparent);background:color-mix(in srgb, currentColor 5%, transparent);border-radius:8px;padding:8px 10px}.NEsHCG_codeBox{background:#2563eb14;border:1px solid #2563eb47;border-radius:10px;flex-wrap:wrap;align-items:center;gap:10px;padding:10px 12px;display:flex}.NEsHCG_codeLabel{color:color-mix(in srgb, currentColor 85%, transparent);font-size:12px}.NEsHCG_codeValue{letter-spacing:.06em;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:18px;font-weight:700}.NEsHCG_codeInput{border:1px solid color-mix(in srgb, currentColor 22%, transparent);background:color-mix(in srgb, currentColor 5%, transparent);min-width:10rem;color:inherit;font:inherit;border-radius:8px;flex:16rem;padding:6px 8px;font-size:13px}.NEsHCG_codeInput:disabled{opacity:.55}.NEsHCG_buttonLink{color:#fff;background:#111;border:1px solid #0000;border-radius:8px;align-items:center;padding:6px 12px;font-size:13px;text-decoration:none;display:inline-flex}.NEsHCG_buttonLink:hover{opacity:.92}";
		const tagId = "dsh-llm-oauth/OauthSection.module.css";
		if (typeof document !== "undefined") {
			const tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") ?? document.createElement("style");
			tag.dataset.plugin = "dsh-llm-oauth";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var OauthSection_module_css_default = {
			"codeLabel": "NEsHCG_codeLabel",
			"rows": "NEsHCG_rows",
			"badges": "NEsHCG_badges",
			"notice": "NEsHCG_notice",
			"rowCard": "NEsHCG_rowCard",
			"rowId": "NEsHCG_rowId",
			"secondaryButton": "NEsHCG_secondaryButton",
			"rowHead": "NEsHCG_rowHead",
			"codeInput": "NEsHCG_codeInput",
			"badgeOk": "NEsHCG_badgeOk",
			"buttonLink": "NEsHCG_buttonLink",
			"badgeOn": "NEsHCG_badgeOn",
			"meta": "NEsHCG_meta",
			"title": "NEsHCG_title",
			"badge": "NEsHCG_badge",
			"badgeOff": "NEsHCG_badgeOff",
			"badgeMissing": "NEsHCG_badgeMissing",
			"section": "NEsHCG_section",
			"button": "NEsHCG_button",
			"intro": "NEsHCG_intro",
			"command": "NEsHCG_command",
			"badgeWarn": "NEsHCG_badgeWarn",
			"codeValue": "NEsHCG_codeValue",
			"codeBox": "NEsHCG_codeBox",
			"rowIdentity": "NEsHCG_rowIdentity",
			"error": "NEsHCG_error",
			"dangerButton": "NEsHCG_dangerButton",
			"rowName": "NEsHCG_rowName",
			"toolbar": "NEsHCG_toolbar",
			"rowActions": "NEsHCG_rowActions",
			"launcher": "NEsHCG_launcher"
		};
		//#endregion
		//#region src/client/OauthSection.tsx
		/**
		* Settings → OAuth / 订阅: enable toggles + login status.
		* Talks to the host plugin over `/dsh-llm-oauth/*` (not Typert RPC).
		* On login, opens the authorization URL in a new window when the host returns one.
		*/
		/** Try to open the OAuth URL; returns false if the browser blocked the popup. */
		function tryOpenAuthWindow(url) {
			try {
				return window.open(url, "_blank", "noopener,noreferrer") !== null;
			} catch {
				return false;
			}
		}
		function extractHttpUrl(text) {
			if (text === void 0) return void 0;
			return text.match(/https?:\/\/[^\s]+/i)?.[0];
		}
		function OauthSection(props) {
			const { t } = props;
			if (t === void 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Loaded, { t });
		}
		function Loaded({ t }) {
			const [status, setStatus] = (0, react.useState)(void 0);
			const [error, setError] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(void 0);
			const [command, setCommand] = (0, react.useState)(void 0);
			const [popupBlocked, setPopupBlocked] = (0, react.useState)(false);
			const [wakingCodex, setWakingCodex] = (0, react.useState)(false);
			const [launchNotice, setLaunchNotice] = (0, react.useState)(void 0);
			const [launchError, setLaunchError] = (0, react.useState)(void 0);
			const openCodex = async () => {
				if (wakingCodex) return;
				setWakingCodex(true);
				setLaunchNotice(void 0);
				setLaunchError(void 0);
				try {
					const result = await wakeCodex();
					setLaunchNotice(t(result.target === "desktop" ? "codexOpened" : "chatgptOpened"));
				} catch (err) {
					setLaunchError(err instanceof Error ? err.message : String(err));
				} finally {
					setWakingCodex(false);
				}
			};
			const codexLauncher = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: OauthSection_module_css_default.launcher,
				"aria-label": t("wakeCodex"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: OauthSection_module_css_default.toolbar,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: OauthSection_module_css_default.secondaryButton,
							disabled: wakingCodex,
							onClick: () => {
								openCodex();
							},
							children: wakingCodex ? t("wakingCodex") : t("wakeCodex")
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: OauthSection_module_css_default.notice,
						children: t("wakeCodexHint")
					}),
					launchNotice !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: OauthSection_module_css_default.notice,
						role: "status",
						children: launchNotice
					}) : null,
					launchError !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: OauthSection_module_css_default.error,
						role: "alert",
						children: [
							launchError,
							" ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
								href: "https://chatgpt.com/",
								target: "_blank",
								rel: "noopener noreferrer",
								children: "ChatGPT ↗"
							})
						]
					}) : null
				]
			});
			const load = (0, react.useCallback)(async () => {
				setBusy({ action: "refresh" });
				setError(void 0);
				try {
					const next = await refreshOauthModels();
					setStatus(next);
					setCommand(void 0);
					setPopupBlocked(false);
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy(void 0);
				}
			}, []);
			(0, react.useEffect)(() => {
				load();
			}, [load]);
			const hasWaiting = status?.providers.some((row) => row.loginStatus === "waiting") ?? false;
			(0, react.useEffect)(() => {
				if (!hasWaiting) return;
				let cancelled = false;
				const poll = async () => {
					try {
						const next = await fetchOauthStatus();
						if (cancelled) return;
						setStatus(next);
						if (!next.providers.some((row) => row.loginStatus === "waiting")) {
							setCommand(void 0);
							setPopupBlocked(false);
						}
					} catch {}
				};
				const timer = window.setInterval(() => {
					poll();
				}, 1500);
				const onFocus = () => {
					poll();
				};
				const onVisibility = () => {
					if (document.visibilityState === "visible") poll();
				};
				window.addEventListener("focus", onFocus);
				document.addEventListener("visibilitychange", onVisibility);
				return () => {
					cancelled = true;
					window.clearInterval(timer);
					window.removeEventListener("focus", onFocus);
					document.removeEventListener("visibilitychange", onVisibility);
				};
			}, [hasWaiting]);
			const applyLoginResult = (next) => {
				setStatus(next);
				const cmd = next.command;
				setCommand(cmd);
				if (cmd?.kind === "error" && cmd.text) setError(cmd.text);
				const url = cmd?.openUrl ?? extractHttpUrl(cmd?.text);
				if (url !== void 0 && cmd?.kind !== "error") {
					const opened = tryOpenAuthWindow(url);
					setPopupBlocked(!opened);
				} else setPopupBlocked(false);
			};
			const run = async (provider, action, fn) => {
				setBusy({
					id: provider,
					action
				});
				setError(void 0);
				if (action !== "login" && action !== "code") {
					setCommand(void 0);
					setPopupBlocked(false);
				}
				try {
					const next = await fn(provider);
					if (action === "login") applyLoginResult(next);
					else {
						setStatus(next);
						setCommand(next.command);
						setError(next.command?.kind === "error" ? next.command.text : void 0);
						if (action !== "code" || !next.providers.some((row) => row.loginStatus === "waiting")) setPopupBlocked(false);
					}
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy(void 0);
				}
			};
			if (status === void 0 && error === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: OauthSection_module_css_default.section,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: OauthSection_module_css_default.title,
						children: t("title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: OauthSection_module_css_default.notice,
						children: t("loading")
					}),
					codexLauncher
				]
			});
			if (status === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: OauthSection_module_css_default.section,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: OauthSection_module_css_default.title,
						children: t("title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: OauthSection_module_css_default.error,
						children: `${t("loadFailed")}: ${error ?? ""}`
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: OauthSection_module_css_default.toolbar,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: OauthSection_module_css_default.secondaryButton,
							onClick: () => {
								load();
							},
							children: t("retry")
						})
					}),
					codexLauncher
				]
			});
			const globalBusy = busy?.action === "refresh";
			const authUrl = command?.openUrl ?? extractHttpUrl(command?.text);
			const userCode = command?.userCode;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: OauthSection_module_css_default.section,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: OauthSection_module_css_default.title,
						children: t("title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: OauthSection_module_css_default.intro,
						children: t("intro")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: OauthSection_module_css_default.notice,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
							href: "https://chatgpt.com/settings/usage",
							target: "_blank",
							rel: "noopener noreferrer",
							children: t("usageLink")
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: OauthSection_module_css_default.notice,
						children: t("usageNote")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: OauthSection_module_css_default.toolbar,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: OauthSection_module_css_default.secondaryButton,
							disabled: globalBusy,
							onClick: () => {
								load();
							},
							children: globalBusy ? t("busy") : t("refresh")
						})
					}),
					error !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: OauthSection_module_css_default.error,
						children: error
					}) : null,
					popupBlocked ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: OauthSection_module_css_default.error,
						children: t("popupBlocked")
					}) : null,
					userCode !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: OauthSection_module_css_default.codeBox,
						role: "status",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: OauthSection_module_css_default.codeLabel,
								children: t("userCodeLabel")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
								className: OauthSection_module_css_default.codeValue,
								children: userCode
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: OauthSection_module_css_default.secondaryButton,
								onClick: () => {
									navigator.clipboard?.writeText(userCode);
								},
								children: t("copyCode")
							})
						]
					}) : null,
					authUrl !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: OauthSection_module_css_default.toolbar,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
							className: OauthSection_module_css_default.buttonLink,
							href: authUrl,
							target: "_blank",
							rel: "noopener noreferrer",
							onClick: () => {
								setPopupBlocked(false);
							},
							children: t("openAuth")
						})
					}) : null,
					command?.text !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: OauthSection_module_css_default.command,
						role: "status",
						children: command.text
					}) : null,
					status.providers.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: OauthSection_module_css_default.notice,
						children: t("empty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: OauthSection_module_css_default.rows,
						children: status.providers.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProviderRow, {
							row,
							t,
							busy,
							onEnable: () => {
								run(row.id, "enable", enableOauthProvider);
							},
							onDisable: () => {
								run(row.id, "disable", disableOauthProvider);
							},
							onLogin: () => {
								run(row.id, "login", loginOauthProvider);
							},
							onLogout: () => {
								run(row.id, "logout", logoutOauthProvider);
							},
							onSubmitCode: (code) => {
								run(row.id, "code", (id) => submitOauthCode(id, code));
							}
						}, row.id))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: OauthSection_module_css_default.notice,
						children: t("tipEnable")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: OauthSection_module_css_default.notice,
						children: t("tipLogin")
					}),
					codexLauncher
				]
			});
		}
		function ProviderRow(props) {
			const { row, t, busy, onEnable, onDisable, onLogin, onLogout, onSubmitCode } = props;
			const rowBusy = busy?.id === row.id;
			const disabled = busy !== void 0;
			const [code, setCode] = (0, react.useState)("");
			const submit = () => {
				const value = code.trim();
				if (value.length === 0) return;
				setCode("");
				onSubmitCode(value);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: OauthSection_module_css_default.rowCard,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: OauthSection_module_css_default.rowHead,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: OauthSection_module_css_default.rowIdentity,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: OauthSection_module_css_default.rowName,
									children: row.name
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: OauthSection_module_css_default.rowId,
									children: row.id
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: OauthSection_module_css_default.badges,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: `${OauthSection_module_css_default.badge} ${row.enabled ? OauthSection_module_css_default.badgeOn : OauthSection_module_css_default.badgeOff}`,
											children: row.enabled ? t("enabled") : t("disabled")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: `${OauthSection_module_css_default.badge} ${row.loggedIn ? OauthSection_module_css_default.badgeOk : OauthSection_module_css_default.badgeMissing}`,
											children: row.loggedIn ? `${t("loggedIn")}${row.authType ? ` (${row.authType})` : ""}` : t("loggedOut")
										}),
										row.loginStatus === "waiting" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: `${OauthSection_module_css_default.badge} ${OauthSection_module_css_default.badgeWarn}`,
											children: t("loginWaiting")
										}) : null,
										row.loginStatus === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: `${OauthSection_module_css_default.badge} ${OauthSection_module_css_default.badgeMissing}`,
											children: t("loginError")
										}) : null
									]
								}),
								row.loggedIn && row.authSource !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: OauthSection_module_css_default.notice,
									children: row.authSource
								}) : null,
								row.id === "openrouter" && !row.enabled ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: OauthSection_module_css_default.notice,
									children: t("openrouterWarn")
								}) : null,
								row.id === "openai" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: OauthSection_module_css_default.notice,
									children: t("openaiWarn")
								}) : null,
								row.loginDetail !== void 0 && row.loginStatus === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: OauthSection_module_css_default.error,
									children: row.loginDetail
								}) : null
							]
						})
					}),
					row.loginPrompt !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
						className: OauthSection_module_css_default.codeBox,
						onSubmit: (event) => {
							event.preventDefault();
							submit();
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: OauthSection_module_css_default.codeLabel,
								children: row.loginPrompt.message
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: OauthSection_module_css_default.codeInput,
								type: "text",
								value: code,
								disabled,
								placeholder: row.loginPrompt.placeholder ?? t("pastePlaceholder"),
								onChange: (event) => {
									setCode(event.target.value);
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "submit",
								className: OauthSection_module_css_default.secondaryButton,
								disabled: disabled || code.trim().length === 0,
								children: rowBusy && busy?.action === "code" ? t("busy") : t("submitCode")
							})
						]
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: OauthSection_module_css_default.rowActions,
						children: [row.enabled ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: OauthSection_module_css_default.secondaryButton,
							disabled,
							onClick: onDisable,
							children: rowBusy && busy?.action === "disable" ? t("busy") : t("disable")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: OauthSection_module_css_default.button,
							disabled,
							onClick: onEnable,
							children: rowBusy && busy?.action === "enable" ? t("busy") : t("enable")
						}), row.loggedIn ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: OauthSection_module_css_default.dangerButton,
							disabled,
							onClick: onLogout,
							children: rowBusy && busy?.action === "logout" ? t("busy") : t("logout")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: OauthSection_module_css_default.secondaryButton,
							disabled,
							onClick: onLogin,
							children: rowBusy && busy?.action === "login" ? t("busy") : t("login")
						})]
					})
				]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** OAuth settings section copy (standalone Settings nav entry). */
		const zh = {
			nav: "OAuth",
			title: "OAuth",
			wakeCodex: "启动codex",
			wakingCodex: "正在打开…",
			wakeCodexHint: "优先打开本机 Codex；未安装时打开 ChatGPT 网页。",
			codexOpened: "已请求唤醒 Codex。",
			chatgptOpened: "已打开 ChatGPT 网页。",
			intro: "连接 ChatGPT 账户，在 DSH 中使用获准的套餐额度。此连接使用新版 openai，登录后会读取账户可用模型。",
			authFile: "凭据文件",
			refresh: "刷新状态",
			usageLink: "查看 ChatGPT 用量",
			usageNote: "剩余额度与恢复时间请以 ChatGPT 用量页为准。刷新状态仅更新登录状态。",
			loading: "加载中…",
			loadFailed: "无法加载 OAuth 状态",
			retry: "重试",
			empty: "当前 catalog 为空。",
			enabled: "已开启",
			disabled: "未开启",
			loggedIn: "已登录",
			loggedOut: "未登录",
			loginWaiting: "浏览器登录进行中…",
			loginError: "最近一次登录失败",
			enable: "开启",
			disable: "关闭",
			login: "Continue with ChatGPT",
			logout: "退出登录",
			busy: "处理中…",
			tipEnable: "开启后，该提供方会出现在模型选择器（需已登录才能对话）。",
			tipLogin: "在系统浏览器中完成登录和授权；完成后返回这里刷新状态。凭据保存在本机。",
			openAuth: "打开授权页",
			userCodeLabel: "设备码",
			copyCode: "复制设备码",
			submitCode: "提交",
			pastePlaceholder: "仅在自动回调失败时粘贴浏览器最终回调地址",
			popupBlocked: "浏览器拦截了弹窗，请点「打开授权页」或允许本站弹窗后重试登录。",
			openrouterWarn: "OpenRouter catalog 很大；确认需要后再开启。",
			openaiWarn: "openai 走「Sign in with ChatGPT」。若已在设置 → 模型用 API Key 配过 openai，请先移除该配置：同一个路由只能由一个提供方注册。"
		};
		const en = {
			nav: "OAuth",
			title: "OAuth",
			wakeCodex: "Open Codex",
			wakingCodex: "Opening…",
			wakeCodexHint: "Open the installed Codex app, or ChatGPT on the web when unavailable.",
			codexOpened: "Codex activation requested.",
			chatgptOpened: "Opened ChatGPT on the web.",
			intro: "Connect your ChatGPT account to use approved plan capacity in DSH. Available models are loaded after sign-in.",
			authFile: "Credential file",
			refresh: "Refresh",
			usageLink: "View ChatGPT usage",
			usageNote: "Check ChatGPT usage for remaining capacity and recovery times. Refresh only updates sign-in status.",
			loading: "Loading…",
			loadFailed: "Could not load OAuth status",
			retry: "Retry",
			empty: "Catalog is empty.",
			enabled: "Enabled",
			disabled: "Disabled",
			loggedIn: "Signed in",
			loggedOut: "Not signed in",
			loginWaiting: "Browser login in progress…",
			loginError: "Last login failed",
			enable: "Enable",
			disable: "Disable",
			login: "Continue with ChatGPT",
			logout: "Sign out",
			busy: "Working…",
			tipEnable: "When enabled, this provider appears in the model picker (sign-in still required to chat).",
			tipLogin: "Complete sign-in and authorization in your system browser, then return here. Credentials are stored locally.",
			openAuth: "Open authorization page",
			userCodeLabel: "Device code",
			copyCode: "Copy code",
			submitCode: "Submit",
			pastePlaceholder: "Paste the final callback URL only if the automatic callback fails",
			popupBlocked: "The browser blocked the popup. Click “Open authorization page” or allow popups for this site and try again.",
			openrouterWarn: "OpenRouter’s catalog is large; enable only if you need it.",
			openaiWarn: "openai signs in with ChatGPT. If Settings → Models already configures an openai API key, remove that profile first — one route id can be registered by only one provider."
		};
		//#endregion
		//#region src/client/index.ts
		const NS = "settings.oauth";
		/** Required client services. */
		const inject = ["slots", "locale"];
		/**
		* Register a standalone OAuth settings section next to Models / Plugins.
		* @param ctx - browser Cordis context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-llm-oauth: dictionaries");
			const t = ctx.locale.bind(NS);
			const injected = () => ({ t });
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "oauth",
				order: 12,
				label: () => t("nav"),
				inject: injected
			}, OauthSection));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

