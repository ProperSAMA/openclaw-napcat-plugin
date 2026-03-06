// Minimal NapCat Channel Implementation
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { stat } from "node:fs/promises";
import { setNapCatConfig } from "./runtime.js";
import { isWsTransport, sendNapCatActionOverWs } from "./ws.js";
import { getInboundImageContext } from "./webhook.js";

function appendAccessToken(rawUrl: string, token: string): string {
    const trimmedToken = String(token || "").trim();
    if (!trimmedToken) return rawUrl;
    try {
        const target = new URL(rawUrl);
        if (!target.searchParams.has("access_token")) {
            target.searchParams.set("access_token", trimmedToken);
        }
        return target.toString();
    } catch {
        return rawUrl;
    }
}

async function sendToNapCat(url: string, payload: any, config: any) {
    const token = String(config?.token || config?.accessToken || "").trim();
    const authedUrl = appendAccessToken(url, token);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(authedUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        throw new Error(`NapCat API Error: ${res.status} ${res.statusText}`);
    }
    return await res.json();
}

function endpointToAction(endpoint: string): string {
    return endpoint.replace(/^\/+/, "").trim();
}

async function sendByConfiguredTransport(config: any, endpoint: string, payload: any) {
    if (isWsTransport(config)) {
        const action = endpointToAction(endpoint);
        return sendNapCatActionOverWs(action, payload, Number(config.wsRequestTimeoutMs || 10000));
    }
    const baseUrl = config.url || "http://127.0.0.1:3000";
    return sendToNapCat(`${baseUrl}${endpoint}`, payload, config);
}

async function callNapCatAction(config: any, action: string, payload: any = {}) {
    const normalizedAction = String(action || "").replace(/^\/+/, "").trim();
    if (!normalizedAction) {
        throw new Error("NapCat action is required");
    }
    return sendByConfiguredTransport(config, `/${normalizedAction}`, payload || {});
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

function isAudioMedia(mediaUrl: string): boolean {
    return /\.(wav|mp3|amr|silk|ogg|m4a|flac|aac)(?:\?.*)?$/i.test(mediaUrl);
}

function resolveVoiceMediaUrl(mediaUrl: string, config: any): string {
    const trimmed = mediaUrl.trim();
    if (!trimmed) return trimmed;
    if (/^(https?:\/\/|file:\/\/)/i.test(trimmed) || trimmed.startsWith("/")) {
        return trimmed;
    }
    const voiceBasePath = String(config.voiceBasePath || "").trim().replace(/\/+$/, "");
    if (!voiceBasePath) return trimmed;
    return `${voiceBasePath}/${trimmed.replace(/^\/+/, "")}`;
}

function buildNapCatMediaCq(mediaUrl: string, config: any): string {
    const resolvedUrl = isAudioMedia(mediaUrl) ? resolveVoiceMediaUrl(mediaUrl, config) : mediaUrl;
    const proxiedMediaUrl = buildMediaProxyUrl(resolvedUrl, config);
    const type = isAudioMedia(resolvedUrl) ? "record" : "image";
    return `[CQ:${type},file=${proxiedMediaUrl}]`;
}

function normalizeNapCatTarget(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return trimmed;
    const withoutProvider = trimmed.replace(/^napcat:/i, "");
    const actionMatch = withoutProvider.match(/^action:(.+)$/i);
    if (actionMatch) {
        return `action:${actionMatch[1].trim().toLowerCase()}`;
    }
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
        /^action:[a-z0-9_.-]+$/i.test(target) ||
        /^session:napcat:(private|group):\d+$/i.test(target) ||
        /^(private|group):\d+$/i.test(target) ||
        /^\d+$/.test(target)
    );
}

type ParsedNapCatTarget =
    | { kind: "action"; action: string }
    | { kind: "private"; targetId: string }
    | { kind: "group"; targetId: string };

function parseNapCatTarget(raw: string): ParsedNapCatTarget {
    const normalized = normalizeNapCatTarget(raw);
    const actionMatch = normalized.match(/^action:(.+)$/i);
    if (actionMatch) {
        return { kind: "action", action: actionMatch[1] };
    }
    if (normalized.startsWith("group:")) {
        return { kind: "group", targetId: normalized.replace("group:", "") };
    }
    if (normalized.startsWith("private:")) {
        return { kind: "private", targetId: normalized.replace("private:", "") };
    }
    if (normalized.startsWith("session:napcat:private:")) {
        return { kind: "private", targetId: normalized.replace("session:napcat:private:", "") };
    }
    if (normalized.startsWith("session:napcat:group:")) {
        return { kind: "group", targetId: normalized.replace("session:napcat:group:", "") };
    }
    return { kind: "private", targetId: normalized };
}

function unwrapJsonCodeFence(text: string): string {
    const trimmed = String(text || "").trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenced ? fenced[1].trim() : trimmed;
}

function parseNapCatActionPayload(text: string): any {
    const normalized = unwrapJsonCodeFence(text);
    if (!normalized) return {};
    try {
        return JSON.parse(normalized);
    } catch (err: any) {
        throw new Error(`NapCat action 参数必须是合法 JSON: ${err?.message || err}`);
    }
}

function requireObjectPayload(payload: any, action: string): Record<string, any> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error(`${action} 参数必须是 JSON 对象`);
    }
    return payload as Record<string, any>;
}

function coerceBoolean(value: any, fieldName: string): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
        const lowered = value.trim().toLowerCase();
        if (["true", "1", "yes", "y"].includes(lowered)) return true;
        if (["false", "0", "no", "n"].includes(lowered)) return false;
    }
    throw new Error(`${fieldName} 必须是 boolean`);
}

function coerceUserId(value: any, fieldName = "user_id"): number {
    const normalized = String(value ?? "").trim();
    if (!/^\d+$/.test(normalized)) {
        throw new Error(`${fieldName} 必须是 QQ 数字 ID`);
    }
    return Number(normalized);
}

function coerceGroupId(value: any, fieldName = "group_id"): number {
    const normalized = String(value ?? "").trim();
    if (!/^\d+$/.test(normalized)) {
        throw new Error(`${fieldName} 必须是群号数字 ID`);
    }
    return Number(normalized);
}

function coerceInteger(value: any, fieldName: string): number {
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || !Number.isInteger(normalized)) {
        throw new Error(`${fieldName} 必须是整数`);
    }
    return normalized;
}

function coerceNonEmptyString(value: any, fieldName: string): string {
    const normalized = String(value ?? "").trim();
    if (!normalized) {
        throw new Error(`${fieldName} 不能为空`);
    }
    return normalized;
}

function buildFileIdentityPayload(payload: Record<string, any>, fieldName = "file"): Record<string, any> {
    const fileIdRaw = payload.file_id ?? payload.fileId;
    const fileRaw = payload.file;
    const requestPayload: Record<string, any> = {};
    if (fileIdRaw !== undefined && String(fileIdRaw).trim()) {
        requestPayload.file_id = String(fileIdRaw).trim();
    }
    if (fileRaw !== undefined && String(fileRaw).trim()) {
        requestPayload.file = String(fileRaw).trim();
    }
    if (!requestPayload.file_id && !requestPayload.file) {
        throw new Error(`至少需要提供 file_id 或 ${fieldName}`);
    }
    return requestPayload;
}

async function buildLocalStreamActionResult(filePath: string, options?: {
    action?: string;
    chunkSize?: number;
    fileName?: string;
    extraInfo?: Record<string, any>;
}) {
    const action = String(options?.action || "stream_action");
    const chunkSize = Math.max(1, Number(options?.chunkSize || 64 * 1024));
    const fileStats = await stat(filePath);
    const fileName = String(options?.fileName || basename(filePath));
    const streamChunks: any[] = [{
        type: "stream",
        data_type: "file_info",
        file_name: fileName,
        file_size: fileStats.size,
        chunk_size: chunkSize,
        ...(options?.extraInfo || {}),
    }];

    let index = 0;
    let bytesRead = 0;
    for await (const chunk of createReadStream(filePath, { highWaterMark: chunkSize })) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesRead += buffer.length;
        const base64Chunk = buffer.toString("base64");
        streamChunks.push({
            type: "stream",
            data_type: "file_chunk",
            index,
            data: base64Chunk,
            size: buffer.length,
            progress: Math.round((bytesRead / fileStats.size) * 100),
            base64_size: base64Chunk.length,
        });
        index += 1;
    }

    return {
        status: "ok",
        retcode: 0,
        data: {
            type: "response",
            data_type: "file_complete",
            total_chunks: index,
            total_bytes: bytesRead,
            message: "Download completed",
        },
        message: "",
        wording: "",
        echo: `openclaw-local-${action}-${Date.now()}`,
        stream: "stream-action",
        stream_chunks: streamChunks,
        stream_chunk_count: streamChunks.length,
    };
}

async function getFriendList(config: any) {
    return callNapCatAction(config, "get_friend_list", {});
}

async function approveFriendRequest(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "set_friend_add_request");
    const flag = String(payload.flag || "").trim();
    if (!flag) {
        throw new Error("set_friend_add_request 需要 flag");
    }
    const approve = coerceBoolean(payload.approve, "approve");
    const remark = String(payload.remark || "").trim();
    const requestPayload: Record<string, any> = { flag, approve };
    if (remark) requestPayload.remark = remark;
    return callNapCatAction(config, "set_friend_add_request", requestPayload);
}

async function setFriendRemark(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "set_friend_remark");
    const userId = coerceUserId(payload.user_id ?? payload.userId);
    const remark = String(payload.remark || "").trim();
    if (!remark) {
        throw new Error("set_friend_remark 需要非空 remark");
    }
    return callNapCatAction(config, "set_friend_remark", {
        user_id: userId,
        remark,
    });
}

async function getStrangerInfo(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "get_stranger_info");
    const userId = coerceUserId(payload.user_id ?? payload.userId);
    const noCacheRaw = payload.no_cache ?? payload.noCache;
    const requestPayload: Record<string, any> = { user_id: userId };
    if (noCacheRaw !== undefined) {
        requestPayload.no_cache = coerceBoolean(noCacheRaw, "no_cache");
    }
    return callNapCatAction(config, "get_stranger_info", requestPayload);
}

async function deleteFriend(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "delete_friend");
    const userId = coerceUserId(payload.user_id ?? payload.userId);
    return callNapCatAction(config, "delete_friend", { user_id: userId });
}

async function getGroupList(config: any) {
    return callNapCatAction(config, "get_group_list", {});
}

async function getGroupInfo(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "get_group_info");
    const groupId = coerceGroupId(payload.group_id ?? payload.groupId);
    const requestPayload: Record<string, any> = { group_id: groupId };
    const noCacheRaw = payload.no_cache ?? payload.noCache;
    if (noCacheRaw !== undefined) {
        requestPayload.no_cache = coerceBoolean(noCacheRaw, "no_cache");
    }
    return callNapCatAction(config, "get_group_info", requestPayload);
}

async function getGroupMemberList(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "get_group_member_list");
    const groupId = coerceGroupId(payload.group_id ?? payload.groupId);
    return callNapCatAction(config, "get_group_member_list", { group_id: groupId });
}

async function setGroupBan(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "set_group_ban");
    const groupId = coerceGroupId(payload.group_id ?? payload.groupId);
    const userId = coerceUserId(payload.user_id ?? payload.userId);
    const durationRaw = payload.duration ?? 1800;
    const duration = coerceInteger(durationRaw, "duration");
    return callNapCatAction(config, "set_group_ban", {
        group_id: groupId,
        user_id: userId,
        duration,
    });
}

async function setGroupKick(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "set_group_kick");
    const groupId = coerceGroupId(payload.group_id ?? payload.groupId);
    const userId = coerceUserId(payload.user_id ?? payload.userId);
    const requestPayload: Record<string, any> = {
        group_id: groupId,
        user_id: userId,
    };
    const rejectAddRequestRaw = payload.reject_add_request ?? payload.rejectAddRequest;
    if (rejectAddRequestRaw !== undefined) {
        requestPayload.reject_add_request = coerceBoolean(rejectAddRequestRaw, "reject_add_request");
    }
    return callNapCatAction(config, "set_group_kick", requestPayload);
}

async function setGroupCard(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "set_group_card");
    const groupId = coerceGroupId(payload.group_id ?? payload.groupId);
    const userId = coerceUserId(payload.user_id ?? payload.userId);
    const card = String(payload.card ?? payload.group_card ?? "").trim();
    if (!card) {
        throw new Error("set_group_card 需要非空 card");
    }
    return callNapCatAction(config, "set_group_card", {
        group_id: groupId,
        user_id: userId,
        card,
    });
}

async function setGroupName(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "set_group_name");
    const groupId = coerceGroupId(payload.group_id ?? payload.groupId);
    const groupName = String(payload.group_name ?? payload.groupName ?? "").trim();
    if (!groupName) {
        throw new Error("set_group_name 需要非空 group_name");
    }
    return callNapCatAction(config, "set_group_name", {
        group_id: groupId,
        group_name: groupName,
    });
}

async function getStatus(config: any) {
    return callNapCatAction(config, "get_status", {});
}

async function getVersionInfo(config: any) {
    return callNapCatAction(config, "get_version_info", {});
}

async function getRecentContact(config: any) {
    return callNapCatAction(config, "get_recent_contact", {});
}

async function setOnlineStatus(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "set_online_status");
    const status = coerceInteger(payload.status, "status");
    const requestPayload: Record<string, any> = { status };
    if (payload.extStatus !== undefined) {
        requestPayload.extStatus = coerceInteger(payload.extStatus, "extStatus");
    }
    if (payload.batteryStatus !== undefined) {
        requestPayload.batteryStatus = coerceInteger(payload.batteryStatus, "batteryStatus");
    }
    return callNapCatAction(config, "set_online_status", requestPayload);
}

async function ocrImage(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "ocr_image");
    const image = coerceNonEmptyString(payload.image ?? payload.image_id ?? payload.file, "image");
    return callNapCatAction(config, "ocr_image", { image });
}

async function uploadPrivateFile(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "upload_private_file");
    const userId = coerceUserId(payload.user_id ?? payload.userId);
    const file = coerceNonEmptyString(payload.file ?? payload.path ?? payload.url, "file");
    const requestPayload: Record<string, any> = {
        user_id: userId,
        file,
    };
    if (payload.name !== undefined) {
        requestPayload.name = coerceNonEmptyString(payload.name, "name");
    }
    return callNapCatAction(config, "upload_private_file", requestPayload);
}

async function uploadGroupFile(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "upload_group_file");
    const groupId = coerceGroupId(payload.group_id ?? payload.groupId);
    const file = coerceNonEmptyString(payload.file ?? payload.path ?? payload.url, "file");
    const requestPayload: Record<string, any> = {
        group_id: groupId,
        file,
    };
    if (payload.name !== undefined) {
        requestPayload.name = coerceNonEmptyString(payload.name, "name");
    }
    const folder = payload.folder ?? payload.folder_id ?? payload.folderId;
    if (folder !== undefined && String(folder).trim()) {
        requestPayload.folder = String(folder).trim();
    }
    return callNapCatAction(config, "upload_group_file", requestPayload);
}

async function getGroupRootFiles(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "get_group_root_files");
    const groupId = coerceGroupId(payload.group_id ?? payload.groupId);
    return callNapCatAction(config, "get_group_root_files", { group_id: groupId });
}

async function getGroupFilesByFolder(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "get_group_files_by_folder");
    const groupId = coerceGroupId(payload.group_id ?? payload.groupId);
    const folderId = coerceNonEmptyString(payload.folder_id ?? payload.folderId ?? payload.folder, "folder_id");
    return callNapCatAction(config, "get_group_files_by_folder", {
        group_id: groupId,
        folder_id: folderId,
    });
}

async function getGroupFileUrl(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "get_group_file_url");
    const groupId = coerceGroupId(payload.group_id ?? payload.groupId);
    const fileId = coerceNonEmptyString(payload.file_id ?? payload.fileId, "file_id");
    const requestPayload: Record<string, any> = {
        group_id: groupId,
        file_id: fileId,
    };
    const busid = payload.busid ?? payload.bus_id ?? payload.busId;
    if (busid !== undefined) {
        requestPayload.busid = coerceInteger(busid, "busid");
    }
    return callNapCatAction(config, "get_group_file_url", requestPayload);
}

async function deleteGroupFile(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "delete_group_file");
    const groupId = coerceGroupId(payload.group_id ?? payload.groupId);
    const fileId = coerceNonEmptyString(payload.file_id ?? payload.fileId, "file_id");
    const requestPayload: Record<string, any> = {
        group_id: groupId,
        file_id: fileId,
    };
    const busid = payload.busid ?? payload.bus_id ?? payload.busId;
    if (busid !== undefined) {
        requestPayload.busid = coerceInteger(busid, "busid");
    }
    return callNapCatAction(config, "delete_group_file", requestPayload);
}

async function moveGroupFile(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "move_group_file");
    const groupId = coerceGroupId(payload.group_id ?? payload.groupId);
    const fileId = coerceNonEmptyString(payload.file_id ?? payload.fileId, "file_id");
    const currentParentDirectory = coerceNonEmptyString(
        payload.current_parent_directory ?? payload.currentParentDirectory ?? payload.from_folder ?? payload.fromFolder,
        "current_parent_directory"
    );
    const targetParentDirectory = coerceNonEmptyString(
        payload.target_parent_directory ?? payload.targetParentDirectory ?? payload.to_folder ?? payload.toFolder,
        "target_parent_directory"
    );
    return callNapCatAction(config, "move_group_file", {
        group_id: groupId,
        file_id: fileId,
        current_parent_directory: currentParentDirectory,
        target_parent_directory: targetParentDirectory,
    });
}

async function getPrivateFileUrl(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "get_private_file_url");
    const fileId = coerceNonEmptyString(payload.file_id ?? payload.fileId, "file_id");
    return callNapCatAction(config, "get_private_file_url", { file_id: fileId });
}

async function getFile(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "get_file");
    return callNapCatAction(config, "get_file", buildFileIdentityPayload(payload));
}

async function getRecord(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "get_record");
    const requestPayload = buildFileIdentityPayload(payload);
    if (payload.out_format !== undefined) {
        requestPayload.out_format = coerceNonEmptyString(payload.out_format, "out_format");
    } else if (payload.outFormat !== undefined) {
        requestPayload.out_format = coerceNonEmptyString(payload.outFormat, "outFormat");
    }
    return callNapCatAction(config, "get_record", requestPayload);
}

async function uploadFileStream(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "upload_file_stream");
    const streamId = coerceNonEmptyString(payload.stream_id ?? payload.streamId, "stream_id");
    const isCompleteRaw = payload.is_complete ?? payload.isComplete;
    if (isCompleteRaw !== undefined && coerceBoolean(isCompleteRaw, "is_complete")) {
        return callNapCatAction(config, "upload_file_stream", {
            stream_id: streamId,
            is_complete: true,
        });
    }

    const requestPayload: Record<string, any> = {
        stream_id: streamId,
        chunk_data: coerceNonEmptyString(payload.chunk_data ?? payload.chunkData, "chunk_data"),
        chunk_index: coerceInteger(payload.chunk_index ?? payload.chunkIndex, "chunk_index"),
        total_chunks: coerceInteger(payload.total_chunks ?? payload.totalChunks, "total_chunks"),
        file_size: coerceInteger(payload.file_size ?? payload.fileSize, "file_size"),
        expected_sha256: coerceNonEmptyString(payload.expected_sha256 ?? payload.expectedSha256, "expected_sha256"),
        filename: coerceNonEmptyString(payload.filename ?? payload.file_name ?? payload.fileName, "filename"),
    };
    const fileRetention = payload.file_retention ?? payload.fileRetention;
    if (fileRetention !== undefined) {
        requestPayload.file_retention = coerceInteger(fileRetention, "file_retention");
    }
    return callNapCatAction(config, "upload_file_stream", requestPayload);
}

async function downloadFileStream(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "download_file_stream");
    const requestPayload = buildFileIdentityPayload(payload);
    const chunkSize = payload.chunk_size ?? payload.chunkSize;
    if (chunkSize !== undefined) {
        requestPayload.chunk_size = coerceInteger(chunkSize, "chunk_size");
    }
    return callNapCatAction(config, "download_file_stream", requestPayload);
}

async function downloadFileImageStream(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "download_file_image_stream");
    const contextImageId = String(payload.context_image_id ?? payload.contextImageId ?? payload.image_context_id ?? "").trim();
    const chunkSize = payload.chunk_size ?? payload.chunkSize;
    if (contextImageId) {
        const context = getInboundImageContext(contextImageId);
        if (!context?.localPath) {
            throw new Error(`未找到图片上下文标识: ${contextImageId}`);
        }
        return buildLocalStreamActionResult(context.localPath, {
            action: "download_file_image_stream",
            chunkSize: chunkSize !== undefined ? coerceInteger(chunkSize, "chunk_size") : undefined,
            fileName: context.file || undefined,
            extraInfo: {
                source: "openclaw-inbound-image-context",
                context_image_id: context.id,
            },
        });
    }
    const requestPayload = buildFileIdentityPayload(payload);
    if (chunkSize !== undefined) {
        requestPayload.chunk_size = coerceInteger(chunkSize, "chunk_size");
    }
    return callNapCatAction(config, "download_file_image_stream", requestPayload);
}

async function downloadFileRecordStream(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "download_file_record_stream");
    const requestPayload = buildFileIdentityPayload(payload);
    const chunkSize = payload.chunk_size ?? payload.chunkSize;
    if (chunkSize !== undefined) {
        requestPayload.chunk_size = coerceInteger(chunkSize, "chunk_size");
    }
    const outFormat = payload.out_format ?? payload.outFormat;
    if (outFormat !== undefined) {
        requestPayload.out_format = coerceNonEmptyString(outFormat, "out_format");
    }
    return callNapCatAction(config, "download_file_record_stream", requestPayload);
}

async function cleanStreamTempFile(config: any, rawPayload: any) {
    requireObjectPayload(rawPayload, "clean_stream_temp_file");
    return callNapCatAction(config, "clean_stream_temp_file", {});
}

async function dispatchNapCatAction(config: any, action: string, text: string) {
    const payload = parseNapCatActionPayload(text);
    switch (action) {
        case "get_friend_list":
            return getFriendList(config);
        case "set_friend_add_request":
            return approveFriendRequest(config, payload);
        case "set_friend_remark":
            return setFriendRemark(config, payload);
        case "get_stranger_info":
            return getStrangerInfo(config, payload);
        case "delete_friend":
            return deleteFriend(config, payload);
        case "get_group_list":
            return getGroupList(config);
        case "get_group_info":
            return getGroupInfo(config, payload);
        case "get_group_member_list":
            return getGroupMemberList(config, payload);
        case "set_group_ban":
            return setGroupBan(config, payload);
        case "set_group_kick":
            return setGroupKick(config, payload);
        case "set_group_card":
            return setGroupCard(config, payload);
        case "set_group_name":
            return setGroupName(config, payload);
        case "get_status":
            return getStatus(config);
        case "get_version_info":
            return getVersionInfo(config);
        case "get_recent_contact":
            return getRecentContact(config);
        case "set_online_status":
            return setOnlineStatus(config, payload);
        case "ocr_image":
            return ocrImage(config, payload);
        case "upload_private_file":
            return uploadPrivateFile(config, payload);
        case "upload_group_file":
            return uploadGroupFile(config, payload);
        case "get_group_root_files":
            return getGroupRootFiles(config, payload);
        case "get_group_files_by_folder":
            return getGroupFilesByFolder(config, payload);
        case "get_group_file_url":
            return getGroupFileUrl(config, payload);
        case "delete_group_file":
            return deleteGroupFile(config, payload);
        case "move_group_file":
            return moveGroupFile(config, payload);
        case "get_private_file_url":
            return getPrivateFileUrl(config, payload);
        case "get_file":
            return getFile(config, payload);
        case "get_record":
            return getRecord(config, payload);
        case "upload_file_stream":
            return uploadFileStream(config, payload);
        case "download_file_stream":
            return downloadFileStream(config, payload);
        case "download_file_image_stream":
            return downloadFileImageStream(config, payload);
        case "download_file_record_stream":
            return downloadFileRecordStream(config, payload);
        case "clean_stream_temp_file":
            return cleanStreamTempFile(config, payload);
        default:
            return callNapCatAction(config, action, payload);
    }
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
            hint: "private:<QQ号> / group:<群号> / session:napcat:private:<QQ号> / session:napcat:group:<群号> / action:<NapCat接口名>"
        }
    },
    configSchema: {
        type: "object",
        properties: {
            url: { type: "string", title: "NapCat HTTP URL", default: "http://127.0.0.1:3000" },
            transport: {
                type: "string",
                title: "Transport",
                description: "Transport mode: http, ws-client, ws-server",
                default: "http",
                enum: ["http", "ws-client", "ws-server"]
            },
            wsUrl: {
                type: "string",
                title: "NapCat WebSocket URL (client mode)",
                description: "Used when transport=ws-client, e.g. ws://127.0.0.1:3001",
                default: ""
            },
            wsHost: {
                type: "string",
                title: "WebSocket Host",
                description: "Server bind host for ws-server mode, or fallback host for ws-client when wsUrl is empty",
                default: "0.0.0.0"
            },
            wsPort: {
                type: "number",
                title: "WebSocket Port",
                description: "Server bind port for ws-server mode, or fallback port for ws-client",
                default: 3001
            },
            wsPath: {
                type: "string",
                title: "WebSocket Path",
                description: "WebSocket path, e.g. /onebot/v11/ws",
                default: "/"
            },
            wsToken: {
                type: "string",
                title: "WebSocket Token",
                description: "Optional WS token (Authorization Bearer + access_token query)",
                default: ""
            },
            wsHeartbeatMs: {
                type: "number",
                title: "WebSocket Heartbeat Interval (ms)",
                description: "Heartbeat interval in milliseconds",
                default: 30000
            },
            wsReconnectMs: {
                type: "number",
                title: "WebSocket Reconnect Interval (ms)",
                description: "Reconnect interval for ws-client mode in milliseconds",
                default: 30000
            },
            wsRequestTimeoutMs: {
                type: "number",
                title: "WebSocket Request Timeout (ms)",
                description: "Timeout waiting action response in WS modes",
                default: 10000
            },
            inboundImageEnabled: {
                type: "boolean",
                title: "Enable Inbound Image Parsing",
                description: "When enabled, parse CQ:image/CQ:record from inbound messages into media fields",
                default: true
            },
            inboundImagePreferUrl: {
                type: "boolean",
                title: "Prefer CQ URL For Inbound Images",
                description: "When true, prefer CQ url field over file id when building inbound image URLs",
                default: true
            },
            inboundMediaDir: {
                type: "string",
                title: "Inbound Media Cache Directory",
                description: "Directory used to cache inbound media files locally before passing to OpenClaw",
                default: "./workspace/napcat-inbound-media"
            },
            agentId: {
                type: "string",
                title: "Fixed Agent ID",
                description: "Optional: force all NapCat inbound sessions to use this OpenClaw agent ID",
                default: ""
            },
            allowUsers: {
                type: "array",
                items: { type: "string" },
                title: "Allowed User IDs",
                description: "Only accept messages from these QQ user IDs (empty = accept all)",
                default: []
            },
            token: {
                type: "string",
                title: "NapCat Access Token",
                description: "Optional NapCat HTTP API token (sent as Authorization Bearer and access_token query)",
                default: ""
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
            },
            voiceBasePath: {
                type: "string",
                title: "Voice Base Path",
                description: "Base directory for relative audio files (e.g. /tmp/napcat-voice)",
                default: ""
            },
            enableInboundLogging: {
                type: "boolean",
                title: "Enable Inbound Message Logging",
                description: "Log all received QQ/group messages before allowlist filtering",
                default: true
            },
            inboundLogDir: {
                type: "string",
                title: "Inbound Log Directory",
                description: "Directory to store per-user/per-group inbound logs",
                default: "./logs/napcat-inbound"
            },
            actionTimeoutMs: {
                type: "number",
                title: "Action Timeout (ms)",
                description: "Optional generic NapCat action timeout hint for future extensions; WS calls still use wsRequestTimeoutMs",
                default: 10000
            },
            autoApproveFriendRequests: {
                type: "boolean",
                title: "Auto Approve Friend Requests",
                description: "Automatically approve inbound friend requests",
                default: false
            },
            friendAutoRemarkTemplate: {
                type: "string",
                title: "Friend Auto Remark Template",
                description: "Optional template used when auto-approving friend requests. Supports {userId}, {nickname}, {comment}",
                default: ""
            },
            friendRequestAllowUsers: {
                type: "array",
                items: { type: "string" },
                title: "Friend Request Allowed User IDs",
                description: "Only auto-approve friend requests from these QQ user IDs (empty = allow all)",
                default: []
            },
            friendRequestLogDir: {
                type: "string",
                title: "Friend Request Log Directory",
                description: "Directory to store friend request logs and action audit logs",
                default: "./logs/napcat-friend-requests"
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
                const result = await sendByConfiguredTransport(config, endpoint, payload);
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

            // Basic media support: try CQ image format, fallback to plain URL.
            const mediaMessage = mediaUrl
                ? buildNapCatMediaCq(mediaUrl, config)
                : "";
            const message = text
                ? (mediaMessage ? `${text}\n${mediaMessage}` : text)
                : (mediaMessage || "");

            const payload: any = { message };
            if (targetType === "group") payload.group_id = targetId;
            else payload.user_id = targetId;

            console.log(`[NapCat] Sending media to ${targetType} ${targetId}: ${message}`);

            try {
                const result = await sendByConfiguredTransport(config, endpoint, payload);
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
