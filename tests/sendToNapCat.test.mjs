import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { sendToNapCat } from "../dist/src/webhook.js";

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

test("non-idempotent message sends are not retried after a lost response", async () => {
  let requestCount = 0;
  const server = createServer((req) => {
    requestCount += 1;
    req.resume();
    req.on("end", () => {
      // Simulate NapCat accepting the request and sending the QQ message, then
      // losing the HTTP response before OpenClaw can observe success.
      req.socket.destroy();
    });
  });
  const baseUrl = await listen(server);

  try {
    await assert.rejects(
      sendToNapCat(
        `${baseUrl}/send_group_msg`,
        { group_id: "123456", message: "only once" },
        undefined,
        { allowRetry: false },
      ),
    );
    assert.equal(requestCount, 1);
  } finally {
    await close(server);
  }
});

test("idempotent NapCat calls keep transient retries enabled", async () => {
  let requestCount = 0;
  const server = createServer((req, res) => {
    requestCount += 1;
    req.resume();
    req.on("end", () => {
      if (requestCount < 3) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"ok","data":{"message":"retried safely"}}');
    });
  });
  const baseUrl = await listen(server);

  try {
    const result = await sendToNapCat(
      `${baseUrl}/get_forward_msg`,
      { message_id: "123456" },
    );
    assert.equal(requestCount, 3);
    assert.equal(result.data.message, "retried safely");
  } finally {
    await close(server);
  }
});

test("NapCat failed responses are not treated as successful JSON responses", async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"failed","retcode":200,"message":"msg not found"}');
    });
  });
  const baseUrl = await listen(server);

  try {
    await assert.rejects(
      sendToNapCat(`${baseUrl}/set_msg_emoji_like`, {
        message_id: "999999",
        emoji_id: "128064",
        set: true,
      }, undefined, { allowRetry: false }),
      /NapCat API returned failure/,
    );
  } finally {
    await close(server);
  }
});
