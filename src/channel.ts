// Minimal NapCat Channel Implementation
import path from "node:path";
import { access, copyFile, mkdir, unlink } from "node:fs/promises";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelMessagingAdapter, ChannelPlugin } from "openclaw/plugin-sdk/core";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import {
    jsonResult,
    readReactionParams,
    resolveReactionMessageId,
} from "openclaw/plugin-sdk/channel-actions";
import { buildNapCatMediaCq, isAudioMedia, redactNapCatMediaForLog, resolveLocalFilePath } from "./media.js";
import { NapCatBusinessError, sendNapCatMessage, sendToNapCat } from "./napcatApi.js";
import { formatNapCatOutgoingText } from "./plainText.js";
import { resolveNapCatEmojiId } from "./reactions.js";
import {
    getNapCatGroupReplySender,
    isNapCatGroupQuoteReplyEnabled,
    resolveNapCatConversationConfig,
    setNapCatConfig,
    startNapCatGroupReplyContextSweeper,
} from "./runtime.js";

const recentTextDeliveries = new Map<string, {
    expiresAt: number;
    promise: Promise<any>;
}>();
const RECENT_TEXT_DELIVERY_TTL_MS = 15_000;
let fallbackMessageIdSequence = 0;

// Addresses a group send to the turn it answers. The turn is identified by the id core attaches
// to the send (ctx.replyToId): an inbound message that triggered this reply, or an id the agent
// named explicitly. Without one this is not a reply to any turn -- a scheduled announcement, a
// proactive message -- and goes out with no prefix, even if a turn for the same group ended
// moments ago. That is the whole point: addressing must not outlive the turn that produced it.
function withActiveGroupReplyPrefix(
    message: string,
    targetType: string,
    targetId: string,
    config: any,
    replyToId?: string
): string {
    if (targetType !== "group" || !message) return message;

    const triggerMessageId = String(replyToId ?? "").trim();
    if (!/^\d+$/.test(triggerMessageId)) return message;

    if (isNapCatGroupQuoteReplyEnabled(config)) {
        const reply = `[CQ:reply,id=${triggerMessageId}]`;
        if (message.includes(reply)) return message;
        return `${reply} ${message}`;
    }

    // groupReplyQuote is off for this conversation, so @ the sender of that same turn. Core's id
    // carries no sender, so it comes from the context registered under this message id -- and
    // only from there. An id nobody registered yields no prefix rather than the wrong person.
    const mentionUserId = String(getNapCatGroupReplySender(targetId, triggerMessageId) || "").trim();
    if (!/^\d+$/.test(mentionUserId)) return message;
    const mention = `[CQ:at,qq=${mentionUserId}]`;
    if (message.includes(mention)) return message;
    return `${mention} ${message}`;
}

function resolveNapCatMessageId(result: any): string {
    const candidates = [
        result?.data?.message_id,
        result?.data?.messageId,
        result?.message_id,
        result?.messageId,
        result?.data?.file_id,
        result?.data?.fileId,
        result?.echo,
    ];
    for (const candidate of candidates) {
        if (candidate !== undefined && candidate !== null && String(candidate).trim()) {
            return String(candidate);
        }
    }
    fallbackMessageIdSequence += 1;
    return `napcat-ack-${Date.now()}-${fallbackMessageIdSequence}`;
}

function toOutboundDeliveryResult(result: any, targetId: string) {
    return {
        channel: "napcat",
        messageId: resolveNapCatMessageId(result),
        chatId: targetId,
    };
}

async function sendTextToNapCatOnce(
    url: string,
    payload: any,
    token: string,
    deliveryKey: string,
) {
    const now = Date.now();
    for (const [key, entry] of recentTextDeliveries) {
        if (entry.expiresAt <= now) recentTextDeliveries.delete(key);
    }

    const existing = recentTextDeliveries.get(deliveryKey);
    if (existing && existing.expiresAt > now) {
        console.warn(`[NapCat] Suppressed duplicate outbound delivery: ${deliveryKey.split("\u0000").slice(0, 2).join(" ")}`);
        return existing.promise;
    }

    // Message sends are non-idempotent, so allowRetry stays off inside the sender and a
    // rejected quote is degraded there rather than by resending this same payload.
    const promise = sendNapCatMessage(url, payload, token);
    recentTextDeliveries.set(deliveryKey, {
        expiresAt: now + RECENT_TEXT_DELIVERY_TTL_MS,
        promise,
    });
    try {
        return await promise;
    } catch (err) {
        recentTextDeliveries.delete(deliveryKey);
        throw err;
    }
}

async function uploadGroupFileToNapCat(url: string, payload: {
    groupId: string;
    filePath: string;
    fileName: string;
    folder?: string;
}, token?: string) {
    // NapCat upload_group_file expects JSON payload (go-cqhttp style), not multipart form-data.
    const requestPayload: Record<string, unknown> = {
        group_id: payload.groupId,
        file: payload.filePath,
        name: payload.fileName,
        upload_file: true,
    };
    if (payload.folder) {
        requestPayload.folder = payload.folder;
    }
    // Uploading the same file twice produces two group files, so this must never be retried.
    return await sendToNapCat(url, requestPayload, token, { allowRetry: false });
}

async function ensureReadableFile(filePath: string): Promise<void> {
    await access(filePath);
}

function getContainerVisiblePath(localPath: string, config: any): string | null {
    const hostPrefix = String(config.groupFileHostPrefix || "").trim().replace(/\/+$/, "");
    const containerPrefix = String(config.groupFileContainerPrefix || "").trim().replace(/\/+$/, "");
    if (!hostPrefix || !containerPrefix) return null;
    if (!localPath.startsWith(hostPrefix + "/") && localPath !== hostPrefix) return null;
    const relative = localPath.slice(hostPrefix.length).replace(/^\/+/, "");
    return `${containerPrefix}/${relative}`;
}

async function stageFileForNapCat(localPath: string, config: any): Promise<string | null> {
    const hostStageDir = String(config.groupFileStageHostDir || "").trim();
    const containerStageDir = String(config.groupFileStageContainerDir || "").trim();
    if (!hostStageDir || !containerStageDir) return null;

    const fileName = path.basename(localPath);
    const stagedHostPath = path.join(hostStageDir, fileName);
    await mkdir(hostStageDir, { recursive: true });
    await copyFile(localPath, stagedHostPath);
    return `${containerStageDir.replace(/\/+$/, "")}/${fileName}`;
}

function isNapCatGroupFileCandidate(mediaUrl: string): boolean {
    if (!mediaUrl) return false;
    if (/^https?:\/\//i.test(mediaUrl)) return false;
    const lower = mediaUrl.toLowerCase();
    if (isAudioMedia(lower)) return false;
    if (/\.(png|jpe?g|gif|webp|bmp|svg)(?:\?.*)?$/i.test(lower)) return false;
    return true;
}

function waitUntilAbort(signal?: AbortSignal, onAbort?: () => void): Promise<void> {
    return new Promise((resolve) => {
        const complete = () => {
            onAbort?.();
            resolve();
        };
        if (!signal) return;
        if (signal.aborted) {
            complete();
            return;
        }
        signal.addEventListener("abort", complete, { once: true });
    });
}

function normalizeNapCatTarget(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return trimmed;
    const withoutProvider = trimmed.replace(/^napcat:/i, "");
    const sessionMatch = withoutProvider.match(/^session:napcat:(private|group):(\d+)$/i);
    if (sessionMatch) {
        return `session:napcat:${sessionMatch[1].toLowerCase()}:${sessionMatch[2]}`;
    }
    const directMatch = withoutProvider.match(/^(private|group):(\d+)$/i);
    if (directMatch) {
        return `${directMatch[1].toLowerCase()}:${directMatch[2]}`;
    }
    if (/^\d+$/.test(withoutProvider)) {
        return withoutProvider;
    }
    return withoutProvider.toLowerCase();
}

function looksLikeNapCatTargetId(raw: string, normalized?: string): boolean {
    const target = (normalized || raw).trim();
    return (
        /^session:napcat:(private|group):\d+$/i.test(target) ||
        /^(private|group):\d+$/i.test(target) ||
        /^\d+$/.test(target)
    );
}

function parseNapCatSessionTarget(raw: string): { chatType: "direct" | "group"; peerId: string } | null {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) return null;
    const withoutProvider = trimmed.replace(/^napcat:/i, "");
    const match = withoutProvider.match(/^(?:session:napcat:)?(private|group):(\d+)$/i);
    if (!match) return null;
    return {
        chatType: match[1].toLowerCase() === "group" ? "group" : "direct",
        peerId: match[2],
    };
}

const inferNapCatTargetChatType: NonNullable<ChannelMessagingAdapter["inferTargetChatType"]> = ({ to }) => {
    return parseNapCatSessionTarget(to)?.chatType;
};

const resolveNapCatOutboundSessionRoute: NonNullable<ChannelMessagingAdapter["resolveOutboundSessionRoute"]> = (params) => {
    const parsed = parseNapCatSessionTarget(params.target);
    if (!parsed) return null;
    const agentId = String(params.agentId || "").trim().toLowerCase() || "main";
    const conversationType = parsed.chatType === "group" ? "group" : "private";
    const peer = { kind: parsed.chatType, id: parsed.peerId } as const;
    const sessionConfig = params.cfg.session as any;
    // The current SDK accepts mainKey/groupScope; the cast keeps the plugin
    // buildable against the older supported SDK until the dependency floor is raised.
    const buildSessionKey = buildAgentSessionKey as (options: Record<string, unknown>) => string;
    const sessionKey = buildSessionKey({
        agentId,
        mainKey: sessionConfig?.mainKey,
        channel: "napcat",
        accountId: params.accountId,
        peer,
        dmScope: sessionConfig?.dmScope,
        groupScope: sessionConfig?.groupScope,
        identityLinks: sessionConfig?.identityLinks,
    });
    const conversationId = `${conversationType}:${parsed.peerId}`;
    return {
        sessionKey,
        baseSessionKey: sessionKey,
        recipientSessionExact: true,
        peer,
        chatType: parsed.chatType,
        from: `napcat:${conversationId}`,
        // Core uses route.to as the delivery target handed to outbound.sendText,
        // which parses `private:<id>` / `group:<id>` (no `napcat:` prefix).
        to: conversationId,
    };
};

export const napcatMessageActions: ChannelMessageActionAdapter = {
    supportsAction: ({ action }) => action === "react",
    describeMessageTool: () => ({
        actions: ["react"],
        capabilities: [],
        schema: null,
    }),
    handleAction: async ({ action, params, cfg, toolContext }) => {
        if (action !== "react") {
            throw new Error(`NapCat message action is not supported: ${action}`);
        }

        const messageId = resolveReactionMessageId({ args: params, toolContext });
        if (messageId === undefined || messageId === null || !String(messageId).trim()) {
            throw new Error(
                "messageId required. Provide messageId explicitly or react to the current inbound message."
            );
        }
        const { emoji, remove } = readReactionParams(params, {
            removeErrorMessage: "Emoji is required to remove a NapCat reaction.",
        });
        const emojiId = resolveNapCatEmojiId(emoji);
        const config = cfg.channels?.napcat || {};
        const baseUrl = config.url || "http://127.0.0.1:15150";
        const token = String(config.token || "").trim();

        // The sender now rejects on a NapCat-level failure instead of handing back the failed
        // body, so the structured "do not retry" hint is produced here rather than from a
        // post-hoc check on the result. A rejected reaction is a legitimate answer for the
        // agent, not an exception, so only business failures are converted.
        try {
            await sendToNapCat(`${baseUrl}/set_msg_emoji_like`, {
                message_id: String(messageId),
                emoji_id: emojiId,
                set: !remove,
            }, token);
        } catch (err) {
            if (!(err instanceof NapCatBusinessError)) throw err;
            return jsonResult({
                ok: false,
                reason: "reaction_failed",
                emoji,
                emojiId,
                hint: "NapCat rejected this reaction. Check the messageId and use an emoji supported by QQ. Do not retry unchanged.",
            });
        }

        return jsonResult({
            ok: true,
            messageId: String(messageId),
            emoji,
            emojiId,
            removed: remove,
        });
    },
};

const napcatMessaging: ChannelMessagingAdapter = {
    normalizeTarget: normalizeNapCatTarget,
    inferTargetChatType: inferNapCatTargetChatType,
    resolveOutboundSessionRoute: resolveNapCatOutboundSessionRoute,
    targetResolver: {
        looksLikeId: looksLikeNapCatTargetId,
        hint: "private:<QQ号> / group:<群号> / session:napcat:private:<QQ号> / session:napcat:group:<群号>"
    }
};

export const napcatPlugin = {
    id: "napcat",
    meta: {
        id: "napcat",
        label: "NapCat QQ",
        selectionLabel: "NapCat QQ (OneBot 11)",
        docsPath: "/channels/napcat",
        blurb: "Connect OpenClaw to QQ through NapCat and OneBot 11.",
        systemImage: "message",
        markdownCapable: false,
    },
    capabilities: {
        chatTypes: ["direct", "group"],
        media: true,
        reactions: true,
        blockStreaming: true
    },
    streaming: {
        blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 }
    },
    messaging: napcatMessaging,
    actions: napcatMessageActions,
    configSchema: {
        schema: {
            type: "object",
            properties: {
            url: { type: "string", title: "NapCat HTTP URL", default: "http://127.0.0.1:15150" },
            agentId: {
                type: "string",
                title: "Default Agent ID",
                description: "Optional default OpenClaw agent for NapCat; explicit OpenClaw bindings take precedence",
                default: ""
            },
            allowUsers: {
                type: "array",
                items: { type: "string" },
                title: "Allowed User IDs",
                description: "Only accept messages from these QQ user IDs (empty = accept all)",
                default: []
            },
            groupWhitelist: {
                type: "array",
                items: { type: "string" },
                title: "Group Whitelist",
                description: "Only accept messages from these QQ group IDs when non-empty",
                default: []
            },
            enableGroupMessages: {
                type: "boolean",
                title: "Enable Group Messages",
                description: "When enabled, process group messages (requires mention to trigger)",
                default: false
            },
            streaming_mode: {
                type: "boolean",
                title: "Streaming Mode",
                description: "Stream replies as incremental QQ messages instead of waiting for the final combined response",
                default: false
            },
            enable_progress_messages: {
                type: "boolean",
                title: "Enable Progress Messages",
                description: "Send assistant intermediate progress (commentary) messages to QQ as well, throttled to 1 per 3s per conversation",
                default: false
            },
            groupReplyQuote: {
                type: "boolean",
                title: "Quote Reply in Groups",
                description: "In group chats, reply by quoting the triggering message ([CQ:reply]) instead of @-mentioning the sender. Off by default; overridable per conversation",
                default: false
            },
            conversationConfigDir: {
                type: "string",
                title: "Per-Conversation Config Directory",
                description: "Directory of per-conversation JSON overrides (default.json plus <group|private>-<id>.json). A missing directory disables the feature",
                default: "~/.openclaw/napcat/conversations"
            },
            plainTextMode: {
                type: "boolean",
                title: "Plain Text Mode",
                description: "Convert outgoing Markdown-style text to QQ-friendly plain text",
                default: true
            },
            groupMentionOnly: {
                type: "boolean",
                title: "Require Mention in Group",
                description: "In group chats, only respond when the bot is mentioned (@)",
                default: true
            },
            enablePrivateTypingStatus: {
                type: "boolean",
                title: "Enable Private Typing Status",
                description: "Show QQ 'typing' status in private chats while OpenClaw is processing a reply",
                default: true
            },
            mediaProxyEnabled: {
                type: "boolean",
                title: "Enable Media Proxy",
                description: "Expose /napcat/media endpoint so NapCat can fetch media from OpenClaw host",
                default: false
            },
            publicBaseUrl: {
                type: "string",
                title: "OpenClaw Public Base URL",
                description: "Base URL reachable by NapCat device, e.g. http://192.168.1.10:18789",
                default: ""
            },
            mediaProxyToken: {
                type: "string",
                title: "Media Proxy Token",
                description: "Required access token when the media proxy is enabled",
                default: ""
            },
            mediaProxyAllowedRoots: {
                type: "array",
                items: { type: "string" },
                title: "Media Proxy Allowed Roots",
                description: "Absolute host directories whose local media files may be served by the proxy",
                default: []
            },
            voiceBasePath: {
                type: "string",
                title: "Voice Base Path",
                description: "Base directory for relative audio files (e.g. /tmp/napcat-voice)",
                default: ""
            },
            groupFileFolder: {
                type: "string",
                title: "Group File Default Folder",
                description: "Optional NapCat group file folder path used by /upload_group_file",
                default: ""
            },
            groupFileHostPrefix: {
                type: "string",
                title: "Group File Host Prefix",
                description: "Host path prefix that is mounted into NapCat container (e.g. /Users/me/shared)",
                default: ""
            },
            groupFileContainerPrefix: {
                type: "string",
                title: "Group File Container Prefix",
                description: "Container path prefix matching host prefix (e.g. /app/shared)",
                default: ""
            },
            groupFileStageHostDir: {
                type: "string",
                title: "Group File Stage Host Dir",
                description: "Host directory (mounted into NapCat container) to stage files before upload",
                default: ""
            },
            groupFileStageContainerDir: {
                type: "string",
                title: "Group File Stage Container Dir",
                description: "Container directory corresponding to stage host dir (e.g. /app/napcat/plugins/upload-staging)",
                default: ""
            },
            enableInboundLogging: {
                type: "boolean",
                title: "Enable Inbound Message Logging",
                description: "Log all received QQ/group messages before allowlist filtering",
                default: true
            },
            inboundLogDir: {
                type: "string",
                title: "Inbound Log Directory",
                description: "Directory to store per-user/per-group inbound logs",
                default: "./logs/napcat-inbound"
            },
            token: {
                type: "string",
                title: "HTTP API Token",
                description: "Token for authenticating with NapCat HTTP server (Bearer token)",
                default: ""
            }
            }
        },
    },
    config: {
        listAccountIds: () => ["default"],
        resolveAccount: (cfg: any) => {
            // Save config for webhook access
            setNapCatConfig(cfg.channels?.napcat || {});
            return {
                accountId: "default",
                name: "Default NapCat",
                enabled: true,
                configured: true,
                config: cfg.channels?.napcat || {}
            };
        },
        isConfigured: () => true,
    },
    outbound: {
        deliveryMode: "direct",
        sendText: async ({ to, text, cfg, replyToId }: any) => {
            const config = cfg.channels?.napcat || {};
            const baseUrl = config.url || "http://127.0.0.1:15150";
            const token = String(config.token || "").trim();
            
            let targetType = "private";
            let targetId = to;
            
            if (to.startsWith("group:")) {
                targetType = "group";
                targetId = to.replace("group:", "");
            } else if (to.startsWith("private:")) {
                targetType = "private";
                targetId = to.replace("private:", "");
            } else if (to.startsWith("session:napcat:private:")) {
                targetType = "private";
                targetId = to.replace("session:napcat:private:", "");
            } else if (to.startsWith("session:napcat:group:")) {
                targetType = "group";
                targetId = to.replace("session:napcat:group:", "");
            }

            // Fallback for direct user input of ID
            if (!to.includes(":")) {
                // If it looks like a group ID (usually same length as user ID, hard to tell)
                // We default to private if not specified.
            }

            const endpoint = targetType === "group" ? "/send_group_msg" : "/send_private_msg";
            const convConfig = resolveNapCatConversationConfig(config, `${targetType}:${targetId}`);
            const message = withActiveGroupReplyPrefix(
                formatNapCatOutgoingText(text, convConfig),
                targetType,
                targetId,
                convConfig,
                replyToId
            );
            const payload: any = { message };
            if (targetType === "group") payload.group_id = targetId;
            else payload.user_id = targetId;

            console.log(`[NapCat] Sending to ${targetType} ${targetId}: ${message}`);
            
            const deliveryKey = `${endpoint}\u0000${targetId}\u0000${message}`;
            const result = await sendTextToNapCatOnce(
                `${baseUrl}${endpoint}`,
                payload,
                token,
                deliveryKey,
            );
            return toOutboundDeliveryResult(result, targetId);
        },
        sendMedia: async ({ to, text, mediaUrl, cfg, replyToId }: any) => {
            const config = cfg.channels?.napcat || {};
            const baseUrl = config.url || "http://127.0.0.1:15150";
            const token = String(config.token || "").trim();

            let targetType = "private";
            let targetId = to;

            if (to.startsWith("group:")) {
                targetType = "group";
                targetId = to.replace("group:", "");
            } else if (to.startsWith("private:")) {
                targetType = "private";
                targetId = to.replace("private:", "");
            } else if (to.startsWith("session:napcat:private:")) {
                targetType = "private";
                targetId = to.replace("session:napcat:private:", "");
            } else if (to.startsWith("session:napcat:group:")) {
                targetType = "group";
                targetId = to.replace("session:napcat:group:", "");
            }

            const endpoint = targetType === "group" ? "/send_group_msg" : "/send_private_msg";

            const isGroupFile =
                targetType === "group" &&
                !!mediaUrl &&
                isNapCatGroupFileCandidate(mediaUrl);

            if (isGroupFile) {
                let stagedPath: string | null = null;
                try {
                    const localFilePath = resolveLocalFilePath(mediaUrl!);
                    if (!localFilePath) {
                        throw new Error("Group file upload requires a local path or file:// URL");
                    }
                    await ensureReadableFile(localFilePath);
                    const fileName = path.basename(localFilePath);
                    const folder = String(config.groupFileFolder || "").trim();

                    const mappedPath = getContainerVisiblePath(localFilePath, config);
                    stagedPath = mappedPath ? null : await stageFileForNapCat(localFilePath, config);
                    const uploadFilePath = mappedPath || stagedPath || localFilePath;

                    if (uploadFilePath === localFilePath && !mappedPath && !stagedPath) {
                        throw new Error("Group file path is not container-visible. Configure groupFileHostPrefix/groupFileContainerPrefix or groupFileStageHostDir/groupFileStageContainerDir.");
                    }

                    const uploadPayload = {
                        groupId: targetId,
                        filePath: uploadFilePath,
                        fileName,
                        folder: folder || undefined,
                    };
                    console.log(`[NapCat] upload_group_file local=${localFilePath} uploadFilePath=${uploadFilePath} payload=${JSON.stringify({
                        group_id: uploadPayload.groupId,
                        file: uploadPayload.filePath,
                        name: uploadPayload.fileName,
                        folder: uploadPayload.folder ?? null,
                        upload_file: true,
                    })}`);
                    const uploadResult = await uploadGroupFileToNapCat(`${baseUrl}/upload_group_file`, uploadPayload, token);

                    const convConfig = resolveNapCatConversationConfig(config, `${targetType}:${targetId}`);
                    const plainText = withActiveGroupReplyPrefix(
                        formatNapCatOutgoingText(text || "", convConfig),
                        targetType,
                        targetId,
                        convConfig,
                        replyToId
                    );
                    if (plainText && plainText.trim()) {
                        await sendNapCatMessage(`${baseUrl}${endpoint}`, {
                            group_id: targetId,
                            message: plainText,
                        }, token);
                    }

                    console.log(`[NapCat] Uploaded group file to ${targetId}: ${localFilePath}`);
                    return toOutboundDeliveryResult(uploadResult, targetId);
                } catch (err: any) {
                    throw err;
                } finally {
                    if (stagedPath) {
                        try {
                            const hostStageDir = String(config.groupFileStageHostDir || "").trim().replace(/\/+$/, "");
                            const containerStageDir = String(config.groupFileStageContainerDir || "").trim().replace(/\/+$/, "");
                            if (hostStageDir && containerStageDir && stagedPath.startsWith(`${containerStageDir}/`)) {
                                const relative = stagedPath.slice(containerStageDir.length).replace(/^\/+/, "");
                                const stagedHostPath = path.join(hostStageDir, relative);
                                await unlink(stagedHostPath);
                                console.log(`[NapCat] Cleaned staged file: ${stagedHostPath}`);
                            }
                        } catch (cleanupErr: any) {
                            console.warn(`[NapCat] Failed to cleanup staged file ${stagedPath}: ${cleanupErr?.message || cleanupErr}`);
                        }
                    }
                }
            }

            // Basic media support: try CQ image/record format.
            const mediaMessage = mediaUrl
                ? await buildNapCatMediaCq(mediaUrl, config)
                : "";
            const convConfig = resolveNapCatConversationConfig(config, `${targetType}:${targetId}`);
            const plainText = formatNapCatOutgoingText(text || "", convConfig);
            const messageWithoutMention = plainText
                ? (mediaMessage ? `${plainText}\n${mediaMessage}` : plainText)
                : (mediaMessage || "");
            const message = withActiveGroupReplyPrefix(messageWithoutMention, targetType, targetId, convConfig, replyToId);

            const payload: any = { message };
            if (targetType === "group") payload.group_id = targetId;
            else payload.user_id = targetId;

            console.log(`[NapCat] Sending media to ${targetType} ${targetId}: ${redactNapCatMediaForLog(message)}`);

            const deliveryKey = `${endpoint}\u0000${targetId}\u0000${message}`;
            const result = await sendTextToNapCatOnce(
                `${baseUrl}${endpoint}`,
                payload,
                token,
                deliveryKey,
            );
            return toOutboundDeliveryResult(result, targetId);
        },
    },
    gateway: {
        startAccount: async (ctx?: any) => {
            ctx?.log?.info?.("NapCat plugin active. Listening on /napcat");
            console.log("[NapCat] Plugin active. Listening on /napcat");
            // Reclaims reply contexts for groups that went quiet; stopped with the account so
            // the timer never outlives the plugin.
            const stopGroupReplyContextSweeper = startNapCatGroupReplyContextSweeper();
            return waitUntilAbort(ctx?.abortSignal, () => {
                stopGroupReplyContextSweeper();
                ctx?.log?.info?.("NapCat plugin stopped");
                console.log("[NapCat] Plugin stopped");
            });
        }
    }
} satisfies ChannelPlugin;
