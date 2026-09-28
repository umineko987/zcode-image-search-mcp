import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createNetworkFetch } from '../src/network.mjs';

test('proxy configuration accepts only passwordless loopback HTTP URLs with ports', async () => {
  for (const url of ['http://127.0.0.1:7890', 'http://[::1]:7890']) {
    const network = createNetworkFetch(url);
    await network.close();
  }
  for (const url of [
    'http://example.com:7890', 'http://192.168.1.1:7890',
    'http://user:pass@127.0.0.1:7890', 'http://user@127.0.0.1:7890',
    'socks5://127.0.0.1:7890', 'https://127.0.0.1:7890',
    'http://127.0.0.1', 'http://127.0.0.1:7890/path',
  ]) {
    assert.throws(() => createNetworkFetch(url), /仅支持无密码的本地 HTTP 代理/);
  }
});

test('browser login CLI sends authorization requests through configured proxy', { timeout: 10_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'image-search-login-proxy-'));
  let destination;
  const proxy = createServer();
  proxy.on('connect', (request, socket) => {
    destination = request.url;
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  let child;
  try {
    child = spawn(process.execPath, [resolve('src/main.mjs'), 'login', 'bigmodel'], {
      env: { ...process.env, HOME: home,
        ZCODE_IMAGE_SEARCH_PROXY: `http://127.0.0.1:${proxy.address().port}` },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 1); // 假代理拒绝连接
    assert.match(stderr, /授权服务网络请求失败或超时/);
    assert.equal(destination, 'zcode.z.ai:443');
    await assert.rejects(readFile(join(home, '.zcode-image-search-mcp/login-credentials.json')),
      { code: 'ENOENT' });
  } finally {
    child?.kill();
    await new Promise((resolve) => proxy.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});
