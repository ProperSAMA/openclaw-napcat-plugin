import type { IncomingMessage, ServerResponse } from "node:http";
import {
    getNapCatConfig,
    getInboundAudioContext,
    getInboundImageContext,
    getInboundMediaContext,
    getInboundVideoContext,
    handleNapCatGroupRequest,
    handleMediaProxyRequest,
    handleNapCatFriendRequest,
    handleNapCatMessageEvent,
    handleNapCatNoticeEvent,
    logInboundMessage,
    logInboundParseFailure,
} from "./index.js";

async function readBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => data += chunk);
        req.on("end", () => {
            try {
                if (!data) {
                    resolve({});
                    return;
                }
                resolve(JSON.parse(data));
            } catch (e) {
                console.error("NapCat JSON Parse Error:", e);
                try {
                    const params = new URLSearchParams(data);
                    const wrapped = params.get("payload") || params.get("data") || params.get("message");
                    if (wrapped) {
                        resolve(JSON.parse(wrapped));
                        return;
                    }
                } catch {
                    // Preserve raw body for diagnostics.
                }
                resolve({ __raw: data, __parseError: true });
            }
        });
        req.on("error", reject);
    });
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

export { getInboundMediaContext, getInboundImageContext, getInboundAudioContext, getInboundVideoContext };

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
        if (event.post_type === "request" && event.request_type === "group") {
            await handleNapCatGroupRequest(event, config);
            continue;
        }
        if (event.post_type === "notice") {
            await handleNapCatNoticeEvent(event, config);
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

    if (!url.startsWith("/napcat")) return false;

    if (method === "GET") {
        return handleMediaProxyRequest(res, url);
    }

    if (method !== "POST") {
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
