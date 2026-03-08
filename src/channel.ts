import {
    buildNapCatMediaCq,
    dispatchNapCatAction,
    looksLikeNapCatTargetId,
    napcatChannelConfigSchema,
    normalizeNapCatTarget,
    parseNapCatTarget,
    setNapCatConfig,
    sendNapCatByTransport,
} from "./index.js";

export const napcatPlugin = {
    id: "napcat",
    meta: {
        id: "napcat",
        name: "NapCatQQ",
        systemImage: "message",
    },
    capabilities: {
        chatTypes: ["direct", "group"],
        text: true,
        media: true,
    },
    messaging: {
        normalizeTarget: normalizeNapCatTarget,
        targetResolver: {
            looksLikeId: looksLikeNapCatTargetId,
            hint: "优先使用 agent:<agentId>:session:napcat:(private|group):<id>；也支持 session:napcat:private:<QQ号> / session:napcat:group:<群号> / private:<QQ号> / group:<群号> / action:<NapCat接口名>。不要使用纯数字 target，也不要使用旧的 agent:<agentId>:napcat:* 标签。",
        },
    },
    configSchema: napcatChannelConfigSchema,
    config: {
        listAccountIds: () => ["default"],
        resolveAccount: (cfg: any) => {
            setNapCatConfig(cfg.channels?.napcat || {});
            return {
                accountId: "default",
                name: "Default NapCat",
                enabled: true,
                configured: true,
                config: cfg.channels?.napcat || {},
            };
        },
        isConfigured: () => true,
    },
    outbound: {
        deliveryMode: "direct",
        sendText: async ({ to, text, cfg }: any) => {
            const config = cfg.channels?.napcat || {};
            const parsedTarget = parseNapCatTarget(to);

            try {
                if (parsedTarget.kind === "action") {
                    const result = await dispatchNapCatAction(config, parsedTarget.action, text);
                    return { ok: true, action: parsedTarget.action, result };
                }

                const targetType = parsedTarget.kind;
                const targetId = parsedTarget.targetId;
                const endpoint = targetType === "group" ? "/send_group_msg" : "/send_private_msg";
                const payload: any = { message: text };
                if (targetType === "group") payload.group_id = targetId;
                else payload.user_id = targetId;

                console.log(`[NapCat] Sending to ${targetType} ${targetId}: ${text}`);
                const result = await sendNapCatByTransport(config, endpoint, payload);
                return { ok: true, result };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        },
        sendMedia: async ({ to, text, mediaUrl, cfg }: any) => {
            const config = cfg.channels?.napcat || {};
            const parsedTarget = parseNapCatTarget(to);
            if (parsedTarget.kind === "action") {
                return { ok: false, error: "NapCat action 调用不支持 mediaUrl，请改用 text 传 JSON 参数" };
            }

            const targetType = parsedTarget.kind;
            const targetId = parsedTarget.targetId;
            const endpoint = targetType === "group" ? "/send_group_msg" : "/send_private_msg";

            const mediaMessage = mediaUrl ? buildNapCatMediaCq(mediaUrl, config) : "";
            const message = text ? (mediaMessage ? `${text}\n${mediaMessage}` : text) : (mediaMessage || "");

            const payload: any = { message };
            if (targetType === "group") payload.group_id = targetId;
            else payload.user_id = targetId;

            console.log(`[NapCat] Sending media to ${targetType} ${targetId}: ${message}`);

            try {
                const result = await sendNapCatByTransport(config, endpoint, payload);
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
        },
    },
};
