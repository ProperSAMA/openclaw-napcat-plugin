import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { buildAgentMediaPayload, detectMime, fetchRemoteMedia, saveMediaBuffer } from 'openclaw/plugin-sdk/media-runtime';

export const INBOUND_IMAGE_LIMITS = { count: 8, bytes: 10 * 1024 * 1024, timeoutMs: 10_000, concurrency: 4, cacheEntries: 256, cacheTtlMs: 5 * 60_000 };
const imageMimes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
export function decodeCqParameter(value: string): string {
    // Decode once, ampersand last (OneBot escaping).
    return value.replace(/&#44;/g, ',').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&');
}
export function extractInboundImageUrls(event: any): string[] {
    const segments = Array.isArray(event.message) ? event.message : event.message && typeof event.message === 'object' ? [event.message] : [];
    const images = segments.filter((s: any) => s?.type === 'image' || s?.type === 'mface');
    if (Array.isArray(event.message) || segments.length) return images.map((s: any) => String(s.data?.url || s.data?.file || '').trim());
    const raw = typeof event.message === 'string' ? event.message : String(event.raw_message || '');
    return [...raw.matchAll(/\[CQ:(?:image|mface),([^\]]*)\]/g)].map(match => {
        const params = Object.fromEntries(match[1].split(',').map(part => { const i = part.indexOf('='); return [part.slice(0, i), decodeCqParameter(part.slice(i + 1))]; }));
        return String(params.url || params.file || '').trim();
    });
}
export function redactInboundMediaText(text: string): string {
    return text.replace(/\[CQ:(?:image|mface),[^\]]*\]/g, '[图片]');
}
function checkedUrl(value: string): string {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('unsafe_url');
    return url.href;
}
type Dependencies = { fetch: typeof fetchRemoteMedia; save: typeof saveMediaBuffer };
type Result = { media: { path: string; contentType: string }[]; failures: string[] };

export type InboundImageStager = (event: any) => Promise<{ payload: ReturnType<typeof buildAgentMediaPayload>; failures: string[] }>;
export function createInboundImageStager(deps: Dependencies = { fetch: fetchRemoteMedia, save: saveMediaBuffer }): InboundImageStager {
    let active = 0;
    // In-flight event sharing is separate from the bounded, successful-attachment cache.
    const inflight = new Map<string, Promise<Result>>();
    const cache = new Map<string, { expires: number; media: Result['media'][number] }>();
    async function stage(urls: string[], eventKey?: string): Promise<Result> {
        const result: Result = { media: [], failures: [] };
        if (urls.length > INBOUND_IMAGE_LIMITS.count) result.failures.push('image_count_limit');
        // Sequential per event preserves order; cross-event slots fail fast, never queue.
        for (const [index, source] of urls.slice(0, INBOUND_IMAGE_LIMITS.count).entries()) {
            const cacheKey = eventKey ? eventKey + ':' + index : undefined;
            const cached = cacheKey ? cache.get(cacheKey) : undefined;
            if (cached) {
                try {
                    await access(cached.media.path, constants.R_OK);
                    result.media.push(cached.media);
                    continue;
                } catch { cache.delete(cacheKey!); }
            }
            let acquired = false;
            let phase = 'download';
            try {
                const url = checkedUrl(source);
                if (active >= INBOUND_IMAGE_LIMITS.concurrency) throw new Error('busy');
                active++; acquired = true;
                const fetched = await deps.fetch({ url, maxBytes: INBOUND_IMAGE_LIMITS.bytes, timeoutMs: INBOUND_IMAGE_LIMITS.timeoutMs, maxRedirects: 0 });
                const mime = await detectMime({ buffer: fetched.buffer });
                if (!mime || !imageMimes.has(mime)) throw new Error('unsupported_image');
                phase = 'store';
                const saved = await deps.save(fetched.buffer, mime, 'inbound', INBOUND_IMAGE_LIMITS.bytes);
                const media = { path: saved.path, contentType: mime };
                result.media.push(media);
                if (cacheKey) {
                    if (cache.size >= INBOUND_IMAGE_LIMITS.cacheEntries) cache.delete(cache.keys().next().value!);
                    cache.set(cacheKey, { expires: Date.now() + INBOUND_IMAGE_LIMITS.cacheTtlMs, media });
                }
            } catch (error: any) {
                const known = new Set(['unsafe_url', 'busy', 'unsupported_image', 'max_bytes', 'http_error', 'fetch_failed']);
                const code = phase === 'store' ? 'store_failed' : known.has(error?.code) ? error.code : known.has(error?.message) ? error.message : 'download_failed';
                // Error messages can contain signed URLs. Return closed codes only.
                result.failures.push('image_' + (index + 1) + ':' + code);
            } finally { if (acquired) active--; }
        }
        return result;
    }
    return async (event: any) => {
        const urls = extractInboundImageUrls(event);
        if (!urls.length) return { payload: {}, failures: [] as string[] };
        const now = Date.now();
        for (const [key, value] of cache) if (value.expires <= now) cache.delete(key);
        const key = event.message_id == null ? undefined : createHash('sha256').update(JSON.stringify([event.self_id, event.message_type, event.group_id, event.user_id, event.message_id, urls])).digest('hex');
        let pending = key ? inflight.get(key) : undefined;
        if (!pending) {
            pending = stage(urls, key);
            if (key) inflight.set(key, pending);
        }
        let result: Result;
        try { result = await pending; }
        finally { if (key && inflight.get(key) === pending) inflight.delete(key); }
        return { payload: buildAgentMediaPayload(result.media), failures: result.failures };
    };
}
export const stageInboundImages: InboundImageStager = createInboundImageStager();
