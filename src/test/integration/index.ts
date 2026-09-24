// src/test/integration/index.ts
//
// Entry point VS Code loads via --extensionTestsPath (see scripts/run-integration-tests.js).
// A deliberately tiny runner: tests run one after another in a real editor.

import * as fs from 'fs';
import { tests } from './extension.test';

export async function run(): Promise<void> {
  const failures: string[] = [];
  const lines: string[] = [];
  for (const { name, fn } of tests) {
    const started = Date.now();
    try {
      await fn();
      lines.push(`  ✔ ${name} (${Date.now() - started}ms)`);
    } catch (err) {
      failures.push(name);
      lines.push(`  ✘ ${name}\n      ${String((err as Error)?.stack ?? err).split('\n').join('\n      ')}`);
    }
  }
  lines.push('', `${tests.length - failures.length} passed, ${failures.length} failed`);

  const report = lines.join('\n');
  console.log(report);
  if (process.env.CODE_HIGHLIGHTER_TEST_REPORT) fs.writeFileSync(process.env.CODE_HIGHLIGHTER_TEST_REPORT, report);
  if (failures.length) throw new Error(`${failures.length} integration test(s) failed`);
}
