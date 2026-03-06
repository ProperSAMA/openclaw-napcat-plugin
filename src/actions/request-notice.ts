import {
    coerceBoolean,
    coerceNonEmptyString,
    requireObjectPayload,
} from "../napcat-action-params.js";
import { callNapCatAction } from "../napcat-transport.js";

async function setGroupAddRequest(config: any, rawPayload: any) {
    const payload = requireObjectPayload(rawPayload, "set_group_add_request");
    const flag = coerceNonEmptyString(payload.flag, "flag");
    const subType = coerceNonEmptyString(payload.sub_type ?? payload.subType ?? payload.type, "sub_type");
    const normalizedSubType = subType.toLowerCase();
    if (!["add", "invite"].includes(normalizedSubType)) {
        throw new Error("sub_type 必须是 add 或 invite");
    }
    const approve = coerceBoolean(payload.approve, "approve");
    const reason = String(payload.reason ?? payload.remark ?? "").trim();
    const requestPayload: Record<string, any> = {
        flag,
        sub_type: normalizedSubType,
        approve,
    };
    if (reason) {
        requestPayload.reason = reason;
    }
    return callNapCatAction(config, "set_group_add_request", requestPayload);
}

async function getGroupSystemMsg(config: any, rawPayload: any) {
    requireObjectPayload(rawPayload, "get_group_system_msg");
    return callNapCatAction(config, "get_group_system_msg", {});
}

async function getGroupIgnoreAddRequest(config: any, rawPayload: any) {
    requireObjectPayload(rawPayload, "get_group_ignore_add_request");
    return callNapCatAction(config, "get_group_ignore_add_request", {});
}

export const requestNoticeActionHandlers: Record<string, (config: any, rawPayload: any) => Promise<any>> = {
    set_group_add_request: setGroupAddRequest,
    get_group_system_msg: getGroupSystemMsg,
    get_group_ignore_add_request: getGroupIgnoreAddRequest,
};
