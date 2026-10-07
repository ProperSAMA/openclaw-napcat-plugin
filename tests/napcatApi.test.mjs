import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { NapCatBusinessError, sendNapCatMessage, sendToNapCat } from "../dist/src/napcatApi.js";

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

// Collects request bodies so a test can assert both how many sends happened and what each one
// carried. The handler is swapped per test to choose the response.
async function withServer(handler, body) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      handler(req, res, requests.length);
    });
  });
  const baseUrl = await listen(server);
  try {
    return await body({ baseUrl, requests });
  } finally {
    await close(server);
  }
}

function ok(res, messageId = 24680) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(`{"status":"ok","data":{"message_id":${messageId}}}`);
}

function failed(res, retcode = 100) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(`{"status":"failed","retcode":${retcode},"message":"invalid reply id"}`);
}

test("a NapCat-level failure is typed so callers can tell it from a lost response", async () => {
  await withServer((req, res) => failed(res, 200), async ({ baseUrl }) => {
    const err = await sendToNapCat(`${baseUrl}/send_group_msg`, { message: "x" }, undefined, { allowRetry: false })
      .then(() => null, (e) => e);

    assert.ok(err instanceof NapCatBusinessError, `expected NapCatBusinessError, got ${err}`);
    assert.equal(err.retcode, 200);
    assert.equal(err.status, "failed");
    // Existing assertions elsewhere match on the message text.
    assert.match(err.message, /NapCat API returned failure/);
  });
});

test("a lost response is not typed as a business failure", async () => {
  await withServer((req) => req.socket.destroy(), async ({ baseUrl }) => {
    const err = await sendToNapCat(`${baseUrl}/send_group_msg`, { message: "x" }, undefined, { allowRetry: false })
      .then(() => null, (e) => e);

    assert.ok(err, "expected the send to fail");
    assert.ok(!(err instanceof NapCatBusinessError), `a network error must stay untyped, got ${err}`);
  });
});

test("a rejected quote is resent once without the prefix", async () => {
  await withServer(
    (req, res, count) => (count === 1 ? failed(res) : ok(res, 11223)),
    async ({ baseUrl, requests }) => {
      const result = await sendNapCatMessage(
        `${baseUrl}/send_group_msg`,
        { group_id: "829914484", message: "[CQ:reply,id=55667788] 这次要引用" },
        undefined,
      );

      assert.equal(requests.length, 2);
      assert.equal(requests[0].message, "[CQ:reply,id=55667788] 这次要引用");
      assert.equal(requests[1].message, "这次要引用");
      assert.equal(result.data.message_id, 11223);
    },
  );
});

test("a business failure on a message without a quote is not resent", async () => {
  await withServer((req, res) => failed(res), async ({ baseUrl, requests }) => {
    const err = await sendNapCatMessage(`${baseUrl}/send_group_msg`, { message: "普通回复" }, undefined)
      .then(() => null, (e) => e);

    assert.ok(err instanceof NapCatBusinessError);
    // Nothing to degrade to, so resending would just be the same rejected message again.
    assert.equal(requests.length, 1);
  });
});

test("a lost response is never resent, even for a quoted reply", async () => {
  // NapCat may have accepted the message before the response was lost, so a resend could
  // deliver a second copy. The quote-degrading retry is only safe when NapCat answered.
  await withServer((req) => req.socket.destroy(), async ({ baseUrl, requests }) => {
    const err = await sendNapCatMessage(
      `${baseUrl}/send_group_msg`,
      { group_id: "829914484", message: "[CQ:reply,id=55667788] 这次要引用" },
      undefined,
    ).then(() => null, (e) => e);

    assert.ok(err);
    assert.ok(!(err instanceof NapCatBusinessError));
    assert.equal(requests.length, 1);
  });
});
