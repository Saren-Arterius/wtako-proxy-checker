// @ts-nocheck

type ProxyType = "http" | "socks5" | "socks4";

interface BunGlobal {
  write(path: string, data: string): Promise<number>;
  fetch(input: string, init?: RequestInit & { proxy?: string }): Promise<Response>;
  spawn(options: {
    cmd: string[];
    stdout: "pipe";
    stderr: "pipe";
  }): {
    exited: Promise<number>;
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
  };
}

declare const Bun: BunGlobal;

interface CheckResult {
  protocol: ProxyType;
  ipPort: string;
  valid: boolean;
  latencySeconds?: string;
  ip?: string;
}

interface FetchResult {
  ok: boolean;
  status?: number;
  body?: string;
  reason?: string;
}

const IP_URL = "https://saren.wtako.net/ip.php";
const SOCKS_PROBE_URL = "https://arch-mirror.wtako.net/lastupdate";

const INPUT_URLS: Record<ProxyType, string> = {
  http: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/refs/heads/master/http.txt",
  socks5: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/refs/heads/master/socks5.txt",
  socks4: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/refs/heads/master/socks4.txt",
};
const ALT_SOURCE_URL =
  "https://github.com/proxifly/free-proxy-list/raw/refs/heads/main/proxies/all/data.txt";

const OUTPUT_CSV = "valid/proxies.csv";
const REQUEST_TIMEOUT_MS = 30_000;
const TOTAL_PROXY_TIMEOUT_MS = 60_000;
const CHECK_CONCURRENCY = 500;

function parseProxyList(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function parseAltSourceByType(content: string, type: ProxyType): string[] {
  const prefix = `${type}://`;
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix) && line.length > prefix.length)
    .map((line) => line.slice(prefix.length));
}

function deduplicate(items: string[]): string[] {
  return [...new Set(items)];
}

function isIpLike(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  return /^[0-9a-fA-F:.]+$/.test(trimmed);
}

async function fetchPlainText(url: string): Promise<string> {
  const response = await Bun.fetch(url);
  if (!response.ok) {
    throw new Error(`failed-to-fetch-${url}-status-${response.status}`);
  }

  return response.text();
}

async function fetchWithProxy(
  url: string,
  proxyUrl: string,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<FetchResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await Bun.fetch(url, {
      method: "GET",
      signal: controller.signal,
      proxy: proxyUrl,
    });

    const body = (await response.text()).trim();
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, status: response.status, body, reason: `http-status-${response.status}` };
    }

    return { ok: true, status: response.status, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message || "request-failed" };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function curlSocksRequest(
  proxy: string,
  type: "socks5" | "socks4",
  url: string,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<FetchResult> {
  const proxyFlag = type === "socks5" ? "--socks5-hostname" : "--socks4a";
  const timeoutSec = Math.ceil(timeoutMs / 1000);

  const proc = Bun.spawn({
    cmd: [
      "curl",
      "-sS",
      "-k",
      "--connect-timeout",
      String(timeoutSec),
      "--max-time",
      String(timeoutSec),
      proxyFlag,
      proxy,
      "-w",
      "\n%{http_code}",
      url,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });

  const [code, stdoutText, stderrText] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (code !== 0) {
    return { ok: false, reason: stderrText.trim() || `curl-exit-${code}` };
  }

  const lines = stdoutText.replace(/\r/g, "").split("\n");
  const statusLine = lines.pop()?.trim() ?? "";
  const body = lines.join("\n").trim();
  const status = Number(statusLine);

  if (!Number.isFinite(status)) {
    return { ok: false, reason: "invalid-http-status" };
  }

  if (status < 200 || status >= 300) {
    return { ok: false, status, body, reason: `http-status-${status}` };
  }

  return { ok: true, status, body };
}

async function checkHttpProxy(proxy: string): Promise<CheckResult> {
  const deadline = Date.now() + TOTAL_PROXY_TIMEOUT_MS;
  const start = Date.now();

  const probeTimeout = Math.max(1_000, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()));
  const probe = await fetchWithProxy(SOCKS_PROBE_URL, `http://${proxy}`, probeTimeout);
  const seconds = ((Date.now() - start) / 1000).toFixed(2);

  if (!probe.ok) {
    return { protocol: "http", ipPort: proxy, valid: false };
  }

  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return { protocol: "http", ipPort: proxy, valid: false };
  }

  const ipTimeout = Math.max(1_000, Math.min(REQUEST_TIMEOUT_MS, remaining));
  const ipResult = await fetchWithProxy(IP_URL, `http://${proxy}`, ipTimeout);
  const ip = ipResult.ok && ipResult.body && isIpLike(ipResult.body) ? ipResult.body : "local-ip-unavailable";

  console.log(`[OK][http] ${proxy} lastupdate=${seconds}s ip=${ip}`);
  return { protocol: "http", ipPort: proxy, valid: true, latencySeconds: seconds, ip };
}

async function checkSocksProxy(proxy: string, type: "socks5" | "socks4"): Promise<CheckResult> {
  const deadline = Date.now() + TOTAL_PROXY_TIMEOUT_MS;
  const probeStart = Date.now();

  const probeTimeout = Math.max(1_000, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()));
  const probe = await curlSocksRequest(proxy, type, SOCKS_PROBE_URL, probeTimeout);
  const probeSeconds = ((Date.now() - probeStart) / 1000).toFixed(2);

  if (!probe.ok) {
    console.log(`[FAIL][${type}] ${proxy} -> ${probe.reason ?? "lastupdate-failed"}`);
    return { protocol: type, ipPort: proxy, valid: false };
  }

  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    console.log(`[FAIL][${type}] ${proxy} -> total-timeout-over-60s`);
    return { protocol: type, ipPort: proxy, valid: false };
  }

  const ipTimeout = Math.max(1_000, Math.min(REQUEST_TIMEOUT_MS, remaining));
  const ipResult = await curlSocksRequest(proxy, type, IP_URL, ipTimeout);
  const ip = ipResult.ok && ipResult.body && isIpLike(ipResult.body) ? ipResult.body : "local-ip-unavailable";

  console.log(`[OK][${type}] ${proxy} (curl) lastupdate=${probeSeconds}s ip=${ip}`);
  return { protocol: type, ipPort: proxy, valid: true, latencySeconds: probeSeconds, ip };
}

async function checkProxy(proxy: string, type: ProxyType): Promise<CheckResult> {
  if (type === "http") {
    return checkHttpProxy(proxy);
  }

  if (type === "socks5") {
    return checkSocksProxy(proxy, "socks5");
  }

  return checkSocksProxy(proxy, "socks4");
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runner(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await worker(items[currentIndex]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runner());
  await Promise.all(workers);
  return results;
}

async function verifyType(type: ProxyType): Promise<CheckResult[]> {
  const primaryText = await fetchPlainText(INPUT_URLS[type]);
  const primaryProxies = parseProxyList(primaryText);

  let altProxies: string[] = [];
  try {
    const altText = await fetchPlainText(ALT_SOURCE_URL);
    altProxies = parseAltSourceByType(altText, type);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[WARN][${type}] alt source unavailable: ${message}`);
  }

  const proxies = deduplicate([...primaryProxies, ...altProxies]);

  console.log(
    `[${type}] checking ${proxies.length} proxies (primary=${primaryProxies.length}, alt=${altProxies.length}, deduped=${proxies.length}, parallel=${Math.min(CHECK_CONCURRENCY, proxies.length)})...`,
  );

  const results = await runWithConcurrency(proxies, CHECK_CONCURRENCY, async (p) => checkProxy(p, type));
  const validCount = results.filter((r) => r.valid).length;
  console.log(`[${type}] valid: ${validCount}/${proxies.length}`);

  return results;
}

async function main(): Promise<void> {
  const [httpResults, socks5Results, socks4Results] = await Promise.all([
    verifyType("http"),
    verifyType("socks5"),
    verifyType("socks4"),
  ]);

  const validRows = [...httpResults, ...socks5Results, ...socks4Results].filter((r) => r.valid);
  const csvLines = [
    "protocol,ip_port,latency,ip.php",
    ...validRows.map((r) => `${r.protocol},${r.ipPort},${r.latencySeconds ?? ""},${r.ip ?? ""}`),
  ];

  await Bun.write(OUTPUT_CSV, csvLines.join("\n"));
  console.log(`Saved ${validRows.length} valid proxies -> ${OUTPUT_CSV}`);
  console.log("Done.");
}

await main();

export {};