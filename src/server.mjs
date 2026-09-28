import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { loadCredentials, syncCredentials } from './credentials.mjs';
import { searchImage } from './proxy.mjs';
import { createNetworkFetch } from './network.mjs';

const tool = {
  name: 'search_image',
  title: 'Search Image',
  description: 'Search the web for existing images matching a query. Results are not content-moderated.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      count: { type: 'integer' },
      gl: { type: 'string' },
      rank: { type: 'boolean' },
    },
    required: ['query', 'count', 'gl', 'rank'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      query: { type: 'string' },
      count: { type: 'integer' },
      ranked: { type: 'boolean' },
      results: {
        type: ['null', 'array'],
        items: {
          type: 'object',
          properties: {
            original_url: { type: 'string' },
            caption: { type: 'string' },
            source: { type: 'string' },
            original_width: { type: 'string' },
            original_height: { type: 'string' },
          },
          required: ['original_url', 'caption', 'source', 'original_width', 'original_height'],
          additionalProperties: false,
        },
      },
    },
    required: ['success', 'query', 'count', 'ranked', 'results'],
    additionalProperties: false,
  },
};

export async function serve() {
  // 连接时捕获登录态，避免用户在第一次搜索前登出。
  await syncCredentials().catch(() => {});
  const network = createNetworkFetch();
  const server = new Server({ name: 'zcode-image-search-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.onclose = () => { void network.close().catch(() => {}); };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool] }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name !== tool.name) throw new McpError(ErrorCode.InvalidParams, '未知工具');
    try {
      return await searchImage(params.arguments ?? {}, await loadCredentials(), network.fetch);
    } catch (error) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: error?.code === 'ENOENT'
            ? '未找到凭据：请在终端运行本程序 login zai 或 login bigmodel，或登录 ZCode 后重试。'
            : '官方搜图调用失败：请检查网络、套餐及凭据；若凭据失效，请重新运行登录命令。',
        }],
      };
    }
  });
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await network.close();
    throw error;
  }
}
