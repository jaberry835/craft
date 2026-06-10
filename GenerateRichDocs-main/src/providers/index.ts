import { loadConfig } from "../config.js";
import type { CreativeProvider } from "./creativeProvider.js";
import { AzureOpenAiCreativeProvider } from "./azureOpenAiCreativeProvider.js";
import { MockCreativeProvider } from "./mockCreativeProvider.js";

export function createCreativeProvider(): CreativeProvider {
  const config = loadConfig();
  const endpoint = config.azureOpenAiEndpoint;
  const apiKey = config.azureOpenAiApiKey;
  const deployment = config.azureOpenAiDeployment;
  const apiVersion = config.azureOpenAiApiVersion;

  if (endpoint && apiKey && deployment && apiVersion) {
    console.log(
      `[provider] Using azure-openai endpoint=${endpoint} deployment=${deployment} apiVersion=${apiVersion}`
    );

    return new AzureOpenAiCreativeProvider({
      azureOpenAiApiKey: apiKey,
      azureOpenAiApiVersion: apiVersion,
      azureOpenAiDeployment: deployment,
      azureOpenAiEndpoint: endpoint
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