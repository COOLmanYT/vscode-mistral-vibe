import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getMaxContextFiles, getExcludedFiles, getMaxFileSize } from './config';
import { ContextMode } from './types';

// Always exclude .env.local for security
const SECURITY_EXCLUDES = ['**/.env.local', '**/.env.*'];

export async function buildEditorContext(): Promise<string> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return '';
  }

  const document = editor.document;
  const selected = editor.selection.isEmpty ? '' : document.getText(editor.selection);
  const relative = vscode.workspace.asRelativePath(document.uri, false);
  
  // Warn if user is about to include .env.local
  if (relative.includes('.env.local') || relative.includes('.env.')) {
    vscode.window.showWarningMessage('Environment files (.env.local, .env.*) are excluded for security. Do not share sensitive data.');
    return '';
  }
  
  return [
    `Active file: ${relative}`,
    selected ? `Selected code:\n\`\`\`${document.languageId}\n${selected}\n\`\`\`` : ''
  ].filter(Boolean).join('\n\n');
}

export async function buildWorkspaceFileContext(): Promise<string> {
  const maxFiles = getMaxContextFiles();
  if (maxFiles <= 0 || !vscode.workspace.isTrusted) {
    return '';
  }

  const userExcludes = [...new Set([...getExcludedFiles(), ...SECURITY_EXCLUDES])];
  // Convert excludes to a glob pattern that findFiles can use
  const excludePattern = userExcludes.length > 0 ? `{${userExcludes.join(',')}}` : undefined;
  const files = await vscode.workspace.findFiles('**/*', excludePattern, maxFiles * 4);
  const maxSize = getMaxFileSize();
  const snippets = await Promise.all(files
    .filter(uri => !isExcludedPath(vscode.workspace.asRelativePath(uri, false), userExcludes))
    .slice(0, maxFiles)
    .map(async uri => {
    try {
      const stat = await fs.stat(uri.fsPath);
      if (stat.size > maxSize) {
        return undefined;
      }
      const content = await fs.readFile(uri.fsPath, 'utf8');
      return `File: ${path.normalize(vscode.workspace.asRelativePath(uri, false))}\n\`\`\`\n${content.slice(0, 4000)}\n\`\`\``;
    } catch {
      return undefined;
    }
  }));

  return snippets.filter(Boolean).join('\n\n');
}

export async function buildContext(mode: ContextMode, selectedFiles: string[] = []): Promise<string> {
  if (mode === 'none') {
    return '';
  }

  if (mode === 'selection') {
    return buildEditorContext();
  }

  if (mode === 'currentFile') {
    return buildCurrentFileContext();
  }

  if (mode === 'openEditors') {
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
    const paths = tabs
      .map(tab => tab.input)
      .filter((input): input is vscode.TabInputText => input instanceof vscode.TabInputText)
      .map(input => input.uri.fsPath);
    return buildFileListContext(paths);
  }

  if (mode === 'selectedFiles') {
    return buildFileListContext(selectedFiles);
  }

  return buildWorkspaceFileContext();
}

export async function buildCurrentFileContext(): Promise<string> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return '';
  }

  const document = editor.document;
  const relative = vscode.workspace.asRelativePath(document.uri, false);
  
  // Security check for .env files
  if (isExcludedPath(relative, SECURITY_EXCLUDES)) {
    vscode.window.showWarningMessage('Environment files (.env.local, .env.*) are excluded for security. Do not share sensitive data.');
    return '';
  }
  
  return [
    `Current file: ${relative}`,
    `\`\`\`${document.languageId}\n${document.getText().slice(0, 12_000)}\n\`\`\``
  ].join('\n');
}

export async function buildFileListContext(filePaths: string[]): Promise<string> {
  if (!vscode.workspace.isTrusted || filePaths.length === 0) {
    return '';
  }

  const maxSize = getMaxFileSize();
  const snippets = await Promise.all(filePaths.slice(0, getMaxContextFiles()).map(async filePath => {
    try {
      const resolved = path.resolve(filePath);
      const stat = await fs.stat(resolved);
      if (!stat.isFile() || stat.size > maxSize) {
        return undefined;
      }
      
      const relative = vscode.workspace.asRelativePath(vscode.Uri.file(resolved), false);
      // Security check for .env files
      if (isExcludedPath(relative, SECURITY_EXCLUDES)) {
        vscode.window.showWarningMessage(`Skipping ${relative} for security. Environment files are excluded.`);
        return undefined;
      }
      
      const content = await fs.readFile(resolved, 'utf8');
      return `File: ${relative}\n\`\`\`\n${content.slice(0, 12_000)}\n\`\`\``;
    } catch {
      return undefined;
    }
  }));

  return snippets.filter(Boolean).join('\n\n');
}

function isExcludedPath(relativePath: string, patterns: string[]): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  return patterns.some(pattern => globToRegExp(pattern).test(normalized));
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  let regex = '^';

  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === '*' && next === '*') {
      regex += '.*';
      index++;
      continue;
    }

    if (char === '*') {
      regex += '[^/]*';
      continue;
    }

    if (char === '?') {
      regex += '[^/]';
      continue;
    }

    if (char === '{') {
      const end = normalized.indexOf('}', index);
      if (end > index) {
        const options = normalized
          .slice(index + 1, end)
          .split(',')
          .map(option => option.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
        regex += '(?:' + options.join('|') + ')';
        index = end;
        continue;
      }
    }

    regex += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }

  regex += '$';
  return new RegExp(regex);
}
