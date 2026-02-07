import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { getNapCatRuntime, getNapCatConfig } from "./runtime.js";

// Group name cache removed


// Simple function to send message via NapCat API
async function sendToNapCat(url: string, payload: any) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        throw new Error(`NapCat API Error: ${res.status} ${res.statusText}`);
    }
    return await res.json();
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
                if (!data) resolve({});
                else resolve(JSON.parse(data));
            } catch (e) {
                console.error("NapCat JSON Parse Error:", e);
                resolve({});
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
    if (body?.post_type !== "message") return;

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

        try {
            await logInboundMessage(body, config);
        } catch (err) {
            console.error("[NapCat] Failed to write inbound log:", err);
        }

        // Heartbeat / Lifecycle
        if (body.post_type === "meta_event") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end('{"status":"ok"}');
            return true;
        }

        if (body.post_type === "message") {
            const runtime = getNapCatRuntime();
            const isGroup = body.message_type === "group";
            // Ensure senderId is numeric string
            const senderId = String(body.user_id);
            // Safety check: if senderId looks like a name (non-numeric), log warning
            if (!/^\d+$/.test(senderId)) {
                console.warn(`[NapCat] WARNING: user_id is not numeric: ${senderId}`);
            }
            const rawText = body.raw_message || "";
            let text = rawText;

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

                const botId = body.self_id || config.selfId;
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

                    const isMentionedCQ = mentionPatternCQ.test(text) || allMentionPatternCQ.test(text);
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
                        wasMentioned = mentionPatternCQ.test(text) || allMentionPatternCQ.test(text) || 
                                       mentionPatternPlain1.test(text) || mentionPatternPlain2.test(text);
                    }
                }

                // Strip mentions from text for cleaner processing and command detection
                if (botId) {
                    const stripCQ = new RegExp(`^\\[CQ:at,qq=${botId}\\]\\s*`, 'i');
                    const stripAll = /^\[CQ:at,qq=all\]\s*/i;
                    const stripPlain1 = new RegExp(`^@[^\\s]+ \\(${botId}\\)\\s*`, 'i');
                    const stripPlain2 = new RegExp(`^@${botId}(?:\\s|$|,)\\s*`, 'i');
                    text = text.replace(stripCQ, '').replace(stripAll, '').replace(stripPlain1, '').replace(stripPlain2, '').trim();
                }
            }

            const messageId = String(body.message_id);
            // OpenClaw convention: conversationId differentiates chats
            // We prefix with type to help outbound routing
            const conversationId = isGroup ? `group:${body.group_id}` : `private:${senderId}`;
            const senderName = body.sender?.nickname || senderId;

            // Generate session key based on conversation type
            // Session format: session:napcat:private:{userId} or session:napcat:group:{groupId}
            const sessionKey = isGroup 
                ? `session:napcat:group:${body.group_id}`
                : `session:napcat:private:${senderId}`;

            // User requested to use session key as display name for consistency
            const sessionDisplayName = sessionKey;

            // Log for debugging
            console.log(`[NapCat] Inbound from ${senderId} (session: ${sessionKey}): ${text.substring(0, 50)}...`);

            // Resolve route for this message with specific session key
            // Note: OpenClaw SDK ignores the sessionKey param, so we must override it after
            const route = await runtime.channel.routing.resolveAgentRoute({
                channel: "napcat",
                conversationId,
                senderId,
                text,
                cfg: runtime.config?.loadConfig?.() || {},
                ctx: {},
            });

            if (!route?.agentId) {
                console.log("[NapCat] No route found for message, ignoring");
                res.statusCode = 200;
                res.setHeader("Content-Type", "application/json");
                res.end('{"status":"ok"}');
                return true;
            }

            // Force our custom session key (OpenClaw SDK doesn't respect the sessionKey param)
            route.sessionKey = sessionKey;

            // Build ctxPayload using runtime methods
            const cfg = runtime.config?.loadConfig?.() || {};
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
                        const isGroup = conversationId.startsWith("group:");
                        const targetId = isGroup ? conversationId.replace("group:", "") : conversationId.replace("private:", "");
                        const endpoint = isGroup ? "/send_group_msg" : "/send_private_msg";
                        const message = buildNapCatMessageFromReply(payload, config);
                        if (!message) {
                            console.log("[NapCat] Skip empty reply payload");
                            return;
                        }
                        const msgPayload = { message };
                        if (isGroup) msgPayload.group_id = targetId;
                        else msgPayload.user_id = targetId;
                        
                        console.log(`[NapCat] Sending reply to ${isGroup ? 'group' : 'private'} ${targetId}: ${message.substring(0, 50)}...`);
                        await sendToNapCat(`${baseUrl}${endpoint}`, msgPayload);
                        console.log("[NapCat] Reply sent successfully");
                    },
                    onError: (err, info) => {
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
                    deliver: async (payload) => {
                        console.log("[NapCat] Reply to deliver:", JSON.stringify(payload).substring(0, 100));
                        // Actually send the message via NapCat API
                        const config = getNapCatConfig();
                        const baseUrl = config.url || "http://127.0.0.1:3000";
                        const isGroup = conversationId.startsWith("group:");
                        const targetId = isGroup ? conversationId.replace("group:", "") : conversationId.replace("private:", "");
                        const endpoint = isGroup ? "/send_group_msg" : "/send_private_msg";
                        const message = buildNapCatMessageFromReply(payload, config);
                        if (!message) {
                            console.log("[NapCat] Skip empty reply payload");
                            return;
                        }
                        const msgPayload = { message };
                        if (isGroup) msgPayload.group_id = targetId;
                        else msgPayload.user_id = targetId;
                        
                        console.log(`[NapCat] Sending reply to ${isGroup ? 'group' : 'private'} ${targetId}: ${message.substring(0, 50)}...`);
                        await sendToNapCat(`${baseUrl}${endpoint}`, msgPayload);
                        console.log("[NapCat] Reply sent successfully");
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
            await runtime.channel.reply.dispatchReplyFromConfig({
                ctx: ctxPayload,
                cfg,
                dispatcher,
                replyOptions: {},
            });
            
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
