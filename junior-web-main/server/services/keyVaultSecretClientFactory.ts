import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';

export interface KeyVaultSecretClientBinding {
  client: SecretClient;
  vaultUrl: string;
  prefix: string;
}

export function createOptionalKeyVaultSecretClient(label: string): KeyVaultSecretClientBinding | undefined {
  const vaultUrl = process.env.AZURE_KEY_VAULT_URL ?? process.env.KEY_VAULT_URI;
  if (!vaultUrl) {
    console.info(`[${label}] Key Vault secret storage is disabled; using local secret persistence.`);
    return undefined;
  }

  const prefix = (process.env.JUNIOR_KEY_VAULT_SECRET_PREFIX ?? 'junior').trim() || 'junior';
  console.info(`[${label}] Key Vault secret storage enabled: vault=${vaultHost(vaultUrl)}, prefix=${prefix}.`);

  return {
    client: new SecretClient(vaultUrl, new DefaultAzureCredential()),
    vaultUrl,
    prefix
  };
}

function vaultHost(vaultUrl: string): string {
  try {
    return new URL(vaultUrl).host;
  } catch {
    return 'invalid-vault-url';
  }
}