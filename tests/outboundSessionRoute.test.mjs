import assert from "node:assert/strict";
import test from "node:test";

import { napcatPlugin } from "../dist/src/channel.js";

const messaging = napcatPlugin.messaging;

test("inferTargetChatType detects direct chats from private targets", () => {
  assert.equal(messaging.inferTargetChatType({ to: "private:123456" }), "direct");
  assert.equal(messaging.inferTargetChatType({ to: "napcat:private:123456" }), "direct");
  assert.equal(
    messaging.inferTargetChatType({ to: "session:napcat:private:123456" }),
    "direct",
  );
  assert.equal(
    messaging.inferTargetChatType({ to: "napcat:session:napcat:private:123456" }),
    "direct",
  );
});

test("inferTargetChatType detects group chats from group targets", () => {
  assert.equal(messaging.inferTargetChatType({ to: "group:987654" }), "group");
  assert.equal(messaging.inferTargetChatType({ to: "napcat:group:987654" }), "group");
  assert.equal(
    messaging.inferTargetChatType({ to: "session:napcat:group:987654" }),
    "group",
  );
});

test("inferTargetChatType returns undefined for bare QQ numbers and unknown targets", () => {
  assert.equal(messaging.inferTargetChatType({ to: "123456" }), undefined);
  assert.equal(messaging.inferTargetChatType({ to: "napcat:123456" }), undefined);
  assert.equal(messaging.inferTargetChatType({ to: "somebody" }), undefined);
  assert.equal(messaging.inferTargetChatType({ to: "" }), undefined);
});

test("resolveOutboundSessionRoute builds canonical private session keys", () => {
  const route = messaging.resolveOutboundSessionRoute({
    cfg: {},
    agentId: "main",
    target: "session:napcat:private:123456",
  });
  assert.deepEqual(route, {
    sessionKey: "agent:main:main",
    baseSessionKey: "agent:main:main",
    recipientSessionExact: true,
    peer: { kind: "direct", id: "123456" },
    chatType: "direct",
    from: "napcat:private:123456",
    to: "private:123456",
  });
});

test("resolveOutboundSessionRoute builds canonical group session keys", () => {
  const route = messaging.resolveOutboundSessionRoute({
    cfg: {},
    agentId: "main",
    target: "napcat:session:napcat:group:987654",
  });
  assert.equal(route.sessionKey, "agent:main:napcat:group:987654");
  assert.equal(route.baseSessionKey, "agent:main:napcat:group:987654");
  assert.equal(route.recipientSessionExact, true);
  assert.deepEqual(route.peer, { kind: "group", id: "987654" });
  assert.equal(route.chatType, "group");
  assert.equal(route.from, "napcat:group:987654");
  assert.equal(route.to, "group:987654");
});

test("resolveOutboundSessionRoute accepts short private/group targets without the session prefix", () => {
  const direct = messaging.resolveOutboundSessionRoute({
    cfg: {},
    agentId: "main",
    target: "private:123456",
  });
  assert.equal(direct.sessionKey, "agent:main:main");
  assert.equal(direct.chatType, "direct");

  const group = messaging.resolveOutboundSessionRoute({
    cfg: {},
    agentId: "main",
    target: "group:987654",
  });
  assert.equal(group.sessionKey, "agent:main:napcat:group:987654");
  assert.equal(group.chatType, "group");
});

test("resolveOutboundSessionRoute normalizes the agent id like the inbound webhook", () => {
  const route = messaging.resolveOutboundSessionRoute({
    cfg: {},
    agentId: " Main ",
    target: "private:123456",
  });
  assert.equal(route.sessionKey, "agent:main:main");
});

test("resolveOutboundSessionRoute honors OpenClaw direct-message scope", () => {
  const route = messaging.resolveOutboundSessionRoute({
    cfg: { session: { dmScope: "per-peer" } },
    agentId: "main",
    accountId: "default",
    target: "private:123456",
  });

  assert.equal(route.sessionKey, "agent:main:direct:123456");
  assert.equal(route.baseSessionKey, route.sessionKey);
  assert.equal(route.recipientSessionExact, true);
});

test("resolveOutboundSessionRoute returns null for bare QQ numbers so the core fallback handles them", () => {
  assert.equal(
    messaging.resolveOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "123456",
    }),
    null,
  );
  assert.equal(
    messaging.resolveOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "napcat:123456",
    }),
    null,
  );
  assert.equal(
    messaging.resolveOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "not-a-target",
    }),
    null,
  );
});
