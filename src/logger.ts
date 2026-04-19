// src/logger.ts

import * as vscode from 'vscode';

// class Logger {
//   private channel: vscode.OutputChannel;
//   private static instance: Logger;

//   private constructor() {
//     this.channel = vscode.window.createOutputChannel('Code Highlighter Debug');
//     this.channel.show(true); // auto-open the panel
//   }

//   static getInstance(): Logger {
//     if (!Logger.instance) {
//       Logger.instance = new Logger();
//     }
//     return Logger.instance;
//   }

//   private timestamp(): string {
//     return new Date().toISOString().split('T')[1].replace('Z', '');
//   }

//   private write(level: string, section: string, message: string, data?: unknown): void {
//     const ts   = this.timestamp();
//     const line = `[${ts}] [${level}] [${section}] ${message}`;
//     this.channel.appendLine(line);
//     if (data !== undefined) {
//       this.channel.appendLine('  DATA: ' + JSON.stringify(data, null, 2));
//     }
//   }

//   info(section: string, message: string, data?: unknown): void {
//     this.write('INFO ', section, message, data);
//   }

//   warn(section: string, message: string, data?: unknown): void {
//     this.write('WARN ', section, message, data);
//   }

//   error(section: string, message: string, data?: unknown): void {
//     this.write('ERROR', section, message, data);
//     console.error(`[${section}] ${message}`, data);
//   }

//   debug(section: string, message: string, data?: unknown): void {
//     this.write('DEBUG', section, message, data);
//   }

//   separator(label: string): void {
//     this.channel.appendLine('');
//     this.channel.appendLine(`${'─'.repeat(20)} ${label} ${'─'.repeat(20)}`);
//   }

//   dispose(): void {
//     this.channel.dispose();
//   }
// }

// export const log = Logger.getInstance();

// //////////////////////// //////////////////////// //////////////////////// //////////////////////// //////////////////////

// src/logger.ts

class Logger {
  private static instance: Logger;
  static getInstance(): Logger {
    if (!Logger.instance) Logger.instance = new Logger();
    return Logger.instance;
  }

  info(_section: string, _message: string, _data?: unknown): void {}
  warn(_section: string, _message: string, _data?: unknown): void {}
  error(_section: string, _message: string, _data?: unknown): void {}
  debug(_section: string, _message: string, _data?: unknown): void {}
  separator(_label: string): void {}
  dispose(): void {}
}

export const log = Logger.getInstance();



// //////////////////////// //////////////////////// //////////////////////// //////////////////////// //////////////////////// //////////////////////