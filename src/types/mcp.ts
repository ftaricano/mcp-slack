export interface MCPServerConfig {
  name: string;
  version: string;
  capabilities: {
    resources: boolean;
    tools: boolean;
    prompts: boolean;
    logging: boolean;
  };
}

export interface SlackResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface SlackTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface SlackPrompt {
  name: string;
  description: string;
  arguments?: Array<{
    name: string;
    description: string;
    required?: boolean;
  }>;
}

export interface AuditLogEntry {
  timestamp: string;
  user: string;
  action: string;
  resource: string;
  details: Record<string, any>;
  status: 'success' | 'error' | 'warning';
  ip?: string;
  userAgent?: string;
}

export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  userScopes?: string[];
}

export interface ErrorResponse {
  code: number;
  message: string;
  data?: any;
}

export type MCPRequest = {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: any;
};

export type MCPResponse = {
  jsonrpc: '2.0';
  id: string | number;
  result?: any;
  error?: ErrorResponse;
};
