import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolveAckReaction } from "openclaw/plugin-sdk/channel-feedback";
import { buildNapCatMediaCq, redactNapCatMediaForLog } from "./media.js";
import { loadMediaProxyResource, MediaProxyError, mediaProxyTokensMatch } from "./mediaProxy.js";
import { formatNapCatOutgoingText } from "./plainText.js";
import { resolveNapCatEmojiId, shouldSendNapCatAckReaction } from "./reactions.js";
import {
    beginNapCatGroupReplyContext,
    endNapCatGroupReplyContext,
    getNapCatRuntime,
    getNapCatConfig,
} from "./runtime.js";

// Group name cache removed


function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNapCatStreamingModeEnabled(config: any): boolean {
    return config?.streaming_mode === true;
}

function isNapCatProgressMessagesEnabled(config: any): boolean {
    return config?.enable_progress_messages === true;
}

export function resolveOpenClawRuntimeConfig(runtime: any): any {
    const current = runtime?.config?.current;
    if (typeof current === "function") {
        return current.call(runtime.config) || {};
    }

    const legacyLoadConfig = runtime?.config?.loadConfig;
    if (typeof legacyLoadConfig === "function") {
        return legacyLoadConfig.call(runtime.config) || {};
    }

    throw new Error("NapCat plugin: OpenClaw runtime config snapshot API is unavailable");
}

export async function resolveNapCatInboundRoute(
    runtime: any,
    cfg: any,
    configuredAgentId: string,
    peer: { kind: "direct" | "group"; id: string },
): Promise<{ route: any; effectiveAgentId: string; sessionKey: string }> {
    const normalizedConfiguredAgentId = String(configuredAgentId || "").trim().toLowerCase();
    const route = await runtime.channel.routing.resolveAgentRoute({
        cfg,
        channel: "napcat",
        defaultAgentId: normalizedConfiguredAgentId || undefined,
        accountId: "default",
        peer,
    });

    const routeAgentId = String(route?.agentId || "").trim().toLowerCase();
    const effectiveAgentId = routeAgentId || normalizedConfiguredAgentId || "main";
    const sessionKey = String(route?.sessionKey || "").trim();
    if (!sessionKey) {
        throw new Error("NapCat plugin: OpenClaw route did not provide a session key");
    }

    return { route, effectiveAgentId, sessionKey };
}

// Throttle assistant commentary (progress) messages so long multi-tool tasks
// do not flood QQ. Final (non-commentary) payloads are never throttled.
const COMMENTARY_MIN_INTERVAL_MS = 3000;
const commentaryLastSentAt = new Map<string, number>();

function shouldDeliverCommentaryPayload(conversationId: string): boolean {
    const now = Date.now();
    const last = commentaryLastSentAt.get(conversationId) || 0;
    if (now - last < COMMENTARY_MIN_INTERVAL_MS) return false;
    commentaryLastSentAt.set(conversationId, now);
    if (commentaryLastSentAt.size > 100) {
        for (const [key, ts] of commentaryLastSentAt) {
            if (now - ts > 10 * 60 * 1000) commentaryLastSentAt.delete(key);
        }
    }
    return true;
}

function isNapCatPrivateTypingEnabled(config: any): boolean {
    return config?.enablePrivateTypingStatus !== false;
}

async function setNapCatPrivateTypingStatus(userId: string, token?: string): Promise<void> {
    const config = getNapCatConfig();
    const baseUrl = config.url || "http://127.0.0.1:15150";
    await sendToNapCat(`${baseUrl}/set_input_status`, {
        user_id: userId,
        event_type: 1,
    }, token);
}

function createPrivateTypingStatusController(options: {
    enabled: boolean;
    userId: string;
    token?: string;
    intervalMs?: number;
}) {
    const intervalMs = Math.max(1000, options.intervalMs ?? 4000);
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    let inFlight = false;

    const ping = async () => {
        if (!options.enabled || stopped || inFlight) return;
        inFlight = true;
        try {
            await setNapCatPrivateTypingStatus(options.userId, options.token);
        } catch (err) {
            console.error(`[NapCat] Failed to update private typing status for ${options.userId}:`, err);
        } finally {
            inFlight = false;
        }
    };

    return {
        start: async () => {
            if (!options.enabled || stopped) return;
            await ping();
            if (!stopped && !timer) {
                timer = setInterval(() => {
                    void ping();
                }, intervalMs);
            }
        },
        stop: () => {
            stopped = true;
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        }
    };
}

const napcatHttpAgent = new HttpAgent({
    keepAlive: true,
    keepAliveMsecs: 10000,
    maxSockets: 20,
    maxFreeSockets: 10,
});

const napcatHttpsAgent = new HttpsAgent({
    keepAlive: true,
    keepAliveMsecs: 10000,
    maxSockets: 20,
    maxFreeSockets: 10,
});

function isRetryableNapCatError(err: any): boolean {
    const code = String(err?.cause?.code || err?.code || "");
    return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "ECONNABORTED"].includes(code);
}

function isNapCatFailedResponse(result: any): boolean {
    return result?.status === "failed" ||
        Number(result?.retcode || 0) !== 0 ||
        result?.data?.status === "failed" ||
        Number(result?.data?.retcode || 0) !== 0;
}

async function postJsonWithNodeHttp(
    url: string,
    payload: any,
    timeoutMs: number,
    opts?: { connectionClose?: boolean; token?: string }
): Promise<{ statusCode: number; statusText: string; bodyText: string }> {
    const target = new URL(url);
    const isHttps = target.protocol === "https:";
    const body = JSON.stringify(payload);
    const transport = isHttps ? httpsRequest : httpRequest;
    const connectionClose = opts?.connectionClose === true;
    const normalizedToken = String(opts?.token ?? "").trim();
    const agent = connectionClose ? undefined : (isHttps ? napcatHttpsAgent : napcatHttpAgent);

    return new Promise((resolve, reject) => {
        const headers: Record<string, string | number> = {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            "Connection": connectionClose ? "close" : "keep-alive",
        };
        if (normalizedToken) {
            headers["Authorization"] = `Bearer ${normalizedToken}`;
        }
        const req = transport(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || (isHttps ? 443 : 80),
                path: `${target.pathname}${target.search}`,
                method: "POST",
                agent,
                headers,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
                res.on("end", () => {
                    const bodyText = Buffer.concat(chunks).toString("utf8");
                    resolve({
                        statusCode: res.statusCode || 0,
                        statusText: res.statusMessage || "",
                        bodyText,
                    });
                });
            }
        );

        req.setTimeout(timeoutMs, () => {
            req.destroy(Object.assign(new Error(`NapCat request timeout after ${timeoutMs}ms`), { code: "ETIMEDOUT" }));
        });

        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

type SendToNapCatOptions = {
    /**
     * Retries are safe for reads and idempotent actions, but must be disabled
     * for message sends: NapCat may have accepted the message even when the
     * HTTP response is lost, and retrying would send the same message again.
     */
    allowRetry?: boolean;
};

// Call the NapCat API using node http/https. Transient retries are opt-out so
// existing read/idempotent callers retain their previous behavior.
export async function sendToNapCat(
    url: string,
    payload: any,
    token?: string,
    options: SendToNapCatOptions = {}
) {
    const maxAttempts = options.allowRetry === false ? 1 : 3;
    const timeoutsMs = [5000, 7000, 9000];
    const cfg = getNapCatConfig();
    const connectionClose = cfg.connectionClose !== false; // default true for local docker stability
    const target = new URL(url);
    const targetInfo = `${target.protocol}//${target.hostname}:${target.port || (target.protocol === "https:" ? "443" : "80")}${target.pathname}`;

    let lastErr: any = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const startedAt = Date.now();
        try {
            const timeoutMs = timeoutsMs[Math.min(attempt - 1, timeoutsMs.length - 1)];
            const res = await postJsonWithNodeHttp(url, payload, timeoutMs, { connectionClose, token });

            if (res.statusCode < 200 || res.statusCode >= 300) {
                throw new Error(`NapCat API Error: ${res.statusCode} ${res.statusText}${res.bodyText ? ` | ${res.bodyText.slice(0, 300)}` : ""}`);
            }

            const elapsedMs = Date.now() - startedAt;
            console.log(`[NapCat] sendToNapCat success attempt ${attempt}/${maxAttempts} ${targetInfo} in ${elapsedMs}ms (connection=${connectionClose ? "close" : "keep-alive"})`);

            if (!res.bodyText) return { status: "ok" };
            let parsed: any;
            try {
                parsed = JSON.parse(res.bodyText);
            } catch {
                return { status: "ok", raw: res.bodyText };
            }
            if (isNapCatFailedResponse(parsed)) {
                throw new Error(`NapCat API returned failure: ${res.bodyText.slice(0, 300)}`);
            }
            return parsed;
        } catch (err: any) {
            lastErr = err;
            const retryable = isRetryableNapCatError(err);
            const elapsedMs = Date.now() - startedAt;
            if (!retryable || attempt >= maxAttempts) {
                console.error(`[NapCat] sendToNapCat failed attempt ${attempt}/${maxAttempts} ${targetInfo} in ${elapsedMs}ms: ${err?.cause?.code || err?.code || err}`);
                break;
            }
            const backoffMs = attempt * 400;
            console.warn(`[NapCat] sendToNapCat retry ${attempt}/${maxAttempts} ${targetInfo} in ${elapsedMs}ms; backoff ${backoffMs}ms; reason=${err?.cause?.code || err?.code || err}`);
            await sleep(backoffMs);
        }
    }

    throw lastErr;
}

export async function buildNapCatMessageFromReply(
    payload: { text?: string; mediaUrl?: string; mediaUrls?: string[]; audioAsVoice?: boolean },
    config: any,
    mentionUserId?: string
) {
    const text = formatNapCatOutgoingText(payload.text?.trim() || "", config);
    const mediaCandidates = [
        ...(payload.mediaUrls || []),
        ...(payload.mediaUrl ? [payload.mediaUrl] : [])
    ];
    const mediaSegments = await Promise.all(
        mediaCandidates
            .map((url) => String(url || "").trim())
            .filter(Boolean)
            .map((url) => buildNapCatMediaCq(url, config, payload.audioAsVoice === true))
    );

    let message = "";
    if (text && mediaSegments.length > 0) message = `${text}\n${mediaSegments.join("\n")}`;
    else if (text) message = text;
    else message = mediaSegments.join("\n");

    if (!message) return "";

    const normalizedMentionUserId = String(mentionUserId || "").trim();
    if (/^\d+$/.test(normalizedMentionUserId)) {
        return `[CQ:at,qq=${normalizedMentionUserId}] ${message}`;
    }
    return message;
}

export async function handleMediaProxyRequest(
    res: ServerResponse,
    url: string,
    config: any = getNapCatConfig(),
): Promise<boolean> {
    if (config.mediaProxyEnabled !== true) {
        res.statusCode = 404;
        res.end("not found");
        return true;
    }

    const parsed = new URL(url, "http://127.0.0.1");
    if (parsed.pathname !== "/napcat/media") {
        res.statusCode = 404;
        res.end("not found");
        return true;
    }

    const expectedToken = String(config.mediaProxyToken || "").trim();
    const token = String(parsed.searchParams.get("token") || "").trim();
    if (!expectedToken) {
        res.statusCode = 503;
        res.end("media proxy is not configured");
        return true;
    }
    if (!mediaProxyTokensMatch(expectedToken, token)) {
        res.statusCode = 403;
        res.end("forbidden");
        return true;
    }

    const mediaUrl = String(parsed.searchParams.get("url") || "").trim();
    if (!mediaUrl) {
        res.statusCode = 400;
        res.end("missing url");
        return true;
    }

    try {
        const resource = await loadMediaProxyResource(mediaUrl, config);
        res.statusCode = 200;
        res.setHeader("Content-Type", resource.contentType);
        res.setHeader("Content-Length", resource.buffer.length);
        res.setHeader("Content-Disposition", "attachment");
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.end(resource.buffer);
        return true;
    } catch (err: any) {
        const statusCode = err instanceof MediaProxyError ? err.statusCode : 500;
        const code = err instanceof MediaProxyError ? err.code : "INTERNAL_ERROR";
        console.error(`[NapCat] Media proxy request failed: ${code}`);
        res.statusCode = statusCode;
        res.end("media proxy error");
        return true;
    }
}

export async function handleNapCatMediaProxy(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = new URL(req.url || "", "http://127.0.0.1").pathname;
    if (pathname !== "/napcat/media") return false;
    console.log(`[NapCat] Incoming request: ${req.method || "UNKNOWN"} ${pathname}`);
    if (req.method !== "GET") {
        res.statusCode = 405;
        res.end("method not allowed");
        return true;
    }
    return handleMediaProxyRequest(res, req.url || "");
}

async function readBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", chunk => data += chunk);
        req.on("end", () => {
            try {
                if (!data) {
                    resolve({});
                    return;
                }
                resolve(JSON.parse(data));
            } catch (e) {
                console.error("NapCat JSON Parse Error:", e);
                // Some deployments send form-urlencoded bodies with nested JSON payload.
                try {
                    const params = new URLSearchParams(data);
                    const wrapped = params.get("payload") || params.get("data") || params.get("message");
                    if (wrapped) {
                        resolve(JSON.parse(wrapped));
                        return;
                    }
                } catch {
                    // Fall through and preserve raw body for diagnostics.
                }
                resolve({ __raw: data, __parseError: true });
            }
        });
        req.on("error", reject);
    });
}

function sanitizeLogToken(raw: string): string {
    return String(raw || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function extractNapCatMessageSegments(input: any): any[] {
    if (Array.isArray(input)) {
        return input.filter((item) => item && typeof item === "object");
    }
    if (input && typeof input === "object" && typeof input.type === "string") {
        return [input];
    }
    if (typeof input === "string") {
        return [{ type: "text", data: { text: input } }];
    }
    return [];
}

function extractForwardEntries(input: any): any[] {
    if (!input) return [];
    if (Array.isArray(input)) {
        return input.filter((item) => item && typeof item === "object");
    }
    if (typeof input !== "object") return [];

    const candidates = [
        input.messages,
        input.message,
        input.content,
        input.data?.messages,
        input.data?.message,
        input.data?.content,
    ];

    for (const candidate of candidates) {
        if (Array.isArray(candidate)) {
            return candidate.filter((item) => item && typeof item === "object");
        }
    }
    return [];
}

function formatInlineSegmentLabel(prefix: string, value?: string): string {
    const normalizedValue = String(value || "").trim();
    return normalizedValue ? `[${prefix}:${normalizedValue}]` : `[${prefix}]`;
}

function normalizeRenderedMessageText(text: string): string {
    return text
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

async function fetchNapCatForwardEntries(
    forwardId: string,
    config: any,
    cache: Map<string, any[] | null>
): Promise<any[] | null> {
    const normalizedId = String(forwardId || "").trim();
    if (!normalizedId) return null;
    if (cache.has(normalizedId)) {
        return cache.get(normalizedId) ?? null;
    }

    const baseUrl = String(config.url || "http://127.0.0.1:15150").trim().replace(/\/+$/, "");
    const token = String(config.token || "").trim();

    try {
        const result = await sendToNapCat(`${baseUrl}/get_forward_msg`, { message_id: normalizedId }, token);
        const entries = extractForwardEntries(result?.data ?? result);
        cache.set(normalizedId, entries.length > 0 ? entries : null);
        return cache.get(normalizedId) ?? null;
    } catch (err) {
        console.error(`[NapCat] Failed to fetch forward message ${normalizedId}:`, err);
        cache.set(normalizedId, null);
        return null;
    }
}

async function renderNapCatSegmentsToText(
    segments: any[],
    config: any,
    cache: Map<string, any[] | null>,
    depth = 0
): Promise<string> {
    if (!Array.isArray(segments) || segments.length === 0) return "";
    if (depth > 3) return "[合并转发嵌套过深]";

    let output = "";
    for (const segment of segments) {
        output += await renderNapCatSegmentToText(segment, config, cache, depth);
    }
    return normalizeRenderedMessageText(output);
}

async function renderNapCatForwardNode(
    node: any,
    config: any,
    cache: Map<string, any[] | null>,
    depth: number
): Promise<string> {
    const rawNode = node?.data && typeof node.data === "object" ? node.data : node;
    const senderName = String(
        rawNode?.nickname ||
        rawNode?.name ||
        rawNode?.sender?.nickname ||
        rawNode?.user_name ||
        rawNode?.user_id ||
        "未知发送者"
    ).trim();

    let contentText = "";
    const contentSegments = extractNapCatMessageSegments(
        rawNode?.content ?? rawNode?.message ?? rawNode?.messages
    );
    if (contentSegments.length > 0) {
        contentText = await renderNapCatSegmentsToText(contentSegments, config, cache, depth + 1);
    } else if (typeof rawNode?.content === "string") {
        contentText = normalizeRenderedMessageText(rawNode.content);
    } else if (typeof rawNode?.message === "string") {
        contentText = normalizeRenderedMessageText(rawNode.message);
    } else if (typeof rawNode?.raw_message === "string") {
        contentText = normalizeRenderedMessageText(rawNode.raw_message);
    }

    return `${senderName}: ${contentText || "[空消息]"}`;
}

async function renderNapCatForwardEntries(
    entries: any[],
    config: any,
    cache: Map<string, any[] | null>,
    depth: number
): Promise<string> {
    if (!Array.isArray(entries) || entries.length === 0) {
        return "[合并转发]\n[未能读取转发内容]";
    }

    const lines: string[] = ["[合并转发]"];
    for (const entry of entries) {
        lines.push(await renderNapCatForwardNode(entry, config, cache, depth + 1));
    }
    return lines.join("\n");
}

async function renderNapCatSegmentToText(
    segment: any,
    config: any,
    cache: Map<string, any[] | null>,
    depth: number
): Promise<string> {
    const type = String(segment?.type || "").trim().toLowerCase();
    const data = segment?.data && typeof segment.data === "object" ? segment.data : {};

    switch (type) {
        case "text":
            return String(data.text || "");
        case "at":
            return data.qq === "all" ? "@全体成员" : `@${String(data.qq || "").trim()}`;
        case "face":
            return formatInlineSegmentLabel("表情", String(data.summary || data.id || "").trim());
        case "image":
        case "mface":
            return formatInlineSegmentLabel("图片", String(data.summary || data.name || "").trim());
        case "record":
            return formatInlineSegmentLabel("语音", String(data.name || "").trim());
        case "video":
            return formatInlineSegmentLabel("视频", String(data.name || "").trim());
        case "file":
            return formatInlineSegmentLabel("文件", String(data.name || data.file || "").trim());
        case "reply":
            return formatInlineSegmentLabel("回复", String(data.id || "").trim());
        case "json":
            return "[JSON消息]";
        case "markdown":
            return String(data.content || data.markdown || "[Markdown消息]");
        case "contact":
            return formatInlineSegmentLabel("名片", String(data.id || data.type || "").trim());
        case "location":
            return formatInlineSegmentLabel("位置", String(data.title || data.address || "").trim());
        case "music":
            return formatInlineSegmentLabel("音乐", String(data.title || data.id || data.type || "").trim());
        case "share":
            return formatInlineSegmentLabel("分享", String(data.title || data.url || "").trim());
        case "lightapp":
            return "[小程序卡片]";
        case "forward": {
            const inlineEntries = extractForwardEntries(data);
            const forwardId = String(data.id || "").trim();
            const entries = inlineEntries.length > 0
                ? inlineEntries
                : await fetchNapCatForwardEntries(forwardId, config, cache);
            if (!entries || entries.length === 0) {
                return forwardId ? `[合并转发:${forwardId}]` : "[合并转发]";
            }
            return `\n${await renderNapCatForwardEntries(entries, config, cache, depth)}\n`;
        }
        default:
            return type ? `[${type}]` : "";
    }
}

async function buildInboundMessageText(event: any, config: any): Promise<string> {
    const segments = extractNapCatMessageSegments(event?.message);
    if (segments.length === 0) {
        return normalizeRenderedMessageText(String(event?.raw_message || ""));
    }

    const cache = new Map<string, any[] | null>();
    const rendered = await renderNapCatSegmentsToText(segments, config, cache);
    return rendered || normalizeRenderedMessageText(String(event?.raw_message || ""));
}

function getInboundLogFilePath(body: any, config: any): string {
    const isGroup = body?.message_type === "group";
    const baseDirRaw = String(config.inboundLogDir || "./logs/napcat-inbound").trim() || "./logs/napcat-inbound";
    const baseDir = resolve(baseDirRaw);
    if (isGroup) {
        const groupId = sanitizeLogToken(String(body?.group_id || "unknown_group"));
        return resolve(baseDir, `group-${groupId}.log`);
    }
    const userId = sanitizeLogToken(String(body?.user_id || "unknown_user"));
    return resolve(baseDir, `qq-${userId}.log`);
}

async function logInboundMessage(body: any, config: any): Promise<void> {
    if (config.enableInboundLogging === false) return;
    if (body?.post_type !== "message" && body?.post_type !== "message_sent") return;

    const filePath = getInboundLogFilePath(body, config);
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        post_type: body.post_type,
        message_type: body.message_type,
        self_id: body.self_id,
        user_id: body.user_id,
        group_id: body.group_id,
        message_id: body.message_id,
        raw_message: body.raw_message || "",
        sender: body.sender || {},
    }) + "\n";

    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, line, "utf8");
}

async function logInboundParseFailure(rawBody: string, config: any): Promise<void> {
    if (config.enableInboundLogging === false) return;
    const baseDirRaw = String(config.inboundLogDir || "./logs/napcat-inbound").trim() || "./logs/napcat-inbound";
    const filePath = resolve(baseDirRaw, "parse-error.log");
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        kind: "parse_error",
        raw_body: rawBody,
    }) + "\n";
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, line, "utf8");
}

function extractNapCatEvents(body: any): any[] {
    if (!body || typeof body !== "object") return [];
    if (Array.isArray(body)) return body.filter((item) => item && typeof item === "object");
    if (body.post_type) return [body];
    if (Array.isArray(body.events)) return body.events.filter((item: any) => item && typeof item === "object");
    if (Array.isArray(body.data)) return body.data.filter((item: any) => item && typeof item === "object");
    if (body.data && typeof body.data === "object") return [body.data];
    if (body.payload && typeof body.payload === "object") return [body.payload];
    return [];
}

export async function handleNapCatWebhook(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = req.url || "";
    const method = req.method || "UNKNOWN";
    const pathname = new URL(url, "http://127.0.0.1").pathname;
    if (pathname !== "/napcat") return false;
    console.log(`[NapCat] Incoming request: ${method} ${pathname}`);
    
    if (method !== "POST") {
        // For non-POST requests to /napcat endpoints, return 405
        res.statusCode = 405;
        res.setHeader("Content-Type", "application/json");
        res.end('{"status":"error","message":"Method Not Allowed"}');
        return true;
    }

    try {
        const body = await readBody(req);
        const config = getNapCatConfig();

        // Note: Token verification for incoming requests from NapCat is not implemented
        // because NapCat's HTTP client does not support custom Authorization headers.
        // The token is only used when OpenClaw sends messages TO NapCat.

        const events = extractNapCatEvents(body);

        try {
            if (body?.__parseError && typeof body.__raw === "string" && body.__raw.trim()) {
                await logInboundParseFailure(body.__raw, config);
            }
            for (const event of events) {
                await logInboundMessage(event, config);
            }
        } catch (err) {
            console.error("[NapCat] Failed to write inbound log:", err);
        }

        const event = events[0] || body;

        // Heartbeat / Lifecycle
        if (event.post_type === "meta_event") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end('{"status":"ok"}');
            return true;
        }

        if (event.post_type === "message") {
            const runtime = getNapCatRuntime();
            const isGroup = event.message_type === "group";
            const groupId = isGroup ? String(event.group_id || "") : "";
            // Ensure senderId is numeric string
            const senderId = String(event.user_id);
            const botId = String(event.self_id || config.selfId || "").trim();
            // Safety check: if senderId looks like a name (non-numeric), log warning
            if (!/^\d+$/.test(senderId)) {
                console.warn(`[NapCat] WARNING: user_id is not numeric: ${senderId}`);
            }
            const rawText = event.raw_message || "";
            let text = await buildInboundMessageText(event, config);

            // Get allowUsers from config
            const allowUsers = config.allowUsers || [];
            const isAllowUser = allowUsers.includes(senderId);

            // Check allowlist logic
            // If allowUsers is configured, only listed users should trigger the bot.
            // This applies to both DMs and Group chats.
            if (allowUsers.length > 0 && !isAllowUser) {
                console.log(`[NapCat] Ignoring message from ${senderId} (not in allowlist)`);
                res.statusCode = 200;
                res.setHeader("Content-Type", "application/json");
                res.end('{"status":"ok"}');
                return true;
            }

            // Group message handling
            const enableGroupMessages = config.enableGroupMessages || false;
            const groupMentionOnly = config.groupMentionOnly !== false; // Default true
            const groupWhitelist = Array.isArray(config.groupWhitelist)
                ? config.groupWhitelist.map((id: any) => String(id).trim()).filter(Boolean)
                : [];
            let wasMentioned = !isGroup; // In DMs, we consider it "mentioned"

            if (isGroup) {
                if (!enableGroupMessages) {
                    // Group messages disabled - ignore
                    console.log(`[NapCat] Ignoring group message (group messages disabled)`);
                    res.statusCode = 200;
                    res.setHeader("Content-Type", "application/json");
                    res.end('{"status":"ok"}');
                    return true;
                }

                if (groupWhitelist.length > 0 && !groupWhitelist.includes(groupId)) {
                    console.log(`[NapCat] Ignoring group message from ${groupId} (not in group whitelist)`);
                    res.statusCode = 200;
                    res.setHeader("Content-Type", "application/json");
                    res.end('{"status":"ok"}');
                    return true;
                }

                if (groupMentionOnly) {
                    // Check if bot was mentioned
                    // NapCat sends self_id as the bot's QQ number
                    if (!botId) {
                        console.log(`[NapCat] Cannot determine bot ID, ignoring group message`);
                        res.statusCode = 200;
                        res.setHeader("Content-Type", "application/json");
                        res.end('{"status":"ok"}');
                        return true;
                    }

                    // Check for bot mention in raw_message
                    // Support two formats:
                    // 1. CQ code format: [CQ:at,qq={botId}] or [CQ:at,qq=all]
                    // 2. Plain text format: @Nickname (botId) or @botId
                    const mentionPatternCQ = new RegExp(`\\[CQ:at,qq=${botId}\\]`, 'i');
                    const allMentionPatternCQ = /\[CQ:at,qq=all\]/i;
                    
                    // Plain text mention patterns: @xxx (123456) or @123456
                    const mentionPatternPlain1 = new RegExp(`@[^\\s]+ \\(${botId}\\)`, 'i');
                    const mentionPatternPlain2 = new RegExp(`@${botId}(?:\\s|$|,)`, 'i');

                    const mentionSource = rawText || text;
                    const isMentionedCQ = mentionPatternCQ.test(mentionSource) || allMentionPatternCQ.test(mentionSource);
                    const isMentionedPlain = mentionPatternPlain1.test(text) || mentionPatternPlain2.test(text);

                    if (!isMentionedCQ && !isMentionedPlain) {
                        console.log(`[NapCat] Ignoring group message (bot not mentioned)`);
                        res.statusCode = 200;
                        res.setHeader("Content-Type", "application/json");
                        res.end('{"status":"ok"}');
                        return true;
                    }

                    wasMentioned = true;
                    console.log(`[NapCat] Bot mentioned in group, processing message`);
                } else {
                    // Check for mention anyway to update wasMentioned
                    if (botId) {
                        const mentionPatternCQ = new RegExp(`\\[CQ:at,qq=${botId}\\]`, 'i');
                        const allMentionPatternCQ = /\[CQ:at,qq=all\]/i;
                        const mentionPatternPlain1 = new RegExp(`@[^\\s]+ \\(${botId}\\)`, 'i');
                        const mentionPatternPlain2 = new RegExp(`@${botId}(?:\\s|$|,)`, 'i');
                        const mentionSource = rawText || text;
                        wasMentioned = mentionPatternCQ.test(mentionSource) || allMentionPatternCQ.test(mentionSource) || 
                                       mentionPatternPlain1.test(text) || mentionPatternPlain2.test(text);
                    }
                }

                // Strip mentions from text for cleaner processing and command detection
                if (botId) {
                    const stripCQ = new RegExp(`^\\[CQ:at,qq=${botId}\\]\\s*`, 'i');
                    const stripAll = /^\[CQ:at,qq=all\]\s*/i;
                    const stripAllPlain = /^@全体成员\s*/i;
                    const stripPlain1 = new RegExp(`^@[^\\s]+ \\(${botId}\\)\\s*`, 'i');
                    const stripPlain2 = new RegExp(`^@${botId}(?:\\s|$|,)\\s*`, 'i');
                    text = text
                        .replace(stripCQ, '')
                        .replace(stripAll, '')
                        .replace(stripAllPlain, '')
                        .replace(stripPlain1, '')
                        .replace(stripPlain2, '')
                        .trim();
                }
            }

            const messageId = String(event.message_id);
            // OpenClaw convention: conversationId differentiates chats
            // We prefix with type to help outbound routing
            const conversationId = isGroup ? `group:${event.group_id}` : `private:${senderId}`;
            const senderName = event.sender?.nickname || senderId;

            const cfg = resolveOpenClawRuntimeConfig(runtime);
            const peer: { kind: "direct" | "group"; id: string } = isGroup
                ? { kind: "group", id: String(event.group_id) }
                : { kind: "direct", id: senderId };
            const configuredAgentId = String(config.agentId || "").trim().toLowerCase();

            // Let OpenClaw own agent selection and canonical session-key construction.
            // A configured NapCat agent is the default owner; explicit OpenClaw bindings
            // remain authoritative and can select a different agent or session scope.
            const { route, effectiveAgentId, sessionKey } = await resolveNapCatInboundRoute(
                runtime,
                cfg,
                configuredAgentId,
                peer,
            );

            if (!route?.agentId) {
                console.log("[NapCat] No route found for message, ignoring");
                res.statusCode = 200;
                res.setHeader("Content-Type", "application/json");
                res.end('{"status":"ok"}');
                return true;
            }

            const routeAgentId = String(route.agentId || "").trim().toLowerCase();
            const ackReaction = resolveAckReaction(cfg, effectiveAgentId, {
                channel: "napcat",
                accountId: route.accountId,
            });
            const shouldSendAckReaction = Boolean(
                ackReaction &&
                shouldSendNapCatAckReaction({
                    scope: cfg.messages?.ackReactionScope,
                    isGroup,
                    requireMention: isGroup && groupMentionOnly,
                    wasMentioned,
                })
            );
            let ackEmojiId: string | null = null;
            if (shouldSendAckReaction) {
                try {
                    ackEmojiId = resolveNapCatEmojiId(ackReaction);
                } catch (err) {
                    console.warn(`[NapCat] Skipping unsupported ack reaction ${JSON.stringify(ackReaction)}:`, err);
                }
            }
            const ackReactionPromise = ackEmojiId
                ? sendToNapCat(`${config.url || "http://127.0.0.1:15150"}/set_msg_emoji_like`, {
                    message_id: messageId,
                    emoji_id: ackEmojiId,
                    set: true,
                }, String(config.token || "").trim(), { allowRetry: false }).then(
                    () => true,
                    (err) => {
                        console.warn(`[NapCat] Failed to add ack reaction to message ${messageId}:`, err);
                        return false;
                    }
                )
                : null;

            // User requested to use session key as display name for consistency
            const sessionDisplayName = sessionKey;
            const bodyForAgent = botId ? `[NapCat context: bot QQ=${botId}]\n${text}` : text;

            // Log for debugging
            console.log(`[NapCat] Inbound from ${senderId} (session: ${sessionKey}): ${text.substring(0, 50)}...`);
            if (configuredAgentId && configuredAgentId !== routeAgentId) {
                console.log(`[NapCat] OpenClaw binding routed configured agent ${configuredAgentId} to ${routeAgentId || "none"}`);
            }

            // Build ctxPayload using runtime methods
            const ctxPayload = {
                Body: text,
                BodyForAgent: bodyForAgent,
                RawBody: rawText,
                CommandBody: text,
                From: `napcat:${conversationId}`,
                To: "me",
                SessionKey: sessionKey,  // Use our custom session key
                SessionDisplayName: sessionDisplayName,
                displayName: sessionDisplayName,
                name: sessionDisplayName,
                Title: sessionDisplayName,
                ConversationTitle: sessionDisplayName,
                Topic: sessionDisplayName,
                Subject: sessionDisplayName,
                AccountId: route.accountId,
                ChatType: isGroup ? "group" : "direct",
                ConversationLabel: sessionKey,
                SenderName: senderName,
                SenderId: senderId,
                SelfId: botId,
                BotId: botId,
                BotQQ: botId,
                NapCatSelfId: botId,
                Provider: "napcat",
                Surface: "napcat",
                MessageSid: messageId,
                WasMentioned: wasMentioned,
                CommandAuthorized: true,
                OriginatingChannel: "napcat",
                OriginatingTo: conversationId,
            };

            // Create dispatcher for replies
            let dispatcher = null;
            let dispatcherReplyOptions: Record<string, unknown> = {};
            let markDispatchIdle: (() => void) | null = null;
            
            const typingController = createPrivateTypingStatusController({
                enabled: !isGroup && isNapCatPrivateTypingEnabled(config),
                userId: senderId,
                token: String(config.token || "").trim(),
            });
            
            if (runtime.channel.reply.createReplyDispatcherWithTyping) {
                console.log("[NapCat] Calling createReplyDispatcherWithTyping...");
                const result = await runtime.channel.reply.createReplyDispatcherWithTyping({
                    responsePrefix: "",
                    responsePrefixContextProvider: () => ({}),
                    humanDelay: 0,
                    deliver: async (payload) => {
                        if (payload?.isCommentary === true && !shouldDeliverCommentaryPayload(conversationId)) {
                            console.log("[NapCat] Commentary payload throttled, skipped");
                            return;
                        }
                        if (payload?.isCommentary === true && typeof payload.text === "string" && payload.text.trim()) {
                            payload = { ...payload, text: `⏳ ${payload.text}` };
                        }
                        typingController.stop();
                        console.log("[NapCat] Reply to deliver:", JSON.stringify(payload).substring(0, 100));
                        // Actually send the message via NapCat API
                        const config = getNapCatConfig();
                        const baseUrl = config.url || "http://127.0.0.1:15150";
                        const token = String(config.token || "").trim();
                        const isGroup = conversationId.startsWith("group:");
                        const targetId = isGroup ? conversationId.replace("group:", "") : conversationId.replace("private:", "");
                        const endpoint = isGroup ? "/send_group_msg" : "/send_private_msg";
                        const message = await buildNapCatMessageFromReply(
                            payload,
                            config,
                            isGroup ? senderId : undefined
                        );
                        if (!message) {
                            console.log("[NapCat] Skip empty reply payload");
                            return;
                        }
                        const msgPayload: Record<string, string> = { message };
                        if (isGroup) msgPayload.group_id = targetId;
                        else msgPayload.user_id = targetId;
                        
                        console.log(`[NapCat] Sending reply to ${isGroup ? 'group' : 'private'} ${targetId}: ${redactNapCatMediaForLog(message).substring(0, 50)}...`);
                        try {
                            await sendToNapCat(`${baseUrl}${endpoint}`, msgPayload, token, { allowRetry: false });
                            console.log("[NapCat] Reply sent successfully");
                        } catch (err) {
                            console.error("[NapCat] Reply delivery failed (suppressed to avoid channel crash):", err);
                        }
                    },
                    onError: (err, info) => {
                        typingController.stop();
                        console.error(`[NapCat] Reply error (${info.kind}):`, err);
                    },
                    onReplyStart: () => {
                        typingController.stop();
                    },
                    onIdle: () => {
                        typingController.stop();
                    },
                });
                dispatcher = result.dispatcher;
                dispatcherReplyOptions = result.replyOptions || {};
                markDispatchIdle = result.markDispatchIdle || null;
            } else if (runtime.channel.reply.createReplyDispatcher) {
                dispatcher = runtime.channel.reply.createReplyDispatcher({
                    responsePrefix: "",
                    responsePrefixContextProvider: () => ({}),
                    humanDelay: 0,
                    deliver: async (payload) => {
                        if (payload?.isCommentary === true && !shouldDeliverCommentaryPayload(conversationId)) {
                            console.log("[NapCat] Commentary payload throttled, skipped");
                            return;
                        }
                        if (payload?.isCommentary === true && typeof payload.text === "string" && payload.text.trim()) {
                            payload = { ...payload, text: `⏳ ${payload.text}` };
                        }
                        typingController.stop();
                        console.log("[NapCat] Reply to deliver:", JSON.stringify(payload).substring(0, 100));
                        // Actually send the message via NapCat API
                        const config = getNapCatConfig();
                        const baseUrl = config.url || "http://127.0.0.1:15150";
                        const token = String(config.token || "").trim();
                        const isGroup = conversationId.startsWith("group:");
                        const targetId = isGroup ? conversationId.replace("group:", "") : conversationId.replace("private:", "");
                        const endpoint = isGroup ? "/send_group_msg" : "/send_private_msg";
                        const message = await buildNapCatMessageFromReply(
                            payload,
                            config,
                            isGroup ? senderId : undefined
                        );
                        if (!message) {
                            console.log("[NapCat] Skip empty reply payload");
                            return;
                        }
                        const msgPayload: Record<string, string> = { message };
                        if (isGroup) msgPayload.group_id = targetId;
                        else msgPayload.user_id = targetId;
                        
                        console.log(`[NapCat] Sending reply to ${isGroup ? 'group' : 'private'} ${targetId}: ${redactNapCatMediaForLog(message).substring(0, 50)}...`);
                        try {
                            await sendToNapCat(`${baseUrl}${endpoint}`, msgPayload, token, { allowRetry: false });
                            console.log("[NapCat] Reply sent successfully");
                        } catch (err) {
                            console.error("[NapCat] Reply delivery failed (suppressed to avoid channel crash):", err);
                        }
                    },
                    onError: (err, info) => {
                        typingController.stop();
                        console.error(`[NapCat] Reply error (${info.kind}):`, err);
                    },
                });
            }

            if (!dispatcher) {
                console.error("[NapCat] Could not create dispatcher");
                res.statusCode = 503;
                res.setHeader("Content-Type", "application/json");
                res.end('{"status":"error","message":"dispatcher creation failed"}');
                return true;
            }

            console.log("[NapCat] Dispatcher created, methods:", Object.keys(dispatcher));

            // Codex source-channel replies use the message tool, which bypasses
            // the dispatcher deliver callback. Keep the triggering group sender
            // available to the outbound adapter while this reply is running.
            const groupReplyContextToken = isGroup
                ? beginNapCatGroupReplyContext(groupId, senderId)
                : null;

            // Dispatch the message to OpenClaw
            try {
                await typingController.start();
                try {
                    await runtime.channel.reply.dispatchReplyFromConfig({
                        ctx: ctxPayload,
                        cfg,
                        dispatcher,
                        replyOptions: {
                            ...dispatcherReplyOptions,
                            disableBlockStreaming: !isNapCatStreamingModeEnabled(config),
                            commentaryPayloadsEnabled: isNapCatProgressMessagesEnabled(config),
                        },
                    });
                } catch (err) {
                    console.error("[NapCat] Reply dispatch failed (acknowledged to avoid NapCat webhook retry):", err);
                    res.statusCode = 200;
                    res.setHeader("Content-Type", "application/json");
                    res.end('{"status":"ok","message":"reply dispatch failed"}');
                    return true;
                }
            } finally {
                typingController.stop();
                markDispatchIdle?.();
                endNapCatGroupReplyContext(groupId, groupReplyContextToken);
                if (cfg.messages?.removeAckAfterReply && ackReactionPromise && ackEmojiId) {
                    void ackReactionPromise.then((didAck) => {
                        if (!didAck) return;
                        return sendToNapCat(`${config.url || "http://127.0.0.1:15150"}/set_msg_emoji_like`, {
                            message_id: messageId,
                            emoji_id: ackEmojiId,
                            set: false,
                        }, String(config.token || "").trim(), { allowRetry: false }).catch((err) => {
                            console.warn(`[NapCat] Failed to remove ack reaction from message ${messageId}:`, err);
                        });
                    });
                }
            }
            
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end('{"status":"ok"}');
            return true;
        }

        // Default OK for handled path
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end('{"status":"ok"}');
        return true;
    } catch (err) {
        console.error("NapCat Webhook Error:", err);
        res.statusCode = 500;
        res.end("error");
        return true;
    }
}
