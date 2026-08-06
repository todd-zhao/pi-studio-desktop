declare module "pi-mcp-adapter/types" {
  export interface McpConfig {
    mcpServers: Record<string, unknown>;
    settings?: Record<string, unknown>;
  }
}

declare module "pi-mcp-adapter" {
  import type { McpConfig } from "pi-mcp-adapter/types";

  export const MCP_STATUS_EVENT: string;
  export function createMcpAdapter(options: { config: McpConfig }): (host: unknown) => void;
}
