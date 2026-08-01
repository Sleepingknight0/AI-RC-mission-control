import { describe, expect, it } from "vitest";

import {
  BoundedLineFramer,
  LineTooLongError,
  parseJsonLine,
} from "../src/codex/line-framer.js";
import {
  RpcRequestBroker,
  buildProviderEnvironment,
} from "../src/codex/rpc-process.js";

describe("Codex JSON-lines transport", () => {
  it("frames split lines and rejects oversized input", () => {
    const framer = new BoundedLineFramer(8);
    expect(framer.push(Buffer.from('{"a":'))).toEqual([]);
    expect(framer.push(Buffer.from("1}\n{}\r\n"))).toEqual(['{"a":1}', "{}"]);
    expect(() => framer.push(Buffer.from("123456789"))).toThrow(LineTooLongError);
  });

  it("classifies malformed provider JSON", () => {
    const parsed = parseJsonLine("{not-json}");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.line).toBe("{not-json}");
  });

  it("correlates out-of-order provider responses", async () => {
    const broker = new RpcRequestBroker();
    const writes: Array<Record<string, unknown>> = [];
    const first = broker.request("first", {}, 1_000, (message) => writes.push(message));
    const second = broker.request("second", {}, 1_000, (message) => writes.push(message));

    broker.settle({ id: writes[1]?.id, result: "second-result" });
    broker.settle({ id: writes[0]?.id, result: "first-result" });

    await expect(first).resolves.toBe("first-result");
    await expect(second).resolves.toBe("second-result");
  });

  it("constructs an allowlisted child environment without unrelated secrets", () => {
    const environment = buildProviderEnvironment({
      PATH: "C:\\tools",
      USERPROFILE: "C:\\Users\\Operator",
      CODEX_HOME: "C:\\Users\\Operator\\.codex",
      AICL_TEST_SECRET: "do-not-forward",
      GOOGLE_APPLICATION_CREDENTIALS: "do-not-forward-either",
    });

    expect(environment.PATH).toBe("C:\\tools");
    expect(environment.USERPROFILE).toBe("C:\\Users\\Operator");
    expect(environment.CODEX_HOME).toBe("C:\\Users\\Operator\\.codex");
    expect(environment).not.toHaveProperty("AICL_TEST_SECRET");
    expect(environment).not.toHaveProperty("GOOGLE_APPLICATION_CREDENTIALS");
    expect(environment.NO_COLOR).toBe("1");
  });
});
