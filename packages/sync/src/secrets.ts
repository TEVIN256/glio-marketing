/**
 * Secret store abstraction. The database holds only `secret_ref` strings;
 * the token itself lives here.
 *
 * TODO: production implementation (Supabase Vault or a cloud KMS-backed
 * store) is chosen before the first real TikTok account is connected
 * (see docs/DECISIONS.md). Until then only the in-memory store exists, for
 * tests.
 */
export interface SecretStore {
  get(ref: string): Promise<string>;
  put(ref: string, value: string): Promise<void>;
}

export class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  async get(ref: string): Promise<string> {
    const value = this.values.get(ref);
    if (value === undefined) throw new Error(`No secret stored for ref ${ref}`);
    return value;
  }

  async put(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }
}
