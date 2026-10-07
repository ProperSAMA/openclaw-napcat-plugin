import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isNapCatGroupQuoteReplyEnabled,
  resolveNapCatConversationConfig,
} from "../dist/src/runtime.js";

// Runs the body against a throwaway directory wired into a base config, then cleans up.
function withConfigDir(files, body) {
  const dir = mkdtempSync(join(tmpdir(), "napcat-conv-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      const target = join(dir, name);
      if (contents === null) {
        mkdirSync(target, { recursive: true });
        continue;
      }
      writeFileSync(target, typeof contents === "string" ? contents : JSON.stringify(contents));
    }
    return body({ dir, base: { url: "http://127.0.0.1:15150", token: "secret", conversationConfigDir: dir } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an explicitly empty conversationConfigDir disables the feature", () => {
  const base = { plainTextMode: true, conversationConfigDir: "" };
  assert.equal(resolveNapCatConversationConfig(base, "group:1"), base);
});

test("a missing directory is not an error", () => {
  const base = { plainTextMode: true, conversationConfigDir: "/nonexistent/napcat/conv" };
  assert.equal(resolveNapCatConversationConfig(base, "group:1"), base);
});

test("a missing default.json leaves the base config untouched", () =>
  withConfigDir({}, ({ base }) => {
    assert.equal(resolveNapCatConversationConfig(base, "group:111"), base);
  }));

test("default.json applies to every conversation", () =>
  withConfigDir({ "default.json": { plainTextMode: false } }, ({ base }) => {
    const merged = resolveNapCatConversationConfig(base, "group:111");
    assert.equal(merged.plainTextMode, false);
    assert.equal(merged.url, base.url);
  }));

test("a conversation file overrides default.json", () =>
  withConfigDir(
    {
      "default.json": { plainTextMode: false, groupReplyQuote: true },
      "group-111.json": { groupReplyQuote: false },
    },
    ({ base }) => {
      const merged = resolveNapCatConversationConfig(base, "group:111");
      assert.equal(merged.groupReplyQuote, false);
      // keys the conversation file omits still come from default.json
      assert.equal(merged.plainTextMode, false);
    },
  ));

test("a conversation file does not leak into other conversations", () =>
  withConfigDir({ "group-111.json": { groupReplyQuote: true } }, ({ base }) => {
    assert.equal(resolveNapCatConversationConfig(base, "group:111").groupReplyQuote, true);
    assert.equal(resolveNapCatConversationConfig(base, "group:222"), base);
    assert.equal(resolveNapCatConversationConfig(base, "group:222").groupReplyQuote, undefined);
  }));

test("private conversations are addressed by private-<id>.json", () =>
  withConfigDir({ "private-222222222.json": { groupReplyQuote: true } }, ({ base }) => {
    assert.equal(resolveNapCatConversationConfig(base, "private:222222222").groupReplyQuote, true);
    assert.equal(resolveNapCatConversationConfig(base, "private:999"), base);
  }));

test("connection-layer keys in a conversation file are ignored", () =>
  withConfigDir(
    { "group-111.json": { url: "http://127.0.0.1:9", token: "hijacked", mediaProxyEnabled: true } },
    ({ base }) => {
      const merged = resolveNapCatConversationConfig(base, "group:111");
      assert.equal(merged.url, base.url);
      assert.equal(merged.token, base.token);
      assert.equal(merged.mediaProxyEnabled, undefined);
    },
  ));

test("conversationConfigDir cannot be overridden from a conversation file", () =>
  withConfigDir({ "group-111.json": { conversationConfigDir: "/tmp/elsewhere" } }, ({ base }) => {
    assert.equal(resolveNapCatConversationConfig(base, "group:111").conversationConfigDir, base.conversationConfigDir);
  }));

test("malformed JSON degrades to the base config instead of throwing", () =>
  withConfigDir({ "group-111.json": "{ not json" }, ({ base }) => {
    assert.equal(resolveNapCatConversationConfig(base, "group:111"), base);
  }));

test("a non-object JSON document is rejected", () =>
  withConfigDir({ "group-111.json": "[1, 2, 3]" }, ({ base }) => {
    assert.equal(resolveNapCatConversationConfig(base, "group:111"), base);
  }));

test("conversation ids are validated before being used as filenames", () =>
  withConfigDir({ "group-111.json": { groupReplyQuote: false } }, ({ base }) => {
    // None of these match ^(group|private):\d+$, so no file lookup happens and the
    // ".." segments can never escape the directory.
    for (const id of ["group:../111", "../../etc/passwd", "group:111/../222", "", "group:", "group:abc"]) {
      assert.equal(resolveNapCatConversationConfig(base, id), base);
    }
  }));

test("editing a file takes effect without a restart", () =>
  withConfigDir({ "group-111.json": { groupReplyQuote: true } }, ({ dir, base }) => {
    const filePath = join(dir, "group-111.json");
    assert.equal(resolveNapCatConversationConfig(base, "group:111").groupReplyQuote, true);

    writeFileSync(filePath, JSON.stringify({ groupReplyQuote: false }));
    // Force a distinct mtime so the mtime-based cache cannot mask the change.
    const future = new Date(Date.now() + 5000);
    utimesSync(filePath, future, future);

    assert.equal(resolveNapCatConversationConfig(base, "group:111").groupReplyQuote, false);
  }));

test("quote replies are off by default and only an explicit true enables them", () => {
  assert.equal(isNapCatGroupQuoteReplyEnabled({}), false);
  assert.equal(isNapCatGroupQuoteReplyEnabled({ groupReplyQuote: undefined }), false);
  assert.equal(isNapCatGroupQuoteReplyEnabled({ groupReplyQuote: false }), false);
  assert.equal(isNapCatGroupQuoteReplyEnabled({ groupReplyQuote: true }), true);
});

test("streaming stays opt-in per conversation, since there is no group-specific switch", () =>
  withConfigDir(
    { "group-111.json": { streaming_mode: true, enable_progress_messages: true } },
    ({ base }) => {
      const opted = resolveNapCatConversationConfig(base, "group:111");
      assert.equal(opted.streaming_mode, true);
      assert.equal(opted.enable_progress_messages, true);

      // A conversation without a file keeps the global (off) values.
      const plain = resolveNapCatConversationConfig(base, "group:222");
      assert.equal(plain, base);
      assert.equal(plain.streaming_mode, undefined);
    },
  ));
