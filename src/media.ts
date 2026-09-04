import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const INLINE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export function isLikelyLocalPath(input: string): boolean {
    if (!input) return false;
    if (input.startsWith("/")) return true;
    if (/^[A-Za-z]:[\\/]/.test(input)) return true;
    if (input.startsWith("./") || input.startsWith("../")) return true;
    return false;
}

export function resolveLocalFilePath(mediaUrl: string): string | null {
    const trimmed = mediaUrl.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith("file://")) {
        return fileURLToPath(trimmed);
    }

    if (isLikelyLocalPath(trimmed)) {
        return path.resolve(trimmed);
    }

    return null;
}

export function buildMediaProxyUrl(mediaUrl: string, config: any): string {
    const enabled = config.mediaProxyEnabled === true;
    const baseUrl = String(config.publicBaseUrl || "").trim();
    if (!enabled || !baseUrl) return mediaUrl;

    const token = String(config.mediaProxyToken || "").trim();
    if (!token) throw new Error("NapCat media proxy is enabled but mediaProxyToken is not configured");

    const publicUrl = new URL(baseUrl);
    if ((publicUrl.protocol !== "http:" && publicUrl.protocol !== "https:")
        || publicUrl.username
        || publicUrl.password
        || publicUrl.search
        || publicUrl.hash) {
        throw new Error("NapCat publicBaseUrl must be an HTTP(S) URL without credentials, query, or fragment");
    }
    publicUrl.pathname = `${publicUrl.pathname.replace(/\/+$/, "")}/napcat/media`;
    publicUrl.searchParams.set("url", mediaUrl);
    publicUrl.searchParams.set("token", token);
    return publicUrl.toString();
}

export function isAudioMedia(mediaUrl: string): boolean {
    return /\.(wav|mp3|amr|silk|ogg|m4a|flac|aac)(?:\?.*)?$/i.test(mediaUrl);
}

export function redactNapCatMediaForLog(message: string): string {
    return message.replace(/(\[CQ:(?:image|record),[^\]]*?file=)[^,\]]+/gi, "$1<redacted>");
}

function isImageMedia(mediaUrl: string): boolean {
    return /\.(png|jpe?g|gif|webp|bmp|svg)(?:\?.*)?$/i.test(mediaUrl);
}

export function resolveVoiceMediaUrl(mediaUrl: string, config: any): string {
    const trimmed = mediaUrl.trim();
    if (!trimmed) return trimmed;
    if (/^(https?:\/\/|file:\/\/)/i.test(trimmed) || trimmed.startsWith("/")) {
        return trimmed;
    }
    const voiceBasePath = String(config.voiceBasePath || "").trim().replace(/\/+$/, "");
    if (!voiceBasePath) return trimmed;
    return `${voiceBasePath}/${trimmed.replace(/^\/+/, "")}`;
}

function getContentTypeByPath(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".png") return "image/png";
    if (ext === ".gif") return "image/gif";
    if (ext === ".webp") return "image/webp";
    if (ext === ".bmp") return "image/bmp";
    if (ext === ".svg") return "image/svg+xml";
    return "application/octet-stream";
}

function isInlineImageContentType(contentType: string | null): boolean {
    return /^image\//i.test(String(contentType || "").trim());
}

function encodeBufferAsBase64File(buffer: Buffer): string {
    return `base64://${buffer.toString("base64")}`;
}

async function tryBuildInlineImage(mediaUrl: string): Promise<string | null> {
    if (!mediaUrl) return null;

    if (/^https?:\/\//i.test(mediaUrl)) {
        const response = await fetch(mediaUrl);
        if (!response.ok) {
            throw new Error(`media fetch failed: ${response.status} ${response.statusText}`);
        }
        const contentType = response.headers.get("content-type");
        if (!isInlineImageContentType(contentType) && !isImageMedia(mediaUrl)) {
            return null;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > INLINE_IMAGE_MAX_BYTES) {
            return null;
        }
        return encodeBufferAsBase64File(buffer);
    }

    const localFilePath = resolveLocalFilePath(mediaUrl);
    if (!localFilePath) return null;
    const contentType = getContentTypeByPath(localFilePath);
    if (!isInlineImageContentType(contentType) && !isImageMedia(localFilePath)) {
        return null;
    }
    const buffer = await readFile(localFilePath);
    if (buffer.length > INLINE_IMAGE_MAX_BYTES) {
        return null;
    }
    return encodeBufferAsBase64File(buffer);
}

export async function resolveNapCatMediaFileValue(
    mediaUrl: string,
    config: any,
    opts?: { forceVoice?: boolean },
): Promise<string> {
    const shouldUseVoice = opts?.forceVoice === true || isAudioMedia(mediaUrl);
    const resolvedUrl = shouldUseVoice ? resolveVoiceMediaUrl(mediaUrl, config) : mediaUrl.trim();

    if (!shouldUseVoice) {
        try {
            const inlineImage = await tryBuildInlineImage(resolvedUrl);
            if (inlineImage) return inlineImage;
        } catch (error: any) {
            console.warn(`[NapCat] Failed to inline image media: ${error?.message || error}`);
        }
    }

    return buildMediaProxyUrl(resolvedUrl, config);
}

export async function buildNapCatMediaCq(mediaUrl: string, config: any, forceVoice = false): Promise<string> {
    const shouldUseVoice = forceVoice || isAudioMedia(mediaUrl);
    const fileValue = await resolveNapCatMediaFileValue(mediaUrl, config, { forceVoice });
    const type = shouldUseVoice ? "record" : "image";
    return `[CQ:${type},file=${fileValue}]`;
}
