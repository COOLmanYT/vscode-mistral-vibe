import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getAvailableModels, getContextMode, getModel, isCodeSuggestionsEnabled, getCodeSuggestionModel } from './config';
import { ApiKeyKind, apiKeyKindLabel, ApiKeyProfileSummary, CredentialStore } from './credentials';
import { ChatHistoryStore } from './historyStore';
import { MistralClient } from './mistralClient';
import { SystemPromptStore } from './systemPrompt';
import { buildContext } from './workspaceContext';
import { discoverVibeCommands, runVibe, VibeCommand } from './vibeCli';
import { findPreferredBash, installVibe } from './vibeTerminal';
import { ChatMessage, ChatTurn, ContextMode } from './types';

type ActiveTab = 'chat' | 'vibe';

interface ChatPanelDependencies {
  client: MistralClient;
  credentials: CredentialStore;
  historyStore: ChatHistoryStore;
  systemPromptStore: SystemPromptStore;
  onHistoryChanged: () => void;
}

interface UiState {
  activeTab: ActiveTab;
  workspaceTrusted: boolean;
  model: string;
  models: string[];
  mistralKeys: ApiKeyProfileSummary[];
  vibeKeys: ApiKeyProfileSummary[];
  activeMistralKeyId?: string;
  activeVibeKeyId?: string;
  systemPrompt: string;
  userInstructions: string;
  bashPath?: string;
  contextMode: ContextMode;
  selectedContextFiles: string[];
  history: Array<Pick<ChatTurn, 'id' | 'title' | 'createdAt' | 'updatedAt'>>;
  vibeCommands: VibeCommand[];
  suggestionsEnabled: boolean;
  suggestionModel: string;
}

export class ChatPanel {
  private static current: ChatPanel | undefined;
  private activeTab: ActiveTab = 'chat';
  private activeTurnId: string = randomUUID();
  private messages: ChatMessage[] = [];
  private vibeMessages: ChatMessage[] = [];
  private contextMode: ContextMode = getContextMode();
  private selectedContextFiles: string[] = [];
  private vibeCommands: VibeCommand[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: ChatPanelDependencies
  ) {
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: []
    };
    this.panel.webview.html = this.render();
    this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message));
    this.panel.onDidDispose(() => {
      ChatPanel.current = undefined;
    });
    void this.loadVibeCommands();
  }

  static show(context: vscode.ExtensionContext, deps: ChatPanelDependencies, activeTab: ActiveTab = 'chat', turn?: ChatTurn): ChatPanel {
    if (ChatPanel.current) {
      ChatPanel.current.activeTab = activeTab;
      if (turn) {
        ChatPanel.current.loadTurn(turn);
      }
      ChatPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      void ChatPanel.current.postState();
      ChatPanel.current.postMessages();
      return ChatPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      'mistralVibeChat',
      'Mistral Vibe',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    ChatPanel.current = new ChatPanel(panel, deps);
    ChatPanel.current.activeTab = activeTab;
    if (turn) {
      ChatPanel.current.loadTurn(turn);
    }
    context.subscriptions.push(panel);
    return ChatPanel.current;
  }

  loadTurn(turn: ChatTurn): void {
    this.activeTurnId = turn.id;
    this.messages = turn.messages;
    this.contextMode = turn.contextMode ?? getContextMode();
    this.activeTab = 'chat';
    this.postMessages();
  }

  async ask(prompt: string): Promise<void> {
    if (await this.handleSlashCommand(prompt)) {
      return;
    }

    const contextText = await buildContext(this.contextMode, this.selectedContextFiles);
    const userContent = [contextText, prompt].filter(Boolean).join('\n\n');
    const userMessage = this.createMessage('user', prompt);
    const requestMessages: ChatMessage[] = [
      { role: 'system', content: this.deps.systemPromptStore.build() },
      ...this.messages,
      { role: 'user', content: userContent }
    ];

    this.messages.push(userMessage);
    this.postMessages();
    this.panel.webview.postMessage({ type: 'busy', value: true });

    const startedAt = Date.now();
    try {
      const response = await this.deps.client.chat(requestMessages);
      const elapsedMs = Date.now() - startedAt;
      const outputTokens = estimateTokens(response);
      this.messages.push(this.createMessage('assistant', response, {
        model: getModel(),
        elapsedMs,
        inputTokens: estimateTokens(requestMessages.map(message => message.content).join('\n')),
        outputTokens,
        tokensPerSecond: outputTokens / Math.max(elapsedMs / 1000, 0.001),
        source: 'chat'
      }));
      await this.saveActiveTurn();
      this.postMessages();
      await this.postState();
    } finally {
      this.panel.webview.postMessage({ type: 'busy', value: false });
    }
  }

  private async handleMessage(message: {
    type?: string;
    value?: string;
    kind?: ApiKeyKind;
    id?: string;
    index?: number;
    systemPrompt?: string;
    userInstructions?: string;
    tab?: ActiveTab;
    contextMode?: ContextMode;
  }) {
    try {
      switch (message.type) {
        case 'ready':
          await this.postState();
          this.postMessages();
          return;
        case 'setTab':
          this.activeTab = message.tab === 'vibe' ? 'vibe' : 'chat';
          await this.postState();
          this.postMessages();
          return;
        case 'ask':
          if (message.value?.trim()) {
            await this.ask(message.value.trim());
          }
          return;
        case 'runVibeInline':
          if (message.value?.trim()) {
            await this.runVibeInline(message.value.trim());
          }
          return;
        case 'selectModel':
          if (message.value) {
            await vscode.workspace.getConfiguration('mistralVibe').update('model', message.value, vscode.ConfigurationTarget.Global);
            await this.postState();
          }
          return;
        case 'selectApiKey':
          if (message.kind && message.id) {
            await this.deps.credentials.setActiveProfileId(message.kind, message.id);
            await this.postState();
          }
          return;
        case 'addApiKey':
          if (message.kind) {
            await this.addApiKey(message.kind);
            await this.postState();
          }
          return;
        case 'saveSystemPrompt':
          await this.deps.systemPromptStore.setSystemPrompt(message.systemPrompt ?? '');
          await this.deps.systemPromptStore.setUserInstructions(message.userInstructions ?? '');
          vscode.window.showInformationMessage('Mistral Vibe system instructions saved.');
          await this.postState();
          return;
        case 'resetSystemPrompt':
          await this.deps.systemPromptStore.reset();
          await this.postState();
          return;
        case 'selectContextMode':
          if (message.contextMode) {
            this.contextMode = message.contextMode;
            await vscode.workspace.getConfiguration('mistralVibe').update('contextMode', message.contextMode, vscode.ConfigurationTarget.Workspace);
            await this.postState();
          }
          return;
        case 'pickContextFiles':
          await this.pickContextFiles();
          await this.postState();
          return;
        case 'configureShell':
          await configureVibeShellPath();
          await this.postState();
          return;
        case 'installVibe':
          await installVibe();
          return;
        case 'openHistory':
          if (message.id) {
            const turn = this.deps.historyStore.get(message.id);
            if (turn) {
              this.loadTurn(turn);
              await this.postState();
            }
          }
          return;
        case 'newChat':
          this.activeTurnId = randomUUID();
          this.messages = [];
          this.postMessages();
          await this.postState();
          return;
        case 'editMessage':
          if (typeof message.index === 'number') {
            await this.editMessage(message.index);
          }
          return;
        case 'applyCode':
          if (typeof message.index === 'number') {
            await this.applyCodeFromMessage(message.index);
          }
          return;
      }
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      this.panel.webview.postMessage({ type: 'busy', value: false });
    }
  }

  private async runVibeInline(commandLine: string): Promise<void> {
    const args = parseCommandLine(commandLine);
    if (args.length === 0) {
      return;
    }

    const vibeProfile = await this.deps.credentials.getActiveProfile('vibe');
    const env = vibeProfile ? { MISTRAL_API_KEY: vibeProfile.value } : {};
    const startedAt = Date.now();
    this.vibeMessages.push(this.createMessage('user', `vibe ${commandLine}`, { source: 'vibe' }));
    this.postMessages();
    this.panel.webview.postMessage({ type: 'busy', value: true });

    try {
      const output = await runVibe(args, undefined, env);
      const elapsedMs = Date.now() - startedAt;
      this.vibeMessages.push(this.createMessage('assistant', output || '(no output)', {
        elapsedMs,
        outputTokens: estimateTokens(output),
        tokensPerSecond: estimateTokens(output) / Math.max(elapsedMs / 1000, 0.001),
        source: 'vibe'
      }));
      this.postMessages();
    } finally {
      this.panel.webview.postMessage({ type: 'busy', value: false });
    }
  }

  private async handleSlashCommand(prompt: string): Promise<boolean> {
    if (!prompt.startsWith('/')) {
      return false;
    }

    const [rawCommand, ...rest] = prompt.slice(1).trim().split(/\s+/);
    const command = rawCommand.toLowerCase();
    const value = rest.join(' ');

    if (command === 'model') {
      if (value) {
        await vscode.workspace.getConfiguration('mistralVibe').update('model', value, vscode.ConfigurationTarget.Global);
      }
      await this.addLocalAssistantMessage(`Active model: \`${getModel()}\``);
      await this.postState();
      return true;
    }

    if (command === 'context') {
      if (isContextMode(value)) {
        this.contextMode = value;
        await vscode.workspace.getConfiguration('mistralVibe').update('contextMode', value, vscode.ConfigurationTarget.Workspace);
      }
      await this.addLocalAssistantMessage(`Context mode: \`${this.contextMode}\`\n\nAvailable modes: none, selection, currentFile, openEditors, workspace, selectedFiles.`);
      await this.postState();
      return true;
    }

    if (command === 'goal' || command === 'reasoning' || command === 'personality') {
      const prefix = command === 'goal' ? 'Goal' : command === 'reasoning' ? 'Reasoning preference' : 'Personality';
      const next = [this.deps.systemPromptStore.getUserInstructions(), value ? `${prefix}: ${value}` : ''].filter(Boolean).join('\n');
      await this.deps.systemPromptStore.setUserInstructions(next);
      await this.addLocalAssistantMessage(`${prefix} saved to system instructions.`);
      await this.postState();
      return true;
    }

    if (command === 'status' || command === 'config') {
      const mistralKeys = await this.deps.credentials.getProfileSummaries('mistral');
      const vibeKeys = await this.deps.credentials.getProfileSummaries('vibe');
      await this.addLocalAssistantMessage([
        `Model: \`${getModel()}\``,
        `Context: \`${this.contextMode}\``,
        `Mistral keys: ${mistralKeys.length}`,
        `Vibe keys: ${vibeKeys.length}`,
        `Code suggestions: ${isCodeSuggestionsEnabled() ? 'on' : 'off'} (\`${getCodeSuggestionModel()}\`)`,
        `Bash/Git Bash: ${findPreferredBash() ?? 'not configured'}`
      ].join('\n'));
      return true;
    }

    if (command === 'mcp') {
      await this.addLocalAssistantMessage('MCP configuration is handled by Mistral Vibe `config.toml`. Use the Vibe tab or `vibe --setup` to configure CLI-side MCP servers.');
      return true;
    }

    if (command === 'file' || command === 'directory' || rawCommand.includes('/') || rawCommand.includes('\\')) {
      await this.readPathSlashCommand(command === 'file' || command === 'directory' ? value : rawCommand);
      return true;
    }

    await this.addLocalAssistantMessage(`Unknown slash command: \`/${command}\`.\n\nTry /status, /model, /context, /goal, /reasoning, /personality, /mcp, /file, or /directory.`);
    return true;
  }

  private async readPathSlashCommand(rawPath: string): Promise<void> {
    if (!rawPath) {
      await this.addLocalAssistantMessage('Provide a file or directory path.');
      return;
    }

    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const resolved = path.resolve(workspace ?? process.cwd(), rawPath);
    if (!workspace || !isInsideDirectory(resolved, workspace)) {
      await this.addLocalAssistantMessage('That path is outside the current workspace, so it was not read.');
      return;
    }

    const stat = await fs.stat(resolved);

    if (stat.isDirectory()) {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      await this.addLocalAssistantMessage(entries.slice(0, 100).map(entry => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`).join('\n'));
      return;
    }

    const content = await fs.readFile(resolved, 'utf8');
    await this.addLocalAssistantMessage(`File: ${vscode.workspace.asRelativePath(vscode.Uri.file(resolved), false)}\n\n\`\`\`\n${content.slice(0, 20_000)}\n\`\`\``);
  }

  private async addLocalAssistantMessage(content: string): Promise<void> {
    this.messages.push(this.createMessage('assistant', content, { source: 'slash', outputTokens: estimateTokens(content) }));
    await this.saveActiveTurn();
    this.postMessages();
  }

  private async addApiKey(kind: ApiKeyKind) {
    const label = apiKeyKindLabel(kind);
    const name = await vscode.window.showInputBox({
      title: `Add ${label} Key`,
      prompt: kind === 'mistral'
        ? 'Name this regular Mistral API key profile.'
        : 'Name this Vibe/Codestral CLI API key profile.',
      ignoreFocusOut: true,
      validateInput(value) {
        return value.trim().length === 0 ? 'Enter a profile name.' : undefined;
      }
    });

    if (!name) {
      return;
    }

    const value = await vscode.window.showInputBox({
      title: `Add ${label} Key`,
      prompt: kind === 'mistral'
        ? 'Paste a regular Mistral API key for /v1 chat and model endpoints.'
        : 'Paste a Vibe/Codestral CLI API key. It is used only for Vibe CLI processes.',
      password: true,
      ignoreFocusOut: true,
      validateInput(input) {
        return input.trim().length < 8 ? 'API key is too short.' : undefined;
      }
    });

    if (!value) {
      return;
    }

    const profile = await this.deps.credentials.addProfile(kind, name.trim(), value.trim());
    vscode.window.showInformationMessage(`${label} key "${profile.name}" saved and selected. Ending in ${profile.last4}.`);
  }

  private async pickContextFiles(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      title: 'Select Mistral Context Files',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
    });

    if (uris) {
      this.selectedContextFiles = uris.map(uri => uri.fsPath);
      this.contextMode = 'selectedFiles';
      await vscode.workspace.getConfiguration('mistralVibe').update('contextMode', 'selectedFiles', vscode.ConfigurationTarget.Workspace);
    }
  }

  private async editMessage(index: number): Promise<void> {
    const list = this.activeTab === 'vibe' ? this.vibeMessages : this.messages;
    const message = list[index];
    if (!message) {
      return;
    }

    const value = await vscode.window.showInputBox({
      title: `Edit ${message.role} message`,
      value: message.content,
      ignoreFocusOut: true
    });

    if (value === undefined) {
      return;
    }

    message.content = value;
    message.meta = { ...message.meta, outputTokens: estimateTokens(value) };
    if (this.activeTab === 'chat') {
      await this.saveActiveTurn();
    }
    this.postMessages();
  }

  private async applyCodeFromMessage(index: number): Promise<void> {
    const message = this.messages[index];
    if (!message) {
      return;
    }

    const block = extractFirstCodeBlock(message.content);
    if (!block) {
      vscode.window.showWarningMessage('No fenced code block found in that message.');
      return;
    }

    const target = block.filePath ? await this.resolveWorkspaceTarget(block.filePath) : undefined;
    if (target) {
      await vscode.workspace.fs.writeFile(target, Buffer.from(block.code, 'utf8'));
      const doc = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(`Applied code to ${vscode.workspace.asRelativePath(target, false)}.`);
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Open a target file or include a file path before the code block.');
      return;
    }

    await editor.edit(edit => {
      if (editor.selection.isEmpty) {
        edit.insert(editor.selection.active, block.code);
      } else {
        edit.replace(editor.selection, block.code);
      }
    });
    vscode.window.showInformationMessage('Applied code to the active editor.');
  }

  private async resolveWorkspaceTarget(rawPath: string): Promise<vscode.Uri | undefined> {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspace) {
      return undefined;
    }

    const resolved = path.resolve(workspace, rawPath);
    if (!isInsideDirectory(resolved, workspace)) {
      return undefined;
    }

    return vscode.Uri.file(resolved);
  }

  private async getState(): Promise<UiState> {
    const mistralKeys = await this.deps.credentials.getProfileSummaries('mistral');
    const vibeKeys = await this.deps.credentials.getProfileSummaries('vibe');
    const activeMistral = await this.deps.credentials.getActiveProfile('mistral');
    const activeVibe = await this.deps.credentials.getActiveProfile('vibe');
    let models = getAvailableModels();

    if (activeMistral) {
      try {
        const liveModels = await this.deps.client.listChatModels();
        if (liveModels.length > 0) {
          models = liveModels;
        }
      } catch {
        // Keep configured fallbacks. Connection validation surfaces the detailed error.
      }
    }

    return {
      activeTab: this.activeTab,
      workspaceTrusted: vscode.workspace.isTrusted,
      model: getModel(),
      models,
      mistralKeys,
      vibeKeys,
      activeMistralKeyId: activeMistral?.id,
      activeVibeKeyId: activeVibe?.id,
      systemPrompt: this.deps.systemPromptStore.getSystemPrompt(),
      userInstructions: this.deps.systemPromptStore.getUserInstructions(),
      bashPath: findPreferredBash(),
      contextMode: this.contextMode,
      selectedContextFiles: this.selectedContextFiles.map(filePath => vscode.workspace.asRelativePath(vscode.Uri.file(filePath), false)),
      history: this.deps.historyStore.list().map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt })),
      vibeCommands: this.vibeCommands,
      suggestionsEnabled: isCodeSuggestionsEnabled(),
      suggestionModel: getCodeSuggestionModel()
    };
  }

  private async loadVibeCommands(): Promise<void> {
    this.vibeCommands = await discoverVibeCommands();
    await this.postState();
  }

  private async saveActiveTurn(): Promise<void> {
    const firstUserMessage = this.messages.find(message => message.role === 'user')?.content ?? 'New chat';
    await this.deps.historyStore.upsert({
      id: this.activeTurnId,
      title: firstUserMessage.slice(0, 80),
      createdAt: this.messages[0]?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      contextMode: this.contextMode,
      messages: this.messages
    });
    this.deps.onHistoryChanged();
  }

  private createMessage(role: 'user' | 'assistant', content: string, meta = {}): ChatMessage {
    return {
      id: randomUUID(),
      role,
      content,
      createdAt: Date.now(),
      meta
    };
  }

  private async postState() {
    this.panel.webview.postMessage({
      type: 'state',
      value: await this.getState()
    });
  }

  private postMessages() {
    this.panel.webview.postMessage({
      type: 'messages',
      value: this.activeTab === 'vibe' ? this.vibeMessages : this.messages
    });
  }

  private render(): string {
    const nonce = randomUUID();
    const csp = [
      "default-src 'none'",
      `style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`
    ].join('; ');

    return /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --mistral-black: #1c1c1b;
      --mistral-yellow: #ffce00;
      --mistral-amber: #ffa300;
      --mistral-orange: #ff7000;
      --mistral-flame: #ff4900;
      --mistral-red: #ff0107;
      --mistral-cream: #fff7df;
    }
    * { box-sizing: border-box; }
    body {
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      margin: 0;
    }
    main { display: grid; grid-template-rows: auto 1fr auto; height: 100vh; min-width: 320px; }
    nav {
      align-items: center;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      justify-content: center;
      gap: 0;
      padding: 10px 12px;
    }
    .tab {
      background: transparent;
      border: 1px solid color-mix(in srgb, var(--mistral-orange) 55%, var(--vscode-panel-border));
      border-radius: 0;
      color: var(--vscode-foreground);
      min-height: 32px;
      min-width: 96px;
    }
    .tab:first-child { border-radius: 6px 0 0 6px; }
    .tab:last-child { border-left: 0; border-radius: 0 6px 6px 0; }
    .tab.active { background: var(--mistral-black); color: var(--mistral-cream); }
    #content { overflow: auto; padding: 12px; }
    .toolbar {
      align-items: end;
      display: grid;
      gap: 8px;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      margin-bottom: 12px;
    }
    label { display: grid; gap: 4px; font-size: 12px; font-weight: 700; }
    select, textarea, input {
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid color-mix(in srgb, var(--mistral-amber) 75%, var(--vscode-input-border));
      border-radius: 6px;
      font-family: var(--vscode-font-family);
      padding: 7px;
      width: 100%;
    }
    textarea { min-height: 72px; resize: vertical; }
    select:focus, textarea:focus, input:focus {
      border-color: var(--mistral-flame);
      outline: 1px solid var(--mistral-flame);
    }
    .buttonRow { display: flex; flex-wrap: wrap; gap: 8px; }
    button {
      background: var(--mistral-black);
      border: 1px solid var(--mistral-black);
      border-radius: 6px;
      color: var(--mistral-cream);
      cursor: pointer;
      font-weight: 700;
      min-height: 31px;
      padding: 0 12px;
      white-space: nowrap;
    }
    button:hover { background: var(--mistral-flame); border-color: var(--mistral-flame); }
    button.secondary {
      background: transparent;
      border-color: color-mix(in srgb, var(--mistral-orange) 70%, var(--vscode-panel-border));
      color: var(--vscode-foreground);
    }
    .setup, .section {
      border: 1px solid color-mix(in srgb, var(--mistral-orange) 60%, var(--vscode-panel-border));
      border-left: 4px solid var(--mistral-flame);
      border-radius: 6px;
      margin-bottom: 12px;
      padding: 12px;
    }
    .setup h2, .section h2 { font-size: 13px; margin: 0 0 6px; }
    .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .messages { display: grid; gap: 8px; }
    article {
      border-left: 3px solid var(--mistral-orange);
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 10px 0 10px 12px;
    }
    article.user { border-left-color: var(--mistral-yellow); }
    article.assistant { border-left-color: var(--mistral-flame); }
    .role {
      color: var(--mistral-flame);
      display: inline-block;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0;
      margin-bottom: 6px;
      text-transform: uppercase;
    }
    article.user .role { color: var(--mistral-amber); }
    .meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin: 4px 0 8px; }
    details { margin-top: 8px; }
    pre {
      background: var(--vscode-textCodeBlock-background);
      border: 1px solid color-mix(in srgb, var(--mistral-orange) 40%, var(--vscode-panel-border));
      overflow: auto;
      padding: 12px;
      border-radius: 6px;
    }
    code { font-family: var(--vscode-editor-font-family); }
    .copyMenu { display: inline-flex; gap: 6px; margin-top: 6px; }
    /* icon-style buttons used across the chat UI */
    .iconBtn {
      width: 34px;
      height: 34px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      background: transparent;
      border: 1px solid transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
    }
    .iconBtn svg { width: 16px; height: 16px; display: block; }
    .iconBtn:hover { background: var(--mistral-flame); color: var(--mistral-cream); border-color: var(--mistral-flame); }
    .iconBtn.secondary { opacity: 0.9; }
    form {
      background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--mistral-yellow));
      border-top: 1px solid color-mix(in srgb, var(--mistral-orange) 60%, var(--vscode-panel-border));
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      padding: 12px;
    }
    #prompt { min-height: 58px; }
    .toast {
      background: var(--mistral-black);
      border: 1px solid var(--mistral-orange);
      border-radius: 6px;
      bottom: 74px;
      color: var(--mistral-cream);
      display: none;
      padding: 8px 10px;
      position: fixed;
      right: 12px;
      z-index: 2;
    }
    @media (max-width: 560px) {
      form { grid-template-columns: 1fr; }
      .toolbar { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <nav>
      <button class="tab" data-tab="chat">Chat</button>
      <button class="tab" data-tab="vibe">Vibe</button>
    </nav>
    <section id="content"></section>
    <form id="form">
      <textarea id="prompt" placeholder="Ask Mistral about this workspace"></textarea>
      <button id="send" type="submit">Send</button>
    </form>
  </main>
  <div class="toast" id="toast"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const content = document.getElementById('content');
    const form = document.getElementById('form');
    const prompt = document.getElementById('prompt');
    const send = document.getElementById('send');
    const toast = document.getElementById('toast');
    let state;
    let messages = [];

    // Icon helpers: return inline SVGs and build icon-only buttons
    function iconSvg(name) {
      switch (name) {
        case 'plus': return '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>';
        case 'key': return '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M7 14a3 3 0 100-6 3 3 0 000 6zm10.5-1.5L23 4l-2.5-2.5L15 6l2.5 2.5L17.5 12.5zM14 8l-6 6v2h2l6-6-2-2z"/></svg>';
        case 'pencil': return '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
        case 'code': return '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M8.7 17.3L3.4 12l5.3-5.3L7 5 1 11l6 6 1.7-1.7zM15.3 6.7L20.6 12l-5.3 5.3L17 19l6-6-6-6-1.7 1.7z"/></svg>';
        case 'play': return '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M8 5v14l11-7z"/></svg>';
        case 'cloud': return '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M19 18H6a4 4 0 010-8c.2 0 .4 0 .6.1A5 5 0 1119 18z"/></svg>';
        case 'gear': return '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M19.4 13c.04-.33.06-.66.06-1s-.02-.67-.06-1l2.11-1.65a.5.5 0 00.12-.64l-2-3.46a.5.5 0 00-.6-.22l-2.49 1a7.03 7.03 0 00-1.7-.99l-.38-2.65A.5.5 0 0012 2h-4a.5.5 0 00-.5.42L7.12 5.07c-.6.23-1.16.54-1.66.92l-2.49-1a.5.5 0 00-.6.22l-2 3.46a.5.5 0 00.12.64L4.2 11c-.04.33-.06.66-.06 1s.02.67.06 1L1.9 14.65a.5.5 0 00-.12.64l2 3.46c.14.24.43.34.68.22l2.49-1c.5.38 1.06.69 1.66.92l.38 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.38-2.65c.6-.23 1.16-.54 1.7-.99l2.49 1c.25.12.54.02.68-.22l2-3.46a.5.5 0 00-.12-.64L19.4 13zM12 15.5A3.5 3.5 0 1112 8.5a3.5 3.5 0 010 7z"/></svg>';
        case 'check': return '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M9 16.2l-3.5-3.5L4 14.2 9 19l12-12-1.5-1.5z"/></svg>';
        case 'clipboard': return '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M16 2H8a2 2 0 00-2 2v1H4v16a2 2 0 002 2h12a2 2 0 002-2V5h-2V4a2 2 0 00-2-2zM9 4h6v2H9V4z"/></svg>';
        default: return '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10"/></svg>';
      }
    }

    function iconButton(action, title, iconName, attrs) {
      attrs = attrs || '';
      return '<button class="iconBtn" data-action="' + escapeAttr(action) + '" title="' + escapeAttr(title) + '" ' + attrs + '>' + iconSvg(iconName) + '</button>';
    }

    vscode.postMessage({ type: 'ready' });

    document.querySelector('nav').addEventListener('click', event => {
      const tab = event.target.dataset.tab;
      if (tab) vscode.postMessage({ type: 'setTab', tab });
    });

    content.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button) return;
      const action = button.dataset.action;
      if (button.dataset.copyIndex) copyMessage(Number(button.dataset.copyIndex), button.dataset.copyFormat);
      if (action === 'addMistralKey') vscode.postMessage({ type: 'addApiKey', kind: 'mistral' });
      if (action === 'addVibeKey') vscode.postMessage({ type: 'addApiKey', kind: 'vibe' });
      if (action === 'saveSystemPrompt') vscode.postMessage({
        type: 'saveSystemPrompt',
        systemPrompt: document.getElementById('systemPrompt').value,
        userInstructions: document.getElementById('userInstructions').value
      });
      if (action === 'resetSystemPrompt') vscode.postMessage({ type: 'resetSystemPrompt' });
      if (action === 'pickContextFiles') vscode.postMessage({ type: 'pickContextFiles' });
      if (action === 'configureShell') vscode.postMessage({ type: 'configureShell' });
      if (action === 'installVibe') vscode.postMessage({ type: 'installVibe' });
      if (action === 'newChat') vscode.postMessage({ type: 'newChat' });
      if (action === 'editMessage') vscode.postMessage({ type: 'editMessage', index: Number(button.dataset.index) });
      if (action === 'applyCode') vscode.postMessage({ type: 'applyCode', index: Number(button.dataset.index) });
      if (action === 'openHistory') vscode.postMessage({ type: 'openHistory', id: button.dataset.id });
      if (action === 'runVibe') {
        const value = document.getElementById('vibeCommand').value.trim();
        if (value) vscode.postMessage({ type: 'runVibeInline', value });
      }
    });

    content.addEventListener('change', event => {
      if (event.target.id === 'modelSelect') vscode.postMessage({ type: 'selectModel', value: event.target.value });
      if (event.target.id === 'mistralKeySelect') vscode.postMessage({ type: 'selectApiKey', kind: 'mistral', id: event.target.value });
      if (event.target.id === 'vibeKeySelect') vscode.postMessage({ type: 'selectApiKey', kind: 'vibe', id: event.target.value });
      if (event.target.id === 'contextMode') vscode.postMessage({ type: 'selectContextMode', contextMode: event.target.value });
    });

    form.addEventListener('submit', event => {
      event.preventDefault();
      const value = prompt.value.trim();
      if (!value) return;
      vscode.postMessage({ type: state.activeTab === 'chat' ? 'ask' : 'runVibeInline', value });
      prompt.value = '';
    });

    window.addEventListener('message', event => {
      if (event.data.type === 'state') {
        state = event.data.value;
        render();
      }
      if (event.data.type === 'messages') {
        messages = event.data.value;
        render();
      }
      if (event.data.type === 'busy') {
        send.disabled = Boolean(event.data.value);
        send.textContent = event.data.value ? 'Working' : 'Send';
      }
    });

    function render() {
      if (!state) return;
      document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === state.activeTab));
      prompt.placeholder = state.activeTab === 'chat' ? 'Ask Mistral, or use /status, /model, /context, /file...' : 'Run Vibe arguments, e.g. --help or ask "write tests"';
      form.style.display = 'grid';
      content.innerHTML = state.activeTab === 'chat' ? renderChat() : renderVibe();
    }

    function renderChat() {
      const setup = state.mistralKeys.length === 0 ? setupCard(
        'First-time Chat setup',
        'Add a regular Mistral API key, then choose a model. Direct chat uses the Mistral REST API.',
        '<button data-action="addMistralKey">Add Mistral API Key</button>'
      ) : '';

      return setup + toolbar([
        selectControl('modelSelect', 'Model', state.models, state.model),
        keySelect('mistralKeySelect', 'Mistral API Key', state.mistralKeys, state.activeMistralKeyId),
        contextControls(),
        '<div class="buttonRow">' + iconButton('addMistralKey','Add Key','key') + iconButton('newChat','New Chat','plus') + '</div>'
      ]) + historyList() + systemPromptEditor() + suggestionsInfo() + '<div class="messages">' + messages.map(renderMessage).join('') + '</div>';
    }

    function renderVibe() {
      const setup = state.vibeKeys.length === 0 ? setupCard(
        'First-time Vibe setup',
        'Add a Vibe/Codestral key and install the Vibe CLI. Commands run inside the extension host and output renders here.',
        '<button data-action="addVibeKey">Add Vibe API Key</button><button class="secondary" data-action="installVibe">Install Vibe</button>'
      ) : '';
      const shell = state.bashPath ? escapeHtml(state.bashPath) : 'No Bash/Git Bash found; configure mistralVibe.vibeShellPath.';
      return setup + toolbar([
        keySelect('vibeKeySelect', 'Vibe API Key', state.vibeKeys, state.activeVibeKeyId),
        '<label>Bash / Git Bash<span class="muted">' + shell + '</span></label>',
        '<div class="buttonRow"><button data-action="addVibeKey">Add Key</button><button class="secondary" data-action="configureShell">Configure Shell</button><button class="secondary" data-action="installVibe">Install</button></div>'
      ]) + '<section class="section"><h2>Run Vibe command</h2><p class="muted">Enter arguments after <code>vibe</code>. Examples: <code>--help</code>, <code>--setup</code>, <code>ask "explain this repo"</code>.</p><label>Command<textarea id="vibeCommand" placeholder="--help"></textarea></label><div class="buttonRow"><button data-action="runVibe">Run Inside Extension</button></div></section><div class="messages">' + messages.map(renderMessage).join('') + '</div>';
    }

    function toolbar(items) {
      return '<div class="toolbar">' + items.join('') + '</div>';
    }

    function setupCard(title, body, actions) {
      return '<section class="setup"><h2>' + escapeHtml(title) + '</h2><p class="muted">' + escapeHtml(body) + '</p><div class="buttonRow">' + actions + '</div></section>';
    }

    function selectControl(id, label, options, selected) {
      return '<label>' + escapeHtml(label) + '<select id="' + id + '">' + options.map(option => '<option value="' + escapeAttr(option) + '"' + (option === selected ? ' selected' : '') + '>' + escapeHtml(option) + '</option>').join('') + '</select></label>';
    }

    function keySelect(id, label, keys, selectedId) {
      const options = keys.length
        ? keys.map(key => '<option value="' + escapeAttr(key.id) + '"' + (key.id === selectedId ? ' selected' : '') + '>' + escapeHtml(key.name + ' ...' + key.last4) + '</option>').join('')
        : '<option value="">No saved keys</option>';
      return '<label>' + escapeHtml(label) + '<select id="' + id + '">' + options + '</select></label>';
    }

    function contextControls() {
      const modes = ['none', 'selection', 'currentFile', 'openEditors', 'workspace', 'selectedFiles'];
      const selected = state.selectedContextFiles.length ? '<span class="muted">' + escapeHtml(state.selectedContextFiles.join(', ')) + '</span>' : '<span class="muted">No files selected</span>';
      return '<label>Context<select id="contextMode">' + modes.map(mode => '<option value="' + mode + '"' + (mode === state.contextMode ? ' selected' : '') + '>' + mode + '</option>').join('') + '</select>' + selected + '</label><div class="buttonRow">' + iconButton('pickContextFiles','Select Files','plus') + '</div>';
    }

    function historyList() {
      if (!state.history.length) return '';
      return '<details class="section"><summary>Chat history</summary><div class="buttonRow">' + state.history.slice(0, 12).map(turn => '<button class="secondary" data-action="openHistory" data-id="' + escapeAttr(turn.id) + '">' + escapeHtml(turn.title) + '</button>').join('') + '</div></details>';
    }

    function suggestionsInfo() {
      return '<section class="section"><h2>Code suggestions</h2><p class="muted">Inline code suggestions are ' + (state.suggestionsEnabled ? 'on' : 'off') + '. Model: <code>' + escapeHtml(state.suggestionModel) + '</code>.</p></section>';
    }

    function systemPromptEditor() {
      return '<details class="setup"><summary>System prompt, custom instructions, and output options</summary><label>System prompt<textarea id="systemPrompt">' + escapeHtml(state.systemPrompt) + '</textarea></label><label>System instructions<textarea id="userInstructions" placeholder="Add project or personal instructions here">' + escapeHtml(state.userInstructions) + '</textarea></label><p class="muted">Slash commands: /status, /model, /context, /goal, /reasoning, /personality, /mcp, /file, /directory.</p><div class="buttonRow">' + iconButton('saveSystemPrompt','Save Instructions','check') + iconButton('resetSystemPrompt','Reset Instructions','gear') + '</div></details>';
    }

    function renderMessage(message, index) {
      const content = markdown(message.content);
      const meta = renderMeta(message.meta);
      const body = message.content.length > 2500
        ? '<details open><summary>' + escapeHtml(message.role) + '</summary>' + content + '</details>'
        : '<span class="role">' + escapeHtml(message.role) + '</span>' + meta + content;
      const apply = message.role === 'assistant' && state.activeTab === 'chat' ? iconButton('applyCode','Apply Code','code','data-index="' + index + '"') : '';
      const copyBtns = iconButton('', 'Copy Markdown','clipboard','data-copy-index="' + index + '" data-copy-format="markdown"') + iconButton('', 'Plaintext','clipboard','data-copy-index="' + index + '" data-copy-format="plain"') + iconButton('', 'Formatting','clipboard','data-copy-index="' + index + '" data-copy-format="formatted"');
      const editBtn = iconButton('editMessage','Edit','pencil','data-index="' + index + '"');
      return '<article class="' + escapeAttr(message.role) + '">' + body + '<div class="copyMenu">' + copyBtns + editBtn + apply + '</div></article>';
    }

    function renderMeta(meta) {
      if (!meta) return '';
      const parts = [];
      if (meta.model) parts.push(meta.model);
      if (meta.inputTokens) parts.push('in ' + meta.inputTokens + ' tok');
      if (meta.outputTokens) parts.push('out ' + meta.outputTokens + ' tok');
      if (meta.elapsedMs) parts.push((meta.elapsedMs / 1000).toFixed(2) + 's');
      if (meta.tokensPerSecond) parts.push(meta.tokensPerSecond.toFixed(1) + ' tok/s');
      return parts.length ? '<div class="meta">' + parts.map(escapeHtml).join(' · ') + '</div>' : '';
    }

    async function copyMessage(index, format) {
      const message = messages[index];
      if (!message) return;
      const markdownValue = message.content;
      const plain = stripMarkdown(markdownValue);
      if (format === 'formatted' && navigator.clipboard.write && window.ClipboardItem) {
        const html = markdown(markdownValue);
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' })
        })]);
      } else {
        await navigator.clipboard.writeText(format === 'plain' ? plain : markdownValue);
      }
      showToast('Copied ' + format);
    }

    function showToast(message) {
      toast.textContent = message;
      toast.style.display = 'block';
      setTimeout(() => { toast.style.display = 'none'; }, 1600);
    }

    function markdown(text) {
      return escapeHtml(text)
        .replace(/\`\`\`([a-zA-Z0-9_./\\\\-]+)?\\n?([\\s\\S]*?)\`\`\`/g, (_match, language, code) => {
          const className = language ? ' class="language-' + escapeAttr(language) + '"' : '';
          return '<pre><code' + className + '>' + code + '</code></pre>';
        })
        .replace(/^> (.*)$/gm, '<blockquote>$1</blockquote>')
        .replace(/^### (.*)$/gm, '<h3>$1</h3>')
        .replace(/^## (.*)$/gm, '<h2>$1</h2>')
        .replace(/^# (.*)$/gm, '<h1>$1</h1>')
        .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\*([^*]+)\\*/g, '<em>$1</em>')
        .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
        .replace(/^[-*] (.*)$/gm, '<li>$1</li>')
        .replace(/\\n\\n/g, '</p><p>')
        .replace(/^/, '<p>')
        .replace(/$/, '</p>');
    }

    function stripMarkdown(value) {
      return value
        .replace(/\`\`\`[a-zA-Z0-9_./\\\\-]*\\n?([\\s\\S]*?)\`\`\`/g, '$1')
        .replace(/[#>*_\`\\[\\]()]/g, '')
        .trim();
    }

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/\\n/g, '&#10;');
    }
  </script>
</body>
</html>`;
  }
}

export async function configureVibeShellPath(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    title: 'Select Bash or Git Bash executable',
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false
  });

  const value = picked?.[0]?.fsPath ?? await vscode.window.showInputBox({
    title: 'Configure Vibe Shell Path',
    prompt: 'Enter the Bash/Git Bash executable path.',
    value: findPreferredBash() ?? ''
  });

  if (value) {
    await vscode.workspace.getConfiguration('mistralVibe').update('vibeShellPath', value, vscode.ConfigurationTarget.Global);
  }
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function parseCommandLine(value: string): string[] {
  const args: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3]);
  }
  return args;
}

function isContextMode(value: string): value is ContextMode {
  return ['none', 'selection', 'currentFile', 'openEditors', 'workspace', 'selectedFiles'].includes(value);
}

function extractFirstCodeBlock(content: string): { code: string; filePath?: string } | undefined {
  const match = content.match(/(?:File:\s*([^\n]+)\n+)?```[a-zA-Z0-9_./\\-]*\n([\s\S]*?)```/);
  if (!match) {
    return undefined;
  }

  return {
    filePath: match[1]?.trim(),
    code: match[2]
  };
}

function isInsideDirectory(candidate: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
