export type Role = 'system' | 'user' | 'assistant';

export type ContextMode = 'none' | 'selection' | 'currentFile' | 'openEditors' | 'workspace' | 'selectedFiles';

export interface MessageMeta {
  model?: string;
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  tokensPerSecond?: number;
  source?: 'chat' | 'vibe' | 'slash';
 }

export interface ChatMessage {
  id?: string;
  role: Role;
  content: string;
  createdAt?: number;
  meta?: MessageMeta;
}

export interface ChatTurn {
  id: string;
  title: string;
  createdAt: number;
  updatedAt?: number;
  contextMode?: ContextMode;
  messages: ChatMessage[];
}

export interface MistralChatResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

export interface MistralModel {
  id: string;
  capabilities?: {
    completion_chat?: boolean;
  };
}

export interface MistralModelsResponse {
  data?: MistralModel[];
  error?: {
    message?: string;
  };
}
