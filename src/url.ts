const DEFAULT_URL = 'http://127.0.0.1:7777';

/**
 * Turn whatever the user gave us into the WebSocket URL the daemon listens on.
 * `http://host` becomes `ws://host/ws`, `https://host/proxy` becomes `wss://host/proxy/ws`,
 * and a URL that already ends in `/ws` is left alone.
 */
export function resolveWsUrl(base: string = DEFAULT_URL): URL {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new TypeError(`Invalid daemon URL: ${base}`);
  }
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new TypeError('Daemon URL must use http, https, ws, or wss');
  }
  if (url.username || url.password || url.hash) {
    throw new TypeError('Daemon URL must not contain credentials or a fragment');
  }
  if (!url.pathname.endsWith('/ws')) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws`;
  }
  return url;
}

/** The reverse: from the WebSocket URL back to the HTTP base that `/health` and `/ready` live under. */
export function resolveHttpUrl(base: string = DEFAULT_URL): URL {
  const url = resolveWsUrl(base);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = url.pathname.slice(0, -'/ws'.length) || '/';
  return url;
}
