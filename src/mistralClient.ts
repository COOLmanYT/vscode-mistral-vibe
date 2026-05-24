import * as vscode from 'vscode';
import { getEndpoint, getModel } from './config';
import { CredentialStore } from './credentials';
import { ChatMessage, MistralChatResponse, MistralModel, MistralModelsResponse } from './types';

export class MistralClient {
  private readonly credentials: CredentialStore;

  constructor(context: vscode.ExtensionContext) {
    this.credentials = new CredentialStore(context);
  }

  async chat(messages: ChatMessage[], model = getModel()): Promise<string> {
    const apiKey = await this.getApiKey();

    const response = await fetch(`${getEndpoint()}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2
      })
    });

    const payload = (await response.json().catch(() => ({}))) as MistralChatResponse;
    if (!response.ok) {
      throw new Error(await this.describeHttpError(response.status, model, payload.error?.message));
    }

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Mistral returned an empty response.');
    }

    return contentToText(content);
  }

  async listModels(): Promise<MistralModel[]> {
    const apiKey = await this.getApiKey();
    const response = await fetch(`${getEndpoint()}/models`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json'
      }
    });

    const payload = (await response.json().catch(() => ({}))) as MistralModelsResponse;
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `Unable to list Mistral models. HTTP ${response.status}.`);
    }

    return payload.data ?? [];
  }

  async listChatModels(): Promise<string[]> {
    const models = await this.listModels();
    return models
      .filter(model => model.capabilities?.completion_chat !== false)
      .map(model => model.id)
      .sort((a, b) => a.localeCompare(b));
  }

  async validate(): Promise<void> {
    let chatModels: string[];
    try {
      chatModels = await this.listChatModels();
    } catch (error) {
      if (!isOfficialMistralEndpoint()) {
        await this.chat([
          { role: 'user', content: 'Reply with "ok" only.' }
        ]);
        return;
      }
      throw error;
    }

    if (chatModels.length === 0) {
      throw new Error('The API key is valid, but no chat-capable Mistral models are available for this workspace.');
    }
  }

  private async getApiKey(): Promise<string> {
    const profile = await this.credentials.getActiveProfile('mistral');
    if (!profile) {
      throw new Error('No Mistral API key profile is configured. Run "Mistral Vibe: Add Mistral API Key" first.');
    }
    return profile.value;
  }

  private async describeHttpError(status: number, model: string, apiMessage?: string): Promise<string> {
    if (status === 401) {
      return 'Mistral rejected the API key. Run "Mistral Vibe: Set API Key" and paste a current key from Mistral Studio.';
    }

    if (status === 403) {
      try {
        const chatModels = await this.listChatModels();
        if (chatModels.length > 0 && !chatModels.includes(model)) {
          return `Mistral accepted the key, but model "${model}" is not available to it. Run "Mistral Vibe: Select Model" and choose one of: ${chatModels.slice(0, 6).join(', ')}.`;
        }
      } catch {
        // Keep the original 403 path below when model listing is also forbidden.
      }

      return apiMessage ?? `Mistral returned HTTP 403 for model "${model}". Check that the API key has API access, billing/workspace access is enabled, and the selected model is available.`;
    }

    return apiMessage ?? `Mistral request failed with HTTP ${status}.`;
  }
}

function contentToText(content: string | Array<{ type?: string; text?: string }>): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .map(part => part.text)
    .filter((text): text is string => Boolean(text))
    .join('\n');
}

function isOfficialMistralEndpoint(): boolean {
  try {
    return new URL(getEndpoint()).hostname === 'api.mistral.ai';
  } catch {
    return false;
  }
}
