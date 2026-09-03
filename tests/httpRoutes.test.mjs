import assert from "node:assert/strict";
import test from "node:test";

import plugin from "../dist/index.js";
import { setNapCatConfig } from "../dist/src/runtime.js";
import { handleNapCatMediaProxy, handleNapCatWebhook } from "../dist/src/webhook.js";

class MockResponse {
  statusCode = 200;
  headers = new Map();
  body = undefined;

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
  }

  end(body) {
    this.body = body;
  }
}

test("registers separate exact webhook and media routes", async () => {
  const routes = [];
  let registeredChannel;
  plugin.register({
    runtime: {},
    registerChannel({ plugin: channel }) {
      registeredChannel = channel;
    },
    registerHttpRoute(route) {
      routes.push(route);
    },
  });

  assert.equal(registeredChannel.id, "napcat");
  assert.deepEqual(
    routes.map(({ path, match, auth }) => ({ path, match, auth })),
    [
      { path: "/napcat", match: "exact", auth: "plugin" },
      { path: "/napcat/media", match: "exact", auth: "plugin" },
    ],
  );

  setNapCatConfig({ mediaProxyEnabled: false });
  const mediaResponse = new MockResponse();
  assert.equal(await routes[1].handler({ method: "GET", url: "/napcat/media" }, mediaResponse), true);
  assert.equal(mediaResponse.statusCode, 404);
});

test("webhook handler only accepts the canonical path and POST method", async () => {
  for (const path of ["/napcat/", "/napcat/other", "/napcat-other"]) {
    assert.equal(await handleNapCatWebhook({ method: "POST", url: path }, new MockResponse()), false);
  }

  const response = new MockResponse();
  assert.equal(await handleNapCatWebhook({ method: "GET", url: "/napcat" }, response), true);
  assert.equal(response.statusCode, 405);
});

test("media handler only accepts the canonical path and GET method", async () => {
  for (const path of ["/napcat/media/", "/napcat/media/other", "/napcat/mediator"]) {
    assert.equal(await handleNapCatMediaProxy({ method: "GET", url: path }, new MockResponse()), false);
  }

  const response = new MockResponse();
  assert.equal(await handleNapCatMediaProxy({ method: "POST", url: "/napcat/media" }, response), true);
  assert.equal(response.statusCode, 405);
});

test("media route logs only its pathname, never query secrets", async () => {
  const messages = [];
  const originalLog = console.log;
  console.log = (...args) => messages.push(args.join(" "));
  try {
    setNapCatConfig({ mediaProxyEnabled: false });
    await handleNapCatMediaProxy(
      { method: "GET", url: "/napcat/media?token=never-log-me&url=%2Fsecret%2Fphoto.png" },
      new MockResponse(),
    );
  } finally {
    console.log = originalLog;
  }
  assert.equal(messages.some((message) => message.includes("never-log-me") || message.includes("secret")), false);
  assert.equal(messages.some((message) => message.endsWith("GET /napcat/media")), true);
});
