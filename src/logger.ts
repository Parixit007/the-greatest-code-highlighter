// src/logger.ts
//
// Logs to the "Code Highlighter" output channel. Debug and trace messages are
// hidden unless enabled with "Developer: Set Log Level…".

import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

function out(): vscode.LogOutputChannel {
  return channel ??= vscode.window.createOutputChannel('Code Highlighter', { log: true });
}

export const log = {
  trace: (message: string, ...args: unknown[]) => out().trace(message, ...args),
  debug: (message: string, ...args: unknown[]) => out().debug(message, ...args),
  info:  (message: string, ...args: unknown[]) => out().info(message, ...args),
  warn:  (message: string, ...args: unknown[]) => out().warn(message, ...args),
  error: (message: string | Error, ...args: unknown[]) => out().error(message, ...args),
  dispose(): void {
    channel?.dispose();
    channel = undefined;
  },
};
