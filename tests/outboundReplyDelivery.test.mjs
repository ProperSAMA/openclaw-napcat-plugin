import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { napcatPlugin } from "../dist/src/channel.js";
import {
  beginNapCatGroupReplyContext,
  endNapCatGroupReplyContext,
} from "../dist/src/runtime.js";

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
  const token = beginNapCatGroupReplyContext(groupId, "997794945");

  try {
    const result = await napcatPlugin.outbound.sendText({
      to: `group:${groupId}`,
      text: "这次应该只发一次",
      cfg: { channels: { napcat: { url: baseUrl } } },
    });

    assert.deepEqual(requests, [{
      group_id: groupId,
      message: "[CQ:at,qq=997794945] 这次应该只发一次",
    }]);
    assert.equal(result.channel, "napcat");
    assert.equal(result.messageId, "24680");
    assert.equal(result.chatId, groupId);
  } finally {
    endNapCatGroupReplyContext(groupId, token);
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
