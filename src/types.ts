export type ProviderName = "openai" | "xai" | "google" | "anthropic";

export interface InputImage {
  /** e.g. "image/png" or "image/jpeg" */
  mimeType: string;
  /** base64 (no data: prefix) */
  base64: string;
  /** original filename for traceability/logging */
  filename?: string;
}

export interface ModelAnswer {
  provider: ProviderName;
  model: string;
  text: string;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface EnsembleOutputs {
  finalMarkdown: string;
  spiceNetlist: string;
  circuitJson: string;
}
