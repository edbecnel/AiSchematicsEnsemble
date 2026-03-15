/**
 * Phase C.5 — Datasheet URL safety and fetch policy.
 *
 * Implements SSRF protection for the SUBCKT utility's datasheet URL ingestion
 * path. The same safety posture should be applied anywhere the backend
 * resolves user-supplied URLs.
 *
 * Rules enforced:
 *   - Only https: is accepted in fetch (http: is rejected with an error).
 *   - Localhost and loopback addresses (127.x, ::1) are blocked.
 *   - RFC 1918 private ranges (10.x, 172.16-31.x, 192.168.x) are blocked.
 *   - Link-local addresses (169.254.x for IPv4, fe80::/10 for IPv6) are blocked.
 *   - AWS/GCP/Azure metadata service IPs are blocked.
 *   - Common cloud metadata hostnames are blocked.
 *   - Maximum fetch size defaults to 32 MiB.
 *   - Fetch timeout defaults to 30 s.
 *   - Content-type must be application/pdf or application/octet-stream (checked
 *     by the caller after receiving the buffer).
 */

import dns from "node:dns/promises";

export class UrlSafetyError extends Error {
  constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "UrlSafetyError";
  }
}

// ---------------------------------------------------------------------------
// Blocked hostnames (cloud metadata services + common loopback aliases)
// ---------------------------------------------------------------------------

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",           // GCP metadata
  "169.254.169.254",                     // AWS / GCP / Azure IMDS
  "metadata.azure.com",
  "managementapi.azure.com",
  "fd00:ec2::254",                       // AWS IPv6 IMDS
]);

// ---------------------------------------------------------------------------
// IP range classification
// ---------------------------------------------------------------------------

/**
 * Returns the reason this IPv4 address is blocked, or undefined if allowed.
 */
function classifyIpv4(ip: string): string | undefined {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined;
  const [a, b] = parts;

  if (a === 127) return "loopback";
  if (a === 10) return "RFC1918-10";
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return "RFC1918-172";
  if (a === 192 && b === 168) return "RFC1918-192";
  if (a === 169 && b === 254) return "link-local";
  if (a === 0) return "unspecified";
  if (a === 255) return "broadcast";
  if (a >= 224 && a <= 239) return "multicast";

  // Loopback 127.x is handled above; catch 127.0.0.1 specifically
  return undefined;
}

/**
 * Returns the reason this IPv6 address is blocked, or undefined if allowed.
 */
function classifyIpv6(ip: string): string | undefined {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "");

  if (normalized === "::1") return "loopback-ipv6";
  if (normalized.startsWith("fe80:")) return "link-local-ipv6";
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return "ULA-ipv6";
  if (normalized.startsWith("::ffff:")) {
    // IPv4-mapped address — extract and check the IPv4 part
    const ipv4 = normalized.slice(7);
    return classifyIpv4(ipv4);
  }
  if (normalized === "::") return "unspecified-ipv6";

  return undefined;
}

function isIpBlocked(ip: string): string | undefined {
  if (ip.includes(":")) return classifyIpv6(ip);
  return classifyIpv4(ip);
}

// ---------------------------------------------------------------------------
// URL validation (before DNS resolution)
// ---------------------------------------------------------------------------

export interface UrlCheckResult {
  ok: true;
  url: URL;
  resolvedIps: string[];
}

export interface UrlCheckFailure {
  ok: false;
  reason: string;
}

export type UrlCheckOutcome = UrlCheckResult | UrlCheckFailure;

/**
 * Validates the URL structure and resolves the hostname to IP addresses,
 * then checks each IP against the blocklist.
 *
 * Throws UrlSafetyError if the URL is structurally invalid or structurally
 * disallowed. Returns UrlCheckOutcome for runtime policy decisions.
 */
export async function checkDatasheetUrl(rawUrl: string): Promise<UrlCheckOutcome> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: "invalid-url" };
  }

  if (url.protocol !== "https:") {
    return { ok: false, reason: "unsupported-protocol: only https: is permitted" };
  }

  const hostname = url.hostname;

  // Fast-path: blocked hostnames
  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
    return { ok: false, reason: `blocked-hostname: ${hostname}` };
  }

  // DNS resolution
  let resolvedIps: string[] = [];
  try {
    const records = await dns.resolve(hostname);
    resolvedIps = Array.isArray(records) ? (records as string[]) : [];
  } catch {
    // Also try dns.lookup as a fallback
    try {
      const entry = await dns.lookup(hostname);
      resolvedIps = [entry.address];
    } catch {
      return { ok: false, reason: `dns-lookup-failed: ${hostname}` };
    }
  }

  for (const ip of resolvedIps) {
    const reason = isIpBlocked(ip);
    if (reason) {
      return { ok: false, reason: `blocked-ip (${ip}): ${reason}` };
    }
  }

  return { ok: true, url, resolvedIps };
}

// ---------------------------------------------------------------------------
// Fetch with safety checks
// ---------------------------------------------------------------------------

export interface FetchDatasheetOptions {
  /** Override for maximum response size in bytes. Default: 32 MiB. */
  maxBytes?: number;
  /** Override for fetch timeout in ms. Default: 30 000 ms. */
  timeoutMs?: number;
  /** Allow http: URLs in dev/local mode. Default: false. */
  allowHttp?: boolean;
}

export interface FetchDatasheetResult {
  ok: true;
  buffer: Buffer;
  contentType: string;
  contentLength?: number;
  resolvedIps: string[];
  sourceUrl: string;
}

export type FetchDatasheetOutcome =
  | FetchDatasheetResult
  | { ok: false; reason: string };

/**
 * Fetch a datasheet URL safely.
 *
 * 1. Validates URL structure and protocol.
 * 2. Resolves hostname and checks IPs against the blocklist.
 * 3. Fetches with timeout and max-size enforcement.
 * 4. Returns the raw buffer; content-type validation is the caller's job.
 */
export async function fetchDatasheetUrl(
  rawUrl: string,
  opts?: FetchDatasheetOptions,
): Promise<FetchDatasheetOutcome> {
  const maxBytes  = opts?.maxBytes  ?? 32 * 1024 * 1024; // 32 MiB
  const timeoutMs = opts?.timeoutMs ?? 30_000;

  // Structural + SSRF check
  const safetyCheck = await checkDatasheetUrl(rawUrl);
  if (!safetyCheck.ok) {
    return { ok: false, reason: safetyCheck.reason };
  }

  const { url, resolvedIps } = safetyCheck;

  // Abort controller for timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        "User-Agent": "ai-schematics-ensemble/datasheet-fetcher",
        "Accept": "application/pdf,application/octet-stream,*/*",
      },
    });
  } catch (err) {
    clearTimeout(timer);
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes("aborted") || errMsg.includes("abort")) {
      return { ok: false, reason: `fetch-timeout: exceeded ${timeoutMs}ms` };
    }
    return { ok: false, reason: `fetch-error: ${errMsg}` };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return { ok: false, reason: `http-error: ${response.status} ${response.statusText}` };
  }

  const contentType = response.headers.get("content-type") ?? "";
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);

  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ok: false, reason: `response-too-large: ${contentLength} bytes exceeds ${maxBytes}` };
  }

  // Stream body with size enforcement
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = response.body?.getReader();

  if (!reader) {
    return { ok: false, reason: "empty-response-body" };
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: `response-too-large: exceeds ${maxBytes} bytes` };
      }
      chunks.push(value);
    }
  } catch (err) {
    return { ok: false, reason: `stream-error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));

  return {
    ok: true,
    buffer,
    contentType,
    contentLength: totalBytes,
    resolvedIps,
    sourceUrl: url.toString(),
  };
}

// ---------------------------------------------------------------------------
// Content-type validation helper
// ---------------------------------------------------------------------------

/**
 * Returns true if the content-type is consistent with a PDF or binary
 * document download. Callers may also accept text/html for datasheet
 * landing pages but that path is intentionally not supported here.
 */
export function isAcceptableDatasheetContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  return (
    ct === "application/pdf" ||
    ct === "application/octet-stream" ||
    ct === "binary/octet-stream" ||
    ct === "application/x-pdf" ||
    ct === "application/acrobat"
  );
}
