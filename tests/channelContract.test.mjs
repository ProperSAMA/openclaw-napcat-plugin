import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { napcatPlugin } from "../dist/src/channel.js";

test("declares complete OpenClaw 2026.8.2 channel metadata", () => {
  assert.deepEqual(napcatPlugin.meta, {
    id: "napcat",
    label: "NapCat QQ",
    selectionLabel: "NapCat QQ (OneBot 11)",
    docsPath: "/channels/napcat",
    blurb: "Connect OpenClaw to QQ through NapCat and OneBot 11.",
    systemImage: "message",
    markdownCapable: false,
  });
  assert.equal("name" in napcatPlugin.meta, false);
  assert.equal("text" in napcatPlugin.capabilities, false);
});

test("keeps runtime and manifest channel schemas identical", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(
    napcatPlugin.configSchema.schema,
    manifest.channelConfigs.napcat.schema,
  );
});
