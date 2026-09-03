import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveNapCatInboundRoute,
  resolveOpenClawRuntimeConfig,
} from "../dist/src/webhook.js";

test("reads the current OpenClaw runtime config snapshot", () => {
  const expected = { agents: { defaults: { model: "openai/gpt-5.6-sol" } } };
  const runtime = {
    config: {
      current() {
        assert.equal(this, runtime.config);
        return expected;
      },
      loadConfig() {
        throw new Error("legacy loader must not be used when current() exists");
      },
    },
  };

  assert.equal(resolveOpenClawRuntimeConfig(runtime), expected);
});

test("falls back to the legacy runtime config loader", () => {
  const expected = { messages: { ackReactionScope: "all" } };
  const runtime = {
    config: {
      loadConfig() {
        assert.equal(this, runtime.config);
        return expected;
      },
    },
  };

  assert.equal(resolveOpenClawRuntimeConfig(runtime), expected);
});

test("fails closed when no runtime config snapshot API is available", () => {
  assert.throws(
    () => resolveOpenClawRuntimeConfig({ config: {} }),
    /runtime config snapshot API is unavailable/,
  );
});

function createRoutingRuntime(route, inspectInput) {
  return {
    channel: {
      routing: {
        async resolveAgentRoute(input) {
          inspectInput?.(input);
          return route;
        },
      },
    },
  };
}

test("uses OpenClaw's default main route when no NapCat agent is configured", async () => {
  const cfg = { session: { dmScope: "main" } };
  const route = { agentId: "main", sessionKey: "agent:main:main", accountId: "default" };
  const runtime = createRoutingRuntime(route, (input) => {
    assert.equal(input.cfg, cfg);
    assert.equal(input.defaultAgentId, undefined);
    assert.deepEqual(input.peer, { kind: "direct", id: "10001" });
  });

  const resolved = await resolveNapCatInboundRoute(
    runtime,
    cfg,
    "",
    { kind: "direct", id: "10001" },
  );
  assert.equal(resolved.effectiveAgentId, "main");
  assert.equal(resolved.sessionKey, "agent:main:main");
});

test("passes the configured NapCat agent to OpenClaw as the default owner", async () => {
  const cfg = {};
  const route = { agentId: "helper", sessionKey: "agent:helper:main", accountId: "default" };
  const runtime = createRoutingRuntime(route, (input) => {
    assert.equal(input.defaultAgentId, "helper");
    assert.equal(input.channel, "napcat");
    assert.equal(input.accountId, "default");
  });

  const resolved = await resolveNapCatInboundRoute(
    runtime,
    cfg,
    " Helper ",
    { kind: "direct", id: "10001" },
  );
  assert.equal(resolved.effectiveAgentId, "helper");
  assert.equal(resolved.sessionKey, "agent:helper:main");
});

test("keeps an explicit OpenClaw binding route authoritative", async () => {
  const cfg = { bindings: [{ agentId: "bound" }] };
  const route = {
    agentId: "bound",
    sessionKey: "agent:bound:napcat:group:20002",
    accountId: "default",
    matchedBy: "binding.peer",
  };
  const runtime = createRoutingRuntime(route);

  const resolved = await resolveNapCatInboundRoute(
    runtime,
    cfg,
    "helper",
    { kind: "group", id: "20002" },
  );
  assert.equal(resolved.route, route);
  assert.equal(resolved.effectiveAgentId, "bound");
  assert.equal(resolved.sessionKey, "agent:bound:napcat:group:20002");
});

test("rejects an incomplete OpenClaw route without a session key", async () => {
  const runtime = createRoutingRuntime({ agentId: "main" });
  await assert.rejects(
    resolveNapCatInboundRoute(runtime, {}, "", { kind: "direct", id: "10001" }),
    /route did not provide a session key/,
  );
});
