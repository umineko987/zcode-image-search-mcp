# ZCode Image Search MCP

在 Claude Code、Codex 或 Pi 中调用 ZCode 的 `search_image`：搜索**现有图片**，不生成图片。服务通过本地 stdio 运行，请求转发到 ZCode 搜图接口。

## 使用前

需要 Node.js ≥ 20，以及可使用搜图服务的 Z.ai 或 BigModel 账号。Pi 本身需要 Node.js ≥ 22.19。

在**运行客户端的同一台机器、同一用户环境**下完成以下任一项：

- 已登录 ZCode：服务启动时会尝试读取并同步本地登录凭据；或
- 在终端单独登录（将 `zai` 换成 `bigmodel` 可使用 BigModel）：

```bash
npx -y @umineko987/zcode-image-search-mcp@latest login zai
```

## 接入客户端

### Claude Code

```bash
claude mcp add zcode-image-search -- npx -y @umineko987/zcode-image-search-mcp@latest
```

默认仅对当前项目生效；如果希望所有项目可用，在 `zcode-image-search` 前加 `--scope user`。

### Codex

```bash
codex mcp add zcode-image-search -- npx -y @umineko987/zcode-image-search-mcp@latest
```

### Pi

Pi 需要先安装第三方 [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter)：

```bash
pi install npm:pi-mcp-adapter
```

重启 Pi，并在 `~/.config/mcp/mcp.json` 中加入以下配置（如已有配置，将 `zcode-image-search` 合并到现有 `mcpServers`）：

```json
{
  "mcpServers": {
    "zcode-image-search": {
      "command": "npx",
      "args": ["-y", "@umineko987/zcode-image-search-mcp@latest"]
    }
  }
}
```

在 Pi 中运行 `/mcp` 可查看连接状态。

## 使用

让客户端调用 `search_image`，传入 `query`（关键词）、`count`（数量）、`gl`（地区代码，如 `us`）、`rank`（是否排序）；这四项均为必填。示例：“用 `search_image` 搜索布偶猫图片，`count=3`、`gl=us`、`rank=true`。”
