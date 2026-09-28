import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { saveLoginCredentials } from './credentials.mjs';

const baseUrl = 'https://zcode.z.ai/api/v1/oauth/cli';
const businessUrl = 'https://api.z.ai/api/auth/z/login';
const loginTimeoutMs = 5 * 60_000;

async function request(url, init, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new Error('授权服务网络请求失败或超时');
  }
  if (!response.ok) throw new Error(`授权服务返回 HTTP ${response.status}`);
  try {
    const body = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new Error('授权服务返回的数据格式无效');
  }
}

function requireSuccess(body) {
  if (body.code !== 0) {
    throw new Error(`授权服务拒绝请求${typeof body.code === 'number' ? `（错误码 ${body.code}）` : ''}`);
  }
  if (!body.data || typeof body.data !== 'object') throw new Error('授权服务返回的数据格式无效');
  return body.data;
}

function nonempty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** 单独的终端登录流程；不会触碰 MCP 的 stdio 通道或 ZCode 凭据文件。 */
export async function login(provider, { fetchImpl = fetch, openBrowser, onUrl = () => {}, now = Date.now, wait = sleep } = {}) {
  if (provider !== 'zai' && provider !== 'bigmodel') throw new Error('请选择 zai 或 bigmodel');

  const pollToken = randomBytes(32).toString('hex');
  const init = requireSuccess(await request(`${baseUrl}/init`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pollToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  }, fetchImpl));
  const flowId = nonempty(init.flow_id);
  const expiresAt = init.expires_at * 1000;
  const intervalMs = init.poll_interval_sec * 1000;
  let authorizeUrl;
  try { authorizeUrl = new URL(init.authorize_url); } catch { /* invalid init response */ }
  if (!flowId || authorizeUrl?.protocol !== 'https:' ||
      typeof init.expires_at !== 'number' || !Number.isFinite(expiresAt) ||
      typeof init.poll_interval_sec !== 'number' || !Number.isFinite(intervalMs) ||
      intervalMs < 1000 || expiresAt <= now()) {
    throw new Error('授权服务返回的登录链接无效');
  }

  const deadline = Math.min(now() + loginTimeoutMs, expiresAt);
  await onUrl(authorizeUrl.href);
  if (openBrowser) {
    try { await openBrowser(authorizeUrl.href); } catch { /* 已显示链接，允许用户手动打开 */ }
  }

  while (now() < deadline) {
    const data = requireSuccess(await request(`${baseUrl}/poll/${encodeURIComponent(flowId)}`, {
      headers: { Authorization: `Bearer ${pollToken}` },
    }, fetchImpl));
    if (data.status === 'failed') throw new Error('浏览器授权失败，请重试');
    if (now() >= deadline) throw new Error('浏览器授权已超时，请重试');
    if (data.status === 'ready') {
      const jwt = nonempty(data.token);
      const providerToken = nonempty(data[provider]?.access_token) || nonempty(data[provider]?.accessToken);
      if (!jwt || !providerToken || !nonempty(data.user?.user_id)) {
        throw new Error('授权成功，但返回的登录凭据不完整');
      }
      let maasJwt = providerToken;
      if (provider === 'zai') {
        const business = await request(businessUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: providerToken }),
        }, fetchImpl);
        if (business.success === false || ![undefined, 0, 200].includes(business.code)) {
          throw new Error('Z.ai 业务凭据兑换失败');
        }
        maasJwt = nonempty(business.data?.access_token) || nonempty(business.data?.accessToken);
        if (!maasJwt) throw new Error('Z.ai 业务凭据兑换失败');
      }
      if (now() >= deadline) throw new Error('浏览器授权已超时，请重试');
      await saveLoginCredentials(provider, { jwt, maasJwt });
      return;
    }
    if (data.status !== 'pending') throw new Error('授权服务返回的数据格式无效');
    await wait(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  throw new Error('浏览器授权已超时，请重试');
}
