import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

export type ApiKeyKind = 'mistral' | 'vibe';

export interface ApiKeyProfile {
  id: string;
  name: string;
  value: string;
  last4: string;
  createdAt: number;
}

export type ApiKeyProfileSummary = Omit<ApiKeyProfile, 'value'>;

const profileSecretKeys: Record<ApiKeyKind, string> = {
  mistral: 'mistralVibe.credentials.mistralProfiles',
  vibe: 'mistralVibe.credentials.vibeProfiles'
};

const activeSecretKeys: Record<ApiKeyKind, string> = {
  mistral: 'mistralVibe.credentials.activeMistralProfile',
  vibe: 'mistralVibe.credentials.activeVibeProfile'
};

const legacyMistralKey = 'mistralVibe.mistralApiKey';

export class CredentialStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async addProfile(kind: ApiKeyKind, name: string, value: string): Promise<ApiKeyProfile> {
    const profiles = await this.getProfiles(kind);
    const profile: ApiKeyProfile = {
      id: randomUUID(),
      name,
      value,
      last4: value.slice(-4),
      createdAt: Date.now()
    };

    await this.saveProfiles(kind, [profile, ...profiles.filter(existing => existing.name !== name)]);
    await this.setActiveProfileId(kind, profile.id);
    return profile;
  }

  async getProfiles(kind: ApiKeyKind): Promise<ApiKeyProfile[]> {
    await this.migrateLegacyMistralKey();
    const raw = await this.context.secrets.get(profileSecretKeys[kind]);
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as ApiKeyProfile[];
      return parsed.filter(profile => profile.id && profile.name && profile.value);
    } catch {
      return [];
    }
  }

  async getActiveProfile(kind: ApiKeyKind): Promise<ApiKeyProfile | undefined> {
    const profiles = await this.getProfiles(kind);
    const activeId = await this.context.secrets.get(activeSecretKeys[kind]);
    return profiles.find(profile => profile.id === activeId) ?? profiles[0];
  }

  async getProfileSummaries(kind: ApiKeyKind): Promise<ApiKeyProfileSummary[]> {
    return (await this.getProfiles(kind)).map(({ value: _value, ...summary }) => summary);
  }

  async setActiveProfileId(kind: ApiKeyKind, profileId: string): Promise<void> {
    await this.context.secrets.store(activeSecretKeys[kind], profileId);
  }

  async deleteProfile(kind: ApiKeyKind, profileId: string): Promise<void> {
    const profiles = await this.getProfiles(kind);
    const activeId = await this.context.secrets.get(activeSecretKeys[kind]);
    const nextProfiles = profiles.filter(profile => profile.id !== profileId);
    await this.saveProfiles(kind, nextProfiles);

    if (activeId === profileId) {
      if (nextProfiles[0]) {
        await this.setActiveProfileId(kind, nextProfiles[0].id);
      } else {
        await this.context.secrets.delete(activeSecretKeys[kind]);
      }
    }
  }

  private async saveProfiles(kind: ApiKeyKind, profiles: ApiKeyProfile[]): Promise<void> {
    await this.context.secrets.store(profileSecretKeys[kind], JSON.stringify(profiles));
  }

  private async migrateLegacyMistralKey(): Promise<void> {
    const rawProfiles = await this.context.secrets.get(profileSecretKeys.mistral);
    if (rawProfiles) {
      return;
    }

    const legacy = await this.context.secrets.get(legacyMistralKey);
    if (!legacy) {
      return;
    }

    const profile: ApiKeyProfile = {
      id: randomUUID(),
      name: 'Default Mistral API key',
      value: legacy,
      last4: legacy.slice(-4),
      createdAt: Date.now()
    };
    await this.saveProfiles('mistral', [profile]);
    await this.setActiveProfileId('mistral', profile.id);
    await this.context.secrets.delete(legacyMistralKey);
  }
}

export function apiKeyKindLabel(kind: ApiKeyKind): string {
  return kind === 'mistral' ? 'Mistral API' : 'Vibe API';
}
