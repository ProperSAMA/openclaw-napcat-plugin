export function resolveNapCatEmojiId(value: string): string {
    const normalized = value.trim().replace(/[\uFE0E\uFE0F]/g, "");
    if (!normalized) {
        throw new Error("Reaction emoji is required");
    }
    if (/^\d+$/.test(normalized)) {
        return normalized;
    }

    const codePoints = Array.from(normalized);
    if (codePoints.length !== 1 || !/^\p{Extended_Pictographic}$/u.test(normalized)) {
        throw new Error(
            `NapCat reactions require a numeric QQ emoji ID or one Unicode emoji; received ${JSON.stringify(normalized)}`
        );
    }

    const codePoint = codePoints[0].codePointAt(0);
    if (!codePoint) {
        throw new Error(`Unable to resolve QQ emoji ID for ${JSON.stringify(normalized)}`);
    }
    return String(codePoint);
}

export function shouldSendNapCatAckReaction(params: {
    scope?: string;
    isGroup: boolean;
    requireMention: boolean;
    wasMentioned: boolean;
}): boolean {
    const scope = params.scope || "group-mentions";
    if (scope === "off" || scope === "none") return false;
    if (scope === "all") return true;
    if (scope === "direct") return !params.isGroup;
    if (scope === "group-all") return params.isGroup;
    if (scope === "group-mentions") {
        return params.isGroup && params.requireMention && params.wasMentioned;
    }
    return false;
}
