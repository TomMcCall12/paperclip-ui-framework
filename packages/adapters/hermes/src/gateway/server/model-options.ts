import { asString } from "@paperclipai/adapter-utils/server-utils";
import {
  allowsInsecureRemoteHttp,
  isRemotePlainHttp,
  remotePlainHttpDeniedMessage,
} from "./transport-security.js";

export type HermesGatewayModelOptionsStatus =
  | "available"
  | "auth_failed"
  | "unsupported"
  | "unreachable"
  | "misconfigured"
  | "invalid_response";

export interface HermesGatewayModelOption {
  id: string;
  label: string;
  provider?: string;
}

export interface HermesGatewayModelOptionsResult {
  status: HermesGatewayModelOptionsStatus;
  message: string | null;
  /** Provider the gateway reports for its active model, when it says so. */
  provider: string | null;
  /** Model the gateway reports as its own active model, when it says so. */
  gatewayModel: string | null;
  models: HermesGatewayModelOption[];
}

const MODEL_OPTIONS_PATH = "/model/options";
const MODEL_OPTIONS_TIMEOUT_MS = 5_000;
const DEFAULT_HERMES_DASHBOARD_PORT = "9119";
const HERMES_DASHBOARD_API_PATHS = new Set(["", "/", "/chat"]);

function normalizeBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
    if (url.port === DEFAULT_HERMES_DASHBOARD_PORT && HERMES_DASHBOARD_API_PATHS.has(normalizedPath)) {
      url.pathname = "/api";
    }
    return url;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function failure(status: Exclude<HermesGatewayModelOptionsStatus, "available">, message: string): HermesGatewayModelOptionsResult {
  return { status, message, provider: null, gatewayModel: null, models: [] };
}

function parseModelEntry(entry: unknown, provider: string | null): HermesGatewayModelOption | null {
  const record = asRecord(entry);
  const id = typeof entry === "string"
    ? nonEmpty(entry)
    : nonEmpty(record?.id) ?? nonEmpty(record?.model) ?? nonEmpty(record?.value);
  if (!id) return null;
  const label = nonEmpty(record?.label)
    ?? nonEmpty(record?.display_name)
    ?? nonEmpty(record?.displayName)
    ?? (record && nonEmpty(record.name) !== id ? nonEmpty(record?.name) : null)
    ?? id;
  const entryProvider = nonEmpty(record?.provider) ?? provider;
  return entryProvider ? { id, label, provider: entryProvider } : { id, label };
}

function modelEntryList(record: Record<string, unknown>): unknown[] | null {
  for (const key of ["models", "options", "data"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return null;
}

function dedupeModels(models: HermesGatewayModelOption[]): HermesGatewayModelOption[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function available(
  provider: string | null,
  gatewayModel: string | null,
  models: HermesGatewayModelOption[],
): HermesGatewayModelOptionsResult {
  return { status: "available", message: null, provider, gatewayModel, models: dedupeModels(models) };
}

/**
 * Hermes lists models for every provider it knows, but this adapter runs on
 * the gateway's current provider only. With provider groups, only the current,
 * authenticated group counts. A flat list is accepted only when the gateway
 * names its current provider, and is filtered to that provider; the current
 * provider is never inferred from model entries. Anything else is rejected so
 * the caller never offers ids the agent cannot run.
 */
function parseModelOptions(payload: unknown): HermesGatewayModelOptionsResult | null {
  const record = asRecord(payload);
  const currentProvider = nonEmpty(record?.provider);
  const gatewayModel = nonEmpty(record?.model) ?? nonEmpty(record?.current) ?? nonEmpty(record?.default);

  if (record && Array.isArray(record.providers)) {
    if (!currentProvider) {
      return failure(
        "invalid_response",
        "Hermes gateway did not report its current provider, so Paperclip cannot tell which models this agent can run.",
      );
    }
    const group = record.providers
      .map(asRecord)
      .find((candidate) => candidate
        && [candidate.slug, candidate.id, candidate.name].some((value) => nonEmpty(value) === currentProvider));
    if (!group) {
      return failure("invalid_response", `Hermes gateway did not list models for its current provider "${currentProvider}".`);
    }
    if (group.authenticated !== true) {
      return failure("auth_failed", `Hermes gateway reports its current provider "${currentProvider}" is not authenticated.`);
    }
    const models = (modelEntryList(group) ?? [])
      .map((entry) => parseModelEntry(entry, currentProvider))
      .filter((model): model is HermesGatewayModelOption => model !== null && model.provider === currentProvider);
    if (models.length === 0) {
      return failure("invalid_response", `Hermes gateway listed no models for its current provider "${currentProvider}".`);
    }
    return available(currentProvider, gatewayModel, models);
  }

  const flat = Array.isArray(payload) ? payload : record ? modelEntryList(record) : null;
  if (!flat) return null;
  if (!currentProvider) {
    return failure(
      "invalid_response",
      "Hermes gateway listed models without naming its current provider, so Paperclip cannot tell which models this agent can run.",
    );
  }
  const parsed = flat
    .map((entry) => parseModelEntry(entry, null))
    .filter((model): model is HermesGatewayModelOption => model !== null);
  return available(
    currentProvider,
    gatewayModel,
    parsed.filter((model) => !model.provider || model.provider === currentProvider),
  );
}

/**
 * Joins the model options route onto the configured base without leaving its
 * origin: `/api` bases get `/model/options`, other bases get `/api/model/options`.
 */
function modelOptionsUrl(baseUrl: URL): URL {
  const url = new URL(baseUrl.toString());
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath.endsWith("/api") ? basePath : `${basePath}/api`}${MODEL_OPTIONS_PATH}`;
  url.search = "";
  url.hash = "";
  return url;
}

/**
 * Lists the model ids a Hermes gateway reports as supported. Runs server-side
 * only: the resolved API key is sent to the gateway and never returned.
 */
export async function listHermesGatewayModelOptions(
  config: Record<string, unknown>,
): Promise<HermesGatewayModelOptionsResult> {
  const apiBaseUrl = asString(config.apiBaseUrl ?? config.url, "").trim();
  const apiKey = asString(config.apiKey ?? config.token, "").trim();
  if (!apiBaseUrl) return failure("misconfigured", "Hermes gateway apiBaseUrl is not configured.");
  if (!apiKey) return failure("misconfigured", "Hermes gateway API key is not configured.");
  const baseUrl = normalizeBaseUrl(apiBaseUrl);
  if (!baseUrl) return failure("misconfigured", "Hermes gateway apiBaseUrl must be an http:// or https:// URL.");
  if (isRemotePlainHttp(baseUrl) && !allowsInsecureRemoteHttp(config)) {
    return failure("misconfigured", remotePlainHttpDeniedMessage(baseUrl.hostname));
  }

  const url = modelOptionsUrl(baseUrl);
  if (url.origin !== baseUrl.origin) {
    return failure("misconfigured", "Hermes gateway model options URL left the configured origin.");
  }
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(MODEL_OPTIONS_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return failure(
      "unreachable",
      timedOut
        ? "Hermes gateway did not answer the model options request in time."
        : "Could not reach the Hermes gateway to list models.",
    );
  }

  if (response.status === 401 || response.status === 403) {
    return failure("auth_failed", `Hermes gateway rejected the configured API key (HTTP ${response.status}).`);
  }
  if (response.status === 404 || response.status === 405) {
    return failure(
      "unsupported",
      `Hermes gateway does not expose ${url.pathname} (HTTP ${response.status}); Paperclip cannot verify supported models.`,
    );
  }
  if (!response.ok) {
    return failure("unreachable", `Hermes gateway model options request failed (HTTP ${response.status}).`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return failure("invalid_response", "Hermes gateway returned a model options response that is not JSON.");
  }
  return parseModelOptions(payload)
    ?? failure("invalid_response", "Hermes gateway returned an unrecognized model options response.");
}
