import type { SnapchatTokens } from "@glio/connectors";
import type { SecretStore } from "./secrets.ts";

/** Secret references holding a Snapchat REFRESH token (newSecretRef("snapchat")). */
export function isSnapchatRef(ref: string): boolean {
  return ref.startsWith("vault:glio/snapchat/");
}

/**
 * A SecretStore for the sync: for Snapchat references it returns a fresh ACCESS token (Snap's access
 * tokens last ~1 hour), minted from the refresh token kept in the inner store; if Snap returns a new
 * refresh token it replaces the stored one. Other references pass through unchanged, so runSync and
 * reconcile work the same for every platform. Access tokens are kept in memory only, for at most
 * 50 minutes, and never written anywhere.
 */
export class SnapchatAccessTokenStore implements SecretStore {
  private readonly cache = new Map<string, { token: string; until: number }>();

  constructor(
    private readonly inner: SecretStore,
    private readonly refresh: (refreshToken: string) => Promise<SnapchatTokens>,
    private readonly now: () => number = Date.now,
  ) {}

  async get(ref: string): Promise<string> {
    if (!isSnapchatRef(ref)) return this.inner.get(ref);
    const hit = this.cache.get(ref);
    if (hit && hit.until > this.now()) return hit.token;
    const refreshToken = await this.inner.get(ref);
    const t = await this.refresh(refreshToken);
    if (t.refreshToken && t.refreshToken !== refreshToken) await this.inner.put(ref, t.refreshToken);
    const ttl = Math.min(50 * 60, Math.max(60, (t.expiresIn ?? 3600) - 600)) * 1000;
    this.cache.set(ref, { token: t.accessToken, until: this.now() + ttl });
    return t.accessToken;
  }

  put(ref: string, value: string): Promise<void> {
    this.cache.delete(ref);
    return this.inner.put(ref, value);
  }

  async delete(ref: string): Promise<void> {
    this.cache.delete(ref);
    await this.inner.delete?.(ref);
  }
}
