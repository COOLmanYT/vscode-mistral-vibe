import * as vscode from 'vscode';
import { ChatTurn } from './types';

const historyKey = 'mistralVibe.chatHistory';

export class ChatHistoryStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): ChatTurn[] {
    return this.context.globalState.get<ChatTurn[]>(historyKey, [])
      .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
  }

  get(id: string): ChatTurn | undefined {
    return this.list().find(turn => turn.id === id);
  }

  async upsert(turn: ChatTurn): Promise<void> {
    const existing = this.list().filter(item => item.id !== turn.id);
    const next = [{ ...turn, updatedAt: Date.now() }, ...existing].slice(0, 100);
    await this.context.globalState.update(historyKey, next);
  }

  async clear(): Promise<void> {
    await this.context.globalState.update(historyKey, []);
  }
}
