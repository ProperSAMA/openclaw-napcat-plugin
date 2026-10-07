import type { IncomingMessage } from "node:http";

export const WEBHOOK_MAX_BYTES = 1024 * 1024;
export const WEBHOOK_BODY_TIMEOUT_MS = 10_000;

export class WebhookBodyError extends Error {
    constructor(message: string, readonly statusCode: number) {
        super(message);
        this.name = "WebhookBodyError";
    }
}

export function readWebhookBody(
    req: IncomingMessage,
    options: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<Buffer> {
    const maxBytes = options.maxBytes ?? WEBHOOK_MAX_BYTES;
    const timeoutMs = options.timeoutMs ?? WEBHOOK_BODY_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
        let size = 0;
        let finished = false;
        const chunks: Buffer[] = [];
        const cleanup = () => {
            clearTimeout(timer);
            req.off("data", onData);
            req.off("end", onEnd);
            req.off("error", onError);
            req.off("aborted", onAborted);
            req.off("close", onClose);
        };
        const fail = (error: Error) => {
            if (finished) return;
            finished = true;
            req.pause(); // Let the handler send 413/408 before closing the connection.
            cleanup();
            // IncomingMessage may emit an error after its aborted event.
            req.once("error", () => {});
            reject(error);
        };
        const onError = (error: Error) => fail(error);
        const onAborted = () => fail(new WebhookBodyError("request body interrupted", 400));
        const onClose = () => { if (!req.complete) onAborted(); };
        const onData = (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > maxBytes) {
                fail(new WebhookBodyError("request body too large", 413));
                return;
            }
            chunks.push(buffer);
        };
        const onEnd = () => {
            if (finished) return;
            finished = true;
            cleanup();
            resolve(Buffer.concat(chunks, size));
        };
        const timer = setTimeout(() => fail(new WebhookBodyError("request body timed out", 408)), timeoutMs);
        req.on("data", onData);
        req.once("end", onEnd);
        req.once("error", onError);
        req.once("aborted", onAborted);
        req.once("close", onClose);
        const declaredLength = Number(req.headers["content-length"]);
        if (declaredLength > maxBytes) fail(new WebhookBodyError("request body too large", 413));
    });
}
