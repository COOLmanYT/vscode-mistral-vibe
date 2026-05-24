import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getVibeExecutable } from './config';
import { CredentialStore } from './credentials';

export interface VibeInstallOption {
  label: string;
  description: string;
  command: string;
  shellPath?: string;
}

export async function openVibeTerminal(credentials: CredentialStore, args: string[] = []): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage('Vibe terminal access is disabled until this workspace is trusted.');
    return;
  }

  const terminal = await createVibeTerminal(credentials, 'Mistral Vibe');
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const workdirArgs = workspace ? ['--workdir', workspace] : [];
  terminal.show();
  terminal.sendText([getVibeExecutable(), ...workdirArgs, ...args].map(shellQuote).join(' '));
}

export async function runVibeSetup(credentials: CredentialStore): Promise<void> {
  const terminal = await createVibeTerminal(credentials, 'Mistral Vibe Setup');
  terminal.show();
  terminal.sendText(`${shellQuote(getVibeExecutable())} --setup`);
}

export async function installVibe(): Promise<void> {
  const options = getInstallOptions();
  const selected = await vscode.window.showQuickPick(options, {
    title: 'Install Mistral Vibe',
    placeHolder: 'Choose admin or non-admin install method'
  });

  if (!selected) {
    return;
  }

  const terminal = vscode.window.createTerminal({
    name: `Install Mistral Vibe: ${selected.label}`,
    shellPath: selected.shellPath ?? findPreferredBash()
  });
  terminal.show();
  terminal.sendText(selected.command);
}

export function findPreferredBash(): string | undefined {
  const configured = vscode.workspace.getConfiguration('mistralVibe').get<string>('vibeShellPath', '').trim();
  if (configured) {
    return configured;
  }

  if (process.platform !== 'win32') {
    return 'bash';
  }

  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(os.homedir(), 'scoop\\apps\\git\\current\\bin\\bash.exe')
  ];

  return candidates.find(candidate => fs.existsSync(candidate));
}

async function createVibeTerminal(credentials: CredentialStore, name: string): Promise<vscode.Terminal> {
  const vibeProfile = await credentials.getActiveProfile('vibe');
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  return vscode.window.createTerminal({
    name,
    cwd: workspace,
    shellPath: findPreferredBash(),
    env: vibeProfile ? { MISTRAL_API_KEY: vibeProfile.value } : undefined
  });
}

function getInstallOptions(): VibeInstallOption[] {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const options: VibeInstallOption[] = [
    {
      label: 'Official Script',
      description: 'Non-admin, Bash/Git Bash, recommended by Mistral',
      command: 'curl -LsSf https://mistral.ai/vibe/install.sh | bash'
    },
    {
      label: 'uv Tool',
      description: 'Non-admin user install with uv',
      command: 'uv tool install mistral-vibe'
    },
    {
      label: 'pip User',
      description: 'Non-admin user install with Python 3.12+',
      command: `${python} -m pip install --user --upgrade mistral-vibe`
    }
  ];

  if (process.platform === 'win32') {
    options.push({
      label: 'pip Admin',
      description: 'Opens elevated PowerShell for system install',
      command: "Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-Command','python -m pip install --upgrade mistral-vibe'",
      shellPath: 'powershell.exe'
    });
  } else {
    options.push({
      label: 'pip Admin',
      description: 'System install with sudo',
      command: `sudo ${python} -m pip install --upgrade mistral-vibe`
    });
  }

  return options;
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}
