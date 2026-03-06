import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { getNapCatRuntime, getNapCatConfig } from "./runtime.js";
import { isWsTransport, sendNapCatActionOverWs } from "./ws.js";

// Group name cache removed


function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

function appendAccessToken(rawUrl: string, token: string): string {
    const trimmedToken = String(token || "").trim();
    if (!trimmedToken) return rawUrl;
    try {
        const target = new URL(rawUrl);
        if (!target.searchParams.has("access_token")) {
            target.searchParams.set("access_token", trimmedToken);
        }
        return target.toString();
    } catch {
        return rawUrl;
    }
}

async function postJsonWithNodeHttp(
    url: string,
    payload: any,
    timeoutMs: number,
    opts?: { connectionClose?: boolean; token?: string }
): Promise<{ statusCode: number; statusText: string; bodyText: string }> {
    const authedUrl = appendAccessToken(url, String(opts?.token || ""));
    const target = new URL(authedUrl);
    const isHttps = target.protocol === "https:";
    const body = JSON.stringify(payload);
    const transport = isHttps ? httpsRequest : httpRequest;
    const connectionClose = opts?.connectionClose === true;
    const agent = connectionClose ? undefined : (isHttps ? napcatHttpsAgent : napcatHttpAgent);
    const token = String(opts?.token || "").trim();

    return new Promise((resolve, reject) => {
        const req = transport(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || (isHttps ? 443 : 80),
                path: `${target.pathname}${target.search}`,
                method: "POST",
                agent,
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                    "Connection": connectionClose ? "close" : "keep-alive",
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
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
async function sendToNapCat(url: string, payload: any) {
    const maxAttempts = 3;
    const timeoutsMs = [5000, 7000, 9000];
    const cfg = getNapCatConfig();
    const connectionClose = cfg.connectionClose !== false; // default true for local docker stability
    const token = String(cfg.token || cfg.accessToken || "").trim();
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

function endpointToAction(endpoint: string): string {
    return endpoint.replace(/^\/+/, "").trim();
}

async function sendNapCatByTransport(config: any, endpoint: string, payload: any) {
    if (isWsTransport(config)) {
        const action = endpointToAction(endpoint);
        return sendNapCatActionOverWs(action, payload, Number(config.wsRequestTimeoutMs || 10000));
    }
    const baseUrl = config.url || "http://127.0.0.1:3000";
    return sendToNapCat(`${baseUrl}${endpoint}`, payload);
}

function buildMediaProxyUrl(mediaUrl: string, config: any): string {
    const enabled = config.mediaProxyEnabled === true;
    const baseUrl = String(config.publicBaseUrl || "").trim().replace(/\/+$/, "");
    if (!enabled || !baseUrl) return mediaUrl;

    const token = String(config.mediaProxyToken || "").trim();
    const query = new URLSearchParams({ url: mediaUrl });
    if (token) query.set("token", token);
    return `${baseUrl}/napcat/media?${query.toString()}`;
}

function isAudioMedia(mediaUrl: string): boolean {
    return /\.(wav|mp3|amr|silk|ogg|m4a|flac|aac)(?:\?.*)?$/i.test(mediaUrl);
}

function resolveVoiceMediaUrl(mediaUrl: string, config: any): string {
    const trimmed = mediaUrl.trim();
    if (!trimmed) return trimmed;
    if (/^(https?:\/\/|file:\/\/)/i.test(trimmed) || trimmed.startsWith("/")) {
        return trimmed;
    }
    const voiceBasePath = String(config.voiceBasePath || "").trim().replace(/\/+$/, "");
    if (!voiceBasePath) return trimmed;
    return `${voiceBasePath}/${trimmed.replace(/^\/+/, "")}`;
}

function buildNapCatMediaCq(mediaUrl: string, config: any, forceVoice = false): string {
    const shouldUseVoice = forceVoice || isAudioMedia(mediaUrl);
    const resolvedUrl = shouldUseVoice ? resolveVoiceMediaUrl(mediaUrl, config) : mediaUrl;
    const proxiedMediaUrl = buildMediaProxyUrl(resolvedUrl, config);
    const type = shouldUseVoice ? "record" : "image";
    return `[CQ:${type},file=${proxiedMediaUrl}]`;
}

function buildNapCatMessageFromReply(
    payload: { text?: string; mediaUrl?: string; mediaUrls?: string[]; audioAsVoice?: boolean },
    config: any
) {
    const text = payload.text?.trim() || "";
    const mediaCandidates = [
        ...(payload.mediaUrls || []),
        ...(payload.mediaUrl ? [payload.mediaUrl] : [])
    ];
    const mediaSegments = mediaCandidates
        .map((url) => String(url || "").trim())
        .filter(Boolean)
        .map((url) => buildNapCatMediaCq(url, config, payload.audioAsVoice === true));

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

interface ParsedMedia {
    text: string;
    imageUrls: string[];
    audioUrls: string[];
}

interface DownloadedMedia {
    paths: string[];
    types: string[];
    records: Array<{ sourceUrl: string; path: string; type: string }>;
}

interface NapCatImageSegment {
    file: string;
    url: string;
    summary: string;
    fileSize: string;
    index: number;
}

interface InboundImageContext {
    id: string;
    createdAt: number;
    messageId: string;
    chatType: "group" | "direct";
    conversationId: string;
    senderId: string;
    groupId?: string;
    sourceIndex: number;
    file: string;
    url: string;
    summary: string;
    fileSize: string;
    localPath: string;
}

const inboundImageContextCache = new Map<string, InboundImageContext>();
const inboundImageContextTtlMs = 24 * 60 * 60 * 1000;

function cleanupInboundImageContexts(now = Date.now()) {
    for (const [key, entry] of inboundImageContextCache) {
        if (now - entry.createdAt > inboundImageContextTtlMs) {
            inboundImageContextCache.delete(key);
        }
    }
}

function buildInboundImageContextId(chatType: "group" | "direct", conversationId: string, messageId: string, sourceIndex: number): string {
    const safeConversation = conversationId.replace(/[^a-zA-Z0-9:_-]/g, "_");
    return `napcat-image:${chatType}:${safeConversation}:${messageId}:${sourceIndex}`;
}

export function getInboundImageContext(id: string): InboundImageContext | null {
    cleanupInboundImageContexts();
    const entry = inboundImageContextCache.get(String(id || "").trim());
    return entry || null;
}

function extractNapCatImageSegments(event: any): NapCatImageSegment[] {
    const segments = Array.isArray(event?.message) ? event.message : [];
    const results: NapCatImageSegment[] = [];
    let index = 0;
    for (const segment of segments) {
        if (!segment || segment.type !== "image" || typeof segment.data !== "object") continue;
        const file = decodeHtmlEntities(String(segment.data.file || "").trim());
        const url = decodeHtmlEntities(String(segment.data.url || "").trim());
        const summary = String(segment.data.summary || "").trim();
        const fileSize = String(segment.data.file_size || segment.data.fileSize || "").trim();
        results.push({ file, url, summary, fileSize, index });
        index++;
    }
    return results;
}

function decodeHtmlEntities(input: string): string {
    return String(input || "")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, "\"")
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">");
}

function parseCqMedia(rawText: string, config: any): ParsedMedia {
    const inboundImageEnabled = config.inboundImageEnabled !== false;
    if (!inboundImageEnabled || !rawText || typeof rawText !== "string") {
        return { text: rawText || "", imageUrls: [], audioUrls: [] };
    }

    const imageUrls: string[] = [];
    const audioUrls: string[] = [];

    const cqRegex = /\[CQ:([a-zA-Z0-9_]+)([^\]]*)\]/g;
    let clean = "";
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = cqRegex.exec(rawText)) !== null) {
        const before = rawText.slice(lastIndex, match.index);
        clean += before;
        lastIndex = cqRegex.lastIndex;

        const type = match[1].toLowerCase();
        const paramsRaw = (match[2] || "").replace(/^,/, "");
        const kv: Record<string, string> = {};
        if (paramsRaw) {
            for (const part of paramsRaw.split(",")) {
                const trimmed = part.trim();
                if (!trimmed) continue;
                const eqIndex = trimmed.indexOf("=");
                if (eqIndex <= 0) continue;
                const key = trimmed.slice(0, eqIndex).trim();
                const value = trimmed.slice(eqIndex + 1).trim();
                if (!key) continue;
                kv[key] = value;
            }
        }

        if (type === "image") {
            const preferUrl = config.inboundImagePreferUrl !== false;
            const urlCandidate = preferUrl ? (kv.url || kv.file) : (kv.file || kv.url);
            const url = decodeHtmlEntities(String(urlCandidate || "").trim());
            if (url) {
                imageUrls.push(url);
            }
        } else if (type === "record") {
            const url = decodeHtmlEntities(String(kv.url || kv.file || "").trim());
            if (url) {
                audioUrls.push(url);
            }
        } else {
            // 保留非媒体 CQ 段（例如 @ 提醒等）
            clean += match[0];
        }
    }

    clean += rawText.slice(lastIndex);
    const normalizedText = clean.trim();

    if (imageUrls.length > 0 || audioUrls.length > 0) {
        console.log(`[NapCat] Parsed media from message: images=${imageUrls.length}, audios=${audioUrls.length}`);
    }

    return {
        text: normalizedText,
        imageUrls,
        audioUrls,
    };
}

function getInboundMediaDir(config: any): string {
    const baseDirRaw = String(config.inboundMediaDir || "./workspace/napcat-inbound-media").trim() || "./workspace/napcat-inbound-media";
    return resolve(baseDirRaw);
}

function extFromContentType(contentType: string): string {
    const normalized = String(contentType || "").toLowerCase();
    if (normalized.includes("image/png")) return ".png";
    if (normalized.includes("image/jpeg")) return ".jpg";
    if (normalized.includes("image/gif")) return ".gif";
    if (normalized.includes("image/webp")) return ".webp";
    if (normalized.includes("audio/wav")) return ".wav";
    if (normalized.includes("audio/mpeg")) return ".mp3";
    if (normalized.includes("audio/ogg")) return ".ogg";
    return "";
}

function normalizeInboundMediaType(contentType: string): string {
    const normalized = String(contentType || "").toLowerCase();
    if (normalized.startsWith("image/")) return "image";
    if (normalized.startsWith("audio/")) return "audio";
    return normalized || "file";
}

async function downloadInboundMedia(urls: string[], kind: "image" | "audio", config: any): Promise<DownloadedMedia> {
    const result: DownloadedMedia = { paths: [], types: [], records: [] };
    if (!Array.isArray(urls) || urls.length === 0) return result;

    const mediaDir = getInboundMediaDir(config);
    await mkdir(mediaDir, { recursive: true });

    for (const rawUrl of urls) {
        const mediaUrl = String(rawUrl || "").trim();
        if (!mediaUrl || (!mediaUrl.startsWith("http://") && !mediaUrl.startsWith("https://"))) continue;

        try {
            const response = await fetch(mediaUrl);
            if (!response.ok) {
                console.warn(`[NapCat] Failed to download inbound ${kind}: ${response.status} ${mediaUrl}`);
                continue;
            }

            const contentType = response.headers.get("content-type") || (kind === "image" ? "image/png" : "application/octet-stream");
            const ext = extFromContentType(contentType) || extname(new URL(mediaUrl).pathname) || (kind === "image" ? ".img" : ".bin");
            const filePath = resolve(mediaDir, `${Date.now()}-${randomUUID()}${ext}`);
            const buffer = Buffer.from(await response.arrayBuffer());
            await writeFile(filePath, buffer);
            result.paths.push(filePath);
            const normalizedType = normalizeInboundMediaType(contentType);
            result.types.push(normalizedType);
            result.records.push({ sourceUrl: mediaUrl, path: filePath, type: normalizedType });
        } catch (err) {
            console.warn(`[NapCat] Failed to download inbound ${kind}: ${mediaUrl}`, err);
        }
    }

    return result;
}

function getFriendRequestLogDir(config: any): string {
    const baseDirRaw = String(config.friendRequestLogDir || "./logs/napcat-friend-requests").trim() || "./logs/napcat-friend-requests";
    return resolve(baseDirRaw);
}

function renderFriendRemarkTemplate(template: string, event: any): string {
    const rawTemplate = String(template || "").trim();
    if (!rawTemplate) return "";
    const nickname = String(event?.nickname || event?.sender?.nickname || "").trim();
    const comment = String(event?.comment || "").trim();
    return rawTemplate
        .replace(/\{userId\}/g, String(event?.user_id || ""))
        .replace(/\{nickname\}/g, nickname)
        .replace(/\{comment\}/g, comment);
}

async function appendFriendRequestLog(event: any, config: any, extra: Record<string, any> = {}): Promise<void> {
    const baseDir = getFriendRequestLogDir(config);
    const userId = sanitizeLogToken(String(event?.user_id || "unknown_user"));
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        post_type: event?.post_type || "",
        request_type: event?.request_type || "",
        self_id: event?.self_id,
        user_id: event?.user_id,
        nickname: event?.nickname || event?.sender?.nickname || "",
        comment: event?.comment || "",
        flag: event?.flag || "",
        ...extra,
    }) + "\n";
    const files = [
        resolve(baseDir, "requests.log"),
        resolve(baseDir, `qq-${userId}.log`),
    ];
    for (const filePath of files) {
        await mkdir(dirname(filePath), { recursive: true });
        await appendFile(filePath, line, "utf8");
    }
}

async function handleNapCatFriendRequest(event: any, config: any): Promise<void> {
    const userId = String(event?.user_id || "").trim();
    const flag = String(event?.flag || "").trim();
    if (!userId || !flag) {
        await appendFriendRequestLog(event, config, {
            status: "invalid",
            reason: "missing_user_id_or_flag",
        });
        console.warn("[NapCat] Ignore malformed friend request event:", event);
        return;
    }

    const allowUsers = Array.isArray(config.friendRequestAllowUsers)
        ? config.friendRequestAllowUsers.map((item: any) => String(item))
        : [];
    const allowMatched = allowUsers.length === 0 || allowUsers.includes(userId);
    const autoApprove = config.autoApproveFriendRequests === true && allowMatched;
    const remark = renderFriendRemarkTemplate(String(config.friendAutoRemarkTemplate || ""), event);

    if (!autoApprove) {
        const status = config.autoApproveFriendRequests === true && !allowMatched
            ? "pending_blocked_by_allowlist"
            : "pending";
        await appendFriendRequestLog(event, config, {
            status,
            autoApprove: false,
            allowMatched,
            remark,
        });
        console.log(`[NapCat] Friend request pending from ${userId} comment=${String(event?.comment || "").slice(0, 80)}`);
        return;
    }

    const payload: any = {
        flag,
        approve: true,
    };
    if (remark) {
        payload.remark = remark;
    }

    try {
        await sendNapCatByTransport(config, "/set_friend_add_request", payload);
        await appendFriendRequestLog(event, config, {
            status: "approved",
            autoApprove: true,
            allowMatched: true,
            remark,
        });
        console.log(`[NapCat] Auto approved friend request from ${userId}`);
    } catch (err: any) {
        await appendFriendRequestLog(event, config, {
            status: "approve_failed",
            autoApprove: true,
            allowMatched: true,
            remark,
            error: String(err?.message || err || ""),
        });
        console.error(`[NapCat] Auto approve friend request failed for ${userId}:`, err);
    }
}

async function handleNapCatMessageEvent(event: any, config: any): Promise<void> {
    const runtime = getNapCatRuntime();
    const isGroup = event.message_type === "group";
    const senderId = String(event.user_id);
    if (!/^\d+$/.test(senderId)) {
        console.warn(`[NapCat] WARNING: user_id is not numeric: ${senderId}`);
    }
    const rawText = event.raw_message || "";
    let text = rawText;

    const allowUsers = config.allowUsers || [];
    const isAllowUser = allowUsers.includes(senderId);
    if (allowUsers.length > 0 && !isAllowUser) {
        console.log(`[NapCat] Ignoring message from ${senderId} (not in allowlist)`);
        return;
    }

    const enableGroupMessages = config.enableGroupMessages || false;
    const groupMentionOnly = config.groupMentionOnly !== false;
    let wasMentioned = !isGroup;

    if (isGroup) {
        if (!enableGroupMessages) {
            console.log(`[NapCat] Ignoring group message (group messages disabled)`);
            return;
        }

        const botId = event.self_id || config.selfId;
        if (groupMentionOnly) {
            if (!botId) {
                console.log(`[NapCat] Cannot determine bot ID, ignoring group message`);
                return;
            }
            const mentionPatternCQ = new RegExp(`\\[CQ:at,qq=${botId}\\]`, "i");
            const allMentionPatternCQ = /\[CQ:at,qq=all\]/i;
            const mentionPatternPlain1 = new RegExp(`@[^\\s]+ \\(${botId}\\)`, "i");
            const mentionPatternPlain2 = new RegExp(`@${botId}(?:\\s|$|,)`, "i");
            const isMentionedCQ = mentionPatternCQ.test(text) || allMentionPatternCQ.test(text);
            const isMentionedPlain = mentionPatternPlain1.test(text) || mentionPatternPlain2.test(text);
            if (!isMentionedCQ && !isMentionedPlain) {
                console.log(`[NapCat] Ignoring group message (bot not mentioned)`);
                return;
            }
            wasMentioned = true;
            console.log(`[NapCat] Bot mentioned in group, processing message`);
        } else if (botId) {
            const mentionPatternCQ = new RegExp(`\\[CQ:at,qq=${botId}\\]`, "i");
            const allMentionPatternCQ = /\[CQ:at,qq=all\]/i;
            const mentionPatternPlain1 = new RegExp(`@[^\\s]+ \\(${botId}\\)`, "i");
            const mentionPatternPlain2 = new RegExp(`@${botId}(?:\\s|$|,)`, "i");
            wasMentioned = mentionPatternCQ.test(text) || allMentionPatternCQ.test(text) ||
                mentionPatternPlain1.test(text) || mentionPatternPlain2.test(text);
        }

        if (botId) {
            const stripCQ = new RegExp(`^\\[CQ:at,qq=${botId}\\]\\s*`, "i");
            const stripAll = /^\[CQ:at,qq=all\]\s*/i;
            const stripPlain1 = new RegExp(`^@[^\\s]+ \\(${botId}\\)\\s*`, "i");
            const stripPlain2 = new RegExp(`^@${botId}(?:\\s|$|,)\\s*`, "i");
            text = text.replace(stripCQ, "").replace(stripAll, "").replace(stripPlain1, "").replace(stripPlain2, "").trim();
        }
    }

    const messageId = String(event.message_id);
    const conversationId = isGroup ? `group:${event.group_id}` : `private:${senderId}`;
    const senderName = event.sender?.nickname || senderId;
    const baseSessionKey = isGroup ? `session:napcat:group:${event.group_id}` : `session:napcat:private:${senderId}`;
    const cfg = runtime.config?.loadConfig?.() || {};
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
        return;
    }

    const configuredAgentId = String(config.agentId || "").trim().toLowerCase();
    const routeAgentId = String(route.agentId || "").trim().toLowerCase();
    const effectiveAgentId = configuredAgentId || routeAgentId || "main";
    const sessionKey = `agent:${effectiveAgentId}:${baseSessionKey}`;
    const sessionDisplayName = sessionKey;

    console.log(`[NapCat] Inbound from ${senderId} (session: ${sessionKey}): ${text.substring(0, 50)}...`);
    if (configuredAgentId && configuredAgentId !== routeAgentId) {
        console.log(`[NapCat] Override route agent by config: ${routeAgentId || "none"} -> ${configuredAgentId}`);
    }

    route.agentId = effectiveAgentId;
    route.sessionKey = sessionKey;

    const parsedMedia = parseCqMedia(text, config);
    const mediaImageUrls = parsedMedia.imageUrls || [];
    const mediaAudioUrls = parsedMedia.audioUrls || [];
    const finalText = parsedMedia.text || text;
    const downloadedImages = await downloadInboundMedia(mediaImageUrls, "image", config);
    const downloadedAudios = await downloadInboundMedia(mediaAudioUrls, "audio", config);
    const imageSegments = extractNapCatImageSegments(event);
    const downloadedImageByUrl = new Map(downloadedImages.records.map((record) => [record.sourceUrl, record]));
    const imageContexts: InboundImageContext[] = [];
    cleanupInboundImageContexts();
    for (const segment of imageSegments) {
        const sourceUrl = segment.url || segment.file;
        const downloaded = downloadedImageByUrl.get(sourceUrl);
        if (!downloaded?.path) continue;
        const contextId = buildInboundImageContextId(isGroup ? "group" : "direct", conversationId, messageId, segment.index);
        const context: InboundImageContext = {
            id: contextId,
            createdAt: Date.now(),
            messageId,
            chatType: isGroup ? "group" : "direct",
            conversationId,
            senderId,
            groupId: isGroup ? String(event.group_id) : undefined,
            sourceIndex: segment.index,
            file: segment.file,
            url: segment.url,
            summary: segment.summary,
            fileSize: segment.fileSize,
            localPath: downloaded.path,
        };
        inboundImageContextCache.set(contextId, context);
        imageContexts.push(context);
    }

    const ctxPayload: any = {
        Body: finalText,
        RawBody: rawText,
        CommandBody: finalText,
        From: `napcat:${conversationId}`,
        To: "me",
        SessionKey: sessionKey,
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

    if (mediaImageUrls.length > 0) {
        ctxPayload.MediaUrls = mediaImageUrls;
        ctxPayload.MediaUrl = mediaImageUrls[0];
        ctxPayload.ImageUrls = mediaImageUrls;
        ctxPayload.Images = mediaImageUrls.map((url: string, index: number) => {
            const context = imageContexts.find((item) => item.sourceIndex === index);
            return context ? {
                type: "image",
                url,
                file: context.file,
                contextImageId: context.id,
                localPath: context.localPath,
            } : { type: "image", url };
        });
    }

    if (imageContexts.length > 0) {
        ctxPayload.ImageContextIds = imageContexts.map((item) => item.id);
        ctxPayload.ImageContextId = imageContexts[0].id;
        ctxPayload.ImageContexts = imageContexts.map((item) => ({
            id: item.id,
            type: "image",
            url: item.url,
            file: item.file,
            summary: item.summary,
            fileSize: item.fileSize,
            localPath: item.localPath,
            messageId: item.messageId,
            chatType: item.chatType,
            conversationId: item.conversationId,
            sourceIndex: item.sourceIndex,
            downloadTarget: "action:download_file_image_stream",
            downloadPayload: { context_image_id: item.id },
        }));
    }

    if (mediaAudioUrls.length > 0) {
        ctxPayload.AudioUrls = mediaAudioUrls;
        ctxPayload.Audios = mediaAudioUrls.map((url: string) => ({ type: "audio", url }));
    }

    const mediaPaths = [...downloadedImages.paths, ...downloadedAudios.paths];
    const mediaTypes = [...downloadedImages.types, ...downloadedAudios.types];
    if (mediaPaths.length > 0) {
        ctxPayload.MediaPaths = mediaPaths;
        ctxPayload.MediaPath = mediaPaths[0];
        ctxPayload.MediaTypes = mediaTypes;
        ctxPayload.MediaType = mediaTypes[0] || "file";
        console.log(`[NapCat] Prepared local media files for OpenClaw: count=${mediaPaths.length}`);
    }

    let dispatcher = null;
    if (runtime.channel.reply.createReplyDispatcherWithTyping) {
        console.log("[NapCat] Calling createReplyDispatcherWithTyping...");
        const result = await runtime.channel.reply.createReplyDispatcherWithTyping({
            responsePrefix: "",
            responsePrefixContextProvider: () => ({}),
            humanDelay: 0,
            deliver: async (payload: any) => {
                console.log("[NapCat] Reply to deliver:", JSON.stringify(payload).substring(0, 100));
                const currentConfig = getNapCatConfig();
                const isGroupReply = conversationId.startsWith("group:");
                const targetId = isGroupReply ? conversationId.replace("group:", "") : conversationId.replace("private:", "");
                const endpoint = isGroupReply ? "/send_group_msg" : "/send_private_msg";
                const message = buildNapCatMessageFromReply(payload, currentConfig);
                if (!message) {
                    console.log("[NapCat] Skip empty reply payload");
                    return;
                }
                const msgPayload: any = { message };
                if (isGroupReply) msgPayload.group_id = targetId;
                else msgPayload.user_id = targetId;
                console.log(`[NapCat] Sending reply to ${isGroupReply ? "group" : "private"} ${targetId}: ${message.substring(0, 50)}...`);
                try {
                    await sendNapCatByTransport(currentConfig, endpoint, msgPayload);
                    console.log("[NapCat] Reply sent successfully");
                } catch (err) {
                    console.error("[NapCat] Reply delivery failed (suppressed to avoid channel crash):", err);
                }
            },
            onError: (err: any, info: any) => {
                console.error(`[NapCat] Reply error (${info.kind}):`, err);
            },
            onReplyStart: () => {},
            onIdle: () => {},
        });
        dispatcher = result.dispatcher;
    } else if (runtime.channel.reply.createReplyDispatcher) {
        dispatcher = runtime.channel.reply.createReplyDispatcher({
            responsePrefix: "",
            responsePrefixContextProvider: () => ({}),
            humanDelay: 0,
            deliver: async (payload: any) => {
                console.log("[NapCat] Reply to deliver:", JSON.stringify(payload).substring(0, 100));
                const currentConfig = getNapCatConfig();
                const isGroupReply = conversationId.startsWith("group:");
                const targetId = isGroupReply ? conversationId.replace("group:", "") : conversationId.replace("private:", "");
                const endpoint = isGroupReply ? "/send_group_msg" : "/send_private_msg";
                const message = buildNapCatMessageFromReply(payload, currentConfig);
                if (!message) {
                    console.log("[NapCat] Skip empty reply payload");
                    return;
                }
                const msgPayload: any = { message };
                if (isGroupReply) msgPayload.group_id = targetId;
                else msgPayload.user_id = targetId;
                console.log(`[NapCat] Sending reply to ${isGroupReply ? "group" : "private"} ${targetId}: ${message.substring(0, 50)}...`);
                try {
                    await sendNapCatByTransport(currentConfig, endpoint, msgPayload);
                    console.log("[NapCat] Reply sent successfully");
                } catch (err) {
                    console.error("[NapCat] Reply delivery failed (suppressed to avoid channel crash):", err);
                }
            },
            onError: (err: any, info: any) => {
                console.error(`[NapCat] Reply error (${info.kind}):`, err);
            },
        });
    }

    if (!dispatcher) {
        console.error("[NapCat] Could not create dispatcher");
        return;
    }

    console.log("[NapCat] Dispatcher created, methods:", Object.keys(dispatcher));
    await runtime.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions: {},
    });
}

export async function handleNapCatInboundBody(body: any): Promise<void> {
    const config = getNapCatConfig();
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

    for (const event of events) {
        if (!event || typeof event !== "object") continue;
        if (event.post_type === "meta_event") continue;
        if (event.post_type === "request" && event.request_type === "friend") {
            await handleNapCatFriendRequest(event, config);
            continue;
        }
        if (event.post_type !== "message") continue;
        await handleNapCatMessageEvent(event, config);
    }
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
        await handleNapCatInboundBody(body);
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
