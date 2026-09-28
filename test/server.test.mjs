import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { searchImage } from '../src/proxy.mjs';

const main = resolve('src/main.mjs');

function encrypt(value, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return `enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

test('stdio auto-syncs ZCode credentials, retains logout copy and picks up re-login', async () => {
  const home = await mkdtemp(join(tmpdir(), 'image-search-auto-'));
  const secret = 'test-secret';
  const sourceDir = join(home, '.zcode/v2');
  const transport = new StdioClientTransport({ command: process.execPath, args: [main],
    env: { ...process.env, HOME: home, ZCODE_CREDENTIAL_SECRET: secret } });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    await mkdir(sourceDir, { recursive: true });
    const zcode = encrypt('a.b.c', secret);
    const maas = encrypt('d.e.f', secret);
    const source = join(sourceDir, 'credentials.json');
    await writeFile(source, JSON.stringify({
      'oauth:active_provider': encrypt('bigmodel', secret),
      zcodejwttoken: zcode,
      'oauth:bigmodel:access_token': maas,
      'oauth:bigmodel:user_info': encrypt('not copied', secret),
    }));
    await client.connect(transport);
    const destination = join(home, '.zcode-image-search-mcp/credentials.json');
    assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), { zcode, maas });
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.equal((await stat(join(home, '.zcode-image-search-mcp'))).mode & 0o777, 0o700);

    await writeFile(source, '{}'); // 模拟退出登录
    const independent = spawnSync(process.execPath, ['--input-type=module', '-e',
      "const {loadCredentials}=await import(process.argv[1]); const {jwt,maasJwt}=await loadCredentials(); process.stdout.write(String(jwt==='a.b.c'&&maasJwt==='d.e.f'));",
      resolve('src/credentials.mjs')], {
      env: { ...process.env, HOME: home, ZCODE_CREDENTIAL_SECRET: secret }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(independent.status, 0, independent.stderr);
    assert.equal(independent.stdout, 'true');

    const nextZcode = encrypt('g.h.i', secret);
    const nextMaas = encrypt('j.k.l', secret);
    await writeFile(source, JSON.stringify({
      'oauth:active_provider': encrypt('bigmodel', secret),
      zcodejwttoken: nextZcode,
      'oauth:bigmodel:access_token': nextMaas,
    }));
    const refreshed = spawnSync(process.execPath, ['--input-type=module', '-e',
      "const {loadCredentials}=await import(process.argv[1]); const {jwt,maasJwt}=await loadCredentials(); process.stdout.write(String(jwt==='g.h.i'&&maasJwt==='j.k.l'));",
      resolve('src/credentials.mjs')], {
      env: { ...process.env, HOME: home, ZCODE_CREDENTIAL_SECRET: secret }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(refreshed.status, 0, refreshed.stderr);
    assert.equal(refreshed.stdout, 'true');
    assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), { zcode: nextZcode, maas: nextMaas });
  } finally {
    await client.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('stdio speaks MCP and exposes the official tool schema', async () => {
  const home = await mkdtemp(join(tmpdir(), 'image-search-stdio-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [main],
    env: { ...process.env, HOME: home } });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name), ['search_image']);
    assert.deepEqual(tools[0].inputSchema.required, ['query', 'count', 'gl', 'rank']);
    assert.equal(tools[0].title, 'Search Image');
    assert.equal(tools[0].description, 'Search the web for existing images matching a query. Results are not content-moderated.');
    assert.deepEqual(tools[0].outputSchema.required, ['success', 'query', 'count', 'ranked', 'results']);
    assert.deepEqual(tools[0].outputSchema.properties.results.type, ['null', 'array']);
    assert.deepEqual(tools[0].outputSchema.properties.results.items.required,
      ['original_url', 'caption', 'source', 'original_width', 'original_height']);
    const result = await client.callTool({ name: 'search_image', arguments: {
      query: 'red apple', count: 1, gl: 'us', rank: false,
    } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /未找到凭据/);
  } finally {
    await client.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('stdio sends authenticated image requests through configured local proxy', async () => {
  const home = await mkdtemp(join(tmpdir(), 'image-search-proxy-'));
  const secret = 'test-secret';
  const sourceDir = join(home, '.zcode/v2');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, 'credentials.json'), JSON.stringify({
    'oauth:active_provider': encrypt('bigmodel', secret),
    zcodejwttoken: encrypt('a.b.c', secret),
    'oauth:bigmodel:access_token': encrypt('d.e.f', secret),
  }));
  let destination;
  const proxy = createServer();
  proxy.on('connect', (request, socket) => {
    destination = request.url;
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const transport = new StdioClientTransport({ command: process.execPath, args: [main],
    env: { ...process.env, HOME: home, ZCODE_CREDENTIAL_SECRET: secret,
      ZCODE_IMAGE_SEARCH_PROXY: `http://127.0.0.1:${proxy.address().port}` } });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'search_image', arguments: {
      query: 'red apple', count: 1, gl: 'us', rank: false,
    } });
    assert.equal(result.isError, true); // 假代理拒绝 CONNECT
    assert.equal(destination, 'zcode.z.ai:443', result.content?.[0]?.text);
  } finally {
    await client.close();
    await new Promise((resolve) => proxy.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test('proxy forwards authenticated MCP requests and returns tool results unchanged', async () => {
  const calls = [];
  const fetchStub = async (resource, init) => {
    assert.equal(String(resource), 'https://zcode.z.ai/api/v1/mcp/server/image_search');
    assert.equal(init.redirect, 'manual');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), 'Bearer zcode-test');
    assert.equal(headers.get('x-bigmodel-authorization'), 'Bearer maas-test');
    const body = JSON.parse(init.body);
    calls.push(body.method);
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: {
      protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1.0.0' },
    } });
    assert.equal(body.method, 'tools/call');
    assert.deepEqual(body.params, { name: 'search_image', arguments: {
      query: 'red apple', count: 1, gl: 'us', rank: false,
    } });
    return Response.json({ jsonrpc: '2.0', id: body.id, result: {
      content: [{ type: 'text', text: 'one image' }], structuredContent: { success: true, results: [{}] },
    } });
  };
  const result = await searchImage({ query: 'red apple', count: 1, gl: 'us', rank: false },
    { jwt: 'zcode-test', maasJwt: 'maas-test' }, fetchStub);
  assert.deepEqual(result.content, [{ type: 'text', text: 'one image' }]);
  assert.equal(result.structuredContent.success, true);
  assert.deepEqual(calls, ['initialize', 'notifications/initialized', 'tools/call']);
});
