import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "./sql.ts";

/**
 * Secret store abstraction. The database tables hold only `secret_ref`
 * strings; the token itself lives here. Production: Supabase Vault
 * (VaultSecretStore, ADR-016). Tests: InMemorySecretStore.
 */
export interface SecretStore {
  get(ref: string): Promise<string>;
  put(ref: string, value: string): Promise<void>;
  /** Remove a secret nobody references any more. Optional. */
  delete?(ref: string): Promise<void>;
}

/** A fresh reference for a new platform token, e.g. `vault:glio/tiktok/<uuid>`. */
export function newSecretRef(platform: string): string {
  return `vault:glio/${platform}/${randomUUID()}`;
}

/**
 * Supabase Vault: secrets are encrypted at rest by Supabase and read back only
 * through `vault.decrypted_secrets`, which is available to the server's
 * database role and not exposed through the API. The secret's Vault `name` is
 * the part of the ref after `vault:`.
 */
export class VaultSecretStore implements SecretStore {
  constructor(private readonly db: SqlExecutor) {}

  private static nameOf(ref: string): string {
    if (!ref.startsWith("vault:") || ref.length <= 6) throw new Error(`Not a Vault secret ref: ${ref}`);
    return ref.slice("vault:".length);
  }

  async get(ref: string): Promise<string> {
    const [row] = await this.db.query("select decrypted_secret from vault.decrypted_secrets where name = $1", [VaultSecretStore.nameOf(ref)]);
    if (!row || typeof row.decrypted_secret !== "string") throw new Error(`No secret stored for ref ${ref}`);
    return row.decrypted_secret;
  }

  async put(ref: string, value: string): Promise<void> {
    const name = VaultSecretStore.nameOf(ref);
    const [existing] = await this.db.query("select id from vault.secrets where name = $1", [name]);
    if (existing) {
      await this.db.query("select vault.update_secret($1::uuid, $2)", [existing.id, value]);
    } else {
      await this.db.query("select vault.create_secret($1, $2, $3)", [value, name, "GLIO platform access token"]);
    }
  }

  async delete(ref: string): Promise<void> {
    await this.db.query("delete from vault.secrets where name = $1", [VaultSecretStore.nameOf(ref)]);
  }
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

  async delete(ref: string): Promise<void> {
    this.values.delete(ref);
  }

  has(ref: string): boolean {
    return this.values.has(ref);
  }
}
