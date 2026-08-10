function hostForUrl(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function assertPort(config) {
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("node config contains an invalid port");
  }
}

export function advertisedNodeUrl(config) {
  assertPort(config);
  if (config.version === 1) {
    if (typeof config.listenHost !== "string" || config.listenHost.length === 0) {
      throw new Error("version 1 node config contains an invalid listenHost");
    }
    return `http://${hostForUrl(config.listenHost)}:${config.port}`;
  }
  if (config.version !== 2) throw new Error("unsupported node config version");
  if (typeof config.advertisedUrl !== "string") throw new Error("version 2 node config is missing advertisedUrl");
  const parsed = new URL(config.advertisedUrl);
  if (
    parsed.protocol !== "http:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("node advertisedUrl must be an HTTP origin");
  }
  if (Number(parsed.port) !== config.port) throw new Error("node advertisedUrl and listen port differ");
  return parsed.origin;
}

export function localNodeUrl(config) {
  assertPort(config);
  let host = config.listenHost;
  if (host === "0.0.0.0") host = "127.0.0.1";
  if (host === "::") host = "::1";
  if (typeof host !== "string" || host.length === 0) throw new Error("node config contains an invalid listenHost");
  return `http://${hostForUrl(host)}:${config.port}`;
}
