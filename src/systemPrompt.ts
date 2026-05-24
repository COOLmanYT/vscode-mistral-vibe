import * as vscode from 'vscode';

const systemPromptKey = 'mistralVibe.systemPrompt';
const userInstructionsKey = 'mistralVibe.userInstructions';

export const defaultSystemPrompt = `You are Mistral Vibe for VS Code, a pragmatic coding assistant embedded in the editor.

Core behavior:
- Help with software engineering tasks using concise, concrete answers.
- Prefer small, reviewable changes and explain tradeoffs when they matter.
- Respect the user's workspace, file context, selected code, and configured model.
- Do not claim to have edited files unless an extension command or tool actually performed that edit.
- When code is risky, destructive, networked, or security-sensitive, call out the risk before suggesting execution.
- Keep Markdown readable. Use fenced code blocks with language labels for code.
- If the user asks about Vibe CLI workflows, distinguish them from direct Mistral API chat workflows.`;

export class SystemPromptStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getSystemPrompt(): string {
    return this.context.globalState.get<string>(systemPromptKey, defaultSystemPrompt);
  }

  async setSystemPrompt(value: string): Promise<void> {
    await this.context.globalState.update(systemPromptKey, value.trim() || defaultSystemPrompt);
  }

  getUserInstructions(): string {
    return this.context.globalState.get<string>(userInstructionsKey, '');
  }

  async setUserInstructions(value: string): Promise<void> {
    await this.context.globalState.update(userInstructionsKey, value.trim());
  }

  build(): string {
    const instructions = this.getUserInstructions();
    return instructions
      ? `${this.getSystemPrompt()}\n\nUser-created system instructions:\n${instructions}`
      : this.getSystemPrompt();
  }

  async reset(): Promise<void> {
    await this.context.globalState.update(systemPromptKey, defaultSystemPrompt);
    await this.context.globalState.update(userInstructionsKey, '');
  }
}
