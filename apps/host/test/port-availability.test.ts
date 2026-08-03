import { createServer } from "node:net";

import { expect, it } from "vitest";

import { assertTcpPortAvailable } from "../src/port-availability.js";

it("rejects a production start when another process owns the configured port", async () => {
  const owner = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    owner.once("error", reject);
    owner.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = owner.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test listener did not expose a TCP port");
  }

  try {
    await expect(
      assertTcpPortAvailable("127.0.0.1", address.port, "Core"),
    ).rejects.toThrow(`Core port 127.0.0.1:${address.port} is already in use`);
  } finally {
    await new Promise<void>((resolvePromise, reject) => {
      owner.close((error) =>
        error === undefined ? resolvePromise() : reject(error),
      );
    });
  }

  await expect(
    assertTcpPortAvailable("127.0.0.1", address.port, "Core"),
  ).resolves.toBeUndefined();
});
