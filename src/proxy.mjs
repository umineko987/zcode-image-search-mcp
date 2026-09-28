import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const endpoint = new URL('https://zcode.z.ai/api/v1/mcp/server/image_search');

export async function searchImage(arguments_, { jwt, maasJwt }, fetchImpl = fetch) {
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${jwt}`,
        'X-Bigmodel-Authorization': `Bearer ${maasJwt}`,
      },
    },
    fetch: (resource, init) => {
      const target = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url;
      if (target !== endpoint.href) throw new Error('上游请求地址不正确');
      return fetchImpl(resource, { ...init, redirect: 'manual' });
    },
  });
  const client = new Client({ name: 'zcode-image-search-mcp', version: '0.1.0' });
  try {
    await client.connect(transport);
    return await client.callTool({ name: 'search_image', arguments: arguments_ }, undefined, { timeout: 90_000 });
  } finally {
    await client.close();
  }
}
