import z from "@deepseek-ai/schemastery";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { deepEqualJson } from "@deepseek-ai/dsh-util-values";
import * as llm from "@deepseek-ai/dsh-llm";
import { LlmAdapter, LlmError, ReasoningEffortId, attributionHeaders, contentHasImage } from "@deepseek-ai/dsh-llm";
import { createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { lock } from "proper-lockfile";
import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
//#region src/catalog.ts
/**
* Resolve OAuth-capable pi-ai catalog providers.
*/
/** Default subscription / OAuth catalog ids this plugin ships. */
const DEFAULT_PROVIDERS = [
	"xai",
	"github-copilot",
	"openai",
	"openai-codex",
	"anthropic",
	"openrouter",
	"kimi-coding"
];
/** Settings / configurable-provider namespace owned by this plugin. */
const SETTINGS_NS = "llm-oauth";
/**
* Every installed catalog provider that declares an OAuth method.
*/
function oauthCatalogProviders() {
	return builtinProviders().filter((provider) => provider.auth.oauth !== void 0);
}
/**
* Resolve configured catalog ids against the installed catalog.
* @param requested - provider ids from plugin config.
* @returns catalog providers in config order.
*/
function resolveOAuthProviders(requested) {
	const catalog = new Map(builtinProviders().map((provider) => [provider.id, provider]));
	const resolved = [];
	for (const id of requested) {
		const provider = catalog.get(id);
		if (provider === void 0) throw new Error(`dsh-llm-oauth: unknown pi-ai catalog provider "${id}"`);
		if (provider.auth.oauth === void 0) throw new Error(`dsh-llm-oauth: provider "${id}" has no OAuth method (GPT subscriptions use "openai" — Sign in with ChatGPT — or the legacy "openai-codex"; pure API-key ids such as "openai"-less gateways stay on the first-party plugin. Run \`node bin/login.mjs --list\` for every OAuth-capable id)`);
		resolved.push(provider);
	}
	if (resolved.length === 0) throw new Error("dsh-llm-oauth: catalog must list at least one OAuth-capable catalog id");
	return resolved;
}
/**
* Human label for a catalog id (falls back to the id).
* @param providerId - pi-ai catalog provider id.
*/
function catalogDisplayName(providerId) {
	return builtinProviders().find((provider) => provider.id === providerId)?.name ?? providerId;
}
//#endregion
//#region src/config.ts
/** Empty enabled-profile object accepted by the settings form. */
const ProviderProfileSchema = z.object({ displayName: z.string() });
/**
* Loader-visible configuration schema.
* Shared by composition entry config and the `llm-oauth` settings section.
*
* `providers` is volatile, so the settings service accepts live enable/disable
* edits to this entry and the Loader swaps the reference in place instead of
* remounting the plugin.
*/
const Config = z.object({
	catalog: z.array(z.string()).default([...DEFAULT_PROVIDERS]),
	providers: z.union([z.dict(ProviderProfileSchema), z.array(z.string())]).default({}).volatile(),
	authPath: z.string()
});
/**
* Read one configuration field's current value; an ordinary value passes
* through unchanged.
* @param value - a parsed field, plain or volatile.
* @returns the current snapshot for a volatile reference.
*/
function readField(value) {
	if (value === void 0 || value === null) return void 0;
	const box = value;
	return typeof box.get === "function" ? box.get() : value;
}
/**
* Project the Loader's configuration onto the plain shape composition input
* uses, so no caller holds a volatile reference between operations.
* @param config - Loader configuration (volatile fields) or plain values.
* @returns plain configuration, detached from the live references.
*/
function readConfig(config = {}) {
	const values = config;
	const catalog = readField(values.catalog);
	const providers = readField(values.providers);
	const authPath = readField(values.authPath);
	return {
		...catalog === void 0 ? {} : { catalog: structuredClone(catalog) },
		...providers === void 0 ? {} : { providers: structuredClone(providers) },
		...authPath === void 0 ? {} : { authPath }
	};
}
/**
* Normalize composition/settings input: legacy `providers: string[]` becomes
* the catalog with nothing enabled (dormant), matching the v0.2 default.
* @param config - partial or legacy configuration.
*/
function resolveConfig(config = {}) {
	const legacyList = Array.isArray(config.providers) ? config.providers : void 0;
	return {
		catalog: config.catalog ?? (legacyList !== void 0 && legacyList.length > 0 ? [...legacyList] : [...DEFAULT_PROVIDERS]),
		providers: legacyList !== void 0 ? {} : config.providers ?? {},
		...config.authPath === void 0 ? {} : { authPath: config.authPath }
	};
}
/** Sorted list of enabled provider route ids. */
function enabledProviderIds(config) {
	const providers = resolveConfig(config).providers;
	return Object.keys(providers).sort((a, b) => a.localeCompare(b));
}
//#endregion
//#region src/context.ts
/**
* Minimal harness → pi-ai context conversion (text, images, tools).
* Image blocks are durable attachment references; the adapter reads their
* request bytes through the host attachment service before conversion.
*/
/** Same defaults as first-party dsh-llm-pi-ai: 2048×2048 pixel budget, 1 MiB encoded. */
const IMAGE_MAX_PIXELS = 4194304;
const IMAGE_MAX_BYTES = 1048576;
function imageTarget(ref) {
	const scale = Math.min(1, Math.sqrt(IMAGE_MAX_PIXELS / (ref.width * ref.height)));
	if (scale === 1) return {
		width: ref.width,
		height: ref.height,
		maxBytes: IMAGE_MAX_BYTES
	};
	if (ref.width >= ref.height) {
		let width = Math.max(1, Math.floor(ref.width * scale));
		let height = Math.max(1, Math.round(width * ref.height / ref.width));
		while (width * height > IMAGE_MAX_PIXELS && width > 1) {
			width -= 1;
			height = Math.max(1, Math.round(width * ref.height / ref.width));
		}
		return {
			width,
			height,
			maxBytes: IMAGE_MAX_BYTES
		};
	}
	let height = Math.max(1, Math.floor(ref.height * scale));
	let width = Math.max(1, Math.round(height * ref.width / ref.height));
	while (width * height > IMAGE_MAX_PIXELS && height > 1) {
		height -= 1;
		width = Math.max(1, Math.round(height * ref.width / ref.height));
	}
	return {
		width,
		height,
		maxBytes: IMAGE_MAX_BYTES
	};
}
function assertSupportedImageRoles(messages) {
	for (const message of messages) if ((message.role === "assistant" || message.role === "system") && contentHasImage(message.content)) throw new LlmError(`dsh-llm-oauth cannot send an image in a ${message.role} message`, "UNSUPPORTED_CONTENT");
}
/**
* Read request bytes for every non-offloaded image in the request.
* @param messages - request messages.
* @param attachments - host attachment service.
* @param signal - request abort signal.
*/
async function prepareRequestImages(messages, attachments, signal) {
	assertSupportedImageRoles(messages);
	const refs = /* @__PURE__ */ new Map();
	for (const message of messages) for (const block of message.content) if (block.type === "image" && block.offloaded !== true) {
		const ref = block.attachment;
		refs.set(String(ref.attachmentId), ref);
	}
	const entries = [...refs.entries()];
	const resolved = await Promise.all(entries.map(([, ref]) => attachments.readImageRequest(ref, imageTarget(ref), signal)));
	return new Map(entries.map(([id], index) => [id, resolved[index]]));
}
function imageName(ref) {
	return ref.name ?? String(ref.attachmentId);
}
/** User content: plain string when text-only, else text + image parts. */
function userContent(message, images) {
	if (!contentHasImage(message.content)) return flattenText(message);
	const content = [];
	for (const block of message.content) if (block.type === "text") {
		if (block.text.length > 0) content.push({
			type: "text",
			text: block.text
		});
	} else if (block.type === "image") {
		const ref = block.attachment;
		if (block.offloaded === true) {
			content.push({
				type: "text",
				text: `[image omitted: ${imageName(ref)}]`
			});
			continue;
		}
		const image = images?.get(String(ref.attachmentId));
		if (image === void 0) throw new LlmError("dsh-llm-oauth image content requires prepared request images", "UNSUPPORTED_CONTENT");
		content.push({
			type: "image",
			data: Buffer.from(image.data).toString("base64"),
			mimeType: image.mediaType
		});
	}
	return content;
}
function flattenText(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/**
* Parse historical tool arguments into pi-ai's JSON object shape.
* pi-ai >= 1.0.0 types `ToolCall.arguments` as `JsonObject`, so a malformed or
* non-object payload must collapse to `{}` rather than an untyped record.
*/
function parseArguments(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
	} catch {}
	return {};
}
function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
}
function toAssistant(message) {
	if (message.source.kind !== "model") throw new LlmError("Assistant message is missing model provenance", "UNSUPPORTED_CONTENT");
	const replay = message.source.replayState;
	const native = replay?.response?.kind === "dsh-chatgpt-pi";
	const content = [];
	for (const [index, block] of message.content.entries()) {
		const meta = native ? replay?.blocks?.[index] ?? {} : {};
		if (block.type === "text") content.push({
			type: "text",
			text: block.text,
			...typeof meta.textSignature === "string" ? { textSignature: meta.textSignature } : {}
		});
		else if (block.type === "reasoning") content.push({
			type: "thinking",
			thinking: block.text,
			...typeof meta.thinkingSignature === "string" ? { thinkingSignature: meta.thinkingSignature } : {},
			...meta.redacted === true ? { redacted: true } : {}
		});
		else if (block.type === "tool-call") content.push({
			type: "toolCall",
			id: String(block.id),
			name: block.name,
			arguments: parseArguments(block.arguments),
			...typeof meta.namespace === "string" ? { namespace: meta.namespace } : {}
		});
	}
	return {
		role: "assistant",
		content,
		api: native ? replay?.response?.api ?? "openai-responses" : "openai-completions",
		provider: message.source.provider,
		model: message.source.model,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 0
	};
}
/**
* Convert one assembled harness request into pi-ai's context envelope.
* @param options - fully assembled model request.
* @param images - request image bytes keyed by attachment id (required when images are present).
*/
function toPiContext(options, images) {
	assertSupportedImageRoles(options.messages);
	for (const message of options.messages) if (images === void 0 && message.content.some((b) => b.type === "image" && b.offloaded !== true)) throw new LlmError("dsh-llm-oauth image content requires prepared request images", "UNSUPPORTED_CONTENT");
	const toolNames = /* @__PURE__ */ new Map();
	const messages = [];
	const leading = options.messages[0];
	const systemPrompt = options.system ?? (leading?.role === "system" ? flattenText(leading) || void 0 : void 0);
	const history = options.system === void 0 && leading?.role === "system" ? options.messages.slice(1) : options.messages;
	for (const message of history) {
		if (message.role === "tool") {
			const resultContent = userContent(message, images);
			messages.push({
				role: "toolResult",
				toolCallId: String(message.toolCallId),
				toolName: toolNames.get(String(message.toolCallId)) ?? "unknown",
				content: typeof resultContent === "string" ? [{
					type: "text",
					text: resultContent || "(no output)"
				}] : resultContent,
				isError: message.isError === true,
				timestamp: 0
			});
			continue;
		}
		if (message.role === "system") {
			messages.push({
				role: "user",
				content: flattenText(message),
				timestamp: 0
			});
			continue;
		}
		if (message.role === "assistant") {
			const assistant = toAssistant(message);
			for (const block of assistant.content) if (block.type === "toolCall") toolNames.set(block.id, block.name);
			messages.push(assistant);
			continue;
		}
		const content = userContent(message, images);
		if (content.length > 0) messages.push({
			role: "user",
			content,
			timestamp: 0
		});
	}
	const tools = options.tools?.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters
	}));
	return {
		...systemPrompt !== void 0 ? { systemPrompt } : {},
		messages,
		...tools !== void 0 && tools.length > 0 ? { tools } : {}
	};
}
//#endregion
//#region src/stream.ts
/**
* pi-ai assistant event → harness StreamChunk translation.
*/
const ids = llm;
const toolCallId = ids.ToolCallId ?? ids.CallId;
function finiteNumber(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function mapUsage(usage) {
	const input = finiteNumber(usage?.input, 0);
	const output = finiteNumber(usage?.output, 0);
	const cacheRead = finiteNumber(usage?.cacheRead, 0);
	const cacheWrite = finiteNumber(usage?.cacheWrite, 0);
	return {
		inputTokens: input,
		outputTokens: output,
		totalTokens: finiteNumber(usage?.totalTokens, input + output),
		...cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
		...cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}
	};
}
function mapStopReason(message) {
	switch (message.stopReason) {
		case "stop":
			if (message.content.length === 0) return {
				kind: "error",
				failure: {
					message: `model "${message.model}" returned a completed response with no content`,
					code: "EMPTY_RESPONSE"
				}
			};
			return { kind: "stop" };
		case "length": return { kind: "max-tokens" };
		case "toolUse": return { kind: "tool-calls" };
		case "pending":
		case "deferred": return {
			kind: "error",
			failure: {
				message: `Unsupported terminal pi-ai state: ${message.stopReason}`,
				code: "PI_AI_ERROR"
			}
		};
		case "aborted": return {
			kind: "aborted",
			failure: {
				message: message.errorMessage ?? "pi-ai stream aborted",
				code: "ABORTED"
			}
		};
		case "error": return {
			kind: "error",
			failure: {
				message: message.errorMessage ?? "pi-ai stream error",
				code: "PI_AI_ERROR"
			}
		};
		default: return {
			kind: "error",
			failure: {
				message: `Unknown terminal pi-ai state: ${String(message.stopReason)}`,
				code: "PI_AI_ERROR"
			}
		};
	}
}
/**
* Translate one pi-ai event stream into harness StreamChunks.
* @param events - one assistant turn's pi-ai event stream.
*/
async function* toStreamChunks(events) {
	const toolIds = /* @__PURE__ */ new Map();
	for await (const event of events) switch (event.type) {
		case "start": break;
		case "text_start":
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "text"
			};
			break;
		case "text_delta":
			yield {
				type: "text-delta",
				index: event.contentIndex,
				text: event.delta ?? ""
			};
			break;
		case "text_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "text",
					text: event.content ?? ""
				}
			};
			break;
		case "thinking_start":
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "reasoning"
			};
			break;
		case "thinking_delta":
			yield {
				type: "reasoning-delta",
				index: event.contentIndex,
				text: event.delta ?? ""
			};
			break;
		case "thinking_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "reasoning",
					text: event.content ?? ""
				}
			};
			break;
		case "toolcall_start": {
			const partial = event.partial.content[event.contentIndex];
			const id = partial?.type === "toolCall" ? partial.id : "";
			const name = partial?.type === "toolCall" ? partial.name : "";
			toolIds.set(event.contentIndex, {
				id,
				name
			});
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "tool-call"
			};
			break;
		}
		case "toolcall_delta": {
			const known = toolIds.get(event.contentIndex);
			yield {
				type: "tool-call-delta",
				index: event.contentIndex,
				id: toolCallId(known?.id ?? ""),
				...known?.name ? { name: known.name } : {},
				argumentsDelta: event.delta ?? ""
			};
			break;
		}
		case "toolcall_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "tool-call",
					id: toolCallId(event.toolCall.id ?? ""),
					name: event.toolCall.name ?? "",
					arguments: JSON.stringify(event.toolCall.arguments ?? {})
				}
			};
			break;
		case "done":
			yield {
				type: "usage",
				usage: mapUsage(event.message.usage)
			};
			yield {
				type: "finish",
				reason: mapStopReason(event.message),
				replayState: {
					response: {
						kind: "dsh-chatgpt-pi",
						...typeof event.message.api === "string" ? { api: event.message.api } : {},
						...typeof event.message.stopReason === "string" ? { stopReason: event.message.stopReason } : {}
					},
					blocks: event.message.content.map((block) => block.type === "thinking" ? {
						...typeof block.thinkingSignature === "string" ? { thinkingSignature: block.thinkingSignature } : {},
						...block.redacted === true ? { redacted: true } : {}
					} : block.type === "text" ? { ...typeof block.textSignature === "string" ? { textSignature: block.textSignature } : {} } : { ...typeof block.namespace === "string" ? { namespace: block.namespace } : {} })
				}
			};
			return;
		case "error":
			yield {
				type: "usage",
				usage: mapUsage(event.error.usage)
			};
			yield {
				type: "finish",
				reason: mapStopReason(event.error)
			};
			return;
	}
	throw new LlmError("pi-ai event stream ended without done/error", "STREAM_CLOSED");
}
//#endregion
//#region bin/device-id.mjs
/** Stable host identity, serialized without hard links (also works on Windows). */
async function getDeviceId(authPath) {
	const path = `${authPath}.device-id`;
	await mkdir(dirname(path), {
		recursive: true,
		mode: 448
	});
	const release = await lock(path, {
		realpath: false,
		retries: {
			retries: 80,
			minTimeout: 20,
			maxTimeout: 100
		}
	});
	try {
		try {
			const id = (await readFile(path, "utf8")).trim();
			if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid persisted ChatGPT host identity");
			return id;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		const id = randomUUID();
		const temp = `${path}.${randomUUID()}.tmp`;
		await writeFile(temp, id + "\n", {
			flag: "wx",
			mode: 384
		});
		await rename(temp, path);
		return id;
	} finally {
		await release();
	}
}
//#endregion
//#region src/secure-file.ts
let ownerSid;
async function protect(file) {
	if (process.platform !== "win32") {
		await chmod(file, 384);
		return;
	}
	ownerSid ??= execFileSync("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"
	], {
		encoding: "utf8",
		windowsHide: true
	}).trim();
	if (!/^S-1-[\d-]+$/.test(ownerSid)) throw new Error("Cannot identify credential owner");
	execFileSync("icacls.exe", [
		file,
		"/inheritance:r",
		"/grant:r",
		`*${ownerSid}:F`
	], {
		windowsHide: true,
		stdio: "pipe"
	});
}
async function readJson$1(file, empty) {
	try {
		const stat = await lstat(file);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4e6) throw new Error("Credential file must be a regular, single-link file");
		const value = JSON.parse(await readFile(file, "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid credential document");
		return value;
	} catch (error) {
		if (error.code === "ENOENT") return empty;
		throw new Error("Cannot read protected credential document", { cause: error });
	}
}
/** Replace a complete, flushed, owner-only file, without truncating the live record. */
async function writeJson(file, value) {
	await mkdir(dirname(file), {
		recursive: true,
		mode: 448
	});
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temporary, "wx", 384);
		try {
			await protect(temporary);
			await handle.writeFile(JSON.stringify(value) + "\n", "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, file);
	} finally {
		await unlink(temporary).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}
/** One lock for the whole document, including different providers and processes. */
async function withFileLock(file, operation) {
	await mkdir(dirname(file), {
		recursive: true,
		mode: 448
	});
	const release = await lock(file, {
		realpath: false,
		stale: 12e4,
		update: 2e4,
		retries: {
			retries: 160,
			minTimeout: 50,
			maxTimeout: 250,
			factor: 1.1,
			randomize: true
		}
	});
	try {
		return await operation();
	} finally {
		await release();
	}
}
//#endregion
//#region src/openai-models.ts
const allowed = /* @__PURE__ */ new Set([
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
]);
const FAST_SUFFIX = "@fast";
function decodeChatGPTEffort(value) {
	const fast = value.endsWith(FAST_SUFFIX);
	const effort = fast ? value.slice(0, -5) : value;
	return {
		effort: effort === "ultra" ? "max" : effort,
		fast
	};
}
function effortLabel(effort) {
	return {
		low: "Low",
		medium: "Medium",
		high: "High",
		xhigh: "Extra high",
		max: "Max",
		ultra: "Ultra",
		none: "Instant",
		minimal: "Minimal"
	}[effort] ?? effort;
}
function parseChatGPTModels(value) {
	const data = value;
	if (!Array.isArray(data?.models)) throw new Error("Unexpected ChatGPT model catalog");
	const models = /* @__PURE__ */ new Map();
	for (const model of data.models) {
		if (model.visibility !== "list" || typeof model.slug !== "string") continue;
		const efforts = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels.flatMap((level) => {
			const effort = level?.effort;
			return typeof effort === "string" && allowed.has(effort) ? [effort] : [];
		}) : void 0;
		if (efforts !== void 0 && efforts.length > 0 && !efforts.includes("none")) efforts.unshift("none");
		const tier = Array.isArray(model.service_tiers) ? model.service_tiers.find((tier) => tier?.id === "priority") : void 0;
		models.set(model.slug, {
			id: model.slug,
			name: typeof model.display_name === "string" ? model.display_name : model.slug,
			efforts: efforts ? [...new Set(efforts)] : void 0,
			defaultEffort: typeof model.default_reasoning_level === "string" && efforts?.includes(model.default_reasoning_level) ? model.default_reasoning_level : void 0,
			fast: tier !== void 0,
			fastDescription: typeof tier?.description === "string" ? tier.description : void 0
		});
	}
	return models;
}
//#endregion
//#region src/openai-chatgpt.ts
/** Personal local integration of the documented SIWC flow; never imports Codex OAuth. */
const OPENAI_RESOURCE = "https://api.openai.com/v1";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const ISSUER = "https://auth.openai.com";
const SCOPES = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
function text(value, field) {
	if (typeof value !== "string" || !value.trim()) throw new Error(`OpenAI response is missing ${field}`);
	return value;
}
function isDirectCredential(credential) {
	return credential?.type === "oauth" && credential.verified === true && typeof credential.subject === "string" && typeof credential.clientId === "string" && credential.clientId !== "dynamic_agent_client" && typeof credential.idToken === "string" && Array.isArray(credential.scopes) && credential.scopes.includes("chatgpt.tokens.use.direct");
}
async function verifyIdentity(token, clientId, nonce, expectedSubject, key) {
	const resolver = key ?? createRemoteJWKSet(new URL((await discovery()).jwks_uri));
	const { payload } = await jwtVerify(token, resolver, {
		issuer: ISSUER,
		audience: clientId,
		algorithms: ["RS256", "ES256"],
		requiredClaims: [
			"exp",
			"iat",
			"sub"
		],
		clockTolerance: 5
	});
	if (nonce !== void 0 && payload.nonce !== nonce) throw new Error("OpenAI ID token nonce mismatch");
	const subject = text(payload.sub, "verified subject");
	if (expectedSubject !== void 0 && expectedSubject !== subject) throw new Error("OpenAI returned a different account; saved registration was preserved");
	return {
		subject,
		...typeof payload.email === "string" ? { email: payload.email } : {}
	};
}
let metadata;
async function discovery() {
	metadata ??= (async () => {
		const response = await fetch(`${ISSUER}/.well-known/openid-configuration`, {
			redirect: "error",
			signal: AbortSignal.timeout(15e3)
		});
		if (!response.ok) throw new Error(`OpenAI discovery failed (${response.status})`);
		const data = await response.json();
		if (data.issuer !== ISSUER) throw new Error("Unexpected OpenAI issuer");
		const trusted = (value) => {
			const url = new URL(text(value, "discovery URL"));
			if (url.origin !== ISSUER || url.username || url.password) throw new Error("Untrusted OpenAI discovery URL");
			return url.href;
		};
		return {
			jwks_uri: trusted(data.jwks_uri),
			revocation_endpoint: trusted(data.revocation_endpoint)
		};
	})().catch((error) => {
		metadata = void 0;
		throw error;
	});
	return metadata;
}
async function tokenRequest(body, signal) {
	const response = await fetch(`${ISSUER}/api/accounts/oauth/token`, {
		method: "POST",
		redirect: "error",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body,
		signal
	});
	if (!response.ok) {
		let code = "";
		try {
			const data = await response.json();
			if (typeof data.error === "string" && /^[a-z_]+$/.test(data.error)) code = data.error;
		} catch {}
		throw new Error(`OpenAI token request failed (${response.status}${code ? `, ${code}` : ""})`);
	}
	return await response.json();
}
var ChatGPTAuth = class {
	authPath;
	store;
	registrationPath;
	visibleModels;
	catalogUntil = 0;
	constructor(authPath, store) {
		this.authPath = authPath;
		this.store = store;
		this.registrationPath = authPath + ".registration.json";
	}
	async registration() {
		return readJson$1(this.registrationPath, {});
	}
	async saveRegistration(registration) {
		await writeJson(this.registrationPath, registration);
	}
	async credential(data, clientId, nonce, previous) {
		const scopes = typeof data.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : previous?.scopes;
		if (!scopes?.includes("chatgpt.tokens.use.direct")) throw new Error("ChatGPT plan usage was not granted; no inference will be sent");
		const idToken = data.id_token === void 0 && previous ? previous.idToken : text(data.id_token, "ID token");
		const identity = data.id_token === void 0 && previous ? {
			subject: previous.subject,
			...previous.email ? { email: previous.email } : {}
		} : await verifyIdentity(idToken, clientId, nonce, previous?.subject ?? (await this.registration()).subject);
		if (typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error("Invalid OpenAI token expiry");
		return {
			type: "oauth",
			access: text(data.access_token, "access token"),
			refresh: text(data.refresh_token, "refresh token"),
			expires: Date.now() + data.expires_in * 1e3 - 6e4,
			clientId,
			idToken,
			scopes,
			verified: true,
			...identity
		};
	}
	async login(interaction) {
		const saved = await this.store.modify("openai", async () => withFileLock(this.authPath + ".session", async () => {
			const previous = await this.registration();
			const hostId = `urn:uuid:${await getDeviceId(this.authPath)}`;
			const signal = AbortSignal.any([...interaction.signal ? [interaction.signal] : [], AbortSignal.timeout(3e5)]);
			const state = randomBytes(32).toString("base64url");
			const nonce = randomBytes(32).toString("base64url");
			const verifier = randomBytes(32).toString("base64url");
			const challenge = createHash("sha256").update(verifier).digest("base64url");
			let redirectUri = "";
			let resolve;
			let reject;
			const callback = new Promise((ok, fail) => {
				resolve = ok;
				reject = fail;
			});
			const parseCallback = (url) => {
				if (url.origin !== new URL(redirectUri).origin || url.pathname !== "/auth/callback") throw new Error("Unexpected OpenAI callback location");
				if (url.searchParams.get("state") !== state) throw new Error("OpenAI OAuth state mismatch");
				if (url.searchParams.has("error")) throw new Error("ChatGPT authorization was declined or cancelled");
				const issued = url.searchParams.get("client_id") ?? previous.clientId;
				if (!issued || issued === "dynamic_agent_client") throw new Error("OpenAI did not issue a client registration");
				if (previous.clientId && previous.clientId !== issued) throw new Error("OpenAI callback changed the saved client registration");
				return {
					code: text(url.searchParams.get("code"), "authorization code"),
					clientId: issued
				};
			};
			const server = createServer((req, res) => {
				res.setHeader("cache-control", "no-store");
				res.setHeader("content-type", "text/plain; charset=utf-8");
				res.setHeader("content-security-policy", "default-src 'none'");
				try {
					const result = parseCallback(new URL(req.url ?? "/", redirectUri));
					res.writeHead(200).end("Authorization received. Return to DeepSeek Harness to check the result.");
					resolve(result);
				} catch (error) {
					res.writeHead(400).end("Invalid or cancelled authorization callback.");
					const url = new URL(req.url ?? "/", redirectUri);
					if (url.searchParams.get("state") === state && url.searchParams.has("error")) reject(error);
				}
			});
			const manualAbort = new AbortController();
			const aborted = () => reject(/* @__PURE__ */ new Error("ChatGPT sign-in cancelled or timed out"));
			try {
				await new Promise((ok, fail) => {
					server.once("error", fail);
					server.listen(0, "127.0.0.1", ok);
				});
				const address = server.address();
				if (!address || typeof address === "string") throw new Error("Cannot open OAuth callback listener");
				redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
				signal.addEventListener("abort", aborted, { once: true });
				signal.throwIfAborted();
				const url = new URL(`${ISSUER}/api/accounts/authorize`);
				url.search = new URLSearchParams({
					client_id: previous.clientId ?? "dynamic_agent_client",
					...previous.clientId ? {} : { agent_name_hint: "DeepSeek Harness ChatGPT" },
					ext_agent_host_id: hostId,
					response_type: "code",
					redirect_uri: redirectUri,
					resource: OPENAI_RESOURCE,
					scope: SCOPES,
					state,
					nonce,
					code_challenge_method: "S256",
					code_challenge: challenge
				}).toString();
				interaction.notify({
					type: "auth_url",
					url: url.href
				});
				const manual = interaction.prompt({
					type: "manual_code",
					message: "仅在自动回调失败时粘贴完整回调地址（不要发到聊天中）",
					placeholder: redirectUri,
					signal: AbortSignal.any([signal, manualAbort.signal])
				}).then((value) => parseCallback(new URL(value.trim())));
				const result = await Promise.race([callback, manual]);
				await this.saveRegistration({
					...previous,
					clientId: result.clientId
				});
				const data = await tokenRequest(new URLSearchParams({
					grant_type: "authorization_code",
					client_id: result.clientId,
					code: result.code,
					code_verifier: verifier,
					redirect_uri: redirectUri,
					resource: OPENAI_RESOURCE
				}), signal);
				const credential = await this.credential(data, result.clientId, nonce);
				await this.saveRegistration({
					clientId: result.clientId,
					subject: credential.subject,
					...credential.email ? { email: credential.email } : {}
				});
				this.visibleModels = void 0;
				this.catalogUntil = 0;
				return credential;
			} finally {
				manualAbort.abort();
				signal.removeEventListener("abort", aborted);
				server.closeAllConnections();
				server.close();
			}
		}));
		if (!isDirectCredential(saved)) throw new Error("ChatGPT login did not produce a verified credential");
		return saved;
	}
	async refresh(current, signal) {
		if (!isDirectCredential(current)) throw new Error("Reconnect using the new openai Sign in with ChatGPT flow");
		return withFileLock(this.authPath + ".session", async () => this.credential(await tokenRequest(new URLSearchParams({
			grant_type: "refresh_token",
			client_id: current.clientId,
			refresh_token: current.refresh,
			resource: OPENAI_RESOURCE
		}), signal), current.clientId, void 0, current));
	}
	async logout() {
		let remoteConfirmed = true;
		await this.store.modify("openai", async (current) => {
			if (isDirectCredential(current)) {
				remoteConfirmed = false;
				for (let attempt = 0; attempt < 2; attempt++) try {
					const endpoint = (await discovery()).revocation_endpoint;
					const response = await fetch(endpoint, {
						method: "POST",
						redirect: "error",
						signal: AbortSignal.timeout(1e4),
						headers: { "content-type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({
							token: current.refresh,
							token_type_hint: "refresh_token",
							client_id: current.clientId
						})
					});
					if (response.status === 200) {
						remoteConfirmed = true;
						break;
					}
					if (response.status < 500) break;
				} catch {}
			}
			return {
				type: "oauth",
				access: "",
				refresh: "",
				expires: 0
			};
		});
		await this.store.delete("openai");
		this.visibleModels = void 0;
		this.catalogUntil = 0;
		if (!remoteConfirmed) throw new Error("已退出本机，但无法确认服务器撤销。请到 ChatGPT 设置中断开此应用。");
	}
	provider(base) {
		const auth = this;
		return {
			...base,
			name: "OpenAI — Sign in with ChatGPT",
			auth: { oauth: {
				name: "Sign in with ChatGPT",
				isSubscription: true,
				loginLabel: "Continue with ChatGPT",
				login: (interaction) => auth.login(interaction),
				refresh: (credential, signal) => auth.refresh(credential, signal),
				async toAuth(credential) {
					if (!isDirectCredential(credential)) throw new Error("Verified ChatGPT plan authorization required; API key fallback is disabled");
					return { apiKey: credential.access };
				}
			} },
			getModels: () => {
				const local = new Map(base.getModels().map((model) => [model.id, model]));
				return [...auth.visibleModels?.values() ?? []].flatMap((account) => {
					const model = local.get(account.id);
					return model ? [{
						...model,
						name: account.name
					}] : [];
				});
			}
		};
	}
	modelInfo(id) {
		return this.visibleModels?.get(id);
	}
	invalidateCatalog() {
		this.catalogUntil = 0;
	}
	clearCatalog() {
		this.visibleModels = void 0;
		this.catalogUntil = 0;
	}
	async loadCatalog(getToken, signal) {
		if (this.visibleModels && this.catalogUntil > Date.now()) return;
		const token = await getToken();
		if (!token) {
			this.visibleModels = void 0;
			return;
		}
		const response = await fetch(`${OPENAI_RESOURCE}/models`, {
			redirect: "error",
			signal: signal ?? AbortSignal.timeout(15e3),
			headers: { authorization: `Bearer ${token}` }
		});
		if (!response.ok) throw new Error(`ChatGPT model discovery failed (${response.status}); no legacy route will be used`);
		this.visibleModels = parseChatGPTModels(await response.json());
		this.catalogUntil = Date.now() + 6e4;
	}
};
//#endregion
//#region src/openai-payload.ts
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const UNSUPPORTED = [
	"background",
	"conversation",
	"max_output_tokens",
	"max_tool_calls",
	"metadata",
	"moderation",
	"multi_agent",
	"prompt",
	"prompt_cache_retention",
	"prompt_cache_options",
	"safety_identifier",
	"temperature",
	"top_logprobs",
	"top_p",
	"truncation",
	"user",
	"previous_response_id"
];
function tools(items) {
	if (items === void 0) return void 0;
	if (!Array.isArray(items)) throw new Error("Invalid ChatGPT tool declaration");
	if (items.length === 0) return [];
	if (items.some((tool) => !record(tool) || !["function", "custom"].includes(String(tool.type)))) throw new Error("This ChatGPT connection supports only DSH local function/custom tools");
	return [{
		type: "namespace",
		name: "dsh",
		description: "Tools executed locally by DeepSeek Harness with its permissions.",
		tools: items
	}];
}
/** Enforce the documented direct route at the last boundary before serialization. */
function prepareChatGPTPayload(value, controls) {
	if (!record(value) || !Array.isArray(value.input)) throw new Error("ChatGPT Responses requires a complete input array");
	const payload = { ...value };
	for (const key of UNSUPPORTED) delete payload[key];
	payload.store = false;
	payload.stream = true;
	if (controls?.effort !== void 0) payload.reasoning = {
		...record(payload.reasoning) ? payload.reasoning : {},
		effort: controls.effort
	};
	if (controls?.fast) payload.service_tier = "priority";
	else delete payload.service_tier;
	payload.input = value.input.map((item) => {
		if (!record(item)) throw new Error("Invalid ChatGPT input item");
		if (String(item.type).startsWith("tool_search")) throw new Error("Responses tool_search is unavailable for this connection");
		if (item.type === "function_call" || item.type === "custom_tool_call") return {
			...item,
			namespace: "dsh"
		};
		if (item.type === "additional_tools") return {
			...item,
			tools: tools(item.tools)
		};
		return item.role === "system" ? {
			...item,
			role: "developer"
		} : item;
	});
	if (payload.tools !== void 0) payload.tools = tools(payload.tools);
	return payload;
}
const directResponsesFetch = async (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	const method = init?.method ?? (input instanceof Request ? input.method : "GET");
	if (url.href !== "https://api.openai.com/v1/responses" || method.toUpperCase() !== "POST") throw new Error("Blocked a request outside the official ChatGPT Responses route");
	return fetch(input, {
		...init,
		redirect: "error"
	});
};
//#endregion
//#region src/adapter.ts
/**
* OAuth-aware pi-ai LlmAdapter.
*
* Unlike first-party dsh-llm-pi-ai, Models is constructed with a CredentialStore
* so streamSimple can refresh subscription tokens under the store lock.
*
* The adapter always knows the full OAuth catalog (login/status/listModels for
* owned routes). Which routes are *registered* with `ctx.llm` is decided by
* the runtime from the enabled settings profiles — dormant providers stay off
* the model picker until the user turns them on.
*/
/** OAuth-backed multi-provider adapter. */
var OAuthPiAiAdapter = class extends LlmAdapter {
	options;
	providers;
	models;
	byId;
	chatGPT;
	constructor(options) {
		super();
		this.options = options;
		this.chatGPT = new ChatGPTAuth(options.authPath, options.store);
		this.providers = resolveOAuthProviders(options.catalog).map((provider) => provider.id === "openai" ? this.chatGPT.provider(provider) : provider);
		const mutable = createModels({ credentials: options.store });
		for (const provider of this.providers) mutable.setProvider(provider);
		this.models = mutable;
		this.byId = new Map(this.providers.map((provider) => [provider.id, provider]));
	}
	/** Full catalog route ids (settings directory), not only registered ones. */
	catalogIds() {
		return this.providers.map((provider) => provider.id);
	}
	/**
	* @deprecated Use {@link catalogIds}. Kept for older command helpers.
	* @returns full catalog route ids.
	*/
	routeIds() {
		return this.catalogIds();
	}
	/** Shared Models collection (login/logout/status). */
	modelsApi() {
		return this.models;
	}
	/** Durable auth file path. */
	authPath() {
		return this.options.authPath;
	}
	/** Catalog display name for a route id. */
	displayName(provider) {
		return this.byId.get(provider)?.name ?? provider;
	}
	providerInfo(provider) {
		const entry = this.byId.get(provider);
		if (entry === void 0) return {
			id: provider,
			name: provider
		};
		return {
			id: entry.id,
			name: entry.name
		};
	}
	listModels(provider) {
		return Promise.resolve().then(async () => {
			this.requireProvider(provider);
			if (provider === "openai") await this.loadChatGPTModels();
			return this.models.getModels(provider).map((model) => ({
				provider,
				id: model.id,
				name: model.name,
				inputModalities: [...model.input]
			}));
		});
	}
	resolveModel(provider, model, _signal) {
		return Promise.resolve().then(async () => {
			if (provider === "openai") await this.loadChatGPTModels(_signal);
			const resolved = this.requireModel(provider, model);
			const account = provider === "openai" ? this.chatGPT.modelInfo(model) : void 0;
			const levels = account?.efforts ?? getSupportedThinkingLevels(resolved);
			const reasoning = levels.length > 0 && !(levels.length === 1 && levels[0] === "off") ? {
				efforts: [...levels.map((level) => ({
					id: ReasoningEffortId(level),
					name: account ? effortLabel(level) : level
				})), ...account?.fast ? levels.map((level) => ({
					id: ReasoningEffortId(level + FAST_SUFFIX),
					name: `${effortLabel(level)} · ⚡ Fast`,
					description: account.fastDescription
				})) : []],
				...account ? { defaultEffort: ReasoningEffortId(account.defaultEffort ?? levels[0]) } : {}
			} : void 0;
			return {
				provider,
				id: model,
				name: resolved.name,
				inputModalities: [...resolved.input],
				context: { contextWindow: resolved.contextWindow },
				...reasoning === void 0 ? {} : { reasoning }
			};
		});
	}
	/**
	* Run an interactive OAuth login and persist the credential.
	* @param provider - catalog provider id.
	* @param interaction - prompt/notify callbacks.
	*/
	async login(provider, interaction) {
		this.requireProvider(provider);
		const credential = provider === "openai" ? await this.chatGPT.login(interaction) : await this.models.login(provider, "oauth", interaction);
		this.options.onAuthChanged?.();
		return credential;
	}
	/** Drop the stored credential for one provider. */
	async logout(provider) {
		this.requireProvider(provider);
		try {
			if (provider === "openai") await this.chatGPT.logout();
			else await this.models.logout(provider);
		} finally {
			this.options.onAuthChanged?.();
		}
	}
	/** Whether the provider currently has complete auth configuration. */
	async checkAuth(provider) {
		this.requireProvider(provider);
		if (provider === "openai" && !isDirectCredential(await this.options.store.read(provider))) return void 0;
		if (provider === "openai") {
			const credential = await this.options.store.read(provider);
			return {
				type: "oauth",
				source: isDirectCredential(credential) && credential.email ? `ChatGPT: ${credential.email}` : "ChatGPT"
			};
		}
		return this.models.checkAuth(provider);
	}
	async loadChatGPTModels(signal) {
		if (!isDirectCredential(await this.options.store.read("openai"))) {
			this.chatGPT.clearCatalog();
			return;
		}
		await this.chatGPT.loadCatalog(async () => (await this.models.getAuth("openai", signal ? { signal } : void 0))?.auth.apiKey, signal);
	}
	async refreshModels() {
		this.chatGPT.invalidateCatalog();
		if (this.byId.has("openai")) await this.loadChatGPTModels();
		this.options.onAuthChanged?.();
	}
	async *stream(options) {
		if (options.stop !== void 0) throw new LlmError("dsh-llm-oauth does not support GenerateOptions.stop", "UNSUPPORTED_OPTION");
		if (options.provider === "openai") {
			if (!isDirectCredential(await this.options.store.read("openai"))) throw new LlmError("请先通过新版 Sign in with ChatGPT 登录；API Key 回退已关闭", "MISSING_CREDENTIAL");
			await this.loadChatGPTModels(options.signal);
		}
		const model = this.requireModel(options.provider, options.model);
		const effort = options.reasoningEffort;
		const direct = options.provider === "openai";
		const requested = effort === void 0 ? void 0 : direct ? decodeChatGPTEffort(effort) : {
			effort: String(effort),
			fast: false
		};
		const account = direct ? this.chatGPT.modelInfo(model.id) : void 0;
		if (requested && account && (!(account.efforts ?? getSupportedThinkingLevels(model)).includes(requested.effort) || requested.fast && !account.fast)) throw new LlmError(`Model "${model.id}" does not support this reasoning/speed selection`, "UNSUPPORTED_REASONING_EFFORT");
		const reasoning = effort === void 0 ? void 0 : getSupportedThinkingLevels(model).find((level) => level === requested?.effort);
		if (effort !== void 0 && reasoning === void 0 && !(direct && account?.efforts?.includes(requested.effort))) throw new LlmError(`Model "${model.id}" does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
		if (await this.models.checkAuth(options.provider) === void 0) throw new LlmError(`dsh-llm-oauth: provider "${options.provider}" is not logged in; run \`/oauth login ${options.provider}\` or use Settings → OAuth / 订阅`, "MISSING_CREDENTIAL");
		const containsImage = options.messages.some((message) => message.content.some((block) => block.type === "image" && block.offloaded !== true));
		if (containsImage && !model.input.includes("image")) throw new LlmError(`Model "${model.id}" does not support image input`, "UNSUPPORTED_CONTENT");
		const attachments = containsImage ? this.options.resolveAttachments?.() : void 0;
		if (containsImage && attachments === void 0) throw new LlmError("dsh-llm-oauth image input requires the host attachment service", "UNSUPPORTED_CONTENT");
		const context = toPiContext(options, attachments === void 0 ? void 0 : await prepareRequestImages(options.messages, attachments, options.signal));
		yield* toStreamChunks(this.models.streamSimple(model, context, {
			maxRetries: 0,
			...reasoning === void 0 || reasoning === "off" ? {} : { reasoning },
			...options.temperature === void 0 ? {} : { temperature: options.temperature },
			...options.maxTokens === void 0 ? {} : { maxTokens: options.maxTokens },
			...options.sessionId === void 0 ? {} : { sessionId: String(options.sessionId) },
			...options.signal === void 0 ? {} : { signal: options.signal },
			headers: attributionHeaders(),
			...direct ? {
				onPayload: (value) => prepareChatGPTPayload(value, requested),
				fetch: directResponsesFetch
			} : {}
		}));
	}
	requireProvider(provider) {
		const entry = this.byId.get(provider);
		if (entry === void 0) throw new LlmError(`dsh-llm-oauth does not own provider "${provider}"`, "NO_ADAPTER");
		return entry;
	}
	requireModel(provider, model) {
		this.requireProvider(provider);
		const resolved = this.models.getModel(provider, model);
		if (resolved === void 0) throw new LlmError(`dsh-llm-oauth provider "${provider}" has no catalog model "${model}"`, "UNKNOWN_MODEL");
		return resolved;
	}
};
//#endregion
//#region src/command.ts
const watches = /* @__PURE__ */ new Map();
const sessions = /* @__PURE__ */ new Map();
/** Resolvers for prompts awaiting a pasted value, keyed by provider id. */
const pendingPrompts = /* @__PURE__ */ new Map();
/** Stop a provider's background login before removing its credentials. */
async function cancelLogin(provider) {
	const session = sessions.get(provider);
	const watch = watches.get(provider);
	session?.abort.abort(/* @__PURE__ */ new Error("OAuth login cancelled"));
	await session?.finished;
	if (watches.get(provider) === watch) watches.delete(provider);
}
/**
* Answer the prompt a background login is waiting on — the value pi-ai asks for
* when a browser callback cannot complete (Sign in with ChatGPT on a remote
* Web UI, or a busy :1455 callback port).
* @param provider - provider id whose login is waiting.
* @param value - pasted final redirect URL or authorization code.
* @returns whether a waiting prompt consumed the value.
*/
function submitLoginCode(provider, value) {
	const pending = pendingPrompts.get(provider);
	if (pending === void 0) return false;
	const trimmed = value.trim();
	if (trimmed.length === 0) return false;
	pendingPrompts.delete(provider);
	const watch = watches.get(provider);
	if (watch !== void 0) {
		delete watch.prompt;
		watch.lines.push("Submitted the pasted value; finishing the sign-in…");
	}
	pending.resolve(trimmed);
	return true;
}
/**
* Wait briefly for an in-flight login to settle after a manual code submission.
* @param provider - provider id whose login is running.
* @param timeoutMs - maximum wait before returning the current state.
*/
async function waitForLogin(provider, timeoutMs = 5e3) {
	const finished = sessions.get(provider)?.finished;
	if (finished === void 0) return;
	let timer;
	try {
		await Promise.race([finished, new Promise((resolve) => {
			timer = setTimeout(resolve, timeoutMs);
		})]);
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
}
/** Snapshot of background login watches (for tests and `/oauth status`). */
function listLoginWatches() {
	return [...watches.values()];
}
function usageText(authPath) {
	return [
		"Usage:",
		"  /oauth status",
		"  /oauth list",
		"  /oauth enable <provider>",
		"  /oauth disable <provider>",
		"  /oauth login <provider>",
		"  /oauth code <provider> <redirect-url-or-code>",
		"  /oauth logout <provider>",
		"",
		`Auth file: ${authPath}`,
		"",
		"Notes:",
		"  - Only enabled providers appear in the model picker.",
		"  - login auto-enables the provider when settings are available.",
		"  - GPT subscriptions: \"openai\" is Sign in with ChatGPT (pi-ai >= 1.0.0);",
		"    \"openai-codex\" is the legacy device-code flow for the Codex models.",
		"  - Grok is provider id \"xai\".",
		"  - Do not also configure the same provider id under llm-pi-ai (DUPLICATE_ADAPTER):",
		"    an id one adapter already owns is refused here with a clear error.",
		"  - Prefer Settings → OAuth / 订阅 for status + enable toggles."
	].join("\n");
}
function formatEvent(event) {
	switch (event.type) {
		case "auth_url": return [`Open this URL:\n${event.url ?? ""}`, ...event.instructions ? [event.instructions] : []];
		case "device_code": return [`Open this URL:\n${event.verificationUri ?? ""}`, `Enter code: ${event.userCode ?? ""}`];
		case "info":
		case "progress": return event.message ? [event.message] : [];
		default: return [];
	}
}
function isLoginNotice(type) {
	return type === "device_code" || type === "auth_url";
}
/**
* Choose a non-interactive answer for a select prompt.
* Prefer device-code / headless options when present (Web has no local
* OAuth callback port for browser login).
*/
function pickSelectOption(provider, options) {
	const byId = (id) => options.find((option) => option.id === id);
	if (provider === "openai-codex") {
		const device = byId("device_code");
		if (device !== void 0) return device;
	}
	const headless = options.find((option) => /device[_-]?code|headless|cli/i.test(`${option.id} ${option.label} ${option.description ?? ""}`));
	if (headless !== void 0) return headless;
	return options[0];
}
/**
* Answer a text prompt without a terminal when a blank / default is valid.
* github-copilot asks for Enterprise URL with blank = github.com.
*/
function answerOptionalTextPrompt(provider, prompt) {
	if (prompt.type !== "text") return void 0;
	const blob = `${prompt.message} ${prompt.placeholder ?? ""}`.toLowerCase();
	if (provider === "github-copilot" || /enterprise|blank for github\.com|github\.com/i.test(blob)) return "";
	if (/\bblank\b|\boptional\b|\bleave empty\b|\(empty\)/i.test(blob)) return "";
}
function resultExtras(watch) {
	return {
		...watch.openUrl === void 0 ? {} : { openUrl: watch.openUrl },
		...watch.userCode === void 0 ? {} : { userCode: watch.userCode }
	};
}
function waitingText(watch) {
	return [
		...watch.lines,
		"",
		`Finish signing in to ${watch.provider} in the browser.`,
		...watch.prompt === void 0 ? [] : [`If the browser callback cannot reach this machine, paste the value it asks for (${watch.prompt.message}) in Settings → OAuth / 订阅, or run:`, `  /oauth code ${watch.provider} <redirect-url-or-code>`],
		"This command has returned so the UI is not stuck; the login continues in the background.",
		"When you are done, run /oauth status or refresh Settings → OAuth / 订阅."
	].join("\n");
}
/**
* Start OAuth and return as soon as the user has something to open.
* The device-code poll is not bound to the command AbortSignal — the Web
* request ends when this handler returns, and aborting it would cancel login.
*/
async function startLogin(adapter, provider, signal) {
	if (signal?.aborted) return {
		kind: "error",
		text: "oauth login cancelled before the provider returned a URL"
	};
	const existing = watches.get(provider);
	if (existing?.status === "waiting") return {
		kind: "success",
		text: waitingText(existing),
		...resultExtras(existing)
	};
	const lines = [];
	const watch = {
		provider,
		status: "waiting",
		lines
	};
	watches.set(provider, watch);
	const session = {
		watch,
		abort: new AbortController()
	};
	sessions.set(provider, session);
	let released = false;
	let release;
	const firstNotice = new Promise((resolve, reject) => {
		release = (error) => {
			if (released) return;
			released = true;
			if (error === void 0) resolve();
			else reject(error);
		};
	});
	const onAbort = () => {
		const error = /* @__PURE__ */ new Error("oauth login cancelled before the provider returned a URL");
		session.abort.abort(error);
		release(error);
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	const interaction = {
		signal: session.abort.signal,
		prompt: async (prompt) => {
			const promptSignal = prompt.signal === void 0 ? session.abort.signal : AbortSignal.any([session.abort.signal, prompt.signal]);
			promptSignal.throwIfAborted();
			if (prompt.type === "select" && prompt.options !== void 0 && prompt.options.length > 0) {
				const preferred = pickSelectOption(provider, prompt.options);
				lines.push(`${prompt.message} → ${preferred.label} (${preferred.id})`);
				return preferred.id;
			}
			const optionalText = answerOptionalTextPrompt(provider, prompt);
			if (optionalText !== void 0) {
				lines.push(optionalText.length === 0 ? `${prompt.message} → (default / blank)` : `${prompt.message} → ${optionalText}`);
				return optionalText;
			}
			watch.prompt = {
				type: prompt.type,
				message: prompt.message,
				...prompt.placeholder === void 0 ? {} : { placeholder: prompt.placeholder }
			};
			lines.push(`${prompt.message}${prompt.placeholder === void 0 ? "" : ` (${prompt.placeholder})`}`);
			return await new Promise((resolve, reject) => {
				const cleanup = () => {
					promptSignal.removeEventListener("abort", onPromptAbort);
					if (pendingPrompts.get(provider) === pending) {
						pendingPrompts.delete(provider);
						delete watch.prompt;
					}
				};
				const onPromptAbort = () => {
					cleanup();
					reject(promptSignal.reason);
				};
				const pending = {
					watch,
					resolve: (value) => {
						cleanup();
						resolve(value);
					}
				};
				pendingPrompts.set(provider, pending);
				promptSignal.addEventListener("abort", onPromptAbort, { once: true });
				release();
			});
		},
		notify: (event) => {
			lines.push(...formatEvent(event));
			if (event.type === "auth_url" && event.url) watch.openUrl = event.url;
			if (event.type === "device_code") {
				if (event.verificationUri) watch.openUrl = event.verificationUri;
				if (event.userCode) watch.userCode = event.userCode;
			}
			if (isLoginNotice(event.type)) release();
		}
	};
	session.finished = Promise.resolve().then(() => adapter.login(provider, interaction)).then(() => {
		watch.status = "ok";
		watch.detail = `Logged in to ${provider}. Tokens stored in ${adapter.authPath()}.`;
		release();
	}, (error) => {
		watch.status = "error";
		watch.detail = error instanceof Error ? error.message : String(error);
		release(error instanceof Error ? error : new Error(watch.detail));
	}).finally(() => {
		if (pendingPrompts.get(provider)?.watch === watch) pendingPrompts.delete(provider);
		delete watch.prompt;
		if (sessions.get(provider) === session) sessions.delete(provider);
	});
	try {
		await firstNotice;
	} catch (error) {
		signal?.removeEventListener("abort", onAbort);
		return {
			kind: "error",
			text: [watch.detail ?? (error instanceof Error ? error.message : String(error)), ...lines].join("\n"),
			...resultExtras(watch)
		};
	}
	signal?.removeEventListener("abort", onAbort);
	if (watch.status === "ok") return {
		kind: "success",
		text: watch.detail ?? `Logged in to ${provider}.`,
		...resultExtras(watch)
	};
	return {
		kind: "success",
		text: waitingText(watch),
		...resultExtras(watch)
	};
}
/**
* Execute `/oauth` against the live adapter.
* @param adapter - registered OAuth adapter.
* @param rawInput - text after the command name.
* @param signal - UI request cancellation; only aborts waiting for the first URL.
*/
async function handleOauthCommand(adapter, rawInput, signal) {
	const parts = rawInput.trim().split(/\s+/).filter(Boolean);
	const action = (parts[0] ?? "status").toLowerCase();
	const target = parts[1];
	const catalog = typeof adapter.catalogIds === "function" ? adapter.catalogIds() : adapter.routeIds();
	if (action === "help" || action === "-h" || action === "--help") return {
		kind: "success",
		text: usageText(adapter.authPath())
	};
	if (action === "list") {
		const rows = ["OAuth catalog owned by this plugin:"];
		for (const id of catalog) {
			const auth = await adapter.checkAuth(id);
			rows.push(`  ${id.padEnd(20)} ${auth === void 0 ? "not logged in" : `${auth.type}${auth.source ? ` (${auth.source})` : ""}`}`);
		}
		rows.push("", "Enable a provider with `/oauth enable <id>` or Settings → OAuth / 订阅.");
		return {
			kind: "success",
			text: rows.join("\n")
		};
	}
	if (action === "code") {
		if (target === void 0) return {
			kind: "error",
			text: "Usage: /oauth code <provider> <redirect-url-or-code>"
		};
		const value = parts.slice(2).join(" ");
		if (value.length === 0) return {
			kind: "error",
			text: "Usage: /oauth code <provider> <redirect-url-or-code>"
		};
		if (!submitLoginCode(target, value)) return {
			kind: "error",
			text: `${target} is not waiting for a pasted value. Start /oauth login ${target} first.`
		};
		return {
			kind: "success",
			text: `Submitted the value for ${target}; the sign-in continues in the background. Run /oauth status or refresh Settings → OAuth / 订阅.`
		};
	}
	if (action === "status") {
		const rows = [`Auth file: ${adapter.authPath()}`, ""];
		for (const id of catalog) {
			const auth = await adapter.checkAuth(id);
			const watch = watches.get(id);
			const login = auth === void 0 ? "not logged in" : `ok (${auth.type}${auth.source ? `, ${auth.source}` : ""})`;
			const extra = watch === void 0 ? "" : watch.status === "waiting" ? " — browser login in progress" : watch.status === "error" ? ` — last login error: ${watch.detail ?? "failed"}` : " — last login finished";
			rows.push(`${id}: ${login}${extra}`);
		}
		rows.push("", "Tip: only enabled providers list models. Use /oauth enable <id> or the Settings panel.");
		return {
			kind: "success",
			text: rows.join("\n")
		};
	}
	if (action === "logout") {
		if (target === void 0) return {
			kind: "error",
			text: "Usage: /oauth logout <provider>"
		};
		try {
			await cancelLogin(target);
			await adapter.logout(target);
			return {
				kind: "success",
				text: `Logged out ${target}.`
			};
		} catch (error) {
			return {
				kind: "error",
				text: error instanceof Error ? error.message : String(error)
			};
		}
	}
	if (action === "login") {
		if (target === void 0) return {
			kind: "error",
			text: "Usage: /oauth login <provider>"
		};
		return startLogin(adapter, target, signal);
	}
	if (action === "enable" || action === "disable") return {
		kind: "error",
		text: `/${action} is handled by the plugin runtime. If you see this, settings may be unavailable.\n\n${usageText(adapter.authPath())}`
	};
	return {
		kind: "error",
		text: `Unknown action "${action}".\n\n${usageText(adapter.authPath())}`
	};
}
/** Environment override for the Harness home. */
const DSH_HOME_ENV = "DSH_HOME";
/**
* Expand `~` / `~/` prefixes.
* @param path - configured path that may begin with a tilde.
*/
function expandHomePath(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}
/**
* Resolve the Harness home.
* Precedence: explicit path, `$DSH_HOME`, then `~/.dsh`.
* @param configured - explicit override.
* @param env - environment mapping.
*/
function resolveDshHome(configured, env = process.env) {
	const fromEnv = env[DSH_HOME_ENV];
	const selected = configured ?? (fromEnv !== void 0 && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), ".dsh"));
	return resolve(expandHomePath(selected));
}
/**
* Default path of the durable OAuth credential file.
* @param configuredHome - optional explicit Harness home.
*/
function defaultAuthPath(configuredHome) {
	return join(resolveDshHome(configuredHome), "openai-chatgpt-local", "credentials.json");
}
//#endregion
//#region src/codex-launcher.ts
const exec = promisify(execFile);
const CHATGPT_WEB = "https://chatgpt.com/";
async function powershell(script, env) {
	const program = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const { stdout } = await exec(program, [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		script
	], {
		windowsHide: true,
		timeout: 15e3,
		maxBuffer: 16384,
		env: {
			...process.env,
			...env
		}
	});
	return stdout.trim();
}
const FIND_CODEX = `
$ErrorActionPreference = 'Stop'
$app = Get-StartApps | Where-Object { $_.AppID -like 'OpenAI.Codex*!*' -or $_.Name -eq 'Codex' } | Select-Object -First 1
if ($app -and $app.AppID -match '^[A-Za-z0-9._-]+![A-Za-z0-9._-]+$') {
  @{kind='package';value=$app.AppID} | ConvertTo-Json -Compress
  exit 0
}
$candidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\\OpenAI\\Codex\\Codex.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\\Codex\\Codex.exe'),
  (Join-Path $env:LOCALAPPDATA 'OpenAI\\Codex\\Codex.exe')
)
foreach ($candidate in $candidates) {
  if (Test-Path -LiteralPath $candidate -PathType Leaf) {
    @{kind='exe';value=$candidate} | ConvertTo-Json -Compress
    exit 0
  }
}
'null'
`;
async function findInstalledCodex() {
	if (process.platform !== "win32") return void 0;
	const result = JSON.parse(await powershell(FIND_CODEX));
	if (typeof result !== "object" || result === null) return void 0;
	const target = result;
	if (target.kind !== "package" && target.kind !== "exe" || typeof target.value !== "string") return void 0;
	return target;
}
const defaultLauncher = {
	findDesktop: findInstalledCodex,
	async openDesktop(target) {
		await powershell(`
$ErrorActionPreference = 'Stop'
if ($env:DSH_CODEX_KIND -eq 'package') {
  Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList ('shell:AppsFolder\\' + $env:DSH_CODEX_TARGET) -WindowStyle Hidden | Out-Null
} else {
  Start-Process -FilePath $env:DSH_CODEX_TARGET -WindowStyle Normal | Out-Null
}
`, {
			DSH_CODEX_KIND: target.kind,
			DSH_CODEX_TARGET: target.value
		});
	},
	async openWeb() {
		if (process.platform === "win32") await powershell("$ErrorActionPreference = 'Stop'; Start-Process -FilePath 'https://chatgpt.com/' -WindowStyle Normal | Out-Null");
		else await exec(process.platform === "darwin" ? "open" : "xdg-open", [CHATGPT_WEB], { timeout: 1e4 });
	}
};
async function launchCodex(launcher = defaultLauncher) {
	const target = await launcher.findDesktop().catch(() => void 0);
	if (target !== void 0) try {
		await launcher.openDesktop(target);
		return { target: "desktop" };
	} catch {}
	await launcher.openWeb();
	return { target: "web" };
}
//#endregion
//#region src/http.ts
const API_PREFIX = "/dsh-llm-oauth";
/** JSON helper. */
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(payload);
}
/** Read a small JSON object body. */
async function readJson(req) {
	const chunks = [];
	for await (const chunk of req) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		if (chunks.reduce((sum, part) => sum + part.length, 0) > 64e3) throw new Error("request body too large");
	}
	if (chunks.length === 0) return {};
	const raw = Buffer.concat(chunks).toString("utf8").trim();
	if (raw.length === 0) return {};
	const parsed = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("JSON body must be an object");
	return parsed;
}
function providerOf(body, url) {
	const fromQuery = url.searchParams.get("provider");
	if (fromQuery !== null && fromQuery.length > 0) return fromQuery;
	const value = body.provider;
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
/**
* Handle one request under `/dsh-llm-oauth`.
* @param controller - OAuth control plane.
* @param req - incoming request.
* @param res - server response.
*/
async function handleOauthHttp(controller, req, res, services = {}) {
	const method = (req.method ?? "GET").toUpperCase();
	const host = req.headers.host ?? "127.0.0.1";
	const url = new URL(req.url ?? "/", `http://${host}`);
	const path = url.pathname.replace(/\/+$/, "") || "/";
	const origin = req.headers.origin;
	if (![
		"127.0.0.1",
		"localhost",
		"[::1]"
	].includes(url.hostname) || origin !== void 0 && origin !== url.origin) {
		sendJson(res, 403, { error: "This local sign-in interface requires a same-origin loopback connection" });
		return;
	}
	if (method === "POST" && req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
		sendJson(res, 415, { error: "JSON content type required" });
		return;
	}
	try {
		if (path === `${API_PREFIX}/launch-codex`) {
			if (method !== "POST") {
				sendJson(res, 405, { error: "POST required" });
				return;
			}
			if (services.authorize?.(req) !== true) {
				sendJson(res, 403, { error: "Authenticated desktop connection required" });
				return;
			}
			await readJson(req);
			sendJson(res, 200, await (services.launchCodex ?? launchCodex)());
			return;
		}
		if (method === "POST" && path === `${API_PREFIX}/refresh`) {
			await controller.refreshModels();
			sendJson(res, 200, await controller.status());
			return;
		}
		if (method === "GET" && (path === API_PREFIX || path === `${API_PREFIX}/status`)) {
			sendJson(res, 200, await controller.status());
			return;
		}
		if (method === "POST" && path === `${API_PREFIX}/enable`) {
			const provider = providerOf(await readJson(req), url);
			if (provider === void 0) {
				sendJson(res, 400, { error: "missing provider" });
				return;
			}
			await controller.enable(provider);
			sendJson(res, 200, await controller.status());
			return;
		}
		if (method === "POST" && path === `${API_PREFIX}/disable`) {
			const provider = providerOf(await readJson(req), url);
			if (provider === void 0) {
				sendJson(res, 400, { error: "missing provider" });
				return;
			}
			await controller.disable(provider);
			sendJson(res, 200, await controller.status());
			return;
		}
		if (method === "POST" && path === `${API_PREFIX}/code`) {
			const body = await readJson(req);
			const provider = providerOf(body, url);
			const value = typeof body.code === "string" ? body.code : typeof body.value === "string" ? body.value : void 0;
			if (provider === void 0 || value === void 0 || value.trim().length === 0) {
				sendJson(res, 400, { error: "missing provider or code" });
				return;
			}
			controller.submitCode(provider, value);
			await waitForLogin(provider);
			const status = await controller.status();
			const stillWaiting = status.providers.some((row) => row.id === provider && row.loginStatus === "waiting");
			sendJson(res, 200, {
				...status,
				...stillWaiting ? { command: {
					kind: "success",
					text: `Submitted the value for ${provider}; the sign-in continues in the background.`
				} } : {}
			});
			return;
		}
		if (method === "POST" && path === `${API_PREFIX}/logout`) {
			const provider = providerOf(await readJson(req), url);
			if (provider === void 0) {
				sendJson(res, 400, { error: "missing provider" });
				return;
			}
			await controller.logout(provider);
			sendJson(res, 200, await controller.status());
			return;
		}
		if (method === "POST" && path === `${API_PREFIX}/login`) {
			const provider = providerOf(await readJson(req), url);
			if (provider === void 0) {
				sendJson(res, 400, { error: "missing provider" });
				return;
			}
			await controller.enable(provider);
			const result = await handleOauthCommand(controller.getAdapter(), `login ${provider}`);
			const status = await controller.status();
			sendJson(res, result.kind === "error" ? 400 : 200, {
				...status,
				command: result
			});
			return;
		}
		sendJson(res, 404, { error: `unknown route ${path}` });
	} catch (error) {
		sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
	}
}
/** Exact path registered on webServer. */
const OAUTH_HTTP_PREFIX = API_PREFIX;
//#endregion
//#region src/service.ts
/**
* Control plane for OAuth providers.
* @param adapter - live OAuth adapter (full catalog).
* @param hooks - enable/disable integration with the runtime.
*/
var OAuthController = class {
	adapter;
	hooks;
	constructor(adapter, hooks) {
		this.adapter = adapter;
		this.hooks = hooks;
	}
	/** Catalog ids the adapter owns. */
	catalog() {
		return this.adapter.catalogIds();
	}
	/** Currently enabled route ids. */
	enabled() {
		return [...this.hooks.listEnabled()];
	}
	/**
	* Build a status snapshot for UIs.
	* @returns auth path, catalog, enabled set, and per-provider rows.
	*/
	async status() {
		const catalog = this.adapter.catalogIds();
		const enabled = new Set(this.hooks.listEnabled());
		const watches = new Map(listLoginWatches().map((watch) => [watch.provider, watch]));
		const providers = [];
		for (const id of catalog) {
			const auth = await this.adapter.checkAuth(id);
			const watch = watches.get(id);
			providers.push(statusRow(id, this.adapter.displayName(id), enabled.has(id), auth, watch));
		}
		return {
			authPath: this.adapter.authPath(),
			catalog,
			enabled: [...enabled].sort((a, b) => a.localeCompare(b)),
			providers
		};
	}
	async refreshModels() {
		await this.adapter.refreshModels();
	}
	/**
	* Enable a catalog provider (show its models once logged in).
	* @param provider - catalog id.
	*/
	async enable(provider) {
		this.requireCatalog(provider);
		await this.hooks.enable(provider);
	}
	/**
	* Disable a catalog provider (hide its models; credentials are kept).
	* @param provider - catalog id.
	*/
	async disable(provider) {
		this.requireCatalog(provider);
		await this.hooks.disable(provider);
	}
	/**
	* Drop stored credentials. Does not change the enabled flag.
	* @param provider - catalog id.
	*/
	async logout(provider) {
		this.requireCatalog(provider);
		await cancelLogin(provider);
		await this.adapter.logout(provider);
	}
	/**
	* Answer the value a running login waits for (pi-ai `manual_code`: the final
	* redirect URL / authorization code a callback flow could not deliver).
	* @param provider - catalog id.
	* @param value - pasted redirect URL or code.
	* @throws when no login of that provider is waiting for a value.
	*/
	submitCode(provider, value) {
		this.requireCatalog(provider);
		if (!submitLoginCode(provider, value)) throw new Error(`dsh-llm-oauth: ${provider} is not waiting for a pasted value; start the sign-in first`);
	}
	/** Underlying adapter (login helper / commands). */
	getAdapter() {
		return this.adapter;
	}
	requireCatalog(provider) {
		if (!this.adapter.catalogIds().includes(provider)) throw new Error(`dsh-llm-oauth: unknown catalog provider "${provider}"`);
	}
};
function statusRow(id, name, enabled, auth, watch) {
	return {
		id,
		name: name || catalogDisplayName(id),
		enabled,
		loggedIn: auth !== void 0,
		...auth === void 0 ? {} : {
			authType: auth.type,
			...auth.source === void 0 ? {} : { authSource: auth.source }
		},
		...watch === void 0 ? {} : {
			loginStatus: watch.status,
			...watch.detail === void 0 ? {} : { loginDetail: watch.detail },
			...watch.prompt === void 0 ? {} : { loginPrompt: watch.prompt }
		}
	};
}
//#endregion
//#region src/store.ts
var FileCredentialStore = class {
	path;
	pending = Promise.resolve();
	constructor(path = defaultAuthPath()) {
		this.path = path;
	}
	enqueue(task) {
		const next = this.pending.catch(() => void 0).then(task);
		this.pending = next.catch(() => void 0);
		return next;
	}
	async read(providerId) {
		return (await readJson$1(this.path, {}))[providerId];
	}
	async list() {
		return Object.entries(await readJson$1(this.path, {})).map(([providerId, credential]) => ({
			providerId,
			type: credential.type
		}));
	}
	modify(providerId, fn) {
		return this.enqueue(() => withFileLock(this.path, async () => {
			const file = await readJson$1(this.path, {});
			const next = await fn(file[providerId]);
			if (next === void 0) return file[providerId];
			file[providerId] = next;
			await writeJson(this.path, file);
			return next;
		}));
	}
	delete(providerId) {
		return this.enqueue(() => withFileLock(this.path, async () => {
			const file = await readJson$1(this.path, {});
			delete file[providerId];
			await writeJson(this.path, file);
		}));
	}
};
//#endregion
//#region src/runtime.ts
const NS = SETTINGS_NS;
/**
* Apply the plugin to its Cordis context.
* @param ctx - scoped plugin context; registrations are effects.
* @param config - configuration resolved by Cordis from the exported schema.
*/
function apply(ctx, config) {
	const entry = resolveConfig(readConfig(config));
	resolveOAuthProviders(entry.catalog);
	const authPath = entry.authPath ?? defaultAuthPath();
	const adapter = new OAuthPiAiAdapter({
		authPath,
		store: new FileCredentialStore(authPath),
		catalog: entry.catalog,
		resolveAttachments: () => ctx.get("attachments"),
		onAuthChanged: () => {
			if (registration !== void 0) registration.replace(registeredRoutes);
		}
	});
	let registration;
	let registeredRoutes = [];
	let directory;
	let directoryFacts;
	/**
	* The live configuration. `config.providers` is a volatile reference, so
	* every operation reads the value the Loader committed last — a settings
	* write reaches the adapter without a remount.
	*/
	const snapshot = () => resolveConfig(readConfig(config));
	const catalogIds = () => snapshot().catalog;
	const enabledIds = () => {
		const allowed = new Set(catalogIds());
		return enabledProviderIds(snapshot()).filter((id) => allowed.has(id));
	};
	/**
	* Models settings rows for providers the user turned on. Dormant catalog
	* entries stay off this directory (and off the model picker) until enabled
	* via Settings → OAuth / 订阅 or `/oauth enable|login`.
	*/
	const directoryEntries = () => {
		const profiles = snapshot().providers;
		return enabledIds().map((provider) => {
			return {
				provider,
				displayName: profiles[provider]?.displayName?.trim() || catalogDisplayName(provider) || provider,
				settingsNs: SETTINGS_NS,
				settingsPath: ["providers", provider]
			};
		});
	};
	const ensureDirectory = () => {
		const entries = directoryEntries();
		if (deepEqualJson(entries, directoryFacts)) return;
		if (directory === void 0) {
			if (entries.length === 0) {
				directoryFacts = entries;
				return;
			}
			directory = ctx.llm.registerConfigurableProviders(entries);
		} else directory.replace(entries);
		directoryFacts = entries;
	};
	const ensureRoutes = () => {
		const routes = enabledIds();
		if (deepEqualJson(routes, registeredRoutes)) return;
		if (registration === void 0) {
			if (routes.length === 0) {
				registeredRoutes = routes;
				return;
			}
			registration = ctx.llm.registerAdapter(routes, adapter);
		} else registration.replace(routes);
		registeredRoutes = routes;
	};
	const refresh = () => {
		try {
			ensureRoutes();
		} catch (error) {
			ctx.logger.error("llm-oauth: keeping previous adapter routes after a refused update");
			ctx.logger.error(error);
		}
		try {
			ensureDirectory();
		} catch (error) {
			ctx.logger.error("llm-oauth: keeping previous configurable-provider directory after a refused update");
			ctx.logger.error(error);
		}
	};
	/**
	* Refuse a configuration that cannot be served: every enabled id must be a
	* catalog id, and every catalog id must be an OAuth-capable pi-ai provider.
	*/
	const assertServiceable = (value) => {
		resolveOAuthProviders(value.catalog);
		const allowed = new Set(value.catalog);
		for (const id of Object.keys(value.providers)) {
			if (!allowed.has(id)) throw new Error(`dsh-llm-oauth: enabled provider "${id}" is not in catalog [${value.catalog.join(", ")}]`);
			resolveOAuthProviders([id]);
			assertRouteFree(id);
		}
	};
	/**
	* One route id belongs to one adapter. `openai` (Sign in with ChatGPT) is also
	* the first-party llm-pi-ai API-key route, so enabling it while such a profile
	* exists must fail loudly here instead of letting DUPLICATE_ADAPTER leave the
	* model picker empty.
	*/
	const assertRouteFree = (provider) => {
		if (registeredRoutes.includes(provider)) return;
		if (ctx.llm.listProviders().map((info) => info.id).includes(provider)) throw new Error(`dsh-llm-oauth: provider route "${provider}" is already registered by another plugin (an llm-pi-ai API-key profile?). Remove that profile first, or keep the API key and use a different id from this catalog.`);
	};
	assertServiceable(entry);
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber));
	});
	ctx.on("internal/config", function(_raw, next) {
		const raw = next();
		if (this !== ctx.fiber) return raw;
		assertServiceable(resolveConfig(readConfig(raw)));
		return raw;
	});
	ctx.on("loader/volatile-update", () => {
		refresh();
	});
	refresh();
	const controller = new OAuthController(adapter, {
		listEnabled: () => enabledIds(),
		enable: async (provider) => {
			const settings = ctx.get("settings");
			if (settings === void 0) throw new Error("dsh-llm-oauth: settings service is unavailable; add the provider under llm-oauth.providers in settings.yaml");
			assertServiceable({
				...snapshot(),
				providers: {
					...snapshot().providers,
					[provider]: {}
				}
			});
			await settings.mutate(NS, [{
				op: "set",
				path: ["providers", provider],
				value: {}
			}]);
			refresh();
		},
		disable: async (provider) => {
			const settings = ctx.get("settings");
			if (settings === void 0) throw new Error("dsh-llm-oauth: settings service is unavailable; remove the provider under llm-oauth.providers in settings.yaml");
			await settings.mutate(NS, [{
				op: "unset",
				path: ["providers", provider]
			}]);
			refresh();
		}
	});
	const commands = ctx.get("commands");
	if (commands !== void 0) commands.register({
		name: "oauth",
		description: "OAuth / subscription providers: status, enable, login, logout",
		input: { hint: "[status|list|enable <provider>|disable <provider>|login <provider>|logout <provider>]" },
		handler: async (invocation) => {
			const parts = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
			const action = (parts[0] ?? "status").toLowerCase();
			const target = parts[1];
			if (action === "enable") {
				if (target === void 0) return {
					kind: "error",
					text: "Usage: /oauth enable <provider>"
				};
				try {
					await controller.enable(target);
					return {
						kind: "success",
						text: `Enabled ${target}. Its models appear in the picker; run /oauth login ${target} if you are not signed in.`
					};
				} catch (error) {
					return {
						kind: "error",
						text: error instanceof Error ? error.message : String(error)
					};
				}
			}
			if (action === "disable") {
				if (target === void 0) return {
					kind: "error",
					text: "Usage: /oauth disable <provider>"
				};
				try {
					await controller.disable(target);
					return {
						kind: "success",
						text: `Disabled ${target}. Stored credentials (if any) were kept.`
					};
				} catch (error) {
					return {
						kind: "error",
						text: error instanceof Error ? error.message : String(error)
					};
				}
			}
			if (action === "login" && target !== void 0) try {
				await controller.enable(target);
			} catch (error) {
				ctx.logger.warn(`[llm-oauth] could not auto-enable ${target} before login: ${String(error)}`);
			}
			return handleOauthCommand(adapter, invocation.rawInput, invocation.signal);
		}
	});
	ctx.inject(["webServer"], (httpCtx) => {
		httpCtx.effect(() => httpCtx.webServer.register({
			kind: "prefix",
			path: OAUTH_HTTP_PREFIX,
			handler: (req, res) => {
				handleOauthHttp(controller, req, res, { authorize: (request) => {
					const connection = httpCtx.get("connection");
					return typeof connection?.requestRejection === "function" && connection.requestRejection(request) === void 0;
				} });
			}
		}), "llm-oauth: http api");
	});
	ctx.logger.info(`[llm-oauth] catalog=[${adapter.catalogIds().join(", ")}] enabled=[${enabledIds().join(", ") || "(none)"}] auth=${authPath}`);
}
//#endregion
//#region src/index.ts
/**
* Standalone OAuth LLM plugin for DeepSeek Harness.
*
* Install with `dsh plugin --profile <name> add github:<user>/dsh-llm-oauth`.
* Do not add a default export: Cordis Loader unwraps `exports.default ?? exports`.
*
* @module dsh-llm-oauth
*/
/** Cordis plugin name; keep this stable after publishing. */
const name = "llm-oauth";
/**
* Services that must exist before the plugin is applied.
* `settings` is optional at runtime: the live policy attaches through ctx.inject,
* and `/oauth` / the HTTP API report their own error when it is absent.
*/
const inject = ["llm"];
//#endregion
export { Config, DEFAULT_PROVIDERS, FileCredentialStore, OAuthController, OAuthPiAiAdapter, SETTINGS_NS, apply, catalogDisplayName, defaultAuthPath, enabledProviderIds, inject, name, oauthCatalogProviders, readConfig, resolveConfig, resolveOAuthProviders };
