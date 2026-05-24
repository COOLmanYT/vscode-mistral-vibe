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
  ]);
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
