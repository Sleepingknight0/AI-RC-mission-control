import type {
  ManagedProviderAccount,
  NativeSessionPageInput,
  NativeSessionProjectionInput,
  ProviderAccountController,
} from "./provider.js";

export interface ProviderAccountControllerRoute {
  providerId: string;
  controller: ProviderAccountController;
}

export class ProviderAccountControllerRouter implements ProviderAccountController {
  readonly #routes: Map<string, ProviderAccountController>;

  constructor(routes: readonly ProviderAccountControllerRoute[]) {
    this.#routes = new Map();
    for (const route of routes) {
      if (this.#routes.has(route.providerId)) {
        throw new Error("Duplicate provider account controller route");
      }
      this.#routes.set(route.providerId, route.controller);
    }
  }

  open(providerId: string, accountId: string): ManagedProviderAccount | null {
    return this.#routes.get(providerId)?.open(providerId, accountId) ?? null;
  }

  rememberIdentity(
    providerId: string,
    accountId: string,
    fingerprint: string | null,
  ): void {
    this.#routes
      .get(providerId)
      ?.rememberIdentity(providerId, accountId, fingerprint);
  }

  nativeSessionPage(
    account: ManagedProviderAccount,
    input: NativeSessionPageInput,
  ) {
    const controller = this.#routes.get(input.providerId);
    if (controller === undefined || account.providerId !== input.providerId) {
      throw new Error("Provider account controller route is unavailable");
    }
    return controller.nativeSessionPage(account, input);
  }

  nativeSessionProjection(input: NativeSessionProjectionInput) {
    const controller = this.#routes.get(input.providerId);
    if (controller?.nativeSessionProjection === undefined) {
      throw new Error("Provider does not support native Session history");
    }
    return controller.nativeSessionProjection(input);
  }

  async closeProvider(providerId: string): Promise<void> {
    await this.#routes.get(providerId)?.closeProvider?.(providerId);
  }

  async close(): Promise<void> {
    const controllers = [...new Set(this.#routes.values())];
    const results = await Promise.allSettled(
      controllers.map((controller) => controller.close?.()),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Provider account controller shutdown failed",
      );
    }
  }
}
