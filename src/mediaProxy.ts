import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { readLocalFileFromRoots } from "openclaw/plugin-sdk/infra-runtime";
import { detectMime, kindFromMime, readResponseWithLimit } from "openclaw/plugin-sdk/media-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

export const MEDIA_PROXY_MAX_BYTES = 25 * 1024 * 1024;
export const MEDIA_PROXY_TIMEOUT_MS = 10_000;
export const MEDIA_PROXY_CHUNK_TIMEOUT_MS = 5_000;

export class MediaProxyError extends Error {
    constructor(
        message: string,
        readonly statusCode: number,
        readonly code: string,
    ) {
        super(message);
        this.name = "MediaProxyError";
    }
}

export type MediaProxyResource = {
    buffer: Buffer;
    contentType: string;
};

type GuardedFetch = typeof fetchWithSsrFGuard;
type LocalFileReader = typeof readLocalFileFromRoots;

export type MediaProxyDependencies = {
    guardedFetch?: GuardedFetch;
    readLocalFile?: LocalFileReader;
};

export function mediaProxyTokensMatch(expectedToken: string, suppliedToken: string): boolean {
    const expected = Buffer.from(expectedToken);
    const supplied = Buffer.from(suppliedToken);
    return expected.length > 0
        && expected.length === supplied.length
        && timingSafeEqual(expected, supplied);
}

function allowedLocalRoots(config: any): string[] {
    const explicitRoots = Array.isArray(config.mediaProxyAllowedRoots)
        ? config.mediaProxyAllowedRoots
        : [];
    return [...explicitRoots, config.voiceBasePath]
        .map((entry) => String(entry || "").trim())
        .filter(Boolean)
        .map((entry) => resolve(entry));
}

async function validateMedia(buffer: Buffer): Promise<string> {
    // Sniff from bytes first. Do not let an upstream header or filename turn HTML,
    // JSON, or another active payload into a trusted media response.
    const detectedMime = await detectMime({ buffer });
    const normalizedMime = String(detectedMime || "").split(";", 1)[0].trim().toLowerCase();
    const kind = kindFromMime(normalizedMime);
    if ((kind !== "image" && kind !== "audio") || normalizedMime === "image/svg+xml") {
        throw new MediaProxyError("media type is not allowed", 415, "UNSUPPORTED_MEDIA_TYPE");
    }
    return normalizedMime;
}

async function loadRemoteMedia(
    mediaUrl: string,
    dependencies: MediaProxyDependencies,
): Promise<MediaProxyResource> {
    let parsed: URL;
    try {
        parsed = new URL(mediaUrl);
    } catch {
        throw new MediaProxyError("invalid remote media URL", 400, "INVALID_URL");
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
        throw new MediaProxyError("unsupported remote media URL", 400, "INVALID_URL");
    }

    let guarded: Awaited<ReturnType<GuardedFetch>>;
    try {
        guarded = await (dependencies.guardedFetch || fetchWithSsrFGuard)({
            url: parsed.toString(),
            mode: "strict",
            pinDns: true,
            maxRedirects: 2,
            timeoutMs: MEDIA_PROXY_TIMEOUT_MS,
            auditContext: "napcat-media-proxy",
        });
    } catch (error: any) {
        if (error?.name === "AbortError" || /timeout/i.test(String(error?.message || ""))) {
            throw new MediaProxyError("remote media request timed out", 504, "UPSTREAM_TIMEOUT");
        }
        if (/ssrf|private|loopback|blocked/i.test(`${error?.name || ""} ${error?.message || ""}`)) {
            throw new MediaProxyError("remote media target is not allowed", 403, "SSRF_BLOCKED");
        }
        throw new MediaProxyError("remote media request failed", 502, "UPSTREAM_FAILURE");
    }

    try {
        const response = guarded.response;
        if (!response.ok) {
            throw new MediaProxyError("remote media returned an unsuccessful status", 502, "UPSTREAM_STATUS");
        }
        const buffer = await readResponseWithLimit(response, MEDIA_PROXY_MAX_BYTES, {
            chunkTimeoutMs: MEDIA_PROXY_CHUNK_TIMEOUT_MS,
            timeoutMs: MEDIA_PROXY_TIMEOUT_MS,
            onOverflow: () => new MediaProxyError("remote media exceeds the size limit", 413, "TOO_LARGE"),
            onIdleTimeout: () => new MediaProxyError("remote media request timed out", 504, "UPSTREAM_TIMEOUT"),
            onTimeout: () => new MediaProxyError("remote media request timed out", 504, "UPSTREAM_TIMEOUT"),
        });
        return {
            buffer,
            contentType: await validateMedia(buffer),
        };
    } finally {
        await guarded.release();
    }
}

async function loadLocalMedia(
    mediaUrl: string,
    config: any,
    dependencies: MediaProxyDependencies,
): Promise<MediaProxyResource> {
    let filePath: string;
    try {
        filePath = mediaUrl.startsWith("file://") ? fileURLToPath(mediaUrl) : mediaUrl;
    } catch {
        throw new MediaProxyError("invalid local media URL", 400, "INVALID_URL");
    }
    if (!isAbsolute(filePath)) {
        throw new MediaProxyError("local media path must be absolute", 400, "INVALID_URL");
    }
    const roots = allowedLocalRoots(config);
    if (roots.length === 0) {
        throw new MediaProxyError("no local media roots are configured", 503, "ROOTS_NOT_CONFIGURED");
    }

    let result;
    try {
        result = await (dependencies.readLocalFile || readLocalFileFromRoots)({
            filePath,
            roots,
            label: "NapCat media proxy",
            maxBytes: MEDIA_PROXY_MAX_BYTES,
            symlinks: "follow-within-root",
            hardlinks: "reject",
        });
    } catch (error: any) {
        const message = String(error?.message || "");
        if (/size|too large|maxBytes/i.test(message)) {
            throw new MediaProxyError("local media exceeds the size limit", 413, "TOO_LARGE");
        }
        if (/ENOENT|not found/i.test(message)) {
            throw new MediaProxyError("local media was not found", 404, "NOT_FOUND");
        }
        throw new MediaProxyError("local media could not be read safely", 403, "LOCAL_FILE_BLOCKED");
    }
    if (!result) {
        throw new MediaProxyError("local media path is outside the configured roots", 403, "LOCAL_FILE_BLOCKED");
    }
    return {
        buffer: result.buffer,
        contentType: await validateMedia(result.buffer),
    };
}

export async function loadMediaProxyResource(
    mediaUrl: string,
    config: any,
    dependencies: MediaProxyDependencies = {},
): Promise<MediaProxyResource> {
    if (/^https?:\/\//i.test(mediaUrl)) return loadRemoteMedia(mediaUrl, dependencies);
    return loadLocalMedia(mediaUrl, config, dependencies);
}
