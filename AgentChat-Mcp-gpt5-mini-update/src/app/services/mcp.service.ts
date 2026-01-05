import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, BehaviorSubject, map, catchError, of } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';
import { 
  MCPTool, 
  MCPServer, 
  MCPListToolsResponse, 
  MCPCallToolRequest, 
  MCPCallToolResponse,
  MCPServerInfo 
} from '../models/mcp.models';

@Injectable({
  providedIn: 'root'
})
export class MCPService {
  private http = inject(HttpClient);
  private authService = inject(AuthService);

  private availableToolsSubject = new BehaviorSubject<MCPTool[]>([]);
  private connectedServersSubject = new BehaviorSubject<MCPServer[]>([]);

  availableTools$ = this.availableToolsSubject.asObservable();
  connectedServers$ = this.connectedServersSubject.asObservable();

  private get mcpServerUrl(): string {
    return environment.azure.functions.mcpServerUrl;
  }  private async getHeaders(): Promise<HttpHeaders> {
    const headers = new HttpHeaders({
      'Content-Type': 'application/json'
    });

    try {
      // Get user's access token for Azure delegation
      const accessToken = await this.authService.getAccessToken();
      
      if (accessToken) {
        // console.log('MCP Service: User token acquired successfully');
        return headers.set('X-User-Token', accessToken);
      } else {
        console.warn('MCP Service: No access token available - user may need to re-authenticate');
      }
    } catch (error) {
      console.error('MCP Service: Error acquiring user token:', error);
      // Try to trigger interactive authentication for Azure Resource Manager scope
      try {
        // console.log('MCP Service: Attempting interactive authentication...');
        await this.authService.loginInteractiveForAzureResources();
        const newToken = await this.authService.getAccessToken();
        if (newToken) {
          // console.log('MCP Service: Interactive authentication successful');
          return headers.set('X-User-Token', newToken);
        }
      } catch (interactiveError) {
        console.error('MCP Service: Interactive authentication failed:', interactiveError);
      }
    }
    
    return headers;
  }

  /**
   * Initialize MCP connection and discover available tools
   */
  async initializeMCP(): Promise<void> {
    // console.log('Initializing MCP connection...');
    
    try {
      // Get server info
      const serverInfo = await this.getServerInfo();
      // console.log('MCP Server Info:', serverInfo);

      // List available tools
      const tools = await this.listTools();
      this.availableToolsSubject.next(tools);
      // console.log('Available MCP Tools:', tools);

      // Update connected servers
      const server: MCPServer = {
        name: serverInfo.name,
        url: this.mcpServerUrl,
        description: `MCP Server v${serverInfo.version}`,
        tools: tools
      };
      this.connectedServersSubject.next([server]);

    } catch (error) {
      console.error('Failed to initialize MCP:', error);
      this.availableToolsSubject.next([]);
      this.connectedServersSubject.next([]);
    }
  }

  /**
   * Get MCP server information
   */  private async getServerInfo(): Promise<MCPServerInfo> {
    try {
      const headers = await this.getHeaders();
      const response = await this.http.get<MCPServerInfo>(
        `${this.mcpServerUrl}/server/info`,
        { headers }
      ).toPromise();
      
      return response || {
        name: 'Unknown MCP Server',
        version: '1.0.0',
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } }
      };
    } catch (error) {
      console.error('Error getting server info:', error);
      // Return default server info if endpoint doesn't exist
      return {
        name: 'MCP Server',
        version: '1.0.0',
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } }
      };
    }
  }
  /**
   * List all available tools from the MCP server
   */  async listTools(): Promise<MCPTool[]> {
    try {
      const headers = await this.getHeaders();
      const response = await this.http.get<any>(
        `${this.mcpServerUrl}/tools`,
        { headers }
      ).toPromise();

      console.log('Raw tools response:', response);
      
      // Handle the response format from /tools endpoint
      // Response has: { server_info, tools_by_category, all_tools }
      if (response && response.all_tools && Array.isArray(response.all_tools)) {
        console.log('Received tools from all_tools array:', response.all_tools.length);
        return response.all_tools;
      } else if (Array.isArray(response)) {
        console.log('Received tools as direct array:', response);
        return response;
      } else if (response && 'tools' in response) {
        console.log('Received tools as wrapped response:', response.tools);
        return response.tools || [];
      }
      
      console.log('No tools found in response');
      return [];
    } catch (error) {
      console.error('Error listing MCP tools:', error);
      return [];
    }
  }

  /**
   * Call a specific MCP tool
   */  async callTool(toolName: string, toolArguments: Record<string, any>): Promise<MCPCallToolResponse> {
    // console.log(`Calling MCP tool: ${toolName}`, toolArguments);

    try {      const request: MCPCallToolRequest = {
        name: toolName,
        arguments: toolArguments
      };

      // console.log('MCP request payload:', JSON.stringify(request));
      // console.log('MCP server URL:', this.mcpServerUrl);
      
      const headers = await this.getHeaders();
      // console.log('Headers:', headers);

      const response = await this.http.post<MCPCallToolResponse>(
        `${this.mcpServerUrl}/tools/call`,
        request,
        { headers }
      ).toPromise();

      // console.log(`MCP tool ${toolName} response:`, response);
      return response || { content: [{ type: 'text', text: 'No response from tool' }] };

    } catch (error) {
      console.error(`Error calling MCP tool ${toolName}:`, error);
      
      // Log more details about the error
      if (error instanceof Error) {
        console.error('Error details:', {
          message: error.message,
          stack: error.stack
        });
      }
      
      return {
        content: [{ type: 'text', text: `Error calling tool: ${error}` }],
        isError: true
      };
    }
  }
  /**
   * Get tools formatted for Azure OpenAI function calling
   */
  getToolsForOpenAI(): any[] {
    const tools = this.availableToolsSubject.value;
    
    return tools.map(tool => {
      // Clean up the input schema to remove null enum values
      const cleanedSchema = this.cleanToolSchema(tool.inputSchema);
      
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: cleanedSchema
        }
      };
    });
  }
  /**
   * Clean tool schema by removing null enum values and other invalid properties
   */
  private cleanToolSchema(schema: any): any {
    if (!schema) return { type: 'object', properties: {}, required: [] };
    
    const cleaned: any = {
      type: schema.type || 'object',
      properties: {},
      required: schema.required || []
    };

    if (schema.properties) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        const cleanedProp: any = {
          type: (prop as any).type || 'string',
          description: (prop as any).description || ''
        };
        
        // Only include enum if it has valid values
        if ((prop as any).enum && Array.isArray((prop as any).enum) && (prop as any).enum.length > 0) {
          cleanedProp.enum = (prop as any).enum;
        }
        
        cleaned.properties[key] = cleanedProp;
      }
    }

    return cleaned;
  }

  /**
   * Check if MCP server is available
   */
  async isServerAvailable(): Promise<boolean> {
    if (!this.mcpServerUrl || this.mcpServerUrl === 'YOUR_MCP_SERVER_URL') {
      return false;
    }

    try {
      await this.getServerInfo();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get current available tools
   */
  getAvailableTools(): MCPTool[] {
    return this.availableToolsSubject.value;
  }

  /**
   * Process multiple tool calls from OpenAI
   */  async processToolCalls(toolCalls: any[]): Promise<any[]> {
    const results = [];

    for (const toolCall of toolCalls) {
      try {
        const args = typeof toolCall.function.arguments === 'string' 
          ? JSON.parse(toolCall.function.arguments)
          : toolCall.function.arguments;        const result = await this.callTool(toolCall.function.name, args);
        // console.log('Raw MCP tool result:', result);
        
        // Extract text content from the MCP response structure
        let content = '';
        if (result.content && Array.isArray(result.content)) {
          content = result.content.map(c => {
            if (c.type === 'text' && c.text) {
              return c.text;
            }
            return c.text || c.data || '';
          }).join('\n');
        }
        
        // console.log('Extracted content for OpenAI:', content);
        
        results.push({
          tool_call_id: toolCall.id,
          role: 'tool',
          content: content || 'No content returned from tool'
        });

      } catch (error) {
        console.error('Error processing tool call:', error);
        results.push({
          tool_call_id: toolCall.id,
          role: 'tool',
          content: `Error: ${error}`
        });
      }
    }

    return results;
  }
}
