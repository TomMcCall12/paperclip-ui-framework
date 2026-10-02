import { afterEach, describe, expect, it, vi } from "vitest";
import { listHermesGatewayModelOptions } from "./model-options.js";

const API_KEY = "hermes-secret-key-123";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("listHermesGatewayModelOptions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads supported model ids from the gateway model options endpoint with the server-side key", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      model: "gpt-6.1-sol",
      provider: "openai-codex",
      models: [
        { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", provider: "openai-codex" },
        { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
        "gpt-5.6-luna",
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listHermesGatewayModelOptions({
      apiBaseUrl: "http://127.0.0.1:9119/chat",
      apiKey: API_KEY,
    });

    expect(result).toEqual({
      status: "available",
      message: null,
      provider: "openai-codex",
      gatewayModel: "gpt-6.1-sol",
      models: [
        { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", provider: "openai-codex" },
        { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
        { id: "gpt-5.6-luna", label: "gpt-5.6-luna" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9119/api/model/options");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(init.redirect).toBe("error");
  });

  it("uses the /api model options route for the live Hermes API server base URL", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      provider: "openai-codex",
      model: "gpt-6.1-sol",
      providers: [
        { slug: "openrouter", name: "OpenRouter", authenticated: true, models: ["openrouter/only-model", "gpt-6.1-sol"] },
        { slug: "anthropic", name: "Anthropic", authenticated: true, models: ["claude-opus-5"] },
        { slug: "openai-codex", name: "OpenAI Codex", authenticated: true, models: ["gpt-6.1-sol", "gpt-5.6-terra"] },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listHermesGatewayModelOptions({
      apiBaseUrl: "http://192.168.0.163:8642",
      dangerouslyAllowInsecureRemoteHttp: true,
      apiKey: API_KEY,
      model: "gpt-6.1-sol",
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://192.168.0.163:8642/api/model/options");
    expect(init.redirect).toBe("error");
    expect(result).toEqual({
      status: "available",
      message: null,
      provider: "openai-codex",
      gatewayModel: "gpt-6.1-sol",
      models: [
        { id: "gpt-6.1-sol", label: "gpt-6.1-sol", provider: "openai-codex" },
        { id: "gpt-5.6-terra", label: "gpt-5.6-terra", provider: "openai-codex" },
      ],
    });
    expect(result.models.map((model) => model.id)).not.toContain("openrouter/only-model");
    expect(result.models.map((model) => model.id)).not.toContain("claude-opus-5");
  });

  it("keeps an existing /api base and stays on the configured origin", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ provider: "nous", models: ["hermes-5"] }));
    vi.stubGlobal("fetch", fetchMock);

    await listHermesGatewayModelOptions({ apiBaseUrl: "https://hermes.example/api/", apiKey: API_KEY });
    await listHermesGatewayModelOptions({ apiBaseUrl: "https://hermes.example/gateway", apiKey: API_KEY });

    const urls = fetchMock.mock.calls.map((call) => (call as unknown as [string])[0]);
    expect(urls).toEqual([
      "https://hermes.example/api/model/options",
      "https://hermes.example/gateway/api/model/options",
    ]);
    for (const url of urls) expect(new URL(url).origin).toBe("https://hermes.example");
  });

  it("fails closed when the current provider is not authenticated", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      provider: "openai-codex",
      providers: [
        { slug: "openai-codex", authenticated: false, models: ["gpt-6.1-sol"] },
        { slug: "openrouter", authenticated: true, models: ["gpt-6.1-sol"] },
      ],
    })));

    const result = await listHermesGatewayModelOptions({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: API_KEY });

    expect(result.status).toBe("auth_failed");
    expect(result.models).toEqual([]);
    expect(result.message).toMatch(/openai-codex.*not authenticated/i);
  });

  it("fails closed when the gateway does not list its current provider", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      provider: "openai-codex",
      providers: [{ slug: "openrouter", authenticated: true, models: ["gpt-6.1-sol"] }],
    })));
    const missingGroup = await listHermesGatewayModelOptions({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: API_KEY });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      providers: [{ slug: "openrouter", authenticated: true, models: ["gpt-6.1-sol"] }],
    })));
    const noCurrentProvider = await listHermesGatewayModelOptions({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: API_KEY });

    for (const result of [missingGroup, noCurrentProvider]) {
      expect(result.status).toBe("invalid_response");
      expect(result.models).toEqual([]);
      expect(result.message).toMatch(/current provider/i);
    }
  });

  it("does not let a flat model list claim models from another provider", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      provider: "openai-codex",
      models: [
        { id: "gpt-6.1-sol", provider: "openai-codex" },
        { id: "openrouter/only-model", provider: "openrouter" },
      ],
    })));
    const scoped = await listHermesGatewayModelOptions({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: API_KEY });
    expect(scoped.models.map((model) => model.id)).toEqual(["gpt-6.1-sol"]);

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      models: [
        { id: "gpt-6.1-sol", provider: "openai-codex" },
        { id: "openrouter/only-model", provider: "openrouter" },
      ],
    })));
    const mixed = await listHermesGatewayModelOptions({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: API_KEY });
    expect(mixed.status).toBe("invalid_response");
    expect(mixed.models).toEqual([]);
  });

  it("fails closed with an auth reason and never echoes the key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: `bad key ${API_KEY}` }, 401)));

    const result = await listHermesGatewayModelOptions({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: API_KEY });

    expect(result.status).toBe("auth_failed");
    expect(result.models).toEqual([]);
    expect(result.message).toMatch(/rejected/i);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("reports an unsupported gateway when the endpoint is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ detail: "Not Found" }, 404)));

    const result = await listHermesGatewayModelOptions({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: API_KEY });

    expect(result.status).toBe("unsupported");
    expect(result.models).toEqual([]);
  });

  it("reports an unreachable gateway without leaking the key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError(`fetch failed for ${API_KEY}`);
    }));

    const result = await listHermesGatewayModelOptions({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: API_KEY });

    expect(result.status).toBe("unreachable");
    expect(result.models).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("rejects an unrecognized response shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ hello: "world" })));

    const result = await listHermesGatewayModelOptions({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: API_KEY });

    expect(result.status).toBe("invalid_response");
    expect(result.models).toEqual([]);
  });

  it("does not send the key over remote plain HTTP or without configuration", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const remote = await listHermesGatewayModelOptions({ apiBaseUrl: "http://10.0.0.5:8642", apiKey: API_KEY });
    const missingKey = await listHermesGatewayModelOptions({ apiBaseUrl: "http://127.0.0.1:8642" });

    expect(remote.status).toBe("misconfigured");
    expect(missingKey.status).toBe("misconfigured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
