import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const secret = 'test-secret';
const loginModule = resolve('src/login.mjs');
const credentialsModule = resolve('src/credentials.mjs');

function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return `enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

const mockLogin = `
const { login } = await import(process.argv[1]);
const { loadCredentials } = await import(process.argv[2]);
const provider = process.argv[3];
const scenario = process.argv[4];
const calls = [];
let pollCount = 0;
let browserCount = 0;
let urlCount = 0;
let clock = Date.now();
let pollToken;
const response = (data) => Response.json({ code: 0, data });
const fetchImpl = async (url, init) => {
  if (url.endsWith('/init')) {
    pollToken = init.headers.Authorization;
    calls.push(['init', init.method, JSON.parse(init.body).provider, init.redirect]);
    return response({ flow_id: 'test-flow', authorize_url: 'https://example.org/authorize',
      expires_at: Math.floor(clock / 1000) + 120, poll_interval_sec: 1 });
  }
  if (url.endsWith('/poll/test-flow')) {
    calls.push(['poll', init.headers.Authorization === pollToken, init.redirect]);
    pollCount++;
    if (scenario === 'timeout' || pollCount === 1) return response({ status: 'pending' });
    return response({ status: 'ready', token: 'zcode.test.jwt', user: { user_id: 'user-test' },
      [provider]: scenario === 'incomplete' ? {} : { access_token: 'oauth.test.jwt' } });
  }
  if (url === 'https://api.z.ai/api/auth/z/login') {
    calls.push(['business', init.method, JSON.parse(init.body).token === 'oauth.test.jwt', init.redirect]);
    return response({ access_token: 'business.test.jwt' });
  }
  throw new Error('Unexpected request');
};
try {
  await login(provider, { fetchImpl,
    onUrl: (url) => { urlCount++; if (url !== 'https://example.org/authorize') throw new Error('Unexpected URL'); },
    openBrowser: async () => { browserCount++; },
    now: () => clock, wait: async (ms) => { clock += scenario === 'timeout' ? 121_000 : ms; },
  });
  const creds = await loadCredentials();
  process.stdout.write(JSON.stringify({ calls, urlCount, browserCount,
    correctPair: creds.jwt === 'zcode.test.jwt' && creds.maasJwt ===
      (provider === 'zai' ? 'business.test.jwt' : 'oauth.test.jwt') }));
} catch (error) {
  process.stdout.write(JSON.stringify({ calls, urlCount, browserCount, error: error.message }));
}
`;

function runMock(home, provider, scenario = 'success') {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', mockLogin,
    loginModule, credentialsModule, provider, scenario], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, HOME: home, ZCODE_CREDENTIAL_SECRET: secret },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('independent browser login stores encrypted JWTs for both providers and wins over ZCode copy', async () => {
  for (const provider of ['bigmodel', 'zai']) {
    const home = await mkdtemp(join(tmpdir(), `image-search-${provider}-`));
    try {
      const dir = join(home, '.zcode-image-search-mcp');
      await mkdir(dir);
      const cached = JSON.stringify({ zcode: encrypt('old.test.jwt'), maas: encrypt('old.maas.jwt') });
      await writeFile(join(dir, 'credentials.json'), cached);
      const outcome = runMock(home, provider);
      assert.equal(outcome.correctPair, true);
      assert.equal(outcome.urlCount, 1);
      assert.equal(outcome.browserCount, 1);
      assert.deepEqual(outcome.calls.slice(0, 3), [
        ['init', 'POST', provider, 'error'],
        ['poll', true, 'error'],
        ['poll', true, 'error'],
      ]);
      assert.deepEqual(outcome.calls.slice(3), provider === 'zai'
        ? [['business', 'POST', true, 'error']] : []);
      const path = join(dir, 'login-credentials.json');
      const stored = await readFile(path, 'utf8');
      assert.equal(JSON.parse(stored).provider, provider);
      assert.match(stored, /enc:v1:/);
      assert.doesNotMatch(stored, /zcode\.test\.jwt|oauth\.test\.jwt|business\.test\.jwt/);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
      assert.equal(await readFile(join(dir, 'credentials.json'), 'utf8'), cached);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test('failed or incomplete authorization never saves a login', async () => {
  for (const scenario of ['incomplete', 'timeout']) {
    const home = await mkdtemp(join(tmpdir(), 'image-search-login-fail-'));
    try {
      const outcome = runMock(home, 'bigmodel', scenario);
      assert.match(outcome.error, scenario === 'timeout' ? /超时/ : /不完整/);
      await assert.rejects(readFile(join(home, '.zcode-image-search-mcp/login-credentials.json')),
        { code: 'ENOENT' });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test('login command offers an interactive provider choice and keeps explicit options', () => {
  const main = resolve('src/main.mjs');
  const env = { ...process.env, ZCODE_IMAGE_SEARCH_PROXY: 'http://example.com:7890' };
  for (const [input, provider] of [['1\n', 'bigmodel'], ['x\n2\n', 'zai']]) {
    const result = spawnSync(process.execPath, [main, 'login'],
      { input, env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1); // 选中平台后拒绝非法代理，无真实授权
    assert.match(result.stdout, /选择登录平台/);
    assert.match(result.stdout, new RegExp(`已选择 ${provider} 登录`));
    assert.match(result.stderr, /仅支持无密码的本地 HTTP 代理/);
  }
  const empty = spawnSync(process.execPath, [main, 'login'],
    { input: '', env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /未选择登录平台/);
  const explicit = spawnSync(process.execPath, [main, 'login', 'bigmodel'],
    { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(explicit.status, 1);
  assert.match(explicit.stdout, /已选择 bigmodel 登录/);
  assert.doesNotMatch(explicit.stdout, /选择登录平台：/);
});
