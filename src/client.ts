import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import * as fs from "fs";
import * as path from "path";
import debug from "debug";
import { loadMcpTools } from "./tools.js";

// Read package name from package.json
let debugLog: debug.Debugger;
function getDebugLog() {
  if (!debugLog) {
    debugLog = debug("@langchain/mcp-adapters:client");
  }
  return debugLog;
}

/**
 * Configuration for stdio transport connection
 */
export interface StdioConnection {
  transport: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  encoding?: string;
  encodingErrorHandler?: "strict" | "ignore" | "replace";
  /**
   * Additional restart settings
   */
  restart?: {
    /**
     * Whether to automatically restart the process if it exits
     */
    enabled?: boolean;
    /**
     * Maximum number of restart attempts
     */
    maxAttempts?: number;
    /**
     * Delay in milliseconds between restart attempts
     */
    delayMs?: number;
  };
}

/**
 * Configuration for SSE transport connection
 */
export interface SSEConnection {
  transport: "sse";
  url: string;
  headers?: Record<string, string>;
  useNodeEventSource?: boolean;
  /**
   * Additional reconnection settings
   */
  reconnect?: {
    /**
     * Whether to automatically reconnect if the connection is lost
     */
    enabled?: boolean;
    /**
     * Maximum number of reconnection attempts
     */
    maxAttempts?: number;
    /**
     * Delay in milliseconds between reconnection attempts
     */
    delayMs?: number;
  };
}

/**
 * Union type for all transport connection types
 */
export type Connection = StdioConnection | SSEConnection;

/**
 * MCP configuration file format
 */
export interface MCPConfig {
  servers: Record<string, Connection>;
}

/**
 * Error class for MCP client operations
 */
export class MCPClientError extends Error {
  constructor(message: string, public readonly serverName?: string) {
    super(message);
    this.name = "MCPClientError";
  }
}

/**
 * Client for connecting to multiple MCP servers and loading LangChain-compatible tools.
 */
export class MultiServerMCPClient {
  private clients: Map<string, Client> = new Map();

  private serverNameToTools: Map<string, StructuredToolInterface[]> = new Map();

  private connections?: Record<string, Connection>;

  private cleanupFunctions: Array<() => Promise<void>> = [];

  private transportInstances: Map<
    string,
    StdioClientTransport | SSEClientTransport
  > = new Map();

  /**
   * Create a new MultiServerMCPClient.
   *
   * @param connections - Optional connections to initialize
   */
  constructor(connections?: Record<string, Connection>) {
    if (connections) {
      this.connections = MultiServerMCPClient.processConnections(connections);
    } else {
      // Try to load from default mcp.json if no connections are provided
      this.connections = MultiServerMCPClient.tryLoadDefaultConfig();
    }
  }

  /**
   * Try to load the default configuration file (mcp.json) from the root directory
   */
  private static tryLoadDefaultConfig():
    | Record<string, Connection>
    | undefined {
    const defaultConfigPath = path.join(process.cwd(), "mcp.json");
    if (fs.existsSync(defaultConfigPath)) {
      getDebugLog()(
        `INFO: Found default configuration at ${defaultConfigPath}, loading automatically`
      );
      const config = MultiServerMCPClient.loadConfigFromFile(defaultConfigPath);
      return MultiServerMCPClient.processConnections(config.servers);
    } else {
      getDebugLog()(`INFO: No default mcp.json found in root directory`);
      // don't throw if there's no default config to load
      return undefined;
    }
  }

  /**
   * Load a configuration from a file
   *
   * @param configPath - Path to the configuration file
   * @returns The parsed configuration
   */
  private static loadConfigFromFile(configPath: string): MCPConfig {
    const configData = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(configData);

    // Validate that config has a servers property
    if (!config || typeof config !== "object" || !("servers" in config)) {
      getDebugLog()(
        `ERROR: Invalid MCP configuration from ${configPath}: missing 'servers' property`
      );
      throw new MCPClientError(
        `Invalid MCP configuration: missing 'servers' property`
      );
    }

    // Process environment variables in the configuration
    MultiServerMCPClient.processEnvVarsInConfig(
      Object.fromEntries(
        Object.entries(
          config.servers as Record<string, StdioConnection>
        ).filter(([_, value]) => value.transport === "stdio")
      )
    );

    return config;
  }

  /**
   * Process environment variables in configuration
   * Replaces ${ENV_VAR} with the actual environment variable value
   *
   * @param servers - The servers configuration object
   */
  private static processEnvVarsInConfig(
    servers: Record<string, StdioConnection>
  ): void {
    for (const [serverName, config] of Object.entries(servers)) {
      if (typeof config !== "object" || config === null) continue;

      // Process env object if it exists
      if (config.env && typeof config.env === "object") {
        for (const [key, value] of Object.entries(config.env)) {
          if (
            typeof value === "string" &&
            value.startsWith("${") &&
            value.endsWith("}")
          ) {
            const envVar = value.slice(2, -1);
            const envValue = process.env[envVar];
            if (envValue) {
              config.env[key] = envValue;
            } else {
              getDebugLog()(
                `WARN: Environment variable ${envVar} not found for server "${serverName}"`
              );
            }
          }
        }
      }

      // Process any other string properties recursively
      MultiServerMCPClient.processEnvVarsRecursively(config);
    }
  }

  /**
   * Process environment variables recursively in an object
   *
   * @param obj - The object to process
   */
  private static processEnvVarsRecursively<T extends object>(obj: T): void {
    if (typeof obj !== "object" || obj === null) return;

    for (const [key, value] of Object.entries(obj)) {
      if (
        typeof value === "string" &&
        value.startsWith("${") &&
        value.endsWith("}")
      ) {
        const envVar = value.slice(2, -1);
        const envValue = process.env[envVar];
        if (envValue) {
          // eslint-disable-next-line no-param-reassign
          obj[key as keyof T] = envValue as T[keyof T];
        }
      } else if (typeof value === "object" && value !== null && key !== "env") {
        // Skip env object as it's handled separately
        MultiServerMCPClient.processEnvVarsRecursively(value);
      }
    }
  }

  /**
   * Process connection configurations
   *
   * @param connections - Raw connection configurations
   * @returns Processed connection configurations
   */
  private static processConnections(
    connections: Record<string, Partial<Connection>>
  ): Record<string, Connection> {
    const processedConnections: Record<string, Connection> = {};

    for (const [serverName, config] of Object.entries(connections)) {
      if (typeof config !== "object" || config === null) {
        getDebugLog()(
          `WARN: Invalid configuration for server "${serverName}". Skipping.`
        );
        continue;
      }

      // Determine the connection type and process accordingly
      if (MultiServerMCPClient.isStdioConnection(config)) {
        processedConnections[serverName] =
          MultiServerMCPClient.processStdioConfig(serverName, config);
      } else if (MultiServerMCPClient.isSSEConnection(config)) {
        processedConnections[serverName] =
          MultiServerMCPClient.processSSEConfig(serverName, config);
      } else {
        throw new MCPClientError(
          `Server "${serverName}" has invalid or unsupported configuration. Skipping.`
        );
      }
    }

    return processedConnections;
  }

  /**
   * Check if a configuration is for a stdio connection
   */
  private static isStdioConnection(config: unknown): config is StdioConnection {
    // When transport is missing, default to stdio if it has command and args
    // OR when transport is explicitly set to 'stdio'
    return (
      typeof config === "object" &&
      config !== null &&
      (!("transport" in config) || config.transport === "stdio") &&
      "command" in config &&
      (!("args" in config) || Array.isArray(config.args))
    );
  }

  /**
   * Check if a configuration is for an SSE connection
   */
  private static isSSEConnection(config: unknown): config is SSEConnection {
    // Only consider it an SSE connection if transport is explicitly set to 'sse'
    return (
      typeof config === "object" &&
      config !== null &&
      "transport" in config &&
      config.transport === "sse" &&
      "url" in config &&
      typeof config.url === "string"
    );
  }

  /**
   * Process stdio connection configuration
   */
  private static processStdioConfig(
    serverName: string,
    config: Partial<StdioConnection>
  ): StdioConnection {
    if (!config.command || typeof config.command !== "string") {
      throw new MCPClientError(
        `Missing or invalid command for server "${serverName}"`
      );
    }

    if (config.args !== undefined && !Array.isArray(config.args)) {
      throw new MCPClientError(
        `Invalid args for server "${serverName} - must be an array of strings`
      );
    }

    if (
      config.args !== undefined &&
      !config.args.every((arg) => typeof arg === "string")
    ) {
      throw new MCPClientError(
        `Invalid args for server "${serverName} - must be an array of strings`
      );
    }

    // Always set transport to 'stdio' regardless of whether it was in the original config
    const stdioConfig: StdioConnection = {
      transport: "stdio",
      command: config.command,
      args: config.args ?? [],
    };

    if (config.env && typeof config.env !== "object") {
      throw new MCPClientError(
        `Invalid env for server "${serverName} - must be an object of key-value pairs`
      );
    }

    if (
      config.env &&
      typeof config.env === "object" &&
      Array.isArray(config.env)
    ) {
      throw new MCPClientError(
        `Invalid env for server "${serverName} - must be an object of key-value pairs`
      );
    }

    if (
      config.env &&
      typeof config.env === "object" &&
      !Object.values(config.env).every((value) => typeof value === "string")
    ) {
      throw new MCPClientError(
        `Invalid env for server "${serverName} - must be an object of key-value pairs with string values`
      );
    }

    // Add optional properties if they exist
    if (config.env && typeof config.env === "object") {
      stdioConfig.env = config.env;
    }

    if (config.encoding !== undefined && typeof config.encoding !== "string") {
      throw new MCPClientError(
        `Invalid encoding for server "${serverName} - must be a string`
      );
    }

    if (typeof config.encoding === "string") {
      stdioConfig.encoding = config.encoding;
    }

    if (
      config.encodingErrorHandler !== undefined &&
      !["strict", "ignore", "replace"].includes(config.encodingErrorHandler)
    ) {
      throw new MCPClientError(
        `Invalid encodingErrorHandler for server "${serverName} - must be one of: strict, ignore, replace`
      );
    }

    if (
      ["strict", "ignore", "replace"].includes(
        config.encodingErrorHandler ?? ""
      )
    ) {
      stdioConfig.encodingErrorHandler = config.encodingErrorHandler as
        | "strict"
        | "ignore"
        | "replace";
    }

    // Add restart configuration if present
    if (config.restart && typeof config.restart !== "object") {
      throw new MCPClientError(
        `Invalid restart for server "${serverName} - must be an object`
      );
    }

    if (config.restart && typeof config.restart === "object") {
      if (
        config.restart.enabled !== undefined &&
        typeof config.restart.enabled !== "boolean"
      ) {
        throw new MCPClientError(
          `Invalid restart.enabled for server "${serverName} - must be a boolean`
        );
      }

      stdioConfig.restart = {
        enabled: Boolean(config.restart.enabled),
      };

      if (
        config.restart.maxAttempts !== undefined &&
        typeof config.restart.maxAttempts !== "number"
      ) {
        throw new MCPClientError(
          `Invalid restart.maxAttempts for server "${serverName} - must be a number`
        );
      }

      if (typeof config.restart.maxAttempts === "number") {
        stdioConfig.restart.maxAttempts = config.restart.maxAttempts;
      }

      if (
        config.restart.delayMs !== undefined &&
        typeof config.restart.delayMs !== "number"
      ) {
        throw new MCPClientError(
          `Invalid restart.delayMs for server "${serverName} - must be a number`
        );
      }

      if (typeof config.restart.delayMs === "number") {
        stdioConfig.restart.delayMs = config.restart.delayMs;
      }
    }

    return stdioConfig;
  }

  /**
   * Process SSE connection configuration
   */
  private static processSSEConfig(
    serverName: string,
    config: SSEConnection
  ): SSEConnection {
    if (!config.url || typeof config.url !== "string") {
      throw new MCPClientError(
        `Missing or invalid url for server "${serverName}"`
      );
    }

    try {
      const url = new URL(config.url);
      if (!url.protocol.startsWith("http")) {
        throw new MCPClientError(
          `Invalid url for server "${serverName} - must be a valid HTTP or HTTPS URL`
        );
      }
    } catch {
      throw new MCPClientError(
        `Invalid url for server "${serverName} - must be a valid URL`
      );
    }

    if (!config.transport || config.transport !== "sse") {
      throw new MCPClientError(
        `Invalid transport for server "${serverName} - must be 'sse'`
      );
    }

    const sseConfig: SSEConnection = {
      transport: "sse",
      url: config.url,
    };

    if (config.headers && typeof config.headers !== "object") {
      throw new MCPClientError(
        `Invalid headers for server "${serverName} - must be an object`
      );
    }

    if (
      config.headers &&
      typeof config.headers === "object" &&
      Array.isArray(config.headers)
    ) {
      throw new MCPClientError(
        `Invalid headers for server "${serverName} - must be an object of key-value pairs`
      );
    }

    if (
      config.headers &&
      typeof config.headers === "object" &&
      !Object.values(config.headers).every((value) => typeof value === "string")
    ) {
      throw new MCPClientError(
        `Invalid headers for server "${serverName} - must be an object of key-value pairs with string values`
      );
    }

    // Add optional headers if they exist
    if (config.headers && typeof config.headers === "object") {
      sseConfig.headers = config.headers;
    }

    if (
      config.useNodeEventSource !== undefined &&
      typeof config.useNodeEventSource !== "boolean"
    ) {
      throw new MCPClientError(
        `Invalid useNodeEventSource for server "${serverName} - must be a boolean`
      );
    }

    // Add optional useNodeEventSource flag if it exists
    if (typeof config.useNodeEventSource === "boolean") {
      sseConfig.useNodeEventSource = config.useNodeEventSource;
    }

    if (config.reconnect && typeof config.reconnect !== "object") {
      throw new MCPClientError(
        `Invalid reconnect for server "${serverName} - must be an object`
      );
    }

    // Add reconnection configuration if present
    if (config.reconnect && typeof config.reconnect === "object") {
      if (
        config.reconnect.enabled !== undefined &&
        typeof config.reconnect.enabled !== "boolean"
      ) {
        throw new MCPClientError(
          `Invalid reconnect.enabled for server "${serverName} - must be a boolean`
        );
      }

      sseConfig.reconnect = {
        enabled: Boolean(config.reconnect.enabled),
      };

      if (
        config.reconnect.maxAttempts !== undefined &&
        typeof config.reconnect.maxAttempts !== "number"
      ) {
        throw new MCPClientError(
          `Invalid reconnect.maxAttempts for server "${serverName} - must be a number`
        );
      }

      if (typeof config.reconnect.maxAttempts === "number") {
        sseConfig.reconnect.maxAttempts = config.reconnect.maxAttempts;
      }

      if (
        config.reconnect.delayMs !== undefined &&
        typeof config.reconnect.delayMs !== "number"
      ) {
        throw new MCPClientError(
          `Invalid reconnect.delayMs for server "${serverName} - must be a number`
        );
      }

      if (typeof config.reconnect.delayMs === "number") {
        sseConfig.reconnect.delayMs = config.reconnect.delayMs;
      }
    }

    return sseConfig;
  }

  /**
   * Load a configuration from a JSON file.
   *
   * @param configPath - Path to the configuration file
   * @returns A new MultiServerMCPClient
   * @throws {MCPClientError} If the configuration file cannot be loaded or parsed
   */
  static fromConfigFile(configPath: string): MultiServerMCPClient {
    try {
      const client = new MultiServerMCPClient();
      const config = MultiServerMCPClient.loadConfigFromFile(configPath);

      // Merge with existing connections if any
      if (client.connections) {
        client.connections = {
          ...client.connections,
          ...MultiServerMCPClient.processConnections(config.servers),
        };
      } else {
        client.connections = MultiServerMCPClient.processConnections(
          config.servers
        );
      }

      getDebugLog()(`INFO: Loaded MCP configuration from ${configPath}`);
      return client;
    } catch (error) {
      getDebugLog()(
        `ERROR: Failed to load MCP configuration from ${configPath}: ${error}`
      );
      throw new MCPClientError(`Failed to load MCP configuration: ${error}`);
    }
  }

  /**
   * Initialize connections to all servers.
   *
   * @returns A map of server names to arrays of tools
   * @throws {MCPClientError} If initialization fails
   */
  async initializeConnections(): Promise<
    Map<string, StructuredToolInterface[]>
  > {
    if (!this.connections || Object.keys(this.connections).length === 0) {
      getDebugLog()(`WARN: No connections to initialize`);
      return new Map();
    }

    for (const [serverName, connection] of Object.entries(this.connections)) {
      getDebugLog()(
        `INFO: Initializing connection to server "${serverName}"...`
      );

      if (connection.transport === "stdio") {
        await this.initializeStdioConnection(serverName, connection);
      } else if (connection.transport === "sse") {
        await this.initializeSSEConnection(serverName, connection);
      } else {
        // This should never happen due to the validation in the constructor
        throw new MCPClientError(
          `Unsupported transport type for server "${serverName}"`,
          serverName
        );
      }
    }

    return this.serverNameToTools;
  }

  /**
   * Initialize a stdio connection
   */
  private async initializeStdioConnection(
    serverName: string,
    connection: StdioConnection
  ): Promise<void> {
    const { command, args, env, restart } = connection;

    getDebugLog()(
      `DEBUG: Creating stdio transport for server "${serverName}" with command: ${command} ${args.join(
        " "
      )}`
    );

    const transport = new StdioClientTransport({
      command,
      args,
      env,
    });

    this.transportInstances.set(serverName, transport);

    const client = new Client({
      name: "langchain-mcp-adapter",
      version: "0.1.0",
    });

    try {
      await client.connect(transport);

      // Set up auto-restart if configured
      if (restart?.enabled) {
        this.setupStdioRestart(serverName, transport, connection, restart);
      }
    } catch (error) {
      throw new MCPClientError(
        `Failed to connect to stdio server "${serverName}": ${error}`,
        serverName
      );
    }

    this.clients.set(serverName, client);

    const cleanup = async () => {
      getDebugLog()(
        `DEBUG: Closing stdio transport for server "${serverName}"`
      );
      await transport.close();
    };

    this.cleanupFunctions.push(cleanup);

    // Load tools for this server
    await this.loadToolsForServer(serverName, client);
  }

  /**
   * Set up stdio restart handling
   */
  private setupStdioRestart(
    serverName: string,
    transport: StdioClientTransport,
    connection: StdioConnection,
    restart: NonNullable<StdioConnection["restart"]>
  ): void {
    const originalOnClose = transport.onclose;
    // eslint-disable-next-line no-param-reassign, @typescript-eslint/no-misused-promises
    transport.onclose = async () => {
      if (originalOnClose) {
        await originalOnClose();
      }

      // Only attempt restart if we haven't cleaned up
      if (this.clients.has(serverName)) {
        getDebugLog()(
          `INFO: Process for server "${serverName}" exited, attempting to restart...`
        );
        await this.attemptReconnect(
          serverName,
          connection,
          restart.maxAttempts,
          restart.delayMs
        );
      }
    };
  }

  /**
   * Initialize an SSE connection
   */
  private async initializeSSEConnection(
    serverName: string,
    connection: SSEConnection
  ): Promise<void> {
    const { url, headers, useNodeEventSource, reconnect } = connection;

    getDebugLog()(
      `DEBUG: Creating SSE transport for server "${serverName}" with URL: ${url}`
    );

    try {
      const transport = await this.createSSETransport(
        serverName,
        url,
        headers,
        useNodeEventSource
      );
      this.transportInstances.set(serverName, transport);

      const client = new Client({
        name: "langchain-mcp-adapter",
        version: "0.1.0",
      });

      try {
        await client.connect(transport);

        // Set up auto-reconnect if configured
        if (reconnect?.enabled) {
          this.setupSSEReconnect(serverName, transport, connection, reconnect);
        }
      } catch (error) {
        throw new MCPClientError(
          `Failed to connect to SSE server "${serverName}": ${error}`,
          serverName
        );
      }

      this.clients.set(serverName, client);

      const cleanup = async () => {
        getDebugLog()(
          `DEBUG: Closing SSE transport for server "${serverName}"`
        );
        await transport.close();
      };

      this.cleanupFunctions.push(cleanup);

      // Load tools for this server
      await this.loadToolsForServer(serverName, client);
    } catch (error) {
      throw new MCPClientError(
        `Failed to create SSE transport for server "${serverName}": ${error}`,
        serverName
      );
    }
  }

  /**
   * Create an SSE transport with appropriate EventSource implementation
   */
  private async createSSETransport(
    serverName: string,
    url: string,
    headers?: Record<string, string>,
    useNodeEventSource?: boolean
  ): Promise<SSEClientTransport> {
    if (!headers) {
      // Simple case - no headers, use default transport
      return new SSEClientTransport(new URL(url));
    }

    getDebugLog()(
      `DEBUG: Using custom headers for SSE transport to server "${serverName}"`
    );

    // If useNodeEventSource is true, try Node.js implementations
    if (useNodeEventSource) {
      return await this.createNodeEventSourceTransport(
        serverName,
        url,
        headers
      );
    }

    // For browser environments, use the basic requestInit approach
    getDebugLog()(
      `DEBUG: Using browser EventSource for server "${serverName}". Headers may not be applied correctly.`
    );
    getDebugLog()(
      `DEBUG: For better headers support in browsers, consider using a custom SSE implementation.`
    );

    return new SSEClientTransport(new URL(url), {
      requestInit: { headers },
    });
  }

  /**
   * Create an EventSource transport for Node.js environments
   */
  private async createNodeEventSourceTransport(
    serverName: string,
    url: string,
    headers: Record<string, string>
  ): Promise<SSEClientTransport> {
    // First try to use extended-eventsource which has better headers support
    try {
      const ExtendedEventSourceModule = await import("extended-eventsource");
      const ExtendedEventSource = ExtendedEventSourceModule.EventSource;

      getDebugLog()(
        `DEBUG: Using Extended EventSource for server "${serverName}"`
      );
      getDebugLog()(
        `DEBUG: Setting headers for Extended EventSource: ${JSON.stringify(
          headers
        )}`
      );

      // Override the global EventSource with the extended implementation
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).EventSource = ExtendedEventSource;

      // For Extended EventSource, create the SSE transport
      return new SSEClientTransport(new URL(url), {
        // Pass empty options for test compatibility
        eventSourceInit: {},
        requestInit: {},
      });
    } catch (extendedError) {
      // Fall back to standard eventsource if extended-eventsource is not available
      getDebugLog()(
        `DEBUG: Extended EventSource not available, falling back to standard EventSource: ${extendedError}`
      );

      try {
        // Dynamically import the eventsource package
        // eslint-disable-next-line import/no-extraneous-dependencies
        const EventSourceModule = await import("eventsource");
        const EventSource =
          "default" in EventSourceModule
            ? EventSourceModule.default
            : EventSourceModule.EventSource;

        getDebugLog()(
          `DEBUG: Using Node.js EventSource for server "${serverName}"`
        );
        getDebugLog()(
          `DEBUG: Setting headers for EventSource: ${JSON.stringify(headers)}`
        );

        // Override the global EventSource with the Node.js implementation
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).EventSource = EventSource;

        // Create transport with headers correctly configured for Node.js EventSource
        return new SSEClientTransport(new URL(url), {
          // Pass the headers to both eventSourceInit and requestInit for compatibility
          requestInit: { headers },
        });
      } catch (nodeError) {
        getDebugLog()(
          `WARN: Failed to load EventSource packages for server "${serverName}". Headers may not be applied to SSE connection: ${nodeError}`
        );

        // Last resort fallback
        return new SSEClientTransport(new URL(url), {
          requestInit: { headers },
        });
      }
    }
  }

  /**
   * Set up SSE reconnect handling
   */
  private setupSSEReconnect(
    serverName: string,
    transport: SSEClientTransport,
    connection: SSEConnection,
    reconnect: NonNullable<SSEConnection["reconnect"]>
  ): void {
    const originalOnClose = transport.onclose;
    // eslint-disable-next-line @typescript-eslint/no-misused-promises, no-param-reassign
    transport.onclose = async () => {
      if (originalOnClose) {
        await originalOnClose();
      }

      // Only attempt reconnect if we haven't cleaned up
      if (this.clients.has(serverName)) {
        getDebugLog()(
          `INFO: SSE connection for server "${serverName}" closed, attempting to reconnect...`
        );
        await this.attemptReconnect(
          serverName,
          connection,
          reconnect.maxAttempts,
          reconnect.delayMs
        );
      }
    };
  }

  /**
   * Load tools for a specific server
   */
  private async loadToolsForServer(
    serverName: string,
    client: Client
  ): Promise<void> {
    try {
      getDebugLog()(`DEBUG: Loading tools for server "${serverName}"...`);
      const tools = await loadMcpTools(serverName, client);
      this.serverNameToTools.set(serverName, tools);
      getDebugLog()(
        `INFO: Successfully loaded ${tools.length} tools from server "${serverName}"`
      );
    } catch (error) {
      throw new MCPClientError(
        `Failed to load tools from server "${serverName}": ${error}`
      );
    }
  }

  /**
   * Attempt to reconnect to a server after a connection failure.
   *
   * @param serverName - The name of the server to reconnect to
   * @param connection - The connection configuration
   * @param maxAttempts - Maximum number of reconnection attempts
   * @param delayMs - Delay in milliseconds between reconnection attempts
   * @private
   */
  private async attemptReconnect(
    serverName: string,
    connection: Connection,
    maxAttempts = 3,
    delayMs = 1000
  ): Promise<void> {
    let connected = false;
    let attempts = 0;

    // Clean up previous connection resources
    this.cleanupServerResources(serverName);

    while (
      !connected &&
      (maxAttempts === undefined || attempts < maxAttempts)
    ) {
      attempts += 1;
      getDebugLog()(
        `INFO: Reconnection attempt ${attempts}${
          maxAttempts ? `/${maxAttempts}` : ""
        } for server "${serverName}"`
      );

      try {
        // Wait before attempting to reconnect
        if (delayMs) {
          await new Promise((resolve) => {
            setTimeout(resolve, delayMs);
          });
        }

        // Initialize just this connection based on its type
        if (connection.transport === "stdio") {
          await this.initializeStdioConnection(serverName, connection);
        } else if (connection.transport === "sse") {
          await this.initializeSSEConnection(serverName, connection);
        }

        // Check if connected
        if (this.clients.has(serverName)) {
          connected = true;
          getDebugLog()(
            `INFO: Successfully reconnected to server "${serverName}"`
          );
        }
      } catch (error) {
        getDebugLog()(
          `ERROR: Failed to reconnect to server "${serverName}" (attempt ${attempts}): ${error}`
        );
      }
    }

    if (!connected) {
      getDebugLog()(
        `ERROR: Failed to reconnect to server "${serverName}" after ${attempts} attempts`
      );
    }
  }

  /**
   * Clean up resources for a specific server
   */
  private cleanupServerResources(serverName: string): void {
    this.clients.delete(serverName);
    this.serverNameToTools.delete(serverName);
    this.transportInstances.delete(serverName);
  }

  /**
   * Get tools from specified servers as a flattened array.
   *
   * @param servers - Optional array of server names to filter tools by.
   *                 If not provided, returns tools from all servers.
   * @returns A flattened array of tools from the specified servers (or all servers)
   */
  getTools(servers?: string[]): StructuredToolInterface[] {
    if (!servers || servers.length === 0) {
      return this.getAllToolsAsFlatArray();
    }
    return this.getToolsFromServers(servers);
  }

  /**
   * Get all tools from all servers as a flat array.
   *
   * @returns A flattened array of all tools
   */
  private getAllToolsAsFlatArray(): StructuredToolInterface[] {
    const allTools: StructuredToolInterface[] = [];
    for (const tools of this.serverNameToTools.values()) {
      allTools.push(...tools);
    }
    return allTools;
  }

  /**
   * Get tools from specific servers as a flat array.
   *
   * @param serverNames - Names of servers to get tools from
   * @returns A flattened array of tools from the specified servers
   */
  private getToolsFromServers(
    serverNames: string[]
  ): StructuredToolInterface[] {
    const allTools: StructuredToolInterface[] = [];
    for (const serverName of serverNames) {
      const tools = this.serverNameToTools.get(serverName);
      if (tools) {
        allTools.push(...tools);
      }
    }
    return allTools;
  }

  /**
   * Get a client for a specific server.
   *
   * @param serverName - The name of the server
   * @returns The client for the server, or undefined if the server is not connected
   */
  getClient(serverName: string): Client | undefined {
    return this.clients.get(serverName);
  }

  /**
   * Close all connections.
   */
  async close(): Promise<void> {
    getDebugLog()(`INFO: Closing all MCP connections...`);

    for (const cleanup of this.cleanupFunctions) {
      try {
        await cleanup();
      } catch (error) {
        getDebugLog()(`ERROR: Error during cleanup: ${error}`);
      }
    }

    this.cleanupFunctions = [];
    this.clients.clear();
    this.serverNameToTools.clear();
    this.transportInstances.clear();

    getDebugLog()(`INFO: All MCP connections closed`);
  }

  /**
   * Connect to an MCP server via stdio transport.
   *
   * @param serverName - A name to identify this server
   * @param command - The command to run
   * @param args - Arguments for the command
   * @param env - Optional environment variables
   * @param restart - Optional restart configuration
   * @returns A map of server names to arrays of tools
   */
  async connectToServerViaStdio(
    serverName: string,
    command: string,
    args: string[],
    env?: Record<string, string>,
    restart?: StdioConnection["restart"]
  ): Promise<Map<string, StructuredToolInterface[]>> {
    const connections: Record<string, Connection> = {
      [serverName]: {
        transport: "stdio",
        command,
        args,
        env,
        restart,
      },
    };

    this.connections = connections;
    return this.initializeConnections();
  }

  /**
   * Connect to an MCP server via SSE transport.
   *
   * @param serverName - A name to identify this server
   * @param url - The URL of the SSE server
   * @param headers - Optional headers to include in the requests
   * @param useNodeEventSource - Whether to use Node.js EventSource (requires eventsource package)
   * @param reconnect - Optional reconnection configuration
   * @returns A map of server names to arrays of tools
   */
  async connectToServerViaSSE(
    serverName: string,
    url: string,
    headers?: Record<string, string>,
    useNodeEventSource?: boolean,
    reconnect?: SSEConnection["reconnect"]
  ): Promise<Map<string, StructuredToolInterface[]>> {
    const connection: SSEConnection = {
      transport: "sse",
      url,
    };

    if (headers) {
      connection.headers = headers;
    }

    if (useNodeEventSource !== undefined) {
      connection.useNodeEventSource = useNodeEventSource;
    }

    if (reconnect) {
      connection.reconnect = reconnect;
    }

    const connections: Record<string, Connection> = {
      [serverName]: connection,
    };

    this.connections = connections;
    return this.initializeConnections();
  }

  /**
   * Add configuration from a JSON file to the existing configuration.
   *
   * @param configPath - Path to the configuration file
   * @returns This client instance for method chaining
   * @throws {MCPClientError} If the configuration file cannot be loaded or parsed
   */
  addConfigFromFile(configPath: string): MultiServerMCPClient {
    try {
      const config = MultiServerMCPClient.loadConfigFromFile(configPath);

      // Merge with existing connections if any
      if (this.connections) {
        this.connections = {
          ...this.connections,
          ...MultiServerMCPClient.processConnections(config.servers),
        };
      } else {
        this.connections = MultiServerMCPClient.processConnections(
          config.servers
        );
      }

      getDebugLog()(`INFO: Added MCP configuration from ${configPath}`);
      return this;
    } catch (error) {
      getDebugLog()(
        `ERROR: Failed to add MCP configuration from ${configPath}: ${error}`
      );
      throw new MCPClientError(`Failed to add MCP configuration: ${error}`);
    }
  }

  /**
   * Add server configurations directly to the existing configuration.
   *
   * @param connections - Server connections to add
   * @returns This client instance for method chaining
   */
  addConnections(
    connections: Record<string, Connection>
  ): MultiServerMCPClient {
    const processedConnections =
      MultiServerMCPClient.processConnections(connections);

    // Merge with existing connections if any
    if (this.connections) {
      this.connections = {
        ...this.connections,
        ...processedConnections,
      };
    } else {
      this.connections = processedConnections;
    }

    getDebugLog()(
      `INFO: Added ${
        Object.keys(processedConnections).length
      } connections to client`
    );
    return this;
  }

  /**
   * Get the server name for a specific tool.
   *
   * @param toolName - The name of the tool
   * @returns The server name or undefined if the tool is not found
   */
  getServerForTool(toolName: string): string | undefined {
    for (const [serverName, tools] of this.serverNameToTools.entries()) {
      if (tools.some((tool) => tool.name === toolName)) {
        return serverName;
      }
    }
    return undefined;
  }
}
