import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getInboundLogFilePath, sanitizeLogToken } from "./napcat-inbound-log.js";

const supportedNoticeTypes = new Set([
    "group_increase",
    "group_decrease",
    "group_recall",
    "group_ban",
    "group_admin",
]);

function getNoticeLogDir(config: any): string {
    const samplePath = getInboundLogFilePath("notice", "index", config);
    return dirname(samplePath);
}

function buildNoticeSummary(event: any): string {
    const noticeType = String(event?.notice_type || "").trim();
    const subType = String(event?.sub_type || "").trim();
    const groupId = String(event?.group_id || "").trim();
    const userId = String(event?.user_id || "").trim();
    const operatorId = String(event?.operator_id || "").trim();

    if (noticeType === "group_recall") {
        return `group_recall group=${groupId} message=${String(event?.message_id || "")} operator=${operatorId || "unknown"}`;
    }
    if (noticeType === "group_ban") {
        return `group_ban group=${groupId} user=${userId || "all"} operator=${operatorId || "unknown"} duration=${String(event?.duration || 0)}`;
    }
    if (noticeType === "group_admin") {
        return `group_admin/${subType || "unknown"} group=${groupId} user=${userId}`;
    }
    if (noticeType === "group_increase" || noticeType === "group_decrease") {
        return `${noticeType}/${subType || "unknown"} group=${groupId} user=${userId} operator=${operatorId || "unknown"}`;
    }
    return `${noticeType || "unknown"}${subType ? `/${subType}` : ""} group=${groupId || "n/a"} user=${userId || "n/a"}`;
}

async function appendNoticeLog(event: any, config: any): Promise<void> {
    const baseDir = getNoticeLogDir(config);
    const groupId = sanitizeLogToken(String(event?.group_id || "global"));
    const userId = sanitizeLogToken(String(event?.user_id || event?.operator_id || "unknown_user"));
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        post_type: event?.post_type || "",
        notice_type: event?.notice_type || "",
        sub_type: event?.sub_type || "",
        self_id: event?.self_id,
        group_id: event?.group_id,
        user_id: event?.user_id,
        operator_id: event?.operator_id,
        target_id: event?.target_id,
        message_id: event?.message_id,
        duration: event?.duration,
        supported: supportedNoticeTypes.has(String(event?.notice_type || "")),
        summary: buildNoticeSummary(event),
        raw: event,
    }) + "\n";
    const files = [
        resolve(baseDir, "notices.log"),
        resolve(baseDir, "notices", `group-${groupId}.log`),
        resolve(baseDir, "notices", `qq-${userId}.log`),
    ];
    for (const filePath of files) {
        await mkdir(dirname(filePath), { recursive: true });
        await appendFile(filePath, line, "utf8");
    }
}

export async function handleNapCatNoticeEvent(event: any, config: any): Promise<void> {
    await appendNoticeLog(event, config);
    const noticeType = String(event?.notice_type || "").trim();
    if (supportedNoticeTypes.has(noticeType)) {
        console.log(`[NapCat] Notice observed: ${buildNoticeSummary(event)}`);
    }
}
