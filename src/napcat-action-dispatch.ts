import { parseNapCatActionPayload } from "./napcat-action-params.js";
import { callNapCatAction } from "./napcat-transport.js";
import {
    fileActionHandlers,
    friendActionHandlers,
    groupActionHandlers,
    requestNoticeActionHandlers,
    streamActionHandlers,
    systemActionHandlers,
} from "./actions/index.js";

const actionHandlers: Record<string, (config: any, rawPayload: any) => Promise<any>> = {
    ...friendActionHandlers,
    ...groupActionHandlers,
    ...requestNoticeActionHandlers,
    ...systemActionHandlers,
    ...fileActionHandlers,
    ...streamActionHandlers,
};

export async function dispatchNapCatAction(config: any, action: string, text: string) {
    const payload = parseNapCatActionPayload(text);
    const handler = actionHandlers[action];
    if (handler) {
        return handler(config, payload);
    }
    return callNapCatAction(config, action, payload);
}
