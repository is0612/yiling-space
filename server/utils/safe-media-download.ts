/**
 * 外部媒体安全下载。
 *
 * 安全边界：
 * 1. 每一跳重定向前都校验 URL；
 * 2. DNS 在实际 socket 建立时解析、校验并把选中的 IP 交给连接器，避免预检查与连接时二次解析之间的 TOCTOU；
 * 3. 流式读取并硬性限制实际字节数；
 * 4. 每个跳转使用独立 Agent，避免跨 host 复用连接。
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

const MAX_REDIRECTS = 5;

/** 这个文件里的响应一律来自 undici 的 fetch，类型也跟着它走。 */
type FetchResponse = Awaited<ReturnType<typeof undiciFetch>>;

/**
 * 把嵌套的 fetch 错误压成一行可读的原因（`UND_ERR_CONNECT_TIMEOUT` / `CERT_...` / `fetch failed`…）。
 *
 * 为什么需要：`fetch failed` 是 undici 的通用外壳，真正的原因在 `error.cause` 里，
 * 不扒出来日志就只有「下载失败」四个字（2026-11-06 语音识别卡这里时就是这样）。
 */
function describeFetchError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const item = current as { message?: string; code?: string };
    const piece = [item.code, item.message].filter(Boolean).join(" ");
    if (piece && !parts.includes(piece)) parts.push(piece);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" <- ").slice(0, 200);
}

type IpRecord = { address: string; family: number };

function unbracket(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "");
}

function ipv4ToBigInt(address: string): bigint | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function inIpv4Cidr(address: bigint, network: string, prefix: number): boolean {
  const base = ipv4ToBigInt(network);
  if (base === null) return true;
  const shift = 32n - BigInt(prefix);
  return (address >> shift) === (base >> shift);
}

function isPrivateIpv4(address: string): boolean {
  const value = ipv4ToBigInt(address);
  if (value === null) return true;

  // 非全球单播、特殊用途、文档示例、链路本地、组播及保留地址。
  const blocked: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return blocked.some(([network, prefix]) => inIpv4Cidr(value, network, prefix));
}

function ipv6ToBigInt(address: string): bigint | null {
  let input = address.toLowerCase();
  if (input.includes("%")) return null;

  // 把 IPv4 尾段改写为两个 16-bit hextet，统一解析。
  if (input.includes(".")) {
    const separator = input.lastIndexOf(":");
    if (separator < 0) return null;
    const ipv4 = ipv4ToBigInt(input.slice(separator + 1));
    if (ipv4 === null) return null;
    const high = Number((ipv4 >> 16n) & 0xffffn).toString(16);
    const low = Number(ipv4 & 0xffffn).toString(16);
    input = input.slice(0, separator + 1) + high + ":" + low;
  }

  const doubleColon = input.indexOf("::");
  let groups: string[];
  if (doubleColon >= 0) {
    if (input.indexOf("::", doubleColon + 2) >= 0) return null;
    const left = input.slice(0, doubleColon);
    const right = input.slice(doubleColon + 2);
    const leftGroups = left ? left.split(":") : [];
    const rightGroups = right ? right.split(":") : [];
    const zeroCount = 8 - leftGroups.length - rightGroups.length;
    if (zeroCount < 1) return null;
    groups = [...leftGroups, ...Array.from({ length: zeroCount }, () => "0"), ...rightGroups];
  } else {
    groups = input.split(":");
    if (groups.length !== 8) return null;
  }

  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
}

function inIpv6Cidr(address: bigint, network: string, prefix: number): boolean {
  const base = ipv6ToBigInt(network);
  if (base === null) return true;
  const shift = 128n - BigInt(prefix);
  return (address >> shift) === (base >> shift);
}

function isPrivateIpv6(address: string): boolean {
  const value = ipv6ToBigInt(address);
  if (value === null) return true;

  // IPv4-mapped IPv6：按尾部 IPv4 的真实范围判断，不能绕过 IPv4 规则。
  if ((value >> 32n) === 0xffffn) {
    const mappedIpv4 = Number(value & 0xffffffffn);
    const octets = [
      (mappedIpv4 >>> 24) & 255,
      (mappedIpv4 >>> 16) & 255,
      (mappedIpv4 >>> 8) & 255,
      mappedIpv4 & 255,
    ];
    return isPrivateIpv4(octets.join("."));
  }

  // 只放行 2000::/3 全球单播，再排除文档网段、协议特殊用途和 6to4。
  if (!inIpv6Cidr(value, "2000::", 3)) return true;
  const blocked: Array<[string, number]> = [
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
  ];
  return blocked.some(([network, prefix]) => inIpv6Cidr(value, network, prefix));
}

function isPublicAddress(address: string, family: number): boolean {
  if (family === 4 || isIP(address) === 4) return !isPrivateIpv4(address);
  if (family === 6 || isIP(address) === 6) return !isPrivateIpv6(address);
  return false;
}

export function assertFetchableMediaUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("IMAGE_INVALID_URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("IMAGE_INVALID_PROTOCOL");
  if (url.username || url.password) throw new Error("IMAGE_INVALID_URL");

  const host = unbracket(url.hostname).toLowerCase();
  if (!host || host.includes("%")) throw new Error("IMAGE_INVALID_URL");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || host.endsWith(".internal") || host.endsWith(".lan") || host === "home.arpa") {
    throw new Error("IMAGE_BLOCKED_HOST");
  }

  const version = isIP(host);
  if (version === 4 && isPrivateIpv4(host)) throw new Error("IMAGE_BLOCKED_HOST");
  if (version === 6 && isPrivateIpv6(host)) throw new Error("IMAGE_BLOCKED_HOST");
  return url;
}

export async function assertPublicMediaHost(hostname: string): Promise<void> {
  const host = unbracket(hostname).toLowerCase();
  const version = isIP(host);
  if (version === 4 || version === 6) {
    if (!isPublicAddress(host, version)) throw new Error("IMAGE_BLOCKED_HOST");
    return;
  }

  let addresses: IpRecord[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("IMAGE_DOWNLOAD_FAILED");
  }
  if (!addresses.length) throw new Error("IMAGE_DOWNLOAD_FAILED");
  if (addresses.some((entry) => !isPublicAddress(entry.address, entry.family))) {
    throw new Error("IMAGE_BLOCKED_HOST");
  }
}

type ResolveMediaHost = (hostname: string) => Promise<IpRecord[]>;
type PinnedLookup = (
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (...args: unknown[]) => void,
) => void;

export function createPinnedLookup(
  onBlocked: () => void,
  resolveAll: ResolveMediaHost = (hostname) => lookup(hostname, { all: true, verbatim: true }),
): PinnedLookup {
  return ((
    hostname: string,
    options: { all?: boolean; family?: number },
    callback: (...args: unknown[]) => void,
  ) => {
    void resolveAll(hostname).then((records) => {
      if (!records.length || records.some((entry) => !isPublicAddress(entry.address, entry.family))) {
        onBlocked();
        const error = Object.assign(new Error("MEDIA_BLOCKED_HOST"), { code: "EACCES" });
        callback(error);
        return;
      }

      const family = options?.family ?? 0;
      const selected = family === 4 || family === 6
        ? records.filter((entry) => entry.family === family)
        : records;
      if (!selected.length) {
        const error = Object.assign(new Error("MEDIA_DNS_FAMILY_UNAVAILABLE"), { code: "ENOTFOUND" });
        callback(error);
        return;
      }

      if (options?.all) callback(null, selected);
      else callback(null, selected[0]!.address, selected[0]!.family);
    }).catch((error: unknown) => {
      callback(error instanceof Error ? error : new Error("MEDIA_DNS_FAILED"));
    });
  }) as PinnedLookup;
}

async function cancelBody(response: FetchResponse | undefined): Promise<void> {
  try {
    await response?.body?.cancel();
  } catch {
    // 取消失败不应覆盖原始下载错误。
  }
}

async function readLimitedBody(response: FetchResponse, maxBytes: number, prefix: string): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      if (!chunk?.byteLength) continue;
      if (total + chunk.byteLength > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // 仍以 TOO_LARGE 作为本次下载的确定结果。
        }
        throw new Error(`${prefix}_TOO_LARGE`);
      }
      // 先保留视图，避免每个网络分块都额外复制一次。
      chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      total += chunk.byteLength;
    }
  } catch (error) {
    if (error instanceof Error && error.message === `${prefix}_TOO_LARGE`) throw error;
    throw new Error(`${prefix}_DOWNLOAD_FAILED`);
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total);
}

function isExpectedDownloadError(error: unknown, prefix: string): error is Error {
  if (!(error instanceof Error)) return false;
  return error.message.startsWith(`${prefix}_`);
}

function validateMediaUrl(raw: string, prefix: "IMAGE" | "VOICE"): URL {
  try {
    return assertFetchableMediaUrl(raw);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "IMAGE_BLOCKED_HOST") throw new Error(`${prefix}_BLOCKED_HOST`);
    if (code === "IMAGE_INVALID_PROTOCOL") throw new Error(`${prefix}_INVALID_PROTOCOL`);
    throw new Error(`${prefix}_INVALID_URL`);
  }
}

export async function downloadSafeMedia(
  rawUrl: string,
  options: {
    prefix: "IMAGE" | "VOICE";
    maxBytes: number;
    timeoutMs: number;
    headers?: Record<string, string>;
    requiredMimePrefix?: string;
  },
): Promise<{ buffer: Buffer; mime: string }> {
  const { prefix, maxBytes, timeoutMs, headers, requiredMimePrefix } = options;
  let currentUrl = validateMediaUrl(rawUrl, prefix);
  const signal = AbortSignal.timeout(timeoutMs);

  // 预检查给出清晰错误；真正建立连接时还会通过 Agent 的 lookup 再校验并固定 IP。
  try {
    await assertPublicMediaHost(currentUrl.hostname);
  } catch (error) {
    if (error instanceof Error && error.message === "IMAGE_BLOCKED_HOST") {
      throw new Error(`${prefix}_BLOCKED_HOST`);
    }
    throw new Error(`${prefix}_DOWNLOAD_FAILED`);
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let blockedDuringConnect = false;
    const agent = new Agent({
      connections: 1,
      pipelining: 0,
      connect: { lookup: createPinnedLookup(() => { blockedDuringConnect = true; }) as never },
    });

    let response: FetchResponse | undefined;
    try {
      /*
       * 必须用 undici 自己的 fetch，不能用 Node 的全局 fetch。
       *
       * 全局 fetch 带的是 Node 内置的那份 undici，而我们 new 的 Agent 来自 npm 装的 undici
       * （版本还不一样：内置 7.x、依赖里 8.x）。把 8.x 的 Agent 当 dispatcher 塞给 7.x 的 fetch，
       * 对方认不出这个 dispatcher 的接口，直接抛 `UND_ERR_INVALID_ARG invalid onRequestStart method`
       * —— 表现就是「所有外链下载失败」，连 403/404 都拿不到（2026-11-06 实测）。
       */
      response = await undiciFetch(currentUrl, {
        redirect: "manual",
        signal,
        headers,
        dispatcher: agent,
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await cancelBody(response);
        if (!location) throw new Error(`${prefix}_DOWNLOAD_FAILED`);
        if (hop === MAX_REDIRECTS) throw new Error(`${prefix}_REDIRECT_LIMIT`);

        let next: URL;
        try {
          next = validateMediaUrl(new URL(location, currentUrl).toString(), prefix);
        } catch (error) {
          if (isExpectedDownloadError(error, prefix)) throw error;
          if (error instanceof Error && error.message === "IMAGE_BLOCKED_HOST") {
            throw new Error(`${prefix}_BLOCKED_HOST`);
          }
          throw new Error(`${prefix}_DOWNLOAD_FAILED`);
        }
        try {
          await assertPublicMediaHost(next.hostname);
        } catch (error) {
          if (error instanceof Error && error.message === "IMAGE_BLOCKED_HOST") {
            throw new Error(`${prefix}_BLOCKED_HOST`);
          }
          throw new Error(`${prefix}_DOWNLOAD_FAILED`);
        }
        currentUrl = next;
        continue;
      }

      if (!response.ok) throw new Error(`${prefix}_HTTP_${response.status}`);

      const declaredLength = response.headers.get("content-length");
      if (declaredLength && /^\d+$/.test(declaredLength)) {
        const length = Number(declaredLength);
        if (!Number.isSafeInteger(length) || length > maxBytes) {
          throw new Error(`${prefix}_TOO_LARGE`);
        }
      }

      const mime = (response.headers.get("content-type") ?? "")
        .split(";")[0]!.trim().toLowerCase();
      if (requiredMimePrefix && !mime.startsWith(requiredMimePrefix)) {
        throw new Error(`${prefix}_NOT_IMAGE`);
      }

      const buffer = await readLimitedBody(response, maxBytes, prefix);
      if (!buffer.length) throw new Error(`${prefix}_EMPTY`);
      return { buffer, mime };
    } catch (error) {
      await cancelBody(response);
      if (blockedDuringConnect) throw new Error(`${prefix}_BLOCKED_HOST`);
      if (isExpectedDownloadError(error, prefix)) throw error;
      /*
       * 带上底层原因：`DOWNLOAD_FAILED` 一个词什么信息都没有。
       * 2026-11-06 语音识别就卡在这里 —— 日志只有 `VOICE_DOWNLOAD_FAILED`，
       * 分不清是 DNS、TLS、超时还是没给 UA。错误里通常只有主机名，不带查询串里的 rkey。
       */
      throw new Error(`${prefix}_DOWNLOAD_FAILED (${describeFetchError(error)})`, { cause: error });
    } finally {
      try {
        await agent.close();
      } catch {
        try {
          await agent.destroy();
        } catch {
          // 忽略 socket 清理异常，不能覆盖下载结果。
        }
      }
    }
  }

  throw new Error(`${prefix}_REDIRECT_LIMIT`);
}
