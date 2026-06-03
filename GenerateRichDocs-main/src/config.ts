export interface AppConfig {
  azureOpenAiEndpoint?: string;
  azureOpenAiApiKey?: string;
  azureOpenAiDeployment?: string;
  azureOpenAiApiVersion: string;
  azureStorageAccountName?: string;
  azureStorageContainerName?: string;
  azureStorageBlobPrefix?: string;
  azureStorageSasToken?: string;
}

export function loadConfig(): AppConfig {
  return {
    azureOpenAiEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
    azureOpenAiApiKey: process.env.AZURE_OPENAI_API_KEY,
    azureOpenAiDeployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    azureOpenAiApiVersion: process.env.AZURE_OPENAI_API_VERSION ?? "2024-10-21",
    azureStorageAccountName: process.env.AZURE_STORAGE_ACCOUNT_NAME,
    azureStorageContainerName: process.env.AZURE_STORAGE_CONTAINER_NAME,
    azureStorageBlobPrefix: process.env.AZURE_STORAGE_BLOB_PREFIX,
    azureStorageSasToken: process.env.AZURE_STORAGE_SAS_TOKEN
  };
}