import test from "node:test";
import assert from "node:assert/strict";
import { createCreativeProvider } from "../src/providers/index.js";

function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
  const originalValues = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(overrides)) {
    originalValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    run();
  } finally {
    for (const [key, value] of originalValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("createCreativeProvider falls back to mock provider when Azure env vars are missing", () => {
  withEnv(
    {
      AZURE_OPENAI_ENDPOINT: undefined,
      AZURE_OPENAI_API_KEY: undefined,
      AZURE_OPENAI_DEPLOYMENT: undefined,
      AZURE_OPENAI_API_VERSION: undefined
    },
    () => {
      const provider = createCreativeProvider();
      assert.equal(provider.name, "mock");
    }
  );
});

test("createCreativeProvider selects Azure provider when required env vars exist", () => {
  withEnv(
    {
      AZURE_OPENAI_ENDPOINT: "https://example-resource.openai.azure.com",
      AZURE_OPENAI_API_KEY: "test-key",
      AZURE_OPENAI_DEPLOYMENT: "test-deployment",
      AZURE_OPENAI_API_VERSION: "2024-10-21"
    },
    () => {
      const provider = createCreativeProvider();
      assert.equal(provider.name, "azure-openai");
    }
  );
});