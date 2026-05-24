import * as vscode from 'vscode';
import { ActionProvider } from './actionProvider';
import { ChatPanel, configureVibeShellPath } from './chatPanel';
import { getAvailableModels, getCodeSuggestionModel, isCodeSuggestionsEnabled } from './config';
import { ApiKeyKind, apiKeyKindLabel, CredentialStore } from './credentials';
import { ChatHistoryStore } from './historyStore';
import { HistoryProvider } from './historyProvider';
import { MistralClient } from './mistralClient';
import { SystemPromptStore } from './systemPrompt';
import { buildEditorContext, buildWorkspaceFileContext } from './workspaceContext';
import { discoverVibeCommands, runVibe } from './vibeCli';
import { installVibe } from './vibeTerminal';

export function activate(context: vscode.ExtensionContext) {
  vscode.commands.executeCommand('setContext', 'mistralVibe.workspaceTrusted', vscode.workspace.isTrusted);

  const client = new MistralClient(context);
  const credentials = new CredentialStore(context);
  const systemPromptStore = new SystemPromptStore(context);
  const historyStore = new ChatHistoryStore(context);
  const historyProvider = new HistoryProvider(historyStore);
  const actionProvider = new ActionProvider();
  const connectionStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  connectionStatus.name = 'Mistral Vibe Connection';
  connectionStatus.command = 'mistralVibe.validateConnection';
  connectionStatus.text = '$(circle-large-outline) Mistral';
  connectionStatus.tooltip = 'Validate Mistral API connection';
  connectionStatus.show();

  const launcherStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  launcherStatus.name = 'Mistral Vibe';
  launcherStatus.command = 'mistralVibe.openChat';
  launcherStatus.text = '$(sparkle) Mistral Vibe';
  launcherStatus.tooltip = 'Open Mistral Vibe Chat or Vibe CLI';
  launcherStatus.show();

  context.subscriptions.push(
    connectionStatus,
    launcherStatus,
    vscode.window.registerTreeDataProvider('mistralVibe.actions', actionProvider),
    vscode.window.registerTreeDataProvider('mistralVibe.history', historyProvider),
    vscode.commands.registerCommand('mistralVibe.openMistral', () => openChat(context, client, credentials, systemPromptStore, historyStore, historyProvider, 'chat')),
    vscode.commands.registerCommand('mistralVibe.openChat', () => openChat(context, client, credentials, systemPromptStore, historyStore, historyProvider, 'chat')),
    vscode.commands.registerCommand('mistralVibe.openVibe', () => openChat(context, client, credentials, systemPromptStore, historyStore, historyProvider, 'vibe')),
    vscode.commands.registerCommand('mistralVibe.openSetup', () => openSetup(context, client, credentials, systemPromptStore, historyStore, historyProvider)),
    vscode.commands.registerCommand('mistralVibe.openHistory', (id: string) => openHistory(context, client, credentials, systemPromptStore, historyStore, historyProvider, id)),
    vscode.commands.registerCommand('mistralVibe.ask', () => askMistral(context, client, credentials, systemPromptStore, historyStore, historyProvider)),
    vscode.commands.registerCommand('mistralVibe.inlineChat', () => inlineChat(client, systemPromptStore)),
    vscode.commands.registerCommand('mistralVibe.explainSelection', () => explainSelection(client, systemPromptStore)),
    vscode.commands.registerCommand('mistralVibe.generateCode', () => generateCode(client, systemPromptStore)),
    vscode.commands.registerCommand('mistralVibe.runVibeCommand', () => runVibeCommand(credentials)),
    vscode.commands.registerCommand('mistralVibe.installVibe', installVibe),
    vscode.commands.registerCommand('mistralVibe.selectModel', () => selectModel(client)),
    vscode.commands.registerCommand('mistralVibe.editSystemInstructions', () => editSystemInstructions(systemPromptStore)),
    vscode.commands.registerCommand('mistralVibe.configureVibeShellPath', configureVibeShellPath),
    vscode.commands.registerCommand('mistralVibe.setApiKey', () => addApiKey(credentials, 'mistral')),
    vscode.commands.registerCommand('mistralVibe.addMistralApiKey', () => addApiKey(credentials, 'mistral')),
    vscode.commands.registerCommand('mistralVibe.addVibeApiKey', () => addApiKey(credentials, 'vibe')),
    vscode.commands.registerCommand('mistralVibe.selectMistralApiKey', () => selectApiKey(credentials, 'mistral')),
    vscode.commands.registerCommand('mistralVibe.selectVibeApiKey', () => selectApiKey(credentials, 'vibe')),
    vscode.commands.registerCommand('mistralVibe.deleteApiKey', () => deleteApiKey(credentials)),
    vscode.commands.registerCommand('mistralVibe.validateConnection', () => validateConnection(client, connectionStatus))
  );

  context.subscriptions.push(registerCodeSuggestions(client, systemPromptStore));
  context.subscriptions.push(registerChatParticipant(context, client, systemPromptStore));

  void maybeShowInitialSetup(context, credentials);
}

export function deactivate() {}

async function maybeShowInitialSetup(context: vscode.ExtensionContext, credentials: CredentialStore) {
  const seenKey = 'mistralVibe.initialSetupPromptSeen';
  if (context.globalState.get<boolean>(seenKey)) {
    return;
  }

  const hasMistralKey = (await credentials.getProfileSummaries('mistral')).length > 0;
  const hasVibeKey = (await credentials.getProfileSummaries('vibe')).length > 0;
  if (hasMistralKey || hasVibeKey) {
    await context.globalState.update(seenKey, true);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    'Set up Mistral Vibe with separate Chat and Vibe API key profiles.',
    'Open Setup',
    'Later'
  );
  await context.globalState.update(seenKey, true);
  if (choice === 'Open Setup') {
    await vscode.commands.executeCommand('mistralVibe.openSetup');
  }
}

function openChat(
  context: vscode.ExtensionContext,
  client: MistralClient,
  credentials: CredentialStore,
  systemPromptStore: SystemPromptStore,
  historyStore: ChatHistoryStore,
  historyProvider: HistoryProvider,
  activeTab: 'chat' | 'vibe'
): ChatPanel {
  return ChatPanel.show(context, {
    client,
    credentials,
    historyStore,
    systemPromptStore,
    onHistoryChanged() {
      historyProvider.refresh();
    }
  }, activeTab);
}

function openHistory(
  context: vscode.ExtensionContext,
  client: MistralClient,
  credentials: CredentialStore,
  systemPromptStore: SystemPromptStore,
  historyStore: ChatHistoryStore,
  historyProvider: HistoryProvider,
  id: string
): ChatPanel | undefined {
  const turn = historyStore.get(id);
  if (!turn) {
    vscode.window.showWarningMessage('That Mistral chat history item no longer exists.');
    return undefined;
  }

  return ChatPanel.show(context, {
    client,
    credentials,
    historyStore,
    systemPromptStore,
    onHistoryChanged() {
      historyProvider.refresh();
    }
  }, 'chat', turn);
}

async function openSetup(
  context: vscode.ExtensionContext,
  client: MistralClient,
  credentials: CredentialStore,
  systemPromptStore: SystemPromptStore,
  historyStore: ChatHistoryStore,
  historyProvider: HistoryProvider
) {
  const hasMistralKey = (await credentials.getProfileSummaries('mistral')).length > 0;
  openChat(context, client, credentials, systemPromptStore, historyStore, historyProvider, hasMistralKey ? 'vibe' : 'chat');
}

async function askMistral(
  context: vscode.ExtensionContext,
  client: MistralClient,
  credentials: CredentialStore,
  systemPromptStore: SystemPromptStore,
  historyStore: ChatHistoryStore,
  historyProvider: HistoryProvider
) {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage('Mistral Vibe is disabled until this workspace is trusted.');
    return;
  }

  const prompt = await vscode.window.showInputBox({
    title: 'Ask Mistral',
    prompt: 'Enter a question. Active editor context will be included when available.',
    ignoreFocusOut: true
  });

  if (!prompt) {
    return;
  }

  const panel = openChat(context, client, credentials, systemPromptStore, historyStore, historyProvider, 'chat');
  const editorContext = await buildEditorContext();
  await panel.ask([editorContext, prompt].filter(Boolean).join('\n\n'));
}

async function inlineChat(client: MistralClient, systemPromptStore: SystemPromptStore) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Open an editor before using inline chat.');
    return;
  }

  const selected = editor.selection.isEmpty ? '' : editor.document.getText(editor.selection);
  const prompt = await vscode.window.showInputBox({
    title: 'Mistral Inline Chat',
    prompt: 'Ask for a change to the selected code or current cursor location.',
    ignoreFocusOut: true
  });

  if (!prompt) {
    return;
  }

  const response = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Mistral inline chat' }, () => client.chat([
    { role: 'system', content: `${systemPromptStore.build()}\n\nReturn only the code or text that should be inserted into the editor unless explanation is explicitly requested.` },
    { role: 'user', content: [`File: ${vscode.workspace.asRelativePath(editor.document.uri, false)}`, selected ? `Selection:\n\`\`\`${editor.document.languageId}\n${selected}\n\`\`\`` : '', `Request: ${prompt}`].filter(Boolean).join('\n\n') }
  ]));

  await editor.edit(edit => {
    if (editor.selection.isEmpty) {
      edit.insert(editor.selection.active, response);
    } else {
      edit.replace(editor.selection, response);
    }
  });
}

async function explainSelection(client: MistralClient, systemPromptStore: SystemPromptStore) {
  const editorContext = await buildEditorContext();
  if (!editorContext.includes('Selected code:')) {
    vscode.window.showWarningMessage('Select code to explain first.');
    return;
  }

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Explaining selection with Mistral' }, async () => {
    const response = await client.chat([
      { role: 'system', content: `${systemPromptStore.build()}\n\nTask mode: explain code clearly and mention correctness risks.` },
      { role: 'user', content: editorContext }
    ]);
    const doc = await vscode.workspace.openTextDocument({ content: response, language: 'markdown' });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  });
}

async function generateCode(client: MistralClient, systemPromptStore: SystemPromptStore) {
  const prompt = await vscode.window.showInputBox({
    title: 'Generate Code',
    prompt: 'Describe the code you want generated.',
    ignoreFocusOut: true
  });
  if (!prompt) {
    return;
  }

  const context = await buildWorkspaceFileContext();
  const response = await client.chat([
    { role: 'system', content: `${systemPromptStore.build()}\n\nTask mode: generate concise, production-quality code. Prefer minimal changes and explain file placement.` },
    { role: 'user', content: [context, prompt].filter(Boolean).join('\n\n') }
  ]);
  const doc = await vscode.workspace.openTextDocument({ content: response, language: 'markdown' });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
}

async function runVibeCommand(credentials: CredentialStore) {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage('Vibe CLI execution is disabled until this workspace is trusted.');
    return;
  }

  const commands = await discoverVibeCommands();
  const selected = await vscode.window.showQuickPick(commands, {
    title: 'Run Vibe CLI Command',
    placeHolder: 'Choose a Vibe command'
  });
  if (!selected) {
    return;
  }

  const extraArgs = await vscode.window.showInputBox({
    title: `vibe ${selected.label}`,
    prompt: 'Optional arguments, split on spaces. Use the terminal for complex quoting.',
    ignoreFocusOut: true
  });

  const args = selected.args.concat(extraArgs?.trim() ? extraArgs.trim().split(/\s+/) : []);
  const vibeProfile = await credentials.getActiveProfile('vibe');
  const env = vibeProfile ? { MISTRAL_API_KEY: vibeProfile.value } : {};
  const output = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Running vibe ${args.join(' ')}` }, () => runVibe(args, undefined, env));
  const doc = await vscode.workspace.openTextDocument({ content: output, language: 'markdown' });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
}

async function addApiKey(credentials: CredentialStore, kind: ApiKeyKind) {
  const label = apiKeyKindLabel(kind);
  const name = await vscode.window.showInputBox({
    title: `Add ${label} Key`,
    prompt: kind === 'mistral'
      ? 'Name this regular Mistral API key profile, for example "Work Platform key".'
      : 'Name this Vibe API key profile, for example "Le Chat Pro Vibe key".',
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
      : 'Paste a Vibe/Codestral CLI API key. This is passed to the Vibe CLI as MISTRAL_API_KEY.',
    password: true,
    ignoreFocusOut: true,
    validateInput(input) {
      return input.trim().length < 8 ? 'API key is too short.' : undefined;
    }
  });

  if (!value) {
    return;
  }

  const profile = await credentials.addProfile(kind, name.trim(), value.trim());
  vscode.window.showInformationMessage(`${label} key "${profile.name}" saved and selected. Ending in ${profile.last4}.`);
}

async function selectApiKey(credentials: CredentialStore, kind: ApiKeyKind) {
  const label = apiKeyKindLabel(kind);
  const profiles = await credentials.getProfiles(kind);
  if (profiles.length === 0) {
    vscode.window.showWarningMessage(`No ${label} key profiles are configured.`);
    return;
  }

  const active = await credentials.getActiveProfile(kind);
  const selected = await vscode.window.showQuickPick(profiles.map(profile => ({
    label: profile.name,
    description: `${profile.id === active?.id ? 'active, ' : ''}ends in ${profile.last4}`,
    detail: new Date(profile.createdAt).toLocaleString(),
    profile
  })), {
    title: `Select ${label} Key`
  });

  if (!selected) {
    return;
  }

  await credentials.setActiveProfileId(kind, selected.profile.id);
  vscode.window.showInformationMessage(`${label} key "${selected.profile.name}" is now active.`);
}

async function deleteApiKey(credentials: CredentialStore) {
  const kindItem = await vscode.window.showQuickPick([
    { label: 'Mistral API', keyKind: 'mistral' as const },
    { label: 'Vibe API', keyKind: 'vibe' as const }
  ], {
    title: 'Delete API Key',
    placeHolder: 'Choose which key type to manage'
  });
  if (!kindItem) {
    return;
  }

  const kind = kindItem.keyKind;
  const profiles = await credentials.getProfiles(kind);
  const selected = await vscode.window.showQuickPick(profiles.map(profile => ({
    label: profile.name,
    description: `ends in ${profile.last4}`,
    profile
  })), {
    title: `Delete ${apiKeyKindLabel(kind)} Key`
  });
  if (!selected) {
    return;
  }

  await credentials.deleteProfile(kind, selected.profile.id);
  vscode.window.showInformationMessage(`${apiKeyKindLabel(kind)} key "${selected.profile.name}" deleted.`);
}

async function editSystemInstructions(systemPromptStore: SystemPromptStore) {
  const doc = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: [
      '# Mistral Vibe System Prompt',
      '',
      systemPromptStore.getSystemPrompt(),
      '',
      '# User Instructions',
      '',
      systemPromptStore.getUserInstructions()
    ].join('\n')
  });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  vscode.window.showInformationMessage('Edit and save system instructions from the Mistral Vibe panel to persist changes.');
}

async function selectModel(client: MistralClient) {
  let models = getAvailableModels();
  try {
    const liveModels = await client.listChatModels();
    if (liveModels.length > 0) {
      models = liveModels;
    }
  } catch (error) {
    vscode.window.showWarningMessage(`Could not load live Mistral models. Showing configured defaults. ${error instanceof Error ? error.message : String(error)}`);
  }

  const model = await vscode.window.showQuickPick(models, {
    title: 'Select Mistral Model',
    placeHolder: 'Models are loaded from /v1/models when possible'
  });
  if (!model) {
    return;
  }
  await vscode.workspace.getConfiguration('mistralVibe').update('model', model, vscode.ConfigurationTarget.Global);
}

async function validateConnection(client: MistralClient, status: vscode.StatusBarItem) {
  status.text = '$(sync~spin) Mistral';
  try {
    await client.validate();
    status.text = '$(pass-filled) Mistral';
    vscode.window.showInformationMessage('Mistral API connection validated.');
  } catch (error) {
    status.text = '$(error) Mistral';
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

function registerCodeSuggestions(client: MistralClient, systemPromptStore: SystemPromptStore): vscode.Disposable {
  return vscode.languages.registerInlineCompletionItemProvider({ scheme: 'file' }, {
    async provideInlineCompletionItems(document, position, _context, token) {
      if (!isCodeSuggestionsEnabled() || !vscode.workspace.isTrusted) {
        return [];
      }

      const linePrefix = document.lineAt(position).text.slice(0, position.character);
      if (linePrefix.trim().length < 3) {
        return [];
      }

      const before = document.getText(new vscode.Range(new vscode.Position(Math.max(position.line - 40, 0), 0), position));
      const afterEndLine = Math.min(position.line + 20, document.lineCount - 1);
      const afterEnd = new vscode.Position(afterEndLine, document.lineAt(afterEndLine).text.length);
      const after = document.getText(new vscode.Range(position, afterEnd));
      const response = await client.chat([
        { role: 'system', content: `${systemPromptStore.build()}\n\nYou are generating inline code completion. Return only the completion text. No markdown fences.` },
        { role: 'user', content: [`File: ${vscode.workspace.asRelativePath(document.uri, false)}`, `Language: ${document.languageId}`, `Before cursor:\n\`\`\`${document.languageId}\n${before}\n\`\`\``, `After cursor:\n\`\`\`${document.languageId}\n${after}\n\`\`\``].join('\n\n') }
      ], getCodeSuggestionModel());

      if (token.isCancellationRequested) {
        return [];
      }

      const text = response.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/```$/, '');
      return [new vscode.InlineCompletionItem(text)];
    }
  });
}

function registerChatParticipant(context: vscode.ExtensionContext, client: MistralClient, systemPromptStore: SystemPromptStore): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant('vscode-mistral-vibe.mistral', async (request, _chatContext, response, token) => {
    response.progress('Thinking with Mistral...');
    const result = await client.chat([
      { role: 'system', content: systemPromptStore.build() },
      { role: 'user', content: request.prompt }
    ]);

    if (token.isCancellationRequested) {
      return;
    }

    response.markdown(result);
    response.button({
      command: 'mistralVibe.openMistral',
      title: 'Open Mistral Panel'
    });

    return {
      metadata: {
        model: getAvailableModels()[0]
      }
    };
  });

  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'mistral-vibe.svg');
  participant.followupProvider = {
    provideFollowups() {
      return [
        { prompt: '/status', label: 'Check Mistral Vibe status' },
        { prompt: 'Explain the current file', label: 'Explain current file' }
      ];
    }
  };

  return participant;
}
