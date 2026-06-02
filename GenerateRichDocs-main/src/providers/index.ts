import { loadConfig } from "../config.js";
import type { CreativeProvider } from "./creativeProvider.js";
import { AzureOpenAiCreativeProvider } from "./azureOpenAiCreativeProvider.js";
import { MockCreativeProvider } from "./mockCreativeProvider.js";

export function createCreativeProvider(): CreativeProvider {
  const config = loadConfig();

  if (
    config.azureOpenAiApiKey &&
    config.azureOpenAiApiVersion &&
    config.azureOpenAiDeployment &&
    config.azureOpenAiEndpoint
  ) {
    return new AzureOpenAiCreativeProvider({
      azureOpenAiApiKey: config.azureOpenAiApiKey,
      azureOpenAiApiVersion: config.azureOpenAiApiVersion,
      azureOpenAiDeployment: config.azureOpenAiDeployment,
      azureOpenAiEndpoint: config.azureOpenAiEndpoint
    });
  }

  return new MockCreativeProvider();
}