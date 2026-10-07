import assert from "node:assert/strict";
import test from "node:test";

import { buildNapCatMessageFromReply } from "../dist/src/webhook.js";

test("group replies mention the user who triggered the reply", async () => {
  const message = await buildNapCatMessageFromReply(
    { text: "你好呀" },
    {},
    "123456789",
  );

  assert.equal(message, "[CQ:at,qq=123456789] 你好呀");
});

test("private replies remain unchanged when no mention user is provided", async () => {
  const message = await buildNapCatMessageFromReply(
    { text: "私聊回复" },
    {},
  );

  assert.equal(message, "私聊回复");
});

test("empty replies do not turn into mention-only messages", async () => {
  const message = await buildNapCatMessageFromReply(
    {},
    {},
    "123456789",
  );

  assert.equal(message, "");
});

test("invalid QQ identifiers are not rendered as CQ mentions", async () => {
  const message = await buildNapCatMessageFromReply(
    { text: "仍然发送正文" },
    {},
    "not-a-qq",
  );

  assert.equal(message, "仍然发送正文");
});

test("a quote id turns the reply into a CQ quote", async () => {
  const message = await buildNapCatMessageFromReply(
    { text: "你好呀" },
    {},
    "123456789",
    "987654321",
  );

  assert.equal(message, "[CQ:reply,id=987654321] 你好呀");
});

test("the quote replaces the mention rather than accompanying it", async () => {
  const message = await buildNapCatMessageFromReply(
    { text: "引用优先" },
    {},
    "123456789",
    "987654321",
  );

  assert.equal(message.includes("[CQ:at"), false);
});

test("an unusable quote id falls back to the mention", async () => {
  const message = await buildNapCatMessageFromReply(
    { text: "退回 @" },
    {},
    "123456789",
    "not-a-message-id",
  );

  assert.equal(message, "[CQ:at,qq=123456789] 退回 @");
});

test("the quote prefix survives plainTextMode formatting", async () => {
  const message = await buildNapCatMessageFromReply(
    { text: "**加粗** 和 `代码`" },
    { plainTextMode: true },
    "123456789",
    "424242",
  );

  // The CQ code is prepended after formatting, so markdown stripping must not touch it
  // and the stripped body must still follow it.
  assert.equal(message, "[CQ:reply,id=424242] 加粗 和 代码");
});

test("an empty reply stays empty even when a quote id is supplied", async () => {
  const message = await buildNapCatMessageFromReply({}, {}, "123456789", "424242");

  assert.equal(message, "");
});
