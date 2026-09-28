#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { serve } from './server.mjs';
import { login } from './login.mjs';
import { createNetworkFetch } from './network.mjs';

async function chooseProvider() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write('选择登录平台：\n  1) BigModel\n  2) Z.ai\n请输入 1 或 2：');
    for await (const line of rl) {
      const answer = line.trim().toLowerCase();
      if (answer === '1' || answer === 'bigmodel') return 'bigmodel';
      if (answer === '2' || answer === 'zai') return 'zai';
      process.stdout.write('请输入 1 或 2：');
    }
    throw new Error('未选择登录平台；请在终端运行登录命令，或明确指定 bigmodel/zai');
  } finally {
    rl.close();
  }
}

const args = process.argv.slice(2);
if (args.length === 0) {
  await serve();
} else if (args[0] === 'login' && (args.length === 1 || (args.length === 2 && ['zai', 'bigmodel'].includes(args[1])))) {
  let network;
  try {
    const provider = args[1] ?? await chooseProvider();
    process.stdout.write(`已选择 ${provider} 登录。\n`);
    network = createNetworkFetch();
    await login(provider, {
      fetchImpl: network.fetch,
      onUrl: (url) => process.stdout.write(`请在浏览器完成 ${provider} 授权（未自动打开时手动访问）：\n${url}\n`),
      openBrowser: async (url) => {
        const { default: open } = await import('open');
        await open(url);
      },
    });
    process.stdout.write('登录成功。此 MCP 服务现在会优先使用这次授权的凭据。\n');
  } catch (error) {
    process.stderr.write(`登录失败：${error.message}\n`);
    process.exitCode = 1;
  } finally {
    await network?.close();
  }
} else {
  process.stderr.write('用法：zcode-image-search-mcp [login [zai|bigmodel]]\n');
  process.exitCode = 2;
}
