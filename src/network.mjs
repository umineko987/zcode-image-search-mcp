import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';

const invalidProxy = 'ZCODE_IMAGE_SEARCH_PROXY 仅支持无密码的本地 HTTP 代理，如 http://127.0.0.1:7890';

export function createNetworkFetch(proxy = process.env.ZCODE_IMAGE_SEARCH_PROXY) {
  let dispatcher;
  if (proxy) {
    let url;
    try { url = new URL(proxy); } catch { throw new Error(invalidProxy); }
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
        !url.port || url.port === '0' || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) {
      throw new Error(invalidProxy);
    }
    dispatcher = new ProxyAgent(url.href);
  } else {
    // 明确直连，不受 Node 或客户端继承的 HTTP_PROXY/HTTPS_PROXY 影响。
    dispatcher = new Agent();
  }
  return {
    fetch: (resource, init) => undiciFetch(resource, { ...init, dispatcher }),
    close: () => dispatcher.close(),
  };
}
