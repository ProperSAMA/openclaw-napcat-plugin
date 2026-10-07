import path from "node:path";
import { loadMediaProxyResource, type OutboundMediaAccess } from "./mediaProxy.js";
import { fileURLToPath } from "node:url";


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

export async function resolveNapCatMediaFileValue(
    mediaUrl: string,
    config: any,
    opts?: { forceVoice?: boolean; mediaAccess?: OutboundMediaAccess },
): Promise<string> {
    const shouldUseVoice = opts?.forceVoice === true || isAudioMedia(mediaUrl);
    let resolvedUrl = shouldUseVoice ? resolveVoiceMediaUrl(mediaUrl, config) : mediaUrl.trim();
    if (isLikelyLocalPath(resolvedUrl) && !path.isAbsolute(resolvedUrl)) {
        resolvedUrl = path.resolve(opts?.mediaAccess?.workspaceDir || process.cwd(), resolvedUrl);
    }
    // Load once through the guarded path, then send the validated bytes. Falling back
    // to the original URL would let NapCat bypass a rejected host security check.
    const resource = await loadMediaProxyResource(resolvedUrl, config, {}, opts?.mediaAccess);
    return `base64://${resource.buffer.toString("base64")}`;
}

export async function buildNapCatMediaCq(
    mediaUrl: string,
    config: any,
    forceVoice = false,
    mediaAccess?: OutboundMediaAccess,
): Promise<string> {
    const shouldUseVoice = forceVoice || isAudioMedia(mediaUrl);
    const fileValue = await resolveNapCatMediaFileValue(mediaUrl, config, { forceVoice, mediaAccess });
    const type = shouldUseVoice ? "record" : "image";
    return `[CQ:${type},file=${fileValue}]`;
}
