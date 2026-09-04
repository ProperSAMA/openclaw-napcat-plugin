import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildMediaProxyUrl, redactNapCatMediaForLog } from "../dist/src/media.js";
import {
  MEDIA_PROXY_MAX_BYTES,
  MediaProxyError,
  loadMediaProxyResource,
} from "../dist/src/mediaProxy.js";
import { handleMediaProxyRequest } from "../dist/src/webhook.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

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

function proxyUrl(mediaUrl, token = "correct-token") {
  const query = new URLSearchParams({ url: mediaUrl, token });
  return `/napcat/media?${query}`;
}

test("media proxy fails closed when disabled or missing its server token", async () => {
  const disabled = new MockResponse();
  await handleMediaProxyRequest(disabled, proxyUrl("/tmp/image.png"), { mediaProxyEnabled: false });
  assert.equal(disabled.statusCode, 404);

  const missingToken = new MockResponse();
  await handleMediaProxyRequest(missingToken, proxyUrl("/tmp/image.png"), { mediaProxyEnabled: true });
  assert.equal(missingToken.statusCode, 503);
});

test("media proxy rejects missing inputs and incorrect tokens", async () => {
  const config = { mediaProxyEnabled: true, mediaProxyToken: "correct-token" };
  const wrongToken = new MockResponse();
  await handleMediaProxyRequest(wrongToken, proxyUrl("/tmp/image.png", "wrong-token"), config);
  assert.equal(wrongToken.statusCode, 403);

  const missingUrl = new MockResponse();
  await handleMediaProxyRequest(missingUrl, "/napcat/media?token=correct-token", config);
  assert.equal(missingUrl.statusCode, 400);
});

test("serves an allowed local image with defensive response headers", async () => {
  const root = await mkdtemp(join(tmpdir(), "napcat-media-allowed-"));
  try {
    const imagePath = join(root, "pixel.png");
    await writeFile(imagePath, PNG);
    const response = new MockResponse();
    await handleMediaProxyRequest(response, proxyUrl(imagePath), {
      mediaProxyEnabled: true,
      mediaProxyToken: "correct-token",
      mediaProxyAllowedRoots: [root],
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, PNG);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("content-disposition"), "attachment");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects local paths and symlinks that escape allowed roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "napcat-media-root-"));
  const outside = await mkdtemp(join(tmpdir(), "napcat-media-outside-"));
  try {
    const outsideImage = join(outside, "outside.png");
    const escapingLink = join(root, "escape.png");
    await writeFile(outsideImage, PNG);
    await symlink(outsideImage, escapingLink);
    const config = { mediaProxyAllowedRoots: [root] };

    await assert.rejects(
      loadMediaProxyResource(outsideImage, config),
      (error) => error instanceof MediaProxyError && error.statusCode === 403,
    );
    await assert.rejects(
      loadMediaProxyResource(escapingLink, config),
      (error) => error instanceof MediaProxyError && error.statusCode === 403,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects local media larger than 25 MiB without reading it", async () => {
  const root = await mkdtemp(join(tmpdir(), "napcat-media-large-"));
  try {
    const largePath = join(root, "large.png");
    await writeFile(largePath, PNG);
    await truncate(largePath, MEDIA_PROXY_MAX_BYTES + 1);
    await assert.rejects(
      loadMediaProxyResource(largePath, { mediaProxyAllowedRoots: [root] }),
      (error) => error instanceof MediaProxyError && [403, 413].includes(error.statusCode),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("blocks loopback remote media through OpenClaw's SSRF guard", async () => {
  await assert.rejects(
    loadMediaProxyResource("http://127.0.0.1/private.png", {}),
    (error) => error instanceof MediaProxyError && error.statusCode === 403,
  );
});

test("bounds remote responses, sniffs MIME, and always releases guarded fetches", async () => {
  let releases = 0;
  const guardedFetch = async ({ url }) => ({
    response: new Response(PNG, { headers: { "content-type": "application/octet-stream" } }),
    finalUrl: url,
    release: async () => { releases += 1; },
  });
  const resource = await loadMediaProxyResource("https://example.com/pixel", {}, { guardedFetch });
  assert.deepEqual(resource.buffer, PNG);
  assert.equal(resource.contentType, "image/png");
  assert.equal(releases, 1);

  const megabyte = new Uint8Array(1024 * 1024);
  let emittedChunks = 0;
  const oversizedBody = new ReadableStream({
    pull(controller) {
      if (emittedChunks > 25) {
        controller.close();
        return;
      }
      emittedChunks += 1;
      controller.enqueue(megabyte);
    },
  });
  const oversizedFetch = async ({ url }) => ({
    response: new Response(oversizedBody, { headers: { "content-type": "image/png" } }),
    finalUrl: url,
    release: async () => { releases += 1; },
  });
  await assert.rejects(
    loadMediaProxyResource("https://example.com/large.png", {}, { guardedFetch: oversizedFetch }),
    (error) => error instanceof MediaProxyError && error.statusCode === 413,
  );
  assert.equal(releases, 2);
});

test("rejects active or non-media remote content even when headers claim media", async () => {
  let released = false;
  const guardedFetch = async ({ url }) => ({
    response: new Response("<html>not an image</html>", { headers: { "content-type": "image/png" } }),
    finalUrl: url,
    release: async () => { released = true; },
  });
  await assert.rejects(
    loadMediaProxyResource("https://example.com/fake.png", {}, { guardedFetch }),
    (error) => error instanceof MediaProxyError && error.statusCode === 415,
  );
  assert.equal(released, true);
});

test("builds validated, authenticated media proxy URLs", () => {
  assert.equal(
    buildMediaProxyUrl("https://media.example/photo a.png", {
      mediaProxyEnabled: true,
      publicBaseUrl: "https://gateway.example/base/",
      mediaProxyToken: "a secret",
    }),
    "https://gateway.example/base/napcat/media?url=https%3A%2F%2Fmedia.example%2Fphoto+a.png&token=a+secret",
  );
  assert.throws(
    () => buildMediaProxyUrl("/tmp/a.png", { mediaProxyEnabled: true, publicBaseUrl: "https://gateway.example" }),
    /mediaProxyToken is not configured/,
  );
  assert.throws(
    () => buildMediaProxyUrl("/tmp/a.png", {
      mediaProxyEnabled: true,
      publicBaseUrl: "https://user:pass@gateway.example/path?leak=1",
      mediaProxyToken: "secret",
    }),
    /publicBaseUrl must be an HTTP\(S\) URL/,
  );
});

test("redacts proxy URLs and tokens from outbound media logs", () => {
  const message = "photo\n[CQ:image,file=https://gateway.example/napcat/media?url=x&token=never-log-me]";
  const redacted = redactNapCatMediaForLog(message);
  assert.equal(redacted, "photo\n[CQ:image,file=<redacted>]" );
  assert.equal(redacted.includes("never-log-me"), false);
});
