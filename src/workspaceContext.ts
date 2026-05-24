import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getMaxContextFiles } from './config';
import { ContextMode } from './types';

export async function buildEditorContext(): Promise<string> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return '';
  }

  const document = editor.document;
  const selected = editor.selection.isEmpty ? '' : document.getText(editor.selection);
  const relative = vscode.workspace.asRelativePath(document.uri, false);
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

  const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist,out,build}/**', maxFiles);
  const snippets = await Promise.all(files.map(async uri => {
    try {
      const stat = await fs.stat(uri.fsPath);
      if (stat.size > 32_000) {
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
  return [
    `Current file: ${vscode.workspace.asRelativePath(document.uri, false)}`,
    `\`\`\`${document.languageId}\n${document.getText().slice(0, 12_000)}\n\`\`\``
  ].join('\n');
}

export async function buildFileListContext(filePaths: string[]): Promise<string> {
  if (!vscode.workspace.isTrusted || filePaths.length === 0) {
    return '';
  }

  const snippets = await Promise.all(filePaths.slice(0, getMaxContextFiles()).map(async filePath => {
    try {
      const resolved = path.resolve(filePath);
      const stat = await fs.stat(resolved);
      if (!stat.isFile() || stat.size > 128_000) {
        return undefined;
      }
      const content = await fs.readFile(resolved, 'utf8');
      return `File: ${vscode.workspace.asRelativePath(vscode.Uri.file(resolved), false)}\n\`\`\`\n${content.slice(0, 12_000)}\n\`\`\``;
    } catch {
      return undefined;
    }
  }));

  return snippets.filter(Boolean).join('\n\n');
}
