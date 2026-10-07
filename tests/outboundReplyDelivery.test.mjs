import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { napcatPlugin } from "../dist/src/channel.js";
import { beginNapCatGroupReplyContext } from "../dist/src/runtime.js";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("message-tool group replies mention the sender and return a delivery identity", async () => {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"ok","data":{"message_id":24680}}');
    });
  });
  const baseUrl = await listen(server);
  const groupId = "829914483";
  beginNapCatGroupReplyContext(groupId, "997794945", "55667780");

  try {
    const result = await napcatPlugin.outbound.sendText({
      to: `group:${groupId}`,
      text: "这次应该只发一次",
      replyToId: "55667780",
      // groupReplyQuote false routes this conversation to the @ fallback, whose sender can only
      // come from the context registered above -- the core's replyToId carries no sender.
      cfg: { channels: { napcat: { url: baseUrl, groupReplyQuote: false, conversationConfigDir: "" } } },
    });

    assert.deepEqual(requests, [{
      group_id: groupId,
      message: "[CQ:at,qq=997794945] 这次应该只发一次",
    }]);
    assert.equal(result.channel, "napcat");
    assert.equal(result.messageId, "24680");
    assert.equal(result.chatId, groupId);
  } finally {
    await close(server);
  }
});

test("identical immediate outbound retries reuse the first delivery", async () => {
  let requestCount = 0;
  const server = createServer((req, res) => {
    requestCount += 1;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"ok","data":{"message_id":13579}}');
    });
  });
  const baseUrl = await listen(server);
  const args = {
    to: "group:123123123",
    text: "不要重复",
    cfg: { channels: { napcat: { url: baseUrl } } },
  };

  try {
    const first = await napcatPlugin.outbound.sendText(args);
    const second = await napcatPlugin.outbound.sendText(args);
    assert.equal(requestCount, 1);
    assert.equal(first.messageId, "13579");
    assert.equal(second.messageId, "13579");
  } finally {
    await close(server);
  }
});

test("opting into groupReplyQuote swaps the mention for a CQ reply", async () => {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"ok","data":{"message_id":11223}}');
    });
  });
  const baseUrl = await listen(server);
  const groupId = "829914484";
  beginNapCatGroupReplyContext(groupId, "997794945", "55667788");

  try {
    await napcatPlugin.outbound.sendText({
      to: `group:${groupId}`,
      text: "这次要引用",
      replyToId: "55667788",
      // conversationConfigDir "" keeps the lookup off this machine's own conversations
      // directory, so the test only exercises the flag it sets here.
      cfg: { channels: { napcat: { url: baseUrl, groupReplyQuote: true, conversationConfigDir: "" } } },
    });

    assert.deepEqual(requests, [{
      group_id: groupId,
      message: "[CQ:reply,id=55667788] 这次要引用",
    }]);
  } finally {
    await close(server);
  }
});

test("a rejected quote is degraded to a plain send that still reports a delivery", async () => {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(requests.length === 1
        ? '{"status":"failed","retcode":100,"message":"invalid reply id"}'
        : '{"status":"ok","data":{"message_id":33445}}');
    });
  });
  const baseUrl = await listen(server);
  const groupId = "829914485";
  beginNapCatGroupReplyContext(groupId, "997794945", "55667789");

  try {
    const result = await napcatPlugin.outbound.sendText({
      to: `group:${groupId}`,
      text: "引用被拒也要送达",
      replyToId: "55667789",
      cfg: { channels: { napcat: { url: baseUrl, groupReplyQuote: true, conversationConfigDir: "" } } },
    });

    assert.deepEqual(requests.map((r) => r.message), [
      "[CQ:reply,id=55667789] 引用被拒也要送达",
      "引用被拒也要送达",
    ]);
    assert.equal(result.messageId, "33445");
  } finally {
    await close(server);
  }
});

test("an HTTP 200 carrying a NapCat failure rejects instead of fabricating a delivery", async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"failed","retcode":100,"message":"group not found"}');
    });
  });
  const baseUrl = await listen(server);

  try {
    // A plain text send has nothing to degrade to, so the failure has to surface. Previously
    // this returned a synthetic "napcat-ack-*" id, telling OpenClaw the message was delivered.
    await assert.rejects(
      napcatPlugin.outbound.sendText({
        to: "group:829914486",
        text: "这条发不出去",
        cfg: { channels: { napcat: { url: baseUrl, conversationConfigDir: "" } } },
      }),
      /NapCat API returned failure/,
    );
  } finally {
    await close(server);
  }
});

test("a lost response is not resent as an unquoted group reply", async () => {
  let requestCount = 0;
  const server = createServer((req) => {
    requestCount += 1;
    req.resume();
    req.on("end", () => {
      // NapCat may have delivered the message before the response was lost; resending the
      // quote-stripped copy would post it to the group twice.
      req.socket.destroy();
    });
  });
  const baseUrl = await listen(server);
  const groupId = "829914487";
  beginNapCatGroupReplyContext(groupId, "997794945", "55667790");

  try {
    await assert.rejects(napcatPlugin.outbound.sendText({
      to: `group:${groupId}`,
      text: "网络断了不要重发",
      replyToId: "55667790",
      cfg: { channels: { napcat: { url: baseUrl, groupReplyQuote: true, conversationConfigDir: "" } } },
    }));
    assert.equal(requestCount, 1);
  } finally {
    await close(server);
  }
});

test("an independent group send does not inherit the previous turn's addressing", async () => {
  // Queue mode "followup" keeps a turn's context alive past the handler's return, so a send
  // that belongs to no turn -- a scheduled announcement, a proactive message -- used to be
  // addressed to whichever turn for the group ran last, for ten minutes after it ended.
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"ok","data":{"message_id":5566}}');
    });
  });
  const baseUrl = await listen(server);
  const groupId = "829914488";
  beginNapCatGroupReplyContext(groupId, "997794945", "55667791");

  try {
    // No replyToId: this send answers no inbound message, so nothing may be prefixed.
    await napcatPlugin.outbound.sendText({
      to: `group:${groupId}`,
      text: "定时公告",
      cfg: { channels: { napcat: { url: baseUrl, conversationConfigDir: "" } } },
    });
    // A replyToId that no turn registered is still not this send's turn: the sender is unknown,
    // so the mention fallback stays off rather than guessing the group's most recent sender.
    await napcatPlugin.outbound.sendText({
      to: `group:${groupId}`,
      text: "别人的消息",
      replyToId: "55667792",
      cfg: { channels: { napcat: { url: baseUrl, groupReplyQuote: false, conversationConfigDir: "" } } },
    });

    assert.deepEqual(requests.map((r) => r.message), ["定时公告", "别人的消息"]);
  } finally {
    await close(server);
  }
});
