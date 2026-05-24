import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getVibeExecutable } from './config';
import { findPreferredBash, shellQuote } from './vibeTerminal';

export interface VibeCommand {
  label: string;
  args: string[];
  description?: string;
}

const fallbackCommands: VibeCommand[] = [
  { label: 'chat', args: ['chat'], description: 'Start or continue a Vibe chat.' },
  { label: 'ask', args: ['ask'], description: 'Ask Vibe a one-shot question.' },
  { label: 'generate', args: ['generate'], description: 'Generate code.' },
  { label: 'explain', args: ['explain'], description: 'Explain code or files.' },
  { label: 'edit', args: ['edit'], description: 'Request code edits.' },
  { label: 'review', args: ['review'], description: 'Review project or file changes.' }
];

export async function discoverVibeCommands(): Promise<VibeCommand[]> {
  try {
    const output = await runVibe(['--help']);
    const commands = parseHelp(output);
    return commands.length > 0 ? commands : fallbackCommands;
  } catch {
    return fallbackCommands;
  }
}

export async function runVibe(args: string[], input?: string, envOverrides: NodeJS.ProcessEnv = {}): Promise<string> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const cwd = workspaceFolder ? path.resolve(workspaceFolder) : undefined;
  const bashPath = findPreferredBash();
  const command = [getVibeExecutable(), ...args].map(shellQuote).join(' ');

  return new Promise((resolve, reject) => {
    const child = bashPath ? spawn(bashPath, ['-lc', command], {
      cwd,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        ...envOverrides
      }
    }) : spawn(getVibeExecutable(), args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        ...envOverrides
      }
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.on('error', error => reject(new Error(`Unable to start Vibe CLI: ${error.message}`)));
    child.on('close', code => {
      const out = Buffer.concat(stdout).toString('utf8').trim();
      const err = Buffer.concat(stderr).toString('utf8').trim();
      if (code === 0) {
        resolve(out);
        return;
      }
      reject(new Error(err || `Vibe CLI exited with code ${code}.`));
    });

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

function parseHelp(helpText: string): VibeCommand[] {
  const lines = helpText.split(/\r?\n/);
  return lines
    .map(line => line.match(/^\s{2,}([a-z][\w:-]*)\s{2,}(.+)$/i))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map(match => ({
      label: match[1],
      args: [match[1]],
      description: match[2].trim()
    }));
}
