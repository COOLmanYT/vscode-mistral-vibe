import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getVibeExecutable } from './config';

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

/**
 * Check if the Vibe executable is available on the system PATH or at the configured location.
 */
export async function checkVibeAvailable(): Promise<{ available: boolean; executable: string; error?: string }> {
  const executable = getVibeExecutable();
  
  // Check if it's an absolute path that exists
  if (path.isAbsolute(executable)) {
    try {
      await import('node:fs/promises').then(fs => fs.access(executable));
      return { available: true, executable };
    } catch {
      return { available: false, executable, error: `Vibe executable not found at: ${executable}` };
    }
  }
  
  // Try to find it on PATH
  return new Promise((resolve) => {
    const child = spawn(executable, ['--version'], { shell: true, windowsHide: true });
    let hasError = false;
    
    child.on('error', () => {
      hasError = true;
      resolve({ available: false, executable, error: `Vibe CLI not found. Install it with: uv tool install mistral-vibe` });
    });
    
    child.on('close', (_code) => {
      if (hasError) {
        resolve({ available: false, executable, error: `Vibe CLI not found. Install it with: uv tool install mistral-vibe` });
      } else {
        resolve({ available: true, executable });
      }
    });
    
    // Timeout after 3 seconds
    setTimeout(() => {
      child.kill();
      resolve({ available: false, executable, error: `Vibe CLI check timed out` });
    }, 3000);
  });
}

export async function discoverVibeCommands(): Promise<VibeCommand[]> {
  try {
    const output = await runVibe(['--help']);
    const commands = parseHelp(output);
    return commands.length > 0 ? commands : fallbackCommands;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    // Don't show error for ENOENT, just return fallback commands
    if (errMsg.includes('ENOENT') || errMsg.includes('not found')) {
      return fallbackCommands;
    }
    vscode.window.showWarningMessage(`Could not discover Vibe commands: ${errMsg}`);
    return fallbackCommands;
  }
}

export async function runVibe(args: string[], input?: string, envOverrides: NodeJS.ProcessEnv = {}): Promise<string> {
  const executable = getVibeExecutable();
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const cwd = workspaceFolder ? path.resolve(workspaceFolder) : undefined;

  return new Promise((resolve, reject) => {
    let child: import('node:child_process').ChildProcessWithoutNullStreams;
    
    try {
      child = spawn(executable, args, {
        cwd,
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          ...envOverrides
        }
      });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        reject(new Error(`Vibe CLI not found. Install it with: uv tool install mistral-vibe, or set mistralVibe.vibeExecutable to the correct path.`));
      } else {
        reject(new Error(`Unable to start Vibe CLI: ${err.message}`));
      }
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.on('error', error => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        reject(new Error(`Vibe CLI not found. Install it with: uv tool install mistral-vibe, or set mistralVibe.vibeExecutable to the correct path.`));
      } else {
        reject(new Error(`Unable to start Vibe CLI: ${err.message}`));
      }
    });
    child.on('close', _code => {
      const out = Buffer.concat(stdout).toString('utf8').trim();
      const err = Buffer.concat(stderr).toString('utf8').trim();
      if (_code === 0) {
        resolve(out);
        return;
      }
      reject(new Error(err || `Vibe CLI exited with code ${_code}.`));
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
