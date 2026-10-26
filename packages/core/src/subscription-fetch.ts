import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const maxSubscriptionBytes = 10 * 1024 * 1024;

/** Fetch only subscriptions through the deployment proxy, without changing other clients. */
export async function fetchSubscriptionText(url: string, options: {
  userAgent?: string | undefined;
  timeoutMs?: number | undefined;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<string> {
  try {
    if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error();
  } catch {
    throw new Error("订阅地址必须是有效的 HTTP 或 HTTPS URL。");
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const env = subscriptionProxyEnvironment(options.env ?? process.env);
  let output: string;
  try {
    const result = await execFileAsync("curl", [
      "--disable", "--silent", "--show-error", "--location", "--globoff", "--compressed",
      "--proto", "=http,https", "--proto-redir", "=http,https", "--max-redirs", "5",
      "--connect-timeout", String(Math.min(10_000, timeoutMs) / 1000),
      "--max-time", String(timeoutMs / 1000), "--max-filesize", String(maxSubscriptionBytes),
      "--user-agent", options.userAgent ?? "Clash.Meta",
      "--header", "Accept: text/yaml, application/yaml, text/plain, */*",
      "--header", "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8",
      "--write-out", "\n%{http_code} %{http_connect}", "--url", url
    ], { env, timeout: timeoutMs + 1000, maxBuffer: maxSubscriptionBytes + 1024, encoding: "utf8", windowsHide: true });
    output = result.stdout;
  } catch (error) {
    // Never return curl's command line or raw stderr: both may contain URL tokens or proxy credentials.
    const failure = error as { code?: string | number; killed?: boolean; stdout?: string };
    const statusLine = failure.stdout?.slice(failure.stdout.lastIndexOf("\n") + 1).trim().split(" ");
    const detail = statusLine?.[1] === "407"
      ? "HTTP 407：代理认证失败，请检查代理用户名和密码。"
      : failure.killed || failure.code === 28
      ? `请求超时（${timeoutMs / 1000} 秒），请检查网络和代理连接。`
      : failure.code === "ENOENT"
        ? "未找到 curl，请安装 curl 后重试。"
        : failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || failure.code === 63
          ? "订阅内容超过 10 MiB 限制。"
          : failure.code === 5
            ? "无法解析代理服务器地址，请检查代理配置。"
            : failure.code === 6
              ? "无法解析订阅服务器域名，请检查 DNS 或使用 socks5h 代理。"
              : failure.code === 7
                ? "无法连接订阅服务器或代理，请检查地址、端口及防火墙。"
                : [35, 51, 58, 60, 77].includes(Number(failure.code))
                  ? "TLS 连接或证书校验失败，请检查服务器证书、系统时间及代理。"
                  : failure.code === 47
                    ? "订阅重定向次数过多，请检查链接是否跳转到了登录页面。"
                    : failure.code === 97
                      ? "SOCKS 代理握手或认证失败，请检查代理协议及账密。"
                      : `网络请求失败${typeof failure.code === "number" ? `（curl ${failure.code}）` : ""}，请检查订阅地址和代理配置。`;
    throw new Error(detail);
  }
  const separator = output.lastIndexOf("\n");
  const status = Number(output.slice(separator + 1).split(" ")[0]);
  if (separator < 0 || !Number.isInteger(status) || status < 100) throw new Error("订阅服务器未返回有效 HTTP 响应。");
  if (status < 200 || status >= 300) {
    const detail = status === 401 || status === 403
      ? "链接未获授权、已过期，或被服务器拦截。"
      : status === 407 ? "代理认证失败，请检查代理用户名和密码。"
        : status === 404 ? "订阅地址不存在或已经失效。"
          : status === 429 ? "请求过于频繁，请稍后重试。" : "请检查订阅服务状态。";
    throw new Error(`HTTP ${status}：${detail}`);
  }
  return output.slice(0, separator);
}

/** Normalize uppercase Docker variables; curl only accepts lowercase http_proxy on Linux. */
export function subscriptionProxyEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const name of ["http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    const value = environment[name] ?? environment[name.toUpperCase()] ?? "";
    delete result[name.toUpperCase()];
    result[name] = value;
  }
  return result;
}
