import { readFile } from 'node:fs/promises';
import type { ModelConnectionStatus } from '../../src/types/api.js';
import type {
  AzureOpenAiConnectionDefinition,
  ModelAuthMode,
  ResolvedModelConnection
} from '../modelTypes.js';

const environmentNamePattern = /^[A-Z_][A-Z0-9_]*$/;

export class ModelConnectionConfig {
  private constructor(
    private readonly connection: AzureOpenAiConnectionDefinition,
    private readonly environment: NodeJS.ProcessEnv
  ) {}

  static async load(
    configPath: string,
    environment: NodeJS.ProcessEnv = process.env
  ): Promise<ModelConnectionConfig> {
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 1) {
      throw new Error('Exactly one AAA model connection must be configured.');
    }
    const connection = parsed[0] as Partial<AzureOpenAiConnectionDefinition>;
    if (
      connection.type !== 'azure-openai'
      || !connection.id?.trim()
      || !connection.name?.trim()
      || !connection.endpointEnv
      || !connection.deploymentEnv
    ) {
      throw new Error('The AAA model connection is invalid.');
    }
    for (const name of [
      connection.endpointEnv,
      connection.deploymentEnv,
      connection.apiVersionEnv,
      connection.apiKeyEnv
    ].filter((value): value is string => Boolean(value))) {
      if (!environmentNamePattern.test(name)) {
        throw new Error(`Invalid environment variable reference: ${name}`);
      }
    }
    if (connection.authMode && !['entra', 'api-key'].includes(connection.authMode)) {
      throw new Error('Model authMode must be "entra" or "api-key".');
    }
    return new ModelConnectionConfig(connection as AzureOpenAiConnectionDefinition, environment);
  }

  status(): ModelConnectionStatus {
    const endpoint = this.value(this.connection.endpointEnv);
    const deployment = this.value(this.connection.deploymentEnv);
    const apiVersion = this.apiVersion();
    const authMode = this.authMode();
    const missing = [
      endpoint ? undefined : this.connection.endpointEnv,
      deployment ? undefined : this.connection.deploymentEnv,
      apiVersion ? undefined : this.connection.apiVersionEnv ?? 'AZURE_OPENAI_API_VERSION',
      authMode === 'api-key' && !this.apiKey()
        ? this.connection.apiKeyEnv ?? 'AZURE_OPENAI_API_KEY'
        : undefined
    ].filter((name): name is string => Boolean(name));

    return {
      id: this.connection.id,
      name: this.connection.name,
      provider: this.connection.type,
      ready: missing.length === 0,
      missing,
      authMode,
      endpointKind: this.connection.endpointKind ?? 'auto',
      endpointHost: this.safeHost(endpoint),
      deployment: deployment || undefined,
      apiVersion: apiVersion || undefined
    };
  }

  resolve(): ResolvedModelConnection {
    const status = this.status();
    if (!status.ready) {
      throw new Error(`Model connection is not ready. Missing: ${status.missing.join(', ')}`);
    }
    return {
      definition: this.connection,
      endpoint: this.value(this.connection.endpointEnv).replace(/\/+$/, ''),
      deployment: this.value(this.connection.deploymentEnv),
      apiVersion: this.apiVersion(),
      apiKey: this.apiKey() || undefined
    };
  }

  private value(name?: string): string {
    return name ? this.environment[name]?.trim() ?? '' : '';
  }

  private authMode(): ModelAuthMode {
    return this.connection.authMode ?? 'entra';
  }

  private apiKey(): string {
    return this.value(this.connection.apiKeyEnv);
  }

  private apiVersion(): string {
    return this.value(this.connection.apiVersionEnv)
      || this.connection.defaultApiVersion?.trim()
      || '';
  }

  private safeHost(endpoint: string): string | undefined {
    if (!endpoint) {
      return undefined;
    }
    try {
      return new URL(endpoint).host;
    } catch {
      return undefined;
    }
  }
}
