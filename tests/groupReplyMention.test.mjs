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
