import { createServer } from "node:net";

export async function assertTcpPortAvailable(
  host: string,
  port: number,
  service: string,
): Promise<void> {
  const server = createServer();
  server.unref();
  try {
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen({ host, port, exclusive: true }, resolvePromise);
    });
  } catch (error) {
    if (isAddressInUse(error)) {
      throw new Error(`${service} port ${host}:${port} is already in use`);
    }
    throw error;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) =>
          error === undefined ? resolvePromise() : reject(error),
        );
      });
    }
  }
}

function isAddressInUse(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EADDRINUSE"
  );
}
