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
export type ConnectorEmit = (message: ConnectorEnvelope) => void;

export class ProviderLostError extends Error {
  constructor(message = "Provider process was lost") {
    super(message);
    this.name = "ProviderLostError";
  }
}

export interface ConnectorProvider {
  startTurn(command: TurnStartCommand, emit: ConnectorEmit): Promise<void>;
  interrupt(command: TurnInterruptCommand): Promise<void>;
  resolveApproval(command: ApprovalResolveCommand): Promise<void>;
  onLost(listener: () => void): () => void;
  close(): Promise<void>;
}
