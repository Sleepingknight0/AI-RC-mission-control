import type {
  ConnectorEnvelope,
  CoreToConnectorEnvelope,
  ProviderAccountCapabilitySnapshot,
  ProviderNativeSessionPage,
} from "@aicl/protocol";

export type TurnStartCommand = Extract<
  CoreToConnectorEnvelope,
  { type: "connector.turn.start" }
>;
export type TurnInterruptCommand = Extract<
  CoreToConnectorEnvelope,
  { type: "connector.turn.interrupt" }
>;
export type ApprovalResolveCommand = Extract<
  CoreToConnectorEnvelope,
  { type: "connector.approval.resolve" }
>;
export type SessionPrepareCommand = Extract<
  CoreToConnectorEnvelope,
  { type: "connector.session.create" | "connector.session.resume" }
>;
export interface ProviderSessionPreparation {
  providerSessionId: string;
  projectPath: string;
  model: string | null;
  reasoningLevel: string | null;
}
export type ConnectorEmit = (message: ConnectorEnvelope) => void;
export type PreparedInputAttachment =
  | {
      attachmentId: string;
      name: string;
      kind: "text";
      mediaType: "text/plain" | "text/markdown";
      text: string;
    }
  | {
      attachmentId: string;
      name: string;
      kind: "image";
      mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
      path: string;
    };

export class ProviderLostError extends Error {
  constructor(message = "Provider process was lost") {
    super(message);
    this.name = "ProviderLostError";
  }
}

export interface ConnectorProvider {
  prepareSession?(
    command: SessionPrepareCommand,
  ): Promise<ProviderSessionPreparation>;
  startTurn(
    command: TurnStartCommand,
    emit: ConnectorEmit,
    attachments?: readonly PreparedInputAttachment[],
  ): Promise<void>;
  interrupt(command: TurnInterruptCommand): Promise<void>;
  resolveApproval(command: ApprovalResolveCommand): Promise<void>;
  onLost(listener: () => void): () => void;
  close(): Promise<void>;
}

export interface ManagedProviderAccount {
  providerId: string;
  accountId: string;
  provider: ConnectorProvider;
  capabilities(
    revision: number,
    active: boolean,
  ): Promise<ProviderAccountCapabilitySnapshot>;
  identityFingerprint(): Promise<string | null>;
}

export interface NativeSessionPageInput {
  providerId: string;
  accountId: string;
  pageSize: number;
  cursor: string | null;
  search: string | null;
  archived: "exclude" | "include" | "only";
}

export interface ProviderAccountController {
  open(providerId: string, accountId: string): ManagedProviderAccount | null;
  rememberIdentity(
    providerId: string,
    accountId: string,
    fingerprint: string | null,
  ): void;
  nativeSessionPage(
    account: ManagedProviderAccount,
    input: NativeSessionPageInput,
  ): Promise<ProviderNativeSessionPage>;
}

export class StaleNativeSessionCursorError extends Error {
  constructor() {
    super("Native Session cursor is stale or does not match the query");
    this.name = "StaleNativeSessionCursorError";
  }
}

export async function nativeSessionPageWithRecovery(
  controller: ProviderAccountController,
  account: ManagedProviderAccount,
  input: NativeSessionPageInput,
): Promise<ProviderNativeSessionPage> {
  try {
    return await controller.nativeSessionPage(account, input);
  } catch (error) {
    if (!(error instanceof StaleNativeSessionCursorError)) throw error;
    const page = await controller.nativeSessionPage(account, {
      ...input,
      cursor: null,
    });
    return {
      ...page,
      cursorReset: true,
      notice: "Native Session cursor expired; showing a fresh first page",
    };
  }
}

export class UnavailableProvider implements ConnectorProvider {
  async startTurn(): Promise<void> {
    throw new Error("No provider account is active");
  }

  async interrupt(): Promise<void> {
    throw new Error("No provider account is active");
  }

  async resolveApproval(): Promise<void> {
    throw new Error("No provider account is active");
  }

  onLost(): () => void {
    return () => undefined;
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}
