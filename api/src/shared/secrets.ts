import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';

/**
 * Resolves configuration values. Order of precedence:
 *   1. process.env (local dev / explicit overrides)
 *   2. Azure Key Vault, via Managed Identity (DefaultAzureCredential)
 *
 * Key Vault secret names use kebab-case (e.g. `db-connection-string`); the
 * env-var fallback uses SCREAMING_SNAKE (e.g. `DB_CONNECTION_STRING`).
 * Values are cached for the lifetime of the (warm) Function host.
 */

const cache = new Map<string, string>();
let client: SecretClient | undefined;

function kvClient(): SecretClient | undefined {
  const uri = process.env.KEY_VAULT_URI;
  if (!uri) return undefined;
  if (!client) {
    client = new SecretClient(uri, new DefaultAzureCredential());
  }
  return client;
}

/**
 * Fetch a secret by its Key Vault name (kebab-case). Falls back to the
 * equivalent env var when Key Vault is not configured (local dev).
 */
export async function getSecret(kvName: string): Promise<string> {
  if (cache.has(kvName)) return cache.get(kvName)!;

  const envName = kvName.toUpperCase().replace(/-/g, '_');
  const envVal = process.env[envName];
  if (envVal) {
    cache.set(kvName, envVal);
    return envVal;
  }

  const c = kvClient();
  if (!c) {
    throw new Error(
      `Secret "${kvName}" not found: no env var ${envName} and KEY_VAULT_URI is unset.`
    );
  }

  const secret = await c.getSecret(kvName);
  if (!secret.value) {
    throw new Error(`Key Vault secret "${kvName}" has no value.`);
  }
  cache.set(kvName, secret.value);
  return secret.value;
}
