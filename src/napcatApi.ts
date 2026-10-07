// Shared NapCat HTTP layer. Both send paths go through here: the dispatcher's reply path
// (src/webhook.ts) and the channel adapter's outbound path (src/channel.ts). They used to
// carry separate senders with different result handling -- the adapter checked only the HTTP
// status, so an HTTP 200 carrying {"status":"failed"} was reported back to OpenClaw as a
// successful delivery. Keeping one implementation is what makes the two paths agree.
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

import { getNapCatConfig } from "./runtime.js";

export const NAPCAT_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

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
        let settled = false;
        let response: IncomingMessage | undefined;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: Error, result?: { statusCode: number; statusText: string; bodyText: string }) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            req.setTimeout(0);
            if (error) reject(error);
            else resolve(result!);
        };
        const interrupted = () => finish(Object.assign(new Error("NapCat response interrupted"), { code: "ECONNRESET" }));
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
                response = res;
                const chunks: Buffer[] = [];
                let size = 0;
                res.on("data", (chunk) => {
                    if (settled) return;
                    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    size += buffer.length;
                    if (size > NAPCAT_RESPONSE_MAX_BYTES) {
                        const error = new Error("NapCat response exceeds the size limit");
                        finish(error);
                        req.destroy(error);
                        return;
                    }
                    chunks.push(buffer);
                });
                res.once("error", (error) => finish(error));
                res.once("aborted", interrupted);
                res.once("close", () => { if (!res.complete) interrupted(); });
                res.once("end", () => finish(undefined, {
                    statusCode: res.statusCode || 0,
                    statusText: res.statusMessage || "",
                    bodyText: Buffer.concat(chunks).toString("utf8"),
                }));
            }
        );

        const timeout = () => {
            const error = Object.assign(new Error(`NapCat request timeout after ${timeoutMs}ms`), { code: "ETIMEDOUT" });
            finish(error);
            req.destroy(error);
        };
        // Socket inactivity alone does not bound a peer that trickles response bytes.
        deadline = setTimeout(timeout, timeoutMs);
        req.setTimeout(timeoutMs, timeout);
        req.once("error", (error) => finish(error));
        req.once("close", () => { if (!response) interrupted(); });
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
    /** Overall deadline per attempt, including response reads. */
    timeoutMs?: number;
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
            const timeoutMs = options.timeoutMs ?? timeoutsMs[Math.min(attempt - 1, timeoutsMs.length - 1)];
            const res = await postJsonWithNodeHttp(url, payload, timeoutMs, { connectionClose, token });

            if (res.statusCode < 200 || res.statusCode >= 300) {
                throw new Error(`NapCat API Error: ${res.statusCode} ${res.statusText}${res.bodyText ? ` | ${res.bodyText.slice(0, 300)}` : ""}`);
            }

            let parsed: any;
            try {
                parsed = JSON.parse(res.bodyText);
            } catch {
                throw new Error("NapCat returned an invalid JSON response; delivery outcome is unknown");
            }
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("NapCat returned an invalid response envelope; delivery outcome is unknown");
            }
            if (!["ok", "failed"].includes(parsed.status)
                || (parsed.retcode !== undefined && !Number.isInteger(parsed.retcode))) {
                throw new Error("NapCat returned an invalid response envelope; delivery outcome is unknown");
            }
            if (isNapCatFailedResponse(parsed)) {
                throw new NapCatBusinessError(`NapCat API returned failure: ${res.bodyText.slice(0, 300)}`, {
                    retcode: Number(parsed?.retcode ?? parsed?.data?.retcode ?? 0),
                    status: String(parsed?.status ?? parsed?.data?.status ?? ""),
                    responseBody: res.bodyText.slice(0, 300),
                });
            }
            if (parsed.status !== "ok"
                || (parsed.retcode !== undefined && parsed.retcode !== 0)) {
                throw new Error("NapCat returned an invalid success envelope; delivery outcome is unknown");
            }
            const elapsedMs = Date.now() - startedAt;
            console.log(`[NapCat] sendToNapCat success attempt ${attempt}/${maxAttempts} ${targetInfo} in ${elapsedMs}ms (connection=${connectionClose ? "close" : "keep-alive"})`);
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

function requireMessageReceipt(result: any): any {
    const id = result?.data?.message_id;
    if ((typeof id !== "string" && typeof id !== "number") || !/^-?\d+$/.test(String(id))) {
        throw new Error("NapCat returned no message receipt; delivery outcome is unknown");
    }
    return result;
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
        return requireMessageReceipt(await sendToNapCat(url, payload, token, { allowRetry: false }));
    } catch (err) {
        if (!(err instanceof NapCatBusinessError)) throw err;
        const message = typeof payload?.message === "string" ? payload.message : "";
        if (!NAPCAT_QUOTE_PREFIX_RE.test(message)) throw err;
        console.warn("[NapCat] Quote-reply rejected; retrying without [CQ:reply]:", err.message);
        return requireMessageReceipt(await sendToNapCat(
            url,
            { ...payload, message: message.replace(NAPCAT_QUOTE_PREFIX_RE, "") },
            token,
            { allowRetry: false },
        ));
    }
}
