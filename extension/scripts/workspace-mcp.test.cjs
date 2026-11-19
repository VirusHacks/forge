const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { test } = require("node:test");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { WorkspaceMcpServer } = require("../out/src/workspaceMcp.js");

test("workspace MCP tools read and search safely over Streamable HTTP", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-mcp-test-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "forge-a-thon-extension" }));
  await fs.writeFile(path.join(root, "src", "helpers.py"), "def get_debug_flag():\n    return True\n");
  await fs.writeFile(path.join(root, ".env"), "FORGE_MCP_SENTINEL=do-not-read\n");
  const server = new WorkspaceMcpServer(0);
  let client;
  try {
    const endpoint = await server.start(root);
    client = new Client({ name: "forge-workspace-mcp-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    const file = await client.callTool({ name: "read_file", arguments: { path: "package.json" } });
    assert.ok(JSON.stringify(file).includes("forge-a-thon-extension"));
    const search = await client.callTool({ name: "search_repository", arguments: { query: "get_debug_flag" } });
    assert.ok(JSON.stringify(search).includes("src/helpers.py:1"));
    const traversal = await client.callTool({ name: "read_file", arguments: { path: "../README.md" } });
    assert.equal(traversal.isError, true);
    const secret = await client.callTool({ name: "read_file", arguments: { path: ".env" } });
    assert.equal(secret.isError, true);
    const secretSearch = await client.callTool({ name: "search_repository", arguments: { query: "FORGE_MCP_SENTINEL" } });
    assert.ok(!JSON.stringify(secretSearch).includes("FORGE_MCP_SENTINEL"));
    const range = await client.callTool({ name: "read_file", arguments: { path: "src/helpers.py", start_line: 2, end_line: 2 } });
    assert.equal(range.content[0].text, "    return True");
    await fs.symlink(path.join(root, ".env"), path.join(root, "alias.txt"));
    const alias = await client.callTool({ name: "read_file", arguments: { path: "alias.txt" } });
    assert.equal(alias.isError, true);
    assert.deepEqual(server.toolCounts, { read_file: 5, search_repository: 2 });
  } finally {
    if (client) await client.close();
    await server.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
