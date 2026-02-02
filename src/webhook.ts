import type { IncomingMessage, ServerResponse } from "node:http";
import { getNapCatRuntime, getNapCatConfig } from "./runtime.js";

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

export async function handleNapCatWebhook(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = req.url || "";
    const method = req.method || "UNKNOWN";
    
    console.log(`[NapCat] Incoming request: ${method} ${url}`);
    
    // Accept /napcat, /napcat/, or any path starting with /napcat
    if (!url.startsWith("/napcat")) return false;
    
    if (method !== "POST") {
        // For non-POST requests to /napcat endpoints, return 405
        res.statusCode = 405;
        res.setHeader("Content-Type", "application/json");
        res.end('{"status":"error","message":"Method Not Allowed"}');
        return true;
    }

    try {
        const body = await readBody(req);

        // Heartbeat / Lifecycle
        if (body.post_type === "meta_event") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end('{"status":"ok"}');
            return true;
        }

        if (body.post_type === "message") {
            const runtime = getNapCatRuntime();
            const config = getNapCatConfig();
            const isGroup = body.message_type === "group";
            const senderId = String(body.user_id);
            const rawText = body.raw_message || "";
            let text = rawText;

            // Get allowUsers from config
            const allowUsers = config.allowUsers || [];

            // Check allowlist (if configured)
            if (allowUsers.length > 0 && !allowUsers.includes(senderId)) {
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

            // Log for debugging
            console.log(`[NapCat] Inbound from ${senderId} (conv: ${conversationId}): ${text.substring(0, 50)}...`);

            // Resolve route for this message
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

            // Build ctxPayload using runtime methods
            const cfg = runtime.config?.loadConfig?.() || {};
            const ctxPayload = {
                Body: text,
                RawBody: rawText,
                CommandBody: text,
                From: `napcat:${conversationId}`,
                To: "me",
                SessionKey: route.sessionKey,
                AccountId: route.accountId,
                ChatType: isGroup ? "group" : "direct",
                ConversationLabel: senderName,
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
                        const msgPayload = { message: payload.text };
                        if (isGroup) msgPayload.group_id = targetId;
                        else msgPayload.user_id = targetId;
                        
                        console.log(`[NapCat] Sending reply to ${isGroup ? 'group' : 'private'} ${targetId}: ${payload.text?.substring(0, 50)}...`);
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
                        const msgPayload = { message: payload.text };
                        if (isGroup) msgPayload.group_id = targetId;
                        else msgPayload.user_id = targetId;
                        
                        console.log(`[NapCat] Sending reply to ${isGroup ? 'group' : 'private'} ${targetId}: ${payload.text?.substring(0, 50)}...`);
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
