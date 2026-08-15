import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { napcatMessageActions } from "../dist/src/channel.js";
import {
  resolveNapCatEmojiId,
  shouldSendNapCatAckReaction,
} from "../dist/src/reactions.js";

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

test("converts a Unicode emoji to the QQ reaction emoji ID", () => {
  assert.equal(resolveNapCatEmojiId("👀"), "128064");
  assert.equal(resolveNapCatEmojiId("👍"), "128077");
  assert.equal(resolveNapCatEmojiId("❤️"), "10084");
  assert.equal(resolveNapCatEmojiId("128064"), "128064");
});

test("rejects composite emoji that cannot map to one QQ emoji ID", () => {
  assert.throws(() => resolveNapCatEmojiId("👨‍💻"), /numeric QQ emoji ID or one Unicode emoji/);
  assert.throws(() => resolveNapCatEmojiId("A"), /numeric QQ emoji ID or one Unicode emoji/);
});

test("uses OpenClaw ack reaction scope semantics", () => {
  const base = { isGroup: true, requireMention: true, wasMentioned: true };
  assert.equal(shouldSendNapCatAckReaction({ ...base, scope: "group-mentions" }), true);
  assert.equal(shouldSendNapCatAckReaction({ ...base, wasMentioned: false, scope: "group-mentions" }), false);
  assert.equal(shouldSendNapCatAckReaction({ ...base, scope: "group-all" }), true);
  assert.equal(shouldSendNapCatAckReaction({ ...base, scope: "off" }), false);
  assert.equal(shouldSendNapCatAckReaction({ ...base, isGroup: false, scope: "direct" }), true);
});

test("react action targets the current inbound message and supports removal", async () => {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        url: req.url,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"ok","data":{"result":true}}');
    });
  });
  const baseUrl = await listen(server);

  try {
    const result = await napcatMessageActions.handleAction({
      action: "react",
      params: { emoji: "👀", remove: true },
      cfg: { channels: { napcat: { url: baseUrl } } },
      toolContext: { currentMessageId: "24680" },
    });

    assert.deepEqual(requests, [{
      url: "/set_msg_emoji_like",
      body: {
        message_id: "24680",
        emoji_id: "128064",
        set: false,
      },
    }]);
    assert.match(result.content[0].text, /"ok": true/);
  } finally {
    await close(server);
  }
});

test("does not intercept the core send action", () => {
  assert.equal(napcatMessageActions.supportsAction({ action: "react" }), true);
  assert.equal(napcatMessageActions.supportsAction({ action: "send" }), false);
});
