// src/extension.ts

import * as vscode from 'vscode';
import { CodeHighlighterApi, Controller } from './controller';
import { registerCommands } from './commands';
import { log } from './logger';

let controller: Controller | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<CodeHighlighterApi> {
  controller = new Controller();
  context.subscriptions.push(controller, ...registerCommands(controller), { dispose: () => log.dispose() });
  await controller.ready;
  log.info('Code Highlighter is ready');
  return controller.api();
}

export async function deactivate(): Promise<void> {
  // Give pending highlight.json writes a chance to finish.
  await controller?.flush();
  controller = undefined;
}
