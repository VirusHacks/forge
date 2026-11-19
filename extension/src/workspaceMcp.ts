import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createServer, type Server as HttpServer } from "node:http";
import { realpath, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export type WorkspaceToolName = "read_file" | "search_repository";
export type WorkspaceToolCounts = Record<WorkspaceToolName, number>;

const MAX_READ_BYTES = 256 * 1024;
const MAX_SEARCH_FILES = 1000;
const MAX_SEARCH_MATCHES = 8;
const MAX_RESULT_CHARS = 1800;

export class WorkspaceMcpServer {
  private httpServer?: HttpServer;
  private rootPath?: string;
  private readonly counts: WorkspaceToolCounts = {
    read_file: 0,
    search_repository: 0,
  };

  constructor(
    private readonly port: number,
    private readonly buildServer?: () => McpServer,
    private readonly route = "/mcp",
  ) {}

  get toolCounts(): WorkspaceToolCounts {
    return { ...this.counts };
  }

  resetToolCounts(): void {
    this.counts.read_file = 0;
    this.counts.search_repository = 0;
  }

  async start(rootPath: string): Promise<string> {
    if (this.httpServer) throw new Error("Workspace MCP server is already running.");
    this.rootPath = await realpath(rootPath);
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.httpServer = server;
    const address = server.address();
    const boundPort = address && typeof address === "object" ? address.port : this.port;
    return `http://127.0.0.1:${boundPort}${this.route}`;
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async handleRequest(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    if (request.url?.split("?", 1)[0] !== this.route) {
      response.writeHead(404).end();
      return;
    }
    if (!this.rootPath || !["GET", "POST", "DELETE"].includes(request.method ?? "")) {
      response.writeHead(405, { Allow: "GET, POST, DELETE" }).end();
      return;
    }

    const mcp = this.buildServer?.() ?? this.createProtocolServer(this.rootPath);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "MCP request failed" }));
      }
      console.error("Forge workspace MCP request failed", safeErrorType(error));
    } finally {
      await mcp.close().catch(() => undefined);
    }
  }

  private createProtocolServer(rootPath: string): McpServer {
    const mcp = new McpServer({ name: "forge-workspace", version: "0.1.0" });
    mcp.registerTool(
      "read_file",
      {
        title: "Read workspace file",
        description: "Read a short excerpt of a workspace file. Set start_line and end_line (1-based, inclusive) to the selected range.",
        inputSchema: {
          path: z.string().min(1).max(1000),
          start_line: z.number().int().positive().optional(),
          end_line: z.number().int().positive().optional(),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async ({ path: relativePath, start_line = 1, end_line }) => {
        this.counts.read_file += 1;
        if (isSensitivePath(relativePath)) throw new Error("Credential-like files are not available through the MCP reader.");
        const absolutePath = await this.resolveWorkspaceFile(rootPath, relativePath);
        const fileStat = await stat(absolutePath);
        if (fileStat.size > MAX_READ_BYTES) throw new Error("File exceeds the 256 KiB read limit.");
        const data = await readFile(absolutePath);
        if (data.includes(0)) throw new Error("Binary files cannot be read through this tool.");
        return {
          content: [{ type: "text", text: excerpt(data.toString("utf8"), start_line, end_line) }],
        };
      },
    );

    mcp.registerTool(
      "search_repository",
      {
        title: "Search workspace",
        description: "Search text files in the current VS Code workspace. Read only.",
        inputSchema: {
          query: z.string().min(1).max(300),
          case_sensitive: z.boolean().optional(),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async ({ query, case_sensitive }) => {
        this.counts.search_repository += 1;
        const files = await collectWorkspaceFiles(rootPath, MAX_SEARCH_FILES);
        const needle = case_sensitive ? query : query.toLocaleLowerCase();
        const matches: string[] = [];
        for (const filePath of files) {
          if (matches.length >= MAX_SEARCH_MATCHES) break;
          const relativePath = path.relative(rootPath, filePath);
          if (isSensitivePath(relativePath)) continue;
          try {
            const absolutePath = await this.resolveWorkspaceFile(rootPath, relativePath);
            const fileStat = await stat(absolutePath);
            if (fileStat.size > MAX_READ_BYTES) continue;
            const data = await readFile(absolutePath);
            if (data.includes(0)) continue;
            const lines = data.toString("utf8").split(/\r?\n/);
            for (let index = 0; index < lines.length && matches.length < MAX_SEARCH_MATCHES; index += 1) {
              const haystack = case_sensitive ? lines[index] : lines[index].toLocaleLowerCase();
              if (haystack.includes(needle)) {
                matches.push(`${path.relative(rootPath, absolutePath)}:${index + 1}: ${lines[index].trim()}`);
              }
            }
          } catch {
            // Files that disappear or become unreadable during a search are skipped.
          }
        }
        return {
          content: [{
            type: "text",
            text: matches.length ? matches.join("\n").slice(0, MAX_RESULT_CHARS) : `No matches found in the first ${files.length} workspace files.`,
          }],
        };
      },
    );
    return mcp;
  }

  private async resolveWorkspaceFile(rootPath: string, relativePath: string): Promise<string> {
    if (path.isAbsolute(relativePath)) throw new Error("Use a workspace-relative path.");
    const candidate = path.resolve(rootPath, relativePath);
    const relative = path.relative(rootPath, candidate);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Path must point to a file inside the workspace.");
    }
    const actualPath = await realpath(candidate);
    const actualRelative = path.relative(rootPath, actualPath);
    if (actualRelative === ".." || actualRelative.startsWith(`..${path.sep}`) || path.isAbsolute(actualRelative)) {
      throw new Error("Symlink resolves outside the workspace.");
    }
    if (isSensitivePath(actualRelative)) throw new Error("Restricted workspace file.");
    if (!(await stat(actualPath)).isFile()) throw new Error("Expected a regular file.");
    return actualPath;
  }
}

async function collectWorkspaceFiles(root: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  const skippedDirectories = new Set([".git", ".aws", ".ssh", "node_modules", ".venv", "venv", "dist", "build"]);
  const pending = [root];
  while (pending.length > 0 && files.length < limit) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name)) pending.push(childPath);
      } else if (entry.isFile()) {
        files.push(childPath);
        if (files.length >= limit) break;
      }
    }
  }
  return files;
}

function safeErrorType(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

export function isSensitivePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").toLocaleLowerCase();
  const name = path.posix.basename(normalized);
  return (
    normalized.split("/").some((segment) => [".git", ".aws", ".ssh", "secrets", "credentials"].includes(segment)) ||
    (name.startsWith(".env") && !name.endsWith(".example")) ||
    [".pem", ".key", ".p12", ".pfx"].some((extension) => name.endsWith(extension))
  );
}

function excerpt(text: string, start: number, end = start + 39): string {
  const lines = text.split(/\r?\n/);
  if (end < start || start > lines.length) throw new Error("Invalid line range.");
  const last = Math.min(end, start + 39, lines.length);
  const block = lines.slice(start - 1, last).join("\n");
  return block.length > MAX_RESULT_CHARS ? block.slice(0, MAX_RESULT_CHARS) + "\n[excerpt truncated]" : block;
}
