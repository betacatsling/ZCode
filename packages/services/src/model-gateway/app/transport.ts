export interface GatewayHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization?: string;
  readonly apiKey?: string;
  readonly anthropicVersion?: string;
  readonly anthropicBeta?: string;
  readonly anthropicDirectBrowserAccess?: string;
  readonly contentType?: string;
  readonly contentLength?: string;
  readonly body: AsyncIterable<Uint8Array>;
  readonly signal: AbortSignal;
}

export interface GatewayHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | AsyncIterable<Uint8Array>;
}

export interface GatewayHttpHandler {
  handle(request: GatewayHttpRequest): Promise<GatewayHttpResponse>;
}

export interface GatewayHttpServerPort {
  listen(input: {
    readonly host: "127.0.0.1" | "::1";
    readonly port: number;
    readonly handler: GatewayHttpHandler;
  }): Promise<{ readonly baseUrl: string }>;
  close(): Promise<void>;
}

export interface GatewayTokenPort {
  createOpaqueToken(): string;
  digestToken(token: string): string;
  createResponseId(): string;
}
