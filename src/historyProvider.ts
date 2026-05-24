import * as vscode from 'vscode';
import { ChatHistoryStore } from './historyStore';
import { ChatTurn } from './types';

export class HistoryProvider implements vscode.TreeDataProvider<HistoryItem> {
  private readonly changed = new vscode.EventEmitter<HistoryItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly store: ChatHistoryStore) {}

  getTreeItem(element: HistoryItem): vscode.TreeItem {
    return element;
  }

  getChildren(): HistoryItem[] {
    return this.store.list().map(turn => new HistoryItem(turn));
  }

  refresh(): void {
    this.changed.fire(undefined);
  }
}

class HistoryItem extends vscode.TreeItem {
  constructor(turn: ChatTurn) {
    super(turn.title, vscode.TreeItemCollapsibleState.None);
    this.description = new Date(turn.updatedAt ?? turn.createdAt).toLocaleString();
    this.tooltip = turn.messages.at(-1)?.content;
    this.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.command = {
      command: 'mistralVibe.openHistory',
      title: 'Open Chat',
      arguments: [turn.id]
    };
  }
}
