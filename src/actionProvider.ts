import * as vscode from 'vscode';

export class ActionProvider implements vscode.TreeDataProvider<ActionItem> {
  private readonly items: ActionItem[] = [
    new ActionItem('Open Chat', 'mistralVibe.openChat', 'comment-discussion'),
    new ActionItem('Open Vibe', 'mistralVibe.openVibe', 'terminal'),
    new ActionItem('Initial Setup', 'mistralVibe.openSetup', 'tools'),
    new ActionItem('Select Model', 'mistralVibe.selectModel', 'list-selection'),
    new ActionItem('Select Mistral API Key', 'mistralVibe.selectMistralApiKey', 'key'),
    new ActionItem('Select Vibe API Key', 'mistralVibe.selectVibeApiKey', 'key')
  ];

  getTreeItem(element: ActionItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ActionItem[] {
    return this.items;
  }
}

class ActionItem extends vscode.TreeItem {
  constructor(label: string, commandId: string, icon: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = {
      command: commandId,
      title: label
    };
  }
}
