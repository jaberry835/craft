export interface AppConfig {
  azureOpenAiEndpoint?: string;
  azureOpenAiApiKey?: string;
  azureOpenAiDeployment?: string;
  azureOpenAiApiVersion: string;
}

export function loadConfig(): AppConfig {
  return {
    azureOpenAiEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
    azureOpenAiApiKey: process.env.AZURE_OPENAI_API_KEY,
    azureOpenAiDeployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    azureOpenAiApiVersion: process.env.AZURE_OPENAI_API_VERSION ?? "2024-10-21"
  };
}