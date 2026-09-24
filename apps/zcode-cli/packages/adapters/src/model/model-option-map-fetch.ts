import type {
  CompiledModelOptionMaps,
  JsonObject,
  ModelOptionValues,
} from "@zcode/model-option-map";

type ProviderFetch = typeof globalThis.fetch;

export interface RawRequestBodyCapture {
  body?: JsonObject;
}

export function createModelOptionMapFetch(input: {
  readonly capture?: RawRequestBodyCapture;
  readonly fetch: ProviderFetch;
  readonly maps: CompiledModelOptionMaps;
  readonly values: ModelOptionValues;
}): ProviderFetch {
  return async (request, init) => {
    const bodyText = await readRequestBody(request, init);
    if (bodyText === undefined) return input.fetch(request, init);
    const body = parseJsonObject(bodyText);
    const patched = input.maps.apply(body, input.values);
    // 修复原因：冻结的 reasoning map 如改写原生 effort，不能静默覆盖已接纳的请求选择。
    const requestedEffort = nestedEffort(body);
    const mappedEffort = nestedEffort(patched);
    if (requestedEffort !== undefined && requestedEffort !== mappedEffort)
      throw new Error("anthropic_native_option_conflict");
    if (input.capture) input.capture.body = patched;
    const patchedBody = JSON.stringify(patched);
    if (request instanceof Request) {
      return input.fetch(new Request(request, { ...init, body: patchedBody }));
    }
    return input.fetch(request, { ...init, body: patchedBody });
  };
}

function nestedEffort(body: JsonObject): unknown {
  const config = body.output_config;
  return config && typeof config === "object" && !Array.isArray(config) ? (config as JsonObject).effort : undefined;
}

async function readRequestBody(
  request: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<string | undefined> {
  if (typeof init?.body === "string") return init.body;
  // Option Map 是 reasoning/max-output 的唯一请求字段权威。若 SDK 改成非文本 Body 却静默
  // 跳过 Patch，请求仍会发出但丢失两个 Option；因此有 Body 时必须 fail-closed。
  if (init?.body !== undefined && init.body !== null) {
    throw new Error("Model option maps require a JSON text request body.");
  }
  if (request instanceof Request) return request.clone().text();
  return undefined;
}

function parseJsonObject(body: string): JsonObject {
  const parsed: unknown = JSON.parse(body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model option maps require a JSON object request body.");
  }
  return parsed as JsonObject;
}
