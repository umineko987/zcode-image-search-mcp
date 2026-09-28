import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { homedir, platform, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

const sourcePath = join(homedir(), '.zcode', 'v2', 'credentials.json');
const savedPath = join(homedir(), '.zcode-image-search-mcp', 'credentials.json');
export const loginCredentialPath = join(homedir(), '.zcode-image-search-mcp', 'login-credentials.json');
const prefix = 'enc:v1:';

function credentialKey() {
  const secret = process.env.ZCODE_CREDENTIAL_SECRET ||
    `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
  return createHash('sha256').update(secret).digest();
}

function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', credentialKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${prefix}${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decrypt(value) {
  if (typeof value !== 'string' || !value.startsWith(prefix)) {
    throw new Error('仅支持 ZCode 的加密凭据');
  }
  const parts = value.slice(prefix.length).split('.');
  if (parts.length !== 3) throw new Error('ZCode 凭据格式无效');
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64url'));
  if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) {
    throw new Error('ZCode 凭据格式无效');
  }
  const key = credentialKey();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('无法解密 ZCode 凭据，请检查登录环境或 ZCODE_CREDENTIAL_SECRET');
  }
}

function assertJwt(value) {
  if (typeof value !== 'string' || value.split('.').length !== 3 || value.split('.').some((part) => !part)) {
    throw new Error('ZCode 登录凭据不完整');
  }
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writePrivateFile(path, contents) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** 有登录态时自动复制两枚 JWT 密文；登出后保留最后一次有效副本。 */
export async function syncCredentials() {
  if (await readOptional(loginCredentialPath) !== null) return false;
  const raw = await readOptional(sourcePath);
  if (!raw) return false;
  let zcode;
  let maas;
  try {
    const records = JSON.parse(raw);
    const provider = decrypt(records['oauth:active_provider']);
    if (provider !== 'zai' && provider !== 'bigmodel') return false;
    zcode = records.zcodejwttoken;
    maas = records[`oauth:${provider}:access_token`];
    assertJwt(decrypt(zcode));
    assertJwt(decrypt(maas));
  } catch {
    return false; // 登出、登录写入中或损坏时不覆盖已保存的副本
  }

  const contents = JSON.stringify({ zcode, maas });
  if (await readOptional(savedPath) === contents) return true;
  await writePrivateFile(savedPath, contents);
  return true;
}

export async function saveLoginCredentials(provider, { jwt, maasJwt }) {
  if (provider !== 'zai' && provider !== 'bigmodel') throw new Error('未知登录平台');
  assertJwt(jwt);
  assertJwt(maasJwt);
  await writePrivateFile(loginCredentialPath, JSON.stringify({
    provider, zcode: encrypt(jwt), maas: encrypt(maasJwt),
  }));
}

export async function loadCredentials() {
  const login = await readOptional(loginCredentialPath);
  if (login === null) await syncCredentials();
  const records = JSON.parse(login ?? await readFile(savedPath, 'utf8'));
  const jwt = decrypt(records.zcode);
  const maasJwt = decrypt(records.maas);
  assertJwt(jwt);
  assertJwt(maasJwt);
  return { jwt, maasJwt };
}
