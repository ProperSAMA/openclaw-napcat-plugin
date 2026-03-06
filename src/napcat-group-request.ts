import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { sanitizeLogToken } from "./napcat-inbound-log.js";

function getGroupRequestLogDir(config: any): string {
    const baseDirRaw = String(config?.friendRequestLogDir || "./logs/napcat-friend-requests").trim() || "./logs/napcat-friend-requests";
    return resolve(baseDirRaw);
}

async function appendGroupRequestLog(event: any, config: any, extra: Record<string, any> = {}): Promise<void> {
    const baseDir = getGroupRequestLogDir(config);
    const groupId = sanitizeLogToken(String(event?.group_id || "unknown_group"));
    const userId = sanitizeLogToken(String(event?.user_id || "unknown_user"));
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        post_type: event?.post_type || "",
        request_type: event?.request_type || "",
        sub_type: event?.sub_type || "",
        self_id: event?.self_id,
        group_id: event?.group_id,
        user_id: event?.user_id,
        nickname: event?.nickname || event?.sender?.nickname || "",
        comment: event?.comment || "",
        flag: event?.flag || "",
        ...extra,
    }) + "\n";
    const files = [
        resolve(baseDir, "requests.log"),
        resolve(baseDir, `group-${groupId}.log`),
        resolve(baseDir, `qq-${userId}.log`),
    ];
    for (const filePath of files) {
        await mkdir(dirname(filePath), { recursive: true });
        await appendFile(filePath, line, "utf8");
    }
}

export async function handleNapCatGroupRequest(event: any, config: any): Promise<void> {
    const groupId = String(event?.group_id || "").trim();
    const userId = String(event?.user_id || "").trim();
    const flag = String(event?.flag || "").trim();
    const subType = String(event?.sub_type || "").trim().toLowerCase();

    if (!groupId || !userId || !flag || !subType) {
        await appendGroupRequestLog(event, config, {
            status: "invalid",
            reason: "missing_group_request_fields",
        });
        console.warn("[NapCat] Ignore malformed group request event:", event);
        return;
    }

    await appendGroupRequestLog(event, config, {
        status: "pending",
        request_kind: subType === "invite" ? "group_invite" : "group_add_request",
    });
    console.log(`[NapCat] Group request pending type=${subType} group=${groupId} user=${userId}`);
}
