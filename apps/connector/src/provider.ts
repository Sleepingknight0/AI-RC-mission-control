import type {
  ConnectorEnvelope,
  CoreToConnectorEnvelope,
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
