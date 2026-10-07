// Shared NapCat HTTP layer. Both send paths go through here: the dispatcher's reply path
// (src/webhook.ts) and the channel adapter's outbound path (src/channel.ts). They used to
// carry separate senders with different result handling -- the adapter checked only the HTTP
// status, so an HTTP 200 carrying {"status":"failed"} was reported back to OpenClaw as a
// successful delivery. Keeping one implementation is what makes the two paths agree.
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

import { getNapCatConfig } from "./runtime.js";

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

export function isRetryableNapCatError(err: any): boolean {
    const code = String(err?.cause?.code || err?.code || "");
    return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "ECONNABORTED"].includes(code);
}

export function isNapCatFailedResponse(result: any): boolean {
    return result?.status === "failed" ||
        Number(result?.retcode || 0) !== 0 ||
        result?.data?.status === "failed" ||
        Number(result?.data?.retcode || 0) !== 0;
}

/**
 * NapCat answered and explicitly rejected the request. Its distinguishing property -- and the
 * reason it is a named type rather than a plain Error -- is that the request is known to have
 * been received and declined, so resending a degraded variant of it cannot duplicate a
 * delivery. A network error carries no such guarantee and must never be retried.
 */
export class NapCatBusinessError extends Error {
    readonly retcode: number | null;
    readonly status: string | null;
    readonly responseBody: string;

    constructor(message: string, options: { retcode?: number | null; status?: string | null; responseBody?: string } = {}) {
        super(message);
        this.name = "NapCatBusinessError";
        this.retcode = options.retcode ?? null;
        this.status = options.status ?? null;
        this.responseBody = options.responseBody ?? "";
    }
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

export type SendToNapCatOptions = {
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
                throw new NapCatBusinessError(`NapCat API returned failure: ${res.bodyText.slice(0, 300)}`, {
                    retcode: Number(parsed?.retcode ?? parsed?.data?.retcode ?? 0),
                    status: String(parsed?.status ?? parsed?.data?.status ?? ""),
                    responseBody: res.bodyText.slice(0, 300),
                });
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

export const NAPCAT_QUOTE_PREFIX_RE = /^\[CQ:reply,id=\d+\]\s*/;

/**
 * Sends one message, degrading a rejected quote to a plain send exactly once.
 *
 * A rejected [CQ:reply] id would otherwise drop the whole reply: message sends run with
 * allowRetry:false and the caller only logs the failure. Retrying without the prefix is safe
 * precisely because NapCat answered -- it declined the request, so nothing was delivered.
 * A network error means the outcome is unknown and NapCat may already have accepted the
 * message, so it is rethrown untouched rather than resent as a second, unquoted copy.
 */
export async function sendNapCatMessage(
    url: string,
    payload: Record<string, any>,
    token?: string
): Promise<any> {
    try {
        return await sendToNapCat(url, payload, token, { allowRetry: false });
    } catch (err) {
        if (!(err instanceof NapCatBusinessError)) throw err;
        const message = typeof payload?.message === "string" ? payload.message : "";
        if (!NAPCAT_QUOTE_PREFIX_RE.test(message)) throw err;
        console.warn("[NapCat] Quote-reply rejected; retrying without [CQ:reply]:", err.message);
        return await sendToNapCat(
            url,
            { ...payload, message: message.replace(NAPCAT_QUOTE_PREFIX_RE, "") },
            token,
            { allowRetry: false },
        );
    }
}
