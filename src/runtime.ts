// Global runtime reference for the plugin
let _runtime: any;
let _config: any = {};
const activeGroupReplyContexts = new Map<string, {
  senderId: string;
  token: symbol;
  expiresAt: number;
}>();

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

export function beginNapCatGroupReplyContext(groupId: string, senderId: string): symbol | null {
  const normalizedGroupId = String(groupId || "").trim();
  const normalizedSenderId = String(senderId || "").trim();
  if (!/^\d+$/.test(normalizedGroupId) || !/^\d+$/.test(normalizedSenderId)) {
    return null;
  }

  const token = Symbol(`napcat-group-reply:${normalizedGroupId}`);
  activeGroupReplyContexts.set(normalizedGroupId, {
    senderId: normalizedSenderId,
    token,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  return token;
}

export function endNapCatGroupReplyContext(groupId: string, token: symbol | null) {
  if (!token) return;
  const normalizedGroupId = String(groupId || "").trim();
  const current = activeGroupReplyContexts.get(normalizedGroupId);
  if (current?.token === token) {
    activeGroupReplyContexts.delete(normalizedGroupId);
  }
}

export function getNapCatGroupReplyMentionUser(groupId: string): string | undefined {
  const normalizedGroupId = String(groupId || "").trim();
  const current = activeGroupReplyContexts.get(normalizedGroupId);
  if (!current) return undefined;
  if (current.expiresAt <= Date.now()) {
    activeGroupReplyContexts.delete(normalizedGroupId);
    return undefined;
  }
  return current.senderId;
}
