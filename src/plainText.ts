export function isPlainTextModeEnabled(config: any): boolean {
    return config?.plainTextMode !== false;
}

export function formatNapCatOutgoingText(text: string, config: any): string {
    const raw = String(text ?? "");
    if (!isPlainTextModeEnabled(config) || !raw) return raw;
    return markdownToPlainText(raw);
}

function markdownToPlainText(input: string): string {
    let text = input.replace(/\r\n/g, "\n");

    text = text.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_match, code) => String(code || "").trim());
    text = text.replace(/~~~[a-zA-Z0-9_-]*\n?([\s\S]*?)~~~/g, (_match, code) => String(code || "").trim());
    text = text.replace(/`([^`\n]+)`/g, "$1");

    text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, alt, url) => {
        const label = String(alt || "").trim();
        const target = String(url || "").trim();
        return [label, target].filter(Boolean).join(" ");
    });
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, label, url) => {
        const textLabel = String(label || "").trim();
        const target = String(url || "").trim();
        return [textLabel, target].filter(Boolean).join(" ");
    });

    text = text.replace(/^#{1,6}\s+/gm, "");
    text = text.replace(/^\s{0,3}>\s?/gm, "");
    text = text.replace(/^\s{0,3}([-*_]){3,}\s*$/gm, "");
    text = text.replace(/^\s{0,3}([-*+])\s+/gm, "$1 ");
    text = text.replace(/^\s{0,3}\d+[.)]\s+/gm, "");

    text = text.replace(/\*\*([^*\n]+)\*\*/g, "$1");
    text = text.replace(/__([^_\n]+)__/g, "$1");
    text = text.replace(/\*([^*\n]+)\*/g, "$1");
    text = text.replace(/_([^_\n]+)_/g, "$1");
    text = text.replace(/~~([^~\n]+)~~/g, "$1");

    text = text.replace(/^\s*\|(.+)\|\s*$/gm, (_match, row) => {
        const cells = String(row)
            .split("|")
            .map((cell) => cell.trim())
            .filter(Boolean);
        if (cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))) {
            return "";
        }
        return cells.join(" | ");
    });

    return text
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
