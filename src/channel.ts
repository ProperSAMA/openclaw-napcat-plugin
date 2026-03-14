// Minimal NapCat Channel Implementation
import path from "node:path";
import { access, copyFile, mkdir, unlink } from "node:fs/promises";
import { buildNapCatMediaCq, isAudioMedia, resolveLocalFilePath } from "./media.js";
import { setNapCatConfig } from "./runtime.js";

async function sendToNapCat(url: string, payload: any, token?: string) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const normalizedToken = String(token ?? "").trim();
    if (normalizedToken) {
        headers["Authorization"] = `Bearer ${normalizedToken}`;
    }
    const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        let body = "";
        try {
            body = await res.text();
        } catch {
            body = "";
        }
        throw new Error(`NapCat API Error: ${res.status} ${res.statusText}${body ? ` | body=${body}` : ""}`);
    }
    return await res.json();
}

async function uploadGroupFileToNapCat(url: string, payload: {
    groupId: string;
    filePath: string;
    fileName: string;
    folder?: string;
}, token?: string) {
    // NapCat upload_group_file expects JSON payload (go-cqhttp style), not multipart form-data.
    const requestPayload: Record<string, unknown> = {
        group_id: payload.groupId,
        file: payload.filePath,
        name: payload.fileName,
        upload_file: true,
    };
    if (payload.folder) {
        requestPayload.folder = payload.folder;
    }
    return await sendToNapCat(url, requestPayload, token);
}

async function ensureReadableFile(filePath: string): Promise<void> {
    await access(filePath);
}

function getContainerVisiblePath(localPath: string, config: any): string | null {
    const hostPrefix = String(config.groupFileHostPrefix || "").trim().replace(/\/+$/, "");
    const containerPrefix = String(config.groupFileContainerPrefix || "").trim().replace(/\/+$/, "");
    if (!hostPrefix || !containerPrefix) return null;
    if (!localPath.startsWith(hostPrefix + "/") && localPath !== hostPrefix) return null;
    const relative = localPath.slice(hostPrefix.length).replace(/^\/+/, "");
    return `${containerPrefix}/${relative}`;
}

async function stageFileForNapCat(localPath: string, config: any): Promise<string | null> {
    const hostStageDir = String(config.groupFileStageHostDir || "").trim();
    const containerStageDir = String(config.groupFileStageContainerDir || "").trim();
    if (!hostStageDir || !containerStageDir) return null;

    const fileName = path.basename(localPath);
    const stagedHostPath = path.join(hostStageDir, fileName);
    await mkdir(hostStageDir, { recursive: true });
    await copyFile(localPath, stagedHostPath);
    return `${containerStageDir.replace(/\/+$/, "")}/${fileName}`;
}

function isNapCatGroupFileCandidate(mediaUrl: string): boolean {
    if (!mediaUrl) return false;
    if (/^https?:\/\//i.test(mediaUrl)) return false;
    const lower = mediaUrl.toLowerCase();
    if (isAudioMedia(lower)) return false;
    if (/\.(png|jpe?g|gif|webp|bmp|svg)(?:\?.*)?$/i.test(lower)) return false;
    return true;
}

function normalizeNapCatTarget(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return trimmed;
    const withoutProvider = trimmed.replace(/^napcat:/i, "");
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
        /^session:napcat:(private|group):\d+$/i.test(target) ||
        /^(private|group):\d+$/i.test(target) ||
        /^\d+$/.test(target)
    );
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
        media: true,
        blockStreaming: true
    },
    streaming: {
        blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 }
    },
    messaging: {
        normalizeTarget: normalizeNapCatTarget,
        targetResolver: {
            looksLikeId: looksLikeNapCatTargetId,
            hint: "private:<QQ号> / group:<群号> / session:napcat:private:<QQ号> / session:napcat:group:<群号>"
        }
    },
    configSchema: {
        type: "object",
        properties: {
            url: { type: "string", title: "NapCat HTTP URL", default: "http://127.0.0.1:3000" },
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
            groupWhitelist: {
                type: "array",
                items: { type: "string" },
                title: "Group Whitelist",
                description: "Only accept messages from these QQ group IDs when non-empty",
                default: []
            },
            enableGroupMessages: {
                type: "boolean",
                title: "Enable Group Messages",
                description: "When enabled, process group messages (requires mention to trigger)",
                default: false
            },
            streaming_mode: {
                type: "boolean",
                title: "Streaming Mode",
                description: "Stream replies as incremental QQ messages instead of waiting for the final combined response",
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
            groupFileFolder: {
                type: "string",
                title: "Group File Default Folder",
                description: "Optional NapCat group file folder path used by /upload_group_file",
                default: ""
            },
            groupFileHostPrefix: {
                type: "string",
                title: "Group File Host Prefix",
                description: "Host path prefix that is mounted into NapCat container (e.g. /Users/me/shared)",
                default: ""
            },
            groupFileContainerPrefix: {
                type: "string",
                title: "Group File Container Prefix",
                description: "Container path prefix matching host prefix (e.g. /app/shared)",
                default: ""
            },
            groupFileStageHostDir: {
                type: "string",
                title: "Group File Stage Host Dir",
                description: "Host directory (mounted into NapCat container) to stage files before upload",
                default: ""
            },
            groupFileStageContainerDir: {
                type: "string",
                title: "Group File Stage Container Dir",
                description: "Container directory corresponding to stage host dir (e.g. /app/napcat/plugins/upload-staging)",
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
            token: {
                type: "string",
                title: "HTTP API Token",
                description: "Token for authenticating with NapCat HTTP server (Bearer token)",
                default: ""
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
            const baseUrl = config.url || "http://127.0.0.1:3000";
            const token = String(config.token || "").trim();
            
            let targetType = "private";
            let targetId = to;
            
            if (to.startsWith("group:")) {
                targetType = "group";
                targetId = to.replace("group:", "");
            } else if (to.startsWith("private:")) {
                targetType = "private";
                targetId = to.replace("private:", "");
            } else if (to.startsWith("session:napcat:private:")) {
                targetType = "private";
                targetId = to.replace("session:napcat:private:", "");
            } else if (to.startsWith("session:napcat:group:")) {
                targetType = "group";
                targetId = to.replace("session:napcat:group:", "");
            }

            // Fallback for direct user input of ID
            if (!to.includes(":")) {
                // If it looks like a group ID (usually same length as user ID, hard to tell)
                // We default to private if not specified.
            }

            const endpoint = targetType === "group" ? "/send_group_msg" : "/send_private_msg";
            const payload: any = { message: text };
            if (targetType === "group") payload.group_id = targetId;
            else payload.user_id = targetId;

            console.log(`[NapCat] Sending to ${targetType} ${targetId}: ${text}`);
            
            try {
                const result = await sendToNapCat(`${baseUrl}${endpoint}`, payload, token);
                return { ok: true, result };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        },
        sendMedia: async ({ to, text, mediaUrl, cfg }: any) => {
            const config = cfg.channels?.napcat || {};
            const baseUrl = config.url || "http://127.0.0.1:3000";
            const token = String(config.token || "").trim();

            let targetType = "private";
            let targetId = to;

            if (to.startsWith("group:")) {
                targetType = "group";
                targetId = to.replace("group:", "");
            } else if (to.startsWith("private:")) {
                targetType = "private";
                targetId = to.replace("private:", "");
            } else if (to.startsWith("session:napcat:private:")) {
                targetType = "private";
                targetId = to.replace("session:napcat:private:", "");
            } else if (to.startsWith("session:napcat:group:")) {
                targetType = "group";
                targetId = to.replace("session:napcat:group:", "");
            }

            const endpoint = targetType === "group" ? "/send_group_msg" : "/send_private_msg";

            const isGroupFile =
                targetType === "group" &&
                !!mediaUrl &&
                isNapCatGroupFileCandidate(mediaUrl);

            if (isGroupFile) {
                let stagedPath: string | null = null;
                try {
                    const localFilePath = resolveLocalFilePath(mediaUrl!);
                    if (!localFilePath) {
                        throw new Error("Group file upload requires a local path or file:// URL");
                    }
                    await ensureReadableFile(localFilePath);
                    const fileName = path.basename(localFilePath);
                    const folder = String(config.groupFileFolder || "").trim();

                    const mappedPath = getContainerVisiblePath(localFilePath, config);
                    stagedPath = mappedPath ? null : await stageFileForNapCat(localFilePath, config);
                    const uploadFilePath = mappedPath || stagedPath || localFilePath;

                    if (uploadFilePath === localFilePath && !mappedPath && !stagedPath) {
                        throw new Error("Group file path is not container-visible. Configure groupFileHostPrefix/groupFileContainerPrefix or groupFileStageHostDir/groupFileStageContainerDir.");
                    }

                    const uploadPayload = {
                        groupId: targetId,
                        filePath: uploadFilePath,
                        fileName,
                        folder: folder || undefined,
                    };
                    console.log(`[NapCat] upload_group_file local=${localFilePath} uploadFilePath=${uploadFilePath} payload=${JSON.stringify({
                        group_id: uploadPayload.groupId,
                        file: uploadPayload.filePath,
                        name: uploadPayload.fileName,
                        folder: uploadPayload.folder ?? null,
                        upload_file: true,
                    })}`);
                    const uploadResult = await uploadGroupFileToNapCat(`${baseUrl}/upload_group_file`, uploadPayload, token);

                    if (text && text.trim()) {
                        await sendToNapCat(`${baseUrl}${endpoint}`, {
                            group_id: targetId,
                            message: text,
                        }, token);
                    }

                    console.log(`[NapCat] Uploaded group file to ${targetId}: ${localFilePath}`);
                    return { ok: true, result: uploadResult };
                } catch (err: any) {
                    return { ok: false, error: err.message };
                } finally {
                    if (stagedPath) {
                        try {
                            const hostStageDir = String(config.groupFileStageHostDir || "").trim().replace(/\/+$/, "");
                            const containerStageDir = String(config.groupFileStageContainerDir || "").trim().replace(/\/+$/, "");
                            if (hostStageDir && containerStageDir && stagedPath.startsWith(`${containerStageDir}/`)) {
                                const relative = stagedPath.slice(containerStageDir.length).replace(/^\/+/, "");
                                const stagedHostPath = path.join(hostStageDir, relative);
                                await unlink(stagedHostPath);
                                console.log(`[NapCat] Cleaned staged file: ${stagedHostPath}`);
                            }
                        } catch (cleanupErr: any) {
                            console.warn(`[NapCat] Failed to cleanup staged file ${stagedPath}: ${cleanupErr?.message || cleanupErr}`);
                        }
                    }
                }
            }

            // Basic media support: try CQ image/record format.
            const mediaMessage = mediaUrl
                ? await buildNapCatMediaCq(mediaUrl, config)
                : "";
            const message = text
                ? (mediaMessage ? `${text}\n${mediaMessage}` : text)
                : (mediaMessage || "");

            const payload: any = { message };
            if (targetType === "group") payload.group_id = targetId;
            else payload.user_id = targetId;

            console.log(`[NapCat] Sending media to ${targetType} ${targetId}: ${message}`);

            try {
                const result = await sendToNapCat(`${baseUrl}${endpoint}`, payload, token);
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
