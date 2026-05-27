import * as vscode from 'vscode';
import { ContextMode } from './types';

export function getConfig() {
  return vscode.workspace.getConfiguration('mistralVibe');
}

export function getEndpoint(): string {
  return getConfig().get<string>('endpoint', 'https://api.mistral.ai/v1').replace(/\/+$/, '');
}

export function getModel(): string {
  return getConfig().get<string>('model', 'mistral-small-latest');
}

export function getAvailableModels(): string[] {
  return getConfig().get<string[]>('availableModels', [
    'mistral-small-latest',
    'mistral-medium-latest',
    'mistral-large-latest',
    'codestral-latest'
  ]).filter(isTextChatModelName);
}

export function getVibeExecutable(): string {
  return getConfig().get<string>('vibeExecutable', 'vibe');
}

export function getMaxContextFiles(): number {
  return getConfig().get<number>('maxContextFiles', 8);
}

export function getContextMode(): ContextMode {
  return getConfig().get<ContextMode>('contextMode', 'currentFile');
}

export function isCodeSuggestionsEnabled(): boolean {
  return getConfig().get<boolean>('codeSuggestions.enabled', false);
}

export function getCodeSuggestionModel(): string {
  return getConfig().get<string>('codeSuggestions.model', 'devstral-2');
}

export function getExcludedFiles(): string[] {
  return getConfig().get<string[]>('excludedFiles', [
    '**/{node_modules,.git,dist,out,build}/**',
    '**/.env',
    '**/.env.local',
    '**/.env.*',
    '**/*.log',
    '**/*.lock',
    '**/coverage/**',
    '**/.vscode/**',
    '**/.idea/**',
    '**/.DS_Store'
  ]);
}

export function getMaxFileSize(): number {
  return getConfig().get<number>('maxFileSize', 32_000);
}

export function isTextChatModelName(model: string): boolean {
  const normalized = model.toLowerCase();
  const excludedFragments = [
    'voxtral',
    'pixtral',
    'ocr',
    'embed',
    'embedding',
    'transcribe',
    'transcription',
    'speech',
    'audio',
    'vision'
  ];

  return !excludedFragments.some(fragment => normalized.includes(fragment));
}
