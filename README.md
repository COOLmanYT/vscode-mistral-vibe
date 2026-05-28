# vscode-mistral-vibe

> [!IMPORTANT]
> This repo is now discontinued and unmaintained. Mistral AI recently created an official VS Code extension that covers the same use cases with better integration and support. Please use the official [Mistral AI extension](https://marketplace.visualstudio.com/items?itemName=mistralai.mistral-vibe-code). (or feel free to fork this!)


> [!NOTE]
> This repository was vide-coded.

*Version: Alpha 0.0.2 - Discontinued*

Not official. A cross-platform VS Code extension that brings Mistral AI and Vibe CLI workflows into the editor.

## Architecture

```text
VS Code Extension Host
├─ extension.ts
│  ├─ command registration
│  ├─ status bar connection indicator
│  └─ workspace trust gate
├─ MistralClient
│  └─ REST calls to /chat/completions with fetch
├─ Secret Storage
│  └─ stores the user-provided Mistral API key
├─ ChatPanel Webview
│  ├─ multi-turn conversation state
│  ├─ markdown rendering
│  ├─ collapsible long responses
│  └─ copy-to-clipboard buttons
├─ HistoryProvider
│  └─ sidebar tree view of recent conversations
├─ Vibe CLI Adapter
│  ├─ discovers commands from vibe --help
│  └─ executes commands with child_process.spawn
└─ Workspace Context Builder
   ├─ active editor selection
   └─ bounded project file snippets
```

The extension is split so the VS Code-specific layer is thin. `MistralClient` and the Vibe CLI adapter can be reused by a future Visual Studio extension with a different UI shell.

## Capabilities

- Command Palette commands for chat, one-shot questions, code explanation, code generation, model selection, API key setup, connection validation, and Vibe CLI execution.
- Separate secure key profiles for regular Mistral API keys and Vibe API keys through `ExtensionContext.secrets`.
- Mistral cloud and self-hosted endpoints via the `mistralVibe.endpoint` setting.
- First-run setup UI with separate Chat and Vibe setup paths.
- In-panel model selection and API key profile selection.
- Editable system prompt and user-created system instructions.
- A single editor title button named `Open Mistral`.
- Activity bar/sidebar action buttons and bottom-left status bar launcher.
- Built-in VS Code Chat participant as `@mistral`.
- Persistent chat history with clickable previous chats.
- Context modes for none, selection, current file, open editors, workspace, or selected files.
- Inline chat for editing selected code.
- Inline code suggestions, disabled by default, using `devstral-2` unless configured otherwise.
- Copy as Markdown, plaintext, or formatted HTML with a success toast.
- Apply code from assistant responses into a detected file or the active editor.
- Markdown response viewing in either a webview chat panel or markdown editor documents.
- Sidebar chat history view.
- Status bar connection state.
- Quick pick model selection.
- Workspace trust checks before workspace context collection or CLI execution.

## package.json contribution points

The extension contributes:

- `mistralVibe.openChat`
- `mistralVibe.openMistral`
- `mistralVibe.openVibe`
- `mistralVibe.openSetup`
- `mistralVibe.inlineChat`
- `mistralVibe.ask`
- `mistralVibe.explainSelection`
- `mistralVibe.generateCode`
- `mistralVibe.runVibeCommand`
- `mistralVibe.openVibeTerminal`
- `mistralVibe.runVibeSetup`
- `mistralVibe.installVibe`
- `mistralVibe.selectModel`
- `mistralVibe.editSystemInstructions`
- `mistralVibe.configureVibeShellPath`
- `mistralVibe.addMistralApiKey`
- `mistralVibe.addVibeApiKey`
- `mistralVibe.selectMistralApiKey`
- `mistralVibe.selectVibeApiKey`
- `mistralVibe.deleteApiKey`
- `mistralVibe.validateConnection`
- `mistralVibe.actions` sidebar action view
- `mistralVibe.history` sidebar view
- Settings for endpoint, model, available models, Vibe executable path, Vibe Bash/Git Bash shell path, and context file limits

See [package.json](./package.json) for the full contribution configuration.

## UI Layout

`Mistral Vibe: Open Chat` opens a split console with a top selector:

```text
Chat | Vibe
-----------
```

- **Chat** uses a regular Mistral API key profile and the REST chat completions API.
- **Vibe** runs `vibe` commands inside the extension host, using Bash or Git Bash when available, and renders output back into the panel.

The first-run setup UI appears when no key profiles exist, and can also be opened with `Mistral Vibe: Open Initial Setup`.

The extension also contributes `@mistral` to VS Code's built-in Chat view. Use that for native AI Chat workflows, and use the Mistral Vibe panel when you need key/model/context controls, Vibe execution, copy modes, history, or apply-code buttons.

## Main extension structure

The activation entry point in [src/extension.ts](./src/extension.ts) wires the extension together:

```ts
export function activate(context: vscode.ExtensionContext) {
  const client = new MistralClient(context);
  const credentials = new CredentialStore(context);
  const historyProvider = new HistoryProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('mistralVibe.history', historyProvider),
    vscode.commands.registerCommand('mistralVibe.openChat', () => openChat(context, client, historyProvider)),
    vscode.commands.registerCommand('mistralVibe.addMistralApiKey', () => addApiKey(credentials, 'mistral')),
    vscode.commands.registerCommand('mistralVibe.addVibeApiKey', () => addApiKey(credentials, 'vibe')),
    vscode.commands.registerCommand('mistralVibe.runVibeCommand', () => runVibeCommand(credentials))
  );
}
```

## API Key Profiles

API keys are never written to settings or files. They are stored in VS Code Secret Storage as named profiles:

```ts
await context.secrets.store('mistralVibe.credentials.mistralProfiles', JSON.stringify(mistralProfiles));
await context.secrets.store('mistralVibe.credentials.vibeProfiles', JSON.stringify(vibeProfiles));
```

There are two separate key types:

- **Mistral API key**: regular Mistral platform key used by this extension for `/v1/models` and `/v1/chat/completions`.
- **Vibe API key**: Vibe/Codestral CLI key used only when launching the Vibe CLI. The extension passes the active Vibe profile to the process as `MISTRAL_API_KEY`.

Use these Command Palette actions:

- `Mistral Vibe: Add Mistral API Key`
- `Mistral Vibe: Select Mistral API Key`
- `Mistral Vibe: Add Vibe API Key`
- `Mistral Vibe: Select Vibe API Key`
- `Mistral Vibe: Delete Saved API Key`

`Mistral Vibe: Validate Connection` checks the active regular Mistral API key by listing available chat-capable models. If the configured endpoint is self-hosted and does not implement `/models`, validation falls back to a minimal chat request.

## System Prompt

The default system prompt is stored in [src/systemPrompt.ts](./src/systemPrompt.ts). Users can view, edit, reset, and extend it from the Chat tab:

- **System prompt** replaces the base behavior prompt.
- **System instructions** append project or personal instructions without replacing the base prompt.

The same prompt builder is used for chat, explain-selection, and generate-code commands.

## Markdown rendering approach

The chat panel is a webview with a restrictive content security policy and no external scripts. It renders markdown inline:

- fenced code blocks as `<pre><code>`
- inline code
- headings
- emphasis and bold text
- blockquotes
- basic lists
- paragraphs
- long responses inside `<details>`
- copy buttons using the Clipboard API, with Markdown, plaintext, and formatted HTML options

Code block language labels are preserved as `language-*` classes. For full syntax highlighting without new runtime dependencies, command responses that are better read as documents are opened as VS Code markdown documents, where VS Code's built-in markdown renderer handles highlighting. A later packaged webview highlighter can be added if inline chat highlighting needs to match the markdown preview exactly.

## Context and Slash Commands

The Chat tab includes a context selector:

- `none`
- `selection`
- `currentFile`
- `openEditors`
- `workspace`
- `selectedFiles`

Supported slash commands include:

- `/status`
- `/config`
- `/model [model-name]`
- `/context [mode]`
- `/goal ...`
- `/reasoning ...`
- `/personality ...`
- `/mcp`
- `/file path`
- `/directory path`

## Vibe CLI feature parity

The Vibe adapter calls `vibe --help` and parses command names dynamically so newly added Vibe commands can appear without a package update. A conservative fallback list is used when the executable is unavailable.

Commands execute through Bash/Git Bash when available, using the workspace root as `cwd`. If an active Vibe API key profile exists, it is injected only into the spawned Vibe process as `MISTRAL_API_KEY`; it is not used for direct Mistral API calls. Complex quoted invocations should still be run in the Vibe terminal.

The Vibe tab supports:

- Running Vibe arguments inside the extension panel, for example `--help`, `--setup`, or `ask "explain this repo"`.
- `Install`: offers the official install script, `uv tool install mistral-vibe`, user-level pip, or admin/system pip.
- `Configure Shell`: picks or enters `mistralVibe.vibeShellPath`.

Mistral's docs say Vibe is configured via `config.toml`, stores API keys in `~/.vibe/.env` when using CLI setup, supports custom prompts in `~/.vibe/prompts`, supports custom agents in `~/.vibe/agents`, and can use `VIBE_HOME` to override the home directory. The extension does not write those files silently; it runs the requested Vibe command or install command so the user stays in control.

## Suggestions

Inline code suggestions are off by default to avoid background API calls:

```json
{
  "mistralVibe.codeSuggestions.enabled": false,
  "mistralVibe.codeSuggestions.model": "devstral-2"
}
```

When enabled, the extension registers a VS Code inline completion provider and asks the configured suggestion model for a short completion around the cursor.

## Cross-platform considerations

- Uses `Uri.fsPath`, `workspace.asRelativePath`, `path.resolve`, and `path.normalize` instead of hard-coded separators.
- Uses `child_process.spawn` with an argument array and `shell: false`.
- Keeps executable path configurable through `mistralVibe.vibeExecutable` for Windows, macOS, Linux, WSL, or custom installations.
- Uses Bash on macOS/Linux and auto-detects common Git Bash paths on Windows. Override with `mistralVibe.vibeShellPath`.
- Uses Node 18+ global `fetch` instead of adding an HTTP dependency.
- Avoids OS-specific filesystem locations.
- Stores credentials in VS Code Secret Storage, which maps to the host platform credential mechanism.

## Workspace trust and permissions

The extension avoids broad permissions and does not run background file scans unless a command needs context. Workspace trust is respected:

- Vibe CLI execution is disabled for untrusted workspaces.
- Project context gathering is disabled for untrusted workspaces.
- Secret storage remains available so users can configure credentials.

## Development

```bash
npm install
npm run compile
```

Open this folder in VS Code and press `F5` to launch an Extension Development Host.
