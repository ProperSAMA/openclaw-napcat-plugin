// Minimal NapCat Channel Implementation
import { setNapCatConfig } from "./runtime.js";

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

export const napcatPlugin = {
    id: "napcat",
    meta: {
        id: "napcat",
        name: "NapCatQQ",
        systemImage: "message"
    },
    capabilities: {
        chatTypes: ["direct", "group"],
        text: true,
        media: true
    },
    messaging: {
        normalizeTarget: normalizeNapCatTarget,
        targetResolver: {
            looksLikeId: looksLikeNapCatTargetId,
            hint: "private:<QQ号> / group:<群号> / session:napcat:private:<QQ号> / session:napcat:group:<群号>"
        }
    },
    configSchema: {
        type: "object",
        properties: {
            url: { type: "string", title: "NapCat HTTP URL", default: "http://127.0.0.1:3000" },
            allowUsers: {
                type: "array",
                items: { type: "string" },
                title: "Allowed User IDs",
                description: "Only accept messages from these QQ user IDs (empty = accept all)",
                default: []
            },
            enableGroupMessages: {
                type: "boolean",
                title: "Enable Group Messages",
                description: "When enabled, process group messages (requires mention to trigger)",
                default: false
            },
            groupMentionOnly: {
                type: "boolean",
                title: "Require Mention in Group",
                description: "In group chats, only respond when the bot is mentioned (@)",
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
                description: "Optional token required by /napcat/media endpoint",
                default: ""
            }
        }
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
        sendText: async ({ to, text, cfg }: any) => {
            const config = cfg.channels?.napcat || {};
            const baseUrl = config.url || "http://127.0.0.1:3000";
            
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
            const payload: any = { message: text };
            if (targetType === "group") payload.group_id = targetId;
            else payload.user_id = targetId;

            console.log(`[NapCat] Sending to ${targetType} ${targetId}: ${text}`);
            
            try {
                const result = await sendToNapCat(`${baseUrl}${endpoint}`, payload);
                return { ok: true, result };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        },
        sendMedia: async ({ to, text, mediaUrl, cfg }: any) => {
            const config = cfg.channels?.napcat || {};
            const baseUrl = config.url || "http://127.0.0.1:3000";

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

            // Basic media support: try CQ image format, fallback to plain URL.
            const proxiedMediaUrl = mediaUrl ? buildMediaProxyUrl(mediaUrl, config) : "";
            const mediaMessage = mediaUrl
                ? `[CQ:image,file=${proxiedMediaUrl}]`
                : "";
            const message = text
                ? (mediaMessage ? `${text}\n${mediaMessage}` : text)
                : (mediaMessage || "");

            const payload: any = { message };
            if (targetType === "group") payload.group_id = targetId;
            else payload.user_id = targetId;

            console.log(`[NapCat] Sending media to ${targetType} ${targetId}: ${message}`);

            try {
                const result = await sendToNapCat(`${baseUrl}${endpoint}`, payload);
                return { ok: true, result };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        },
    },
    gateway: {
        startAccount: async () => {
             console.log("[NapCat] Plugin active. Listening on /napcat");
             return { stop: () => {} };
        }
    }
};
