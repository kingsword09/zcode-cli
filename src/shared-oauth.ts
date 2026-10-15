interface CredentialReader {
  loadMany(keys: string[]): Promise<Record<string, string | null>>;
}

interface AccountProvider {
  providerId: string;
  family: string;
}

const activeProviderKey = "oauth:active_provider";
const identityKey = (provider: string) => `account-provider:${provider}:identity`;
const sourceKey = (provider: string) => `account-provider:${provider}:auth-source`;

function profileIdentity(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const profile = JSON.parse(value);
    const id = profile?.user_id ?? profile?.id ?? profile?.rawProfile?.user_id;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

/** Desktop owns oauth:*; standalone account markers must not shadow that session. */
export function sharedOAuthCredentialReader<T extends CredentialReader>(
  store: T,
  providers: () => Promise<readonly AccountProvider[]>,
): Omit<T, "load" | "loadMany"> & CredentialReader & { load(key: string): Promise<string | null> } {
  const loadMany = async (keys: string[]): Promise<Record<string, string | null>> => {
    const identityKeys = keys.filter(key => key.startsWith("account-provider:") && key.endsWith(":identity"));
    if (!identityKeys.length) return store.loadMany(keys);
    const catalog = (await providers()).filter(provider => identityKeys.includes(identityKey(provider.providerId)));
    if (!catalog.length) return store.loadMany(keys);
    const sourceKeys = catalog.map(provider => sourceKey(provider.providerId));
    const sources = await store.loadMany(sourceKeys);
    const shared = catalog.filter(provider => sources[sourceKey(provider.providerId)] !== "manual");
    if (!shared.length) return store.loadMany(keys);

    // Do not decrypt stale CLI identities for OAuth, or unrelated OAuth data for manual keys.
    const overridden = new Set(shared.map(provider => identityKey(provider.providerId)));
    const values = await store.loadMany([...keys.filter(key => !overridden.has(key)), activeProviderKey]);
    const family = values[activeProviderKey];
    let identity: string | null = null;
    if (family && shared.some(provider => provider.family === family)) {
      const profileKey = `oauth:${family}:user_info`;
      const current = await store.loadMany([activeProviderKey, profileKey]);
      if (current[activeProviderKey] === family) identity = profileIdentity(current[profileKey]);
    }
    for (const provider of shared) {
      values[identityKey(provider.providerId)] = provider.family === family ? identity : null;
    }
    return Object.fromEntries(keys.map(key => [key, values[key] ?? null]));
  };
  return { ...store, loadMany, load: async key => (await loadMany([key]))[key] ?? null };
}

/** A successful OAuth exchange must publish Desktop's business token, never its OAuth input. */
export function zaiBusinessAccessToken(material: { zaiBusinessToken?: string }): string {
  const token = material.zaiBusinessToken?.trim();
  if (!token) throw new Error("Z.AI login did not return a business access token.");
  return token;
}
