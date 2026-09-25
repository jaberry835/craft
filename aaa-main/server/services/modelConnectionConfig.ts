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
    const oneOf = (field: keyof AzureOpenAiConnectionDefinition, allowed: readonly string[]) => {
      const value = connection[field];
      if (value !== undefined && (typeof value !== 'string' || !allowed.includes(value))) {
        throw new Error(`Model ${field} must be one of: ${allowed.map((item) => `"${item}"`).join(', ')}.`);
      }
    };
    oneOf('endpointKind', ['auto', 'foundry-project', 'openai-v1', 'azure-openai-legacy']);
    oneOf('api', ['auto', 'chat-completions', 'responses']);
    oneOf('tokenParameter', ['auto', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'omit']);
    oneOf('reasoningSummary', ['auto', 'concise', 'detailed']);
    if (connection.temperature !== undefined && connection.temperature !== null
      && (typeof connection.temperature !== 'number' || !Number.isFinite(connection.temperature))) {
      throw new Error('Model temperature must be a number, or null to omit it.');
    }
    if (connection.maxTokens !== undefined
      && (!Number.isInteger(connection.maxTokens) || connection.maxTokens <= 0)) {
      throw new Error('Model maxTokens must be a positive integer.');
    }
    if (connection.reasoningEffort !== undefined
      && (typeof connection.reasoningEffort !== 'string' || !connection.reasoningEffort.trim())) {
      throw new Error('Model reasoningEffort must be a non-empty string such as "low", "medium", or "high".');
    }
    for (const field of ['adaptive', 'stream', 'includeUsage'] as const) {
      if (connection[field] !== undefined && typeof connection[field] !== 'boolean') {
        throw new Error(`Model ${field} must be true or false.`);
      }
    }
    if (connection.maxRetries !== undefined
      && (!Number.isInteger(connection.maxRetries) || connection.maxRetries < 0 || connection.maxRetries > 10)) {
      throw new Error('Model maxRetries must be an integer from 0 to 10.');
    }
    if (connection.contextWindow !== undefined
      && (!Number.isInteger(connection.contextWindow) || connection.contextWindow < 1024)) {
      throw new Error('Model contextWindow must be an integer of at least 1024 tokens.');
    }
    const compaction = connection.compaction;
    if (compaction !== undefined) {
      if (typeof compaction !== 'object' || compaction === null || Array.isArray(compaction)) {
        throw new Error('Model compaction must be an object.');
      }
      if (compaction.auto !== undefined && typeof compaction.auto !== 'boolean') {
        throw new Error('Model compaction.auto must be true or false.');
      }
      if (compaction.threshold !== undefined
        && (typeof compaction.threshold !== 'number' || compaction.threshold < 0.3 || compaction.threshold > 0.95)) {
        throw new Error('Model compaction.threshold must be a number from 0.3 to 0.95.');
      }
      if (compaction.summaryMaxTokens !== undefined
        && (!Number.isInteger(compaction.summaryMaxTokens) || compaction.summaryMaxTokens < 256)) {
        throw new Error('Model compaction.summaryMaxTokens must be an integer of at least 256.');
      }
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
      api: this.connection.api ?? 'auto',
      adaptive: this.connection.adaptive !== false,
      ...(this.connection.contextWindow ? { contextWindow: this.connection.contextWindow } : {}),
      autoCompact: Boolean(this.connection.contextWindow) && this.connection.compaction?.auto !== false,
      compactThreshold: this.connection.compaction?.threshold ?? 0.8,
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
