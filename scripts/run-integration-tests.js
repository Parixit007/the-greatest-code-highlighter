#!/usr/bin/env node
// Runs the integration tests (out/test/integration) inside a real VS Code window,
// using a throwaway workspace, profile and extensions folder.
//
// Uses the VS Code installed on this machine. Point VSCODE_EXECUTABLE at the
// VS Code binary to use a different one (required outside the usual install paths).

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function findVSCode() {
  if (process.env.VSCODE_EXECUTABLE) return process.env.VSCODE_EXECUTABLE;
  const candidates = {
    darwin: [
      '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
      '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
      path.join(os.homedir(), 'Applications/Visual Studio Code.app/Contents/MacOS/Code'),
    ],
    linux: ['/usr/share/code/code', '/snap/code/current/usr/share/code/code'],
    win32: [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe')],
  }[process.platform] || [];
  return candidates.find(candidate => fs.existsSync(candidate));
}

const executable = findVSCode();
if (!executable) {
  console.error('Could not find VS Code. Set VSCODE_EXECUTABLE to the path of the VS Code binary.');
  process.exit(1);
}

const root = path.resolve(__dirname, '..');
// A short base keeps VS Code's IPC socket path under the macOS limit, and
// realpath matters because file-change events for paths behind a symlink
// (macOS: /tmp → /private/tmp) don't reach open documents.
const base = process.platform === 'win32' ? os.tmpdir() : '/tmp';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(base, 'chl-')));
const workspace = path.join(tmp, 'workspace');
const report = path.join(tmp, 'report.txt');
fs.mkdirSync(workspace);

const args = [
  workspace,
  `--extensionDevelopmentPath=${root}`,
  `--extensionTestsPath=${path.join(root, 'out', 'test', 'integration', 'index')}`,
  `--user-data-dir=${path.join(tmp, 'user-data')}`,
  `--extensions-dir=${path.join(tmp, 'extensions')}`,
  '--disable-extensions',
  '--disable-workspace-trust',
  '--skip-welcome',
  '--skip-release-notes',
  '--new-window',
];

const env = { ...process.env, CODE_HIGHLIGHTER_TEST_REPORT: report };
delete env.ELECTRON_RUN_AS_NODE;

console.log(`Running integration tests in ${executable}`);
const output = [];
const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', chunk => output.push(chunk));
child.stderr.on('data', chunk => output.push(chunk));
child.on('exit', code => {
  if (fs.existsSync(report)) {
    console.log(fs.readFileSync(report, 'utf8'));
  } else {
    console.error('VS Code exited without writing a test report. Its output was:\n');
    console.error(Buffer.concat(output).toString('utf8').slice(-8000));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code ?? 1);
});
