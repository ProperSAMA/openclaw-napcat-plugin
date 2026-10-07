import assert from "node:assert/strict";
import test from "node:test";

import {
  beginNapCatGroupReplyContext,
  getNapCatGroupReplyContextStats,
  getNapCatGroupReplySender,
  sweepNapCatGroupReplyContexts,
} from "../dist/src/runtime.js";

// Entries now live until they expire rather than until the webhook handler returns, and the
// store is module-level state shared by every test in this file. Each test therefore takes its
// own group id, and assertions are written so they do not depend on a cleared store.
const SENDER = "222222222";

test("a registered group message resolves to its own id and sender", () => {
  const group = "256807830";
  beginNapCatGroupReplyContext(group, SENDER, "111111");
  assert.equal(getNapCatGroupReplySender(group, "111111"), SENDER);
  // Scoped to the turn: a neighbouring message id must not resolve to this sender.
  assert.equal(getNapCatGroupReplySender(group, "111112"), undefined);
});

test("overlapping turns each keep their own sender", () => {
  const group = "256807831";
  beginNapCatGroupReplyContext(group, SENDER, "111111");
  beginNapCatGroupReplyContext(group, "333333333", "222222");

  // The old "latest entry for the group" lookup could only ever answer with the newer turn's
  // sender, which would mis-address the older turn's still-in-flight reply.
  assert.equal(getNapCatGroupReplySender(group, "111111"), SENDER);
  assert.equal(getNapCatGroupReplySender(group, "222222"), "333333333");
});

test("a context registered before an earlier run finished still resolves for the later run", () => {
  // The regression under queue mode "followup": the handler for message 2 returns as soon as
  // the message is enqueued, and its agent run happens only after run 1 ends. Nothing may
  // remove the entry in between, or the later run's replies go out unaddressed.
  const group = "256807832";
  beginNapCatGroupReplyContext(group, SENDER, "111111"); // message 1, run 1 starts
  beginNapCatGroupReplyContext(group, SENDER, "222222"); // message 2, handler returns now

  // run 1 finishes here -- under the old teardown its cleanup could clear the store

  assert.equal(getNapCatGroupReplySender(group, "222222"), SENDER); // run 2 finds message 2
});

test("contexts for different groups do not interfere", () => {
  const group = "256807833";
  const otherGroup = "1020986467";
  beginNapCatGroupReplyContext(group, SENDER, "111111");
  beginNapCatGroupReplyContext(otherGroup, SENDER, "999999");

  assert.equal(getNapCatGroupReplySender(group, "111111"), SENDER);
  assert.equal(getNapCatGroupReplySender(otherGroup, "999999"), SENDER);
  // An id registered for one group must not resolve through another.
  assert.equal(getNapCatGroupReplySender(otherGroup, "111111"), undefined);
});

test("an unknown group has no context", () => {
  assert.equal(getNapCatGroupReplySender("256807899", "111111"), undefined);
});

test("a message registered without a usable id is not matchable", () => {
  const group = "256807834";
  beginNapCatGroupReplyContext(group, SENDER, "not-a-message-id");
  assert.equal(getNapCatGroupReplySender(group, "not-a-message-id"), undefined);
  assert.equal(getNapCatGroupReplySender(group, "111111"), undefined);
});

test("non-numeric group or sender ids register nothing", () => {
  for (const [group, sender] of [
    ["", SENDER],
    ["group:1", SENDER],
    ["256807835", ""],
    ["256807835", "not-a-qq"],
  ]) {
    assert.equal(beginNapCatGroupReplyContext(group, sender, "111111"), null);
    assert.equal(getNapCatGroupReplySender(group, "111111"), undefined);
  }
});

test("one busy group cannot grow its entry list without bound", () => {
  const group = "256807840";
  const before = getNapCatGroupReplyContextStats().entryCount;

  for (let i = 0; i < 50; i += 1) {
    beginNapCatGroupReplyContext(group, SENDER, String(100000 + i));
  }
  const after50 = getNapCatGroupReplyContextStats().entryCount;
  const added = after50 - before;
  assert.ok(added <= 8, `per-group entries must stay capped, but 50 inserts added ${added}`);
  // The cap trims the oldest entries, never the newest: the turn that just arrived is the one
  // whose reply is still in flight.
  assert.equal(getNapCatGroupReplySender(group, "100049"), SENDER);
  assert.equal(getNapCatGroupReplySender(group, "100000"), undefined);

  // Another 500 inserts must not add anything at all -- the old implementation scanned and
  // kept the whole array, so this is also the O(n^2) regression guard.
  for (let i = 0; i < 500; i += 1) {
    beginNapCatGroupReplyContext(group, SENDER, String(200000 + i));
  }
  assert.equal(getNapCatGroupReplyContextStats().entryCount, after50);
  assert.equal(getNapCatGroupReplySender(group, "200499"), SENDER);
});

test("the sweep leaves live entries alone", () => {
  const group = "256807841";
  beginNapCatGroupReplyContext(group, SENDER, "333333");

  // Nothing has expired yet, so a sweep at the current time must not reclaim anything.
  sweepNapCatGroupReplyContexts();
  assert.equal(getNapCatGroupReplySender(group, "333333"), SENDER);
});

test("the total entry budget is enforced across groups", () => {
  // 300 groups x 8 entries overshoots the 2000 entry budget without reaching the 500 group cap,
  // so this exercises the total bound rather than the per-group or per-group-count one.
  for (let g = 0; g < 300; g += 1) {
    const group = String(700000000 + g);
    for (let i = 0; i < 8; i += 1) {
      beginNapCatGroupReplyContext(group, SENDER, String(900000 + i));
    }
  }
  assert.ok(getNapCatGroupReplyContextStats().entryCount > 2000, "fixture must overshoot the budget");

  sweepNapCatGroupReplyContexts();
  const after = getNapCatGroupReplyContextStats().entryCount;
  assert.ok(after <= 2000, `total entries must stay capped, saw ${after}`);
});

// Kept last: this sweeps with a future timestamp, which expires every entry in the module-level
// store, so any test after it would have to rebuild its fixture anyway.
test("a group that goes quiet is reclaimed once its entries expire", () => {
  const group = "256807842";
  beginNapCatGroupReplyContext(group, SENDER, "444444");
  assert.equal(getNapCatGroupReplySender(group, "444444"), SENDER);

  // No further traffic for this group, so lazy pruning would never look at it again.
  sweepNapCatGroupReplyContexts(Date.now() + 11 * 60 * 1000);

  assert.equal(getNapCatGroupReplySender(group, "444444"), undefined);
  assert.equal(getNapCatGroupReplyContextStats().entryCount, 0);
});
