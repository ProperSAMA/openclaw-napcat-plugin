import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { buildNapCatMediaCq } from "./media.js";
import { getNapCatRuntime, getNapCatConfig } from "./runtime.js";

// Group name cache removed


function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNapCatStreamingModeEnabled(config: any): boolean {
    return config?.streaming_mode === true;
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

// Send message via NapCat API (node http/https keep-alive + retry for transient socket errors)
async function sendToNapCat(url: string, payload: any, token?: string) {
    const maxAttempts = 3;
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
            try {
                return JSON.parse(res.bodyText);
            } catch {
                return { status: "ok", raw: res.bodyText };
            }
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

async function buildNapCatMessageFromReply(
    payload: { text?: string; mediaUrl?: string; mediaUrls?: string[]; audioAsVoice?: boolean },
    config: any
) {
    const text = payload.text?.trim() || "";
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

    if (text && mediaSegments.length > 0) return `${text}\n${mediaSegments.join("\n")}`;
    if (text) return text;
    return mediaSegments.join("\n");
}

function getContentTypeByPath(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".png") return "image/png";
    if (ext === ".gif") return "image/gif";
    if (ext === ".webp") return "image/webp";
    if (ext === ".bmp") return "image/bmp";
    if (ext === ".svg") return "image/svg+xml";
    return "application/octet-stream";
}

async function handleMediaProxyRequest(res: ServerResponse, url: string): Promise<boolean> {
    const config = getNapCatConfig();
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
    if (expectedToken && token !== expectedToken) {
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
        if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
            const upstream = await fetch(mediaUrl);
            if (!upstream.ok) {
                res.statusCode = 502;
                res.end(`upstream fetch failed: ${upstream.status}`);
                return true;
            }
            const contentType = upstream.headers.get("content-type") || "application/octet-stream";
            res.statusCode = 200;
            res.setHeader("Content-Type", contentType);
            const buffer = Buffer.from(await upstream.arrayBuffer());
            res.setHeader("Content-Length", buffer.length);
            res.end(buffer);
            return true;
        }

        let filePath = mediaUrl;
        if (mediaUrl.startsWith("file://")) {
            filePath = decodeURIComponent(new URL(mediaUrl).pathname);
        }
        if (!filePath.startsWith("/")) {
            res.statusCode = 400;
            res.end("unsupported media url");
            return true;
        }

        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) {
            res.statusCode = 404;
            res.end("file not found");
            return true;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", getContentTypeByPath(filePath));
        res.setHeader("Content-Length", fileStat.size);
        createReadStream(filePath).pipe(res);
        return true;
    } catch (err) {
        console.error("[NapCat] Media proxy error:", err);
        res.statusCode = 500;
        res.end("media proxy error");
        return true;
    }
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

    const baseUrl = String(config.url || "http://127.0.0.1:3000").trim().replace(/\/+$/, "");
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
    
    console.log(`[NapCat] Incoming request: ${method} ${url}`);
    
    // Accept /napcat, /napcat/, or any path starting with /napcat
    if (!url.startsWith("/napcat")) return false;

    if (method === "GET") {
        return handleMediaProxyRequest(res, url);
    }
    
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
            // Ensure senderId is numeric string
            const senderId = String(event.user_id);
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

                const botId = event.self_id || config.selfId;
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

            // Generate NapCat base session key by conversation type
            // Base format: session:napcat:private:{userId} or session:napcat:group:{groupId}
            const baseSessionKey = isGroup 
                ? `session:napcat:group:${event.group_id}`
                : `session:napcat:private:${senderId}`;
            const cfg = runtime.config?.loadConfig?.() || {};

            // Resolve route for this message with specific session key
            // Note: OpenClaw SDK ignores the sessionKey param, so we must override it after
            const route = await runtime.channel.routing.resolveAgentRoute({
                channel: "napcat",
                conversationId,
                senderId,
                text,
                cfg,
                ctx: {},
            });

            if (!route?.agentId) {
                console.log("[NapCat] No route found for message, ignoring");
                res.statusCode = 200;
                res.setHeader("Content-Type", "application/json");
                res.end('{"status":"ok"}');
                return true;
            }

            const configuredAgentId = String(config.agentId || "").trim().toLowerCase();
            const routeAgentId = String(route.agentId || "").trim().toLowerCase();
            const effectiveAgentId = configuredAgentId || routeAgentId || "main";
            const sessionKey = `agent:${effectiveAgentId}:${baseSessionKey}`;

            // User requested to use session key as display name for consistency
            const sessionDisplayName = sessionKey;

            // Log for debugging
            console.log(`[NapCat] Inbound from ${senderId} (session: ${sessionKey}): ${text.substring(0, 50)}...`);
            if (configuredAgentId && configuredAgentId !== routeAgentId) {
                console.log(`[NapCat] Override route agent by config: ${routeAgentId || "none"} -> ${configuredAgentId}`);
            }

            // Force our custom session key and configured agent
            route.agentId = effectiveAgentId;
            route.sessionKey = sessionKey;

            // Build ctxPayload using runtime methods
            const ctxPayload = {
                Body: text,
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
            
            // Store conversationId for reply routing
            const replyTarget = conversationId;
            
            if (runtime.channel.reply.createReplyDispatcherWithTyping) {
                console.log("[NapCat] Calling createReplyDispatcherWithTyping...");
                const result = await runtime.channel.reply.createReplyDispatcherWithTyping({
                    responsePrefix: "",
                    responsePrefixContextProvider: () => ({}),
                    humanDelay: 0,
                    deliver: async (payload) => {
                        console.log("[NapCat] Reply to deliver:", JSON.stringify(payload).substring(0, 100));
                        // Actually send the message via NapCat API
                        const config = getNapCatConfig();
                        const baseUrl = config.url || "http://127.0.0.1:3000";
                        const token = String(config.token || "").trim();
                        const isGroup = conversationId.startsWith("group:");
                        const targetId = isGroup ? conversationId.replace("group:", "") : conversationId.replace("private:", "");
                        const endpoint = isGroup ? "/send_group_msg" : "/send_private_msg";
                        const message = await buildNapCatMessageFromReply(payload, config);
                        if (!message) {
                            console.log("[NapCat] Skip empty reply payload");
                            return;
                        }
                        const msgPayload: Record<string, string> = { message };
                        if (isGroup) msgPayload.group_id = targetId;
                        else msgPayload.user_id = targetId;
                        
                        console.log(`[NapCat] Sending reply to ${isGroup ? 'group' : 'private'} ${targetId}: ${message.substring(0, 50)}...`);
                        try {
                            await sendToNapCat(`${baseUrl}${endpoint}`, msgPayload, token);
                            console.log("[NapCat] Reply sent successfully");
                        } catch (err) {
                            console.error("[NapCat] Reply delivery failed (suppressed to avoid channel crash):", err);
                        }
                    },
                    onError: (err, info) => {
                        console.error(`[NapCat] Reply error (${info.kind}):`, err);
                    },
                    onReplyStart: () => {},
                    onIdle: () => {},
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
                        console.log("[NapCat] Reply to deliver:", JSON.stringify(payload).substring(0, 100));
                        // Actually send the message via NapCat API
                        const config = getNapCatConfig();
                        const baseUrl = config.url || "http://127.0.0.1:3000";
                        const token = String(config.token || "").trim();
                        const isGroup = conversationId.startsWith("group:");
                        const targetId = isGroup ? conversationId.replace("group:", "") : conversationId.replace("private:", "");
                        const endpoint = isGroup ? "/send_group_msg" : "/send_private_msg";
                        const message = await buildNapCatMessageFromReply(payload, config);
                        if (!message) {
                            console.log("[NapCat] Skip empty reply payload");
                            return;
                        }
                        const msgPayload: Record<string, string> = { message };
                        if (isGroup) msgPayload.group_id = targetId;
                        else msgPayload.user_id = targetId;
                        
                        console.log(`[NapCat] Sending reply to ${isGroup ? 'group' : 'private'} ${targetId}: ${message.substring(0, 50)}...`);
                        try {
                            await sendToNapCat(`${baseUrl}${endpoint}`, msgPayload, token);
                            console.log("[NapCat] Reply sent successfully");
                        } catch (err) {
                            console.error("[NapCat] Reply delivery failed (suppressed to avoid channel crash):", err);
                        }
                    },
                    onError: (err, info) => {
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

            // Dispatch the message to OpenClaw
            try {
                await runtime.channel.reply.dispatchReplyFromConfig({
                    ctx: ctxPayload,
                    cfg,
                    dispatcher,
                    replyOptions: {
                        ...dispatcherReplyOptions,
                        disableBlockStreaming: !isNapCatStreamingModeEnabled(config),
                    },
                });
            } finally {
                markDispatchIdle?.();
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
