import { loadConfig } from "../config.js";
import type { CreativeProvider } from "./creativeProvider.js";
import { AzureOpenAiCreativeProvider } from "./azureOpenAiCreativeProvider.js";
import { MockCreativeProvider } from "./mockCreativeProvider.js";

export function createCreativeProvider(): CreativeProvider {
  const config = loadConfig();
  const hasAzureConfig = Boolean(
    config.azureOpenAiApiKey &&
    config.azureOpenAiApiVersion &&
    config.azureOpenAiDeployment &&
    config.azureOpenAiEndpoint
  );

  if (hasAzureConfig) {
    console.log(
      `[provider] Using azure-openai endpoint=${config.azureOpenAiEndpoint} deployment=${config.azureOpenAiDeployment} apiVersion=${config.azureOpenAiApiVersion}`
    );

    return new AzureOpenAiCreativeProvider({
      azureOpenAiApiKey: config.azureOpenAiApiKey,
      azureOpenAiApiVersion: config.azureOpenAiApiVersion,
      azureOpenAiDeployment: config.azureOpenAiDeployment,
      azureOpenAiEndpoint: config.azureOpenAiEndpoint
    });
  }

  const missingVars = [
    ["AZURE_OPENAI_ENDPOINT", config.azureOpenAiEndpoint],
    ["AZURE_OPENAI_API_KEY", config.azureOpenAiApiKey],
    ["AZURE_OPENAI_DEPLOYMENT", config.azureOpenAiDeployment],
    ["AZURE_OPENAI_API_VERSION", config.azureOpenAiApiVersion]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name)
    .join(", ");

  console.warn(`[provider] Azure OpenAI not fully configured. Falling back to mock provider. Missing: ${missingVars || "none"}`);

  return new MockCreativeProvider();
}