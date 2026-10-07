import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Global runtime reference for the plugin
let _runtime: any;
let _config: any = {};
// One entry per inbound group message, kept until it expires rather than until the webhook
// handler returns. With queue mode "followup" the handler returns as soon as the message is
// enqueued and the agent run happens later, so tearing the entry down on return removed the
// context before the run that needed it had even started -- and that run's replies then went
// out with neither a quote nor an @.
type NapCatGroupReplyEntry = {
  senderId: string;
  messageId?: string;
  token: symbol;
  expiresAt: number;
};

const activeGroupReplyContexts = new Map<string, NapCatGroupReplyEntry[]>();

// Running total of entries across every group, maintained by the helpers below so the bounds
// can be enforced in O(1) instead of by rescanning the map.
let activeGroupReplyEntryCount = 0;

// Three bounds, because each one alone leaks: the group count caps a burst of distinct
// groups, the per-group entry cap keeps one busy group from growing without bound, and the
// total caps the product of the two. Expired entries form a prefix of each group's array
// (they are appended in non-decreasing expiry order), so pruning them is a prefix removal
// rather than the full-array scan this used to do on every insert and every lookup.
const GROUP_CONTEXT_LIMIT = 500;
const GROUP_ENTRY_LIMIT = 8;
const TOTAL_ENTRY_LIMIT = 2000;
const GROUP_CONTEXT_TTL_MS = 10 * 60 * 1000;
const GROUP_CONTEXT_SWEEP_INTERVAL_MS = 30_000;

function dropNapCatGroupReplyContext(groupId: string): void {
  const entries = activeGroupReplyContexts.get(groupId);
  if (!entries) return;
  activeGroupReplyEntryCount -= entries.length;
  activeGroupReplyContexts.delete(groupId);
}

function pruneExpiredGroupReplyEntries(entries: NapCatGroupReplyEntry[], now: number): void {
  let expired = 0;
  while (expired < entries.length && entries[expired].expiresAt <= now) expired += 1;
  if (expired === 0) return;
  entries.splice(0, expired);
  activeGroupReplyEntryCount -= expired;
}

// Reclaims groups that have gone quiet. Lazy pruning only runs when the same group is touched
// again, which for a group that stops receiving messages never happens, so the entries would
// sit in the map forever. Called on a timer and directly by tests.
export function sweepNapCatGroupReplyContexts(now: number = Date.now()): void {
  for (const [groupId, entries] of [...activeGroupReplyContexts]) {
    pruneExpiredGroupReplyEntries(entries, now);
    if (entries.length === 0) dropNapCatGroupReplyContext(groupId);
  }

  while (activeGroupReplyEntryCount > TOTAL_ENTRY_LIMIT && activeGroupReplyContexts.size > 0) {
    const oldest = activeGroupReplyContexts.keys().next().value;
    if (oldest === undefined) break;
    dropNapCatGroupReplyContext(oldest);
  }
}

// Started from the plugin's gateway hook and stopped when the account aborts, so importing
// this module never leaves a timer running behind the caller's back.
export function startNapCatGroupReplyContextSweeper(): () => void {
  const timer = setInterval(() => sweepNapCatGroupReplyContexts(), GROUP_CONTEXT_SWEEP_INTERVAL_MS);
  // The sweep must never be the reason the process stays alive.
  timer.unref?.();
  return () => clearInterval(timer);
}

// Exposed so tests can assert the bounds hold rather than inferring them from behaviour.
export function getNapCatGroupReplyContextStats(): { groupCount: number; entryCount: number } {
  return { groupCount: activeGroupReplyContexts.size, entryCount: activeGroupReplyEntryCount };
}

export function setNapCatRuntime(runtime: any) {
  _runtime = runtime;
}

export function setNapCatConfig(config: any) {
  _config = config;
}

export function getNapCatRuntime() {
  if (!_runtime) {
    throw new Error("NapCat runtime not initialized");
  }
  return _runtime;
}

export function getNapCatConfig() {
  return _config || {};
}

// Opt-in: an absent key means upstream behaviour (the @ mention), so only an explicit
// true turns quoting on. Per-conversation files inherit this default.
export function isNapCatGroupQuoteReplyEnabled(config: any): boolean {
  return config?.groupReplyQuote === true;
}

// Behaviour keys a per-conversation override file may set. Connection-layer keys
// (url, token, mediaProxy*, conversationConfigDir, ...) are deliberately excluded so a
// stray file can never redirect traffic at a different NapCat instance.
const CONVERSATION_OVERRIDABLE_KEYS = new Set([
  "groupReplyQuote",
  "streaming_mode",
  "enable_progress_messages",
  "plainTextMode",
  "groupMentionOnly",
  "enablePrivateTypingStatus",
  "agentId",
]);

const CONVERSATION_CONFIG_CACHE_LIMIT = 500;
const conversationConfigCache = new Map<string, { mtimeMs: number; data: Record<string, any> }>();
const warnedNonOverridableKeys = new Set<string>();

// Mirrors the schema default. Applied here too because an absent key is not guaranteed to
// have been materialised into the runtime config; a missing directory is a no-op anyway.
const DEFAULT_CONVERSATION_CONFIG_DIR = "~/.openclaw/napcat/conversations";

function expandHome(dir: string): string {
  if (dir === "~") return homedir();
  if (dir.startsWith("~/")) return join(homedir(), dir.slice(2));
  return dir;
}

// Absent -> the default directory. Explicitly empty -> disabled.
function resolveConversationConfigDir(config: any): string {
  const raw = config?.conversationConfigDir;
  if (raw === undefined || raw === null) return expandHome(DEFAULT_CONVERSATION_CONFIG_DIR);
  const trimmed = String(raw).trim();
  return trimmed ? expandHome(trimmed) : "";
}

// Reads <dir>/<fileName> as a flat JSON object, cached by mtime so an edited file takes
// effect on the next message without restarting anything. Never throws: an unreadable or
// malformed file degrades to "no override" instead of taking the channel down.
function readConversationConfigLayer(dir: string, fileName: string): Record<string, any> | null {
  const filePath = join(dir, fileName);

  let mtimeMs: number;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    conversationConfigCache.delete(filePath);
    return null;
  }

  const cached = conversationConfigCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.data;

  let data: Record<string, any>;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`[NapCat] Conversation config ${filePath} must be a JSON object; ignored`);
      return null;
    }
    data = parsed;
  } catch (err: any) {
    console.warn(`[NapCat] Failed to read conversation config ${filePath}:`, err?.message || err);
    return null;
  }

  if (conversationConfigCache.size >= CONVERSATION_CONFIG_CACHE_LIMIT) {
    const oldest = conversationConfigCache.keys().next().value;
    if (oldest !== undefined) conversationConfigCache.delete(oldest);
  }
  conversationConfigCache.set(filePath, { mtimeMs, data });
  return data;
}

// Layers <dir>/default.json, then <dir>/<group|private>-<id>.json, on top of the channel
// config. The result is a superset of baseConfig, so callers can keep reading
// connection-layer keys (url, token, ...) from it unchanged.
export function resolveNapCatConversationConfig(baseConfig: any, conversationId: string): any {
  const dir = resolveConversationConfigDir(baseConfig);
  if (!dir) return baseConfig;

  const layers: Array<Record<string, any>> = [];
  const defaultLayer = readConversationConfigLayer(dir, "default.json");
  if (defaultLayer) layers.push(defaultLayer);

  // Validate before building a filename: group ids and sender ids arrive from NapCat over
  // the wire, so an unchecked value could escape the directory via "..".
  const match = /^(group|private):(\d+)$/.exec(String(conversationId || "").trim());
  if (match) {
    const layer = readConversationConfigLayer(dir, `${match[1]}-${match[2]}.json`);
    if (layer) layers.push(layer);
  }

  if (layers.length === 0) return baseConfig;

  const merged: any = { ...baseConfig };
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (!CONVERSATION_OVERRIDABLE_KEYS.has(key)) {
        if (!warnedNonOverridableKeys.has(key)) {
          warnedNonOverridableKeys.add(key);
          console.warn(`[NapCat] Conversation config key "${key}" is not overridable; ignored`);
        }
        continue;
      }
      merged[key] = value;
    }
  }
  return merged;
}

export function beginNapCatGroupReplyContext(
  groupId: string,
  senderId: string,
  messageId?: string
): symbol | null {
  const normalizedGroupId = String(groupId || "").trim();
  const normalizedSenderId = String(senderId || "").trim();
  if (!/^\d+$/.test(normalizedGroupId) || !/^\d+$/.test(normalizedSenderId)) {
    return null;
  }

  const normalizedMessageId = String(messageId ?? "").trim();
  const token = Symbol(`napcat-group-reply:${normalizedGroupId}`);
  const now = Date.now();

  let entries = activeGroupReplyContexts.get(normalizedGroupId);
  if (entries) {
    pruneExpiredGroupReplyEntries(entries, now);
    // Drop the group once its last entry expired, so the group count reflects groups with a
    // live turn rather than every group ever seen.
    if (entries.length === 0) {
      dropNapCatGroupReplyContext(normalizedGroupId);
      entries = undefined;
    }
  }

  if (!entries) {
    if (activeGroupReplyContexts.size >= GROUP_CONTEXT_LIMIT) {
      const oldest = activeGroupReplyContexts.keys().next().value;
      if (oldest !== undefined) dropNapCatGroupReplyContext(oldest);
    }
    entries = [];
    activeGroupReplyContexts.set(normalizedGroupId, entries);
  }

  entries.push({
    senderId: normalizedSenderId,
    messageId: /^\d+$/.test(normalizedMessageId) ? normalizedMessageId : undefined,
    token,
    expiresAt: now + GROUP_CONTEXT_TTL_MS,
  });
  activeGroupReplyEntryCount += 1;

  // Only the newest few turns can plausibly own an outbound send, so the oldest are dropped
  // rather than kept until they expire.
  const excess = entries.length - GROUP_ENTRY_LIMIT;
  if (excess > 0) {
    entries.splice(0, excess);
    activeGroupReplyEntryCount -= excess;
  }

  return token;
}

// The turn a send belongs to, identified by the message id it answers. Core hands that id to
// the outbound path (ctx.replyToId, sourced from this turn's MessageSid), so an exact match is
// what scopes a reply to its own turn. The previous "latest entry for the group" lookup could
// not: for the whole TTL window it handed every unrelated send to the group -- an announcement,
// a proactive message -- the prefix of a turn that had already finished.
function findGroupReplyContext(groupId: string, messageId: string): NapCatGroupReplyEntry | undefined {
  const normalizedGroupId = String(groupId || "").trim();
  const normalizedMessageId = String(messageId ?? "").trim();
  if (!/^\d+$/.test(normalizedMessageId)) return undefined;

  const entries = activeGroupReplyContexts.get(normalizedGroupId);
  if (!entries || entries.length === 0) return undefined;

  pruneExpiredGroupReplyEntries(entries, Date.now());
  if (entries.length === 0) {
    dropNapCatGroupReplyContext(normalizedGroupId);
    return undefined;
  }

  // Newest first: if the same message id were registered twice, the later turn's sender wins.
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].messageId === normalizedMessageId) return entries[i];
  }
  return undefined;
}

// Only the sender is looked up this way. A quote id comes straight from core's replyToId, but
// that carries no sender, so the @ fallback (groupReplyQuote: false) still needs the turn that
// registered this message. An id nobody registered yields nothing rather than a guess.
export function getNapCatGroupReplySender(groupId: string, messageId: string): string | undefined {
  return findGroupReplyContext(groupId, messageId)?.senderId;
}
