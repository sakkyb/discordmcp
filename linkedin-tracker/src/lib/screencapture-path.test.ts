// launchd gives these jobs a minimal PATH (see scripts/*.plist.template):
//   /opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
// `screencapture` lives in /usr/sbin, which is NOT on it. A bare name therefore
// resolves fine from a shell and raises ENOENT under launchd — which silently
// broke the WhatsApp chat-verify step for a week. Every call site must use the
// absolute path, so guard that here rather than in a comment.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PACKAGE_ROOT } from './config.js';

const SCREENCAPTURE = '/usr/sbin/screencapture';

function sourceFiles(): string[] {
  const roots = [path.join(PACKAGE_ROOT, 'src'), path.join(PACKAGE_ROOT, 'scripts')];
  const found: string[] = [];
  for (const root of roots) {
    for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(ts|py|applescript)$/.test(entry.name)) continue;
      // This file quotes the bad pattern in order to describe it.
      if (entry.name === 'screencapture-path.test.ts') continue;
      found.push(path.join(entry.parentPath ?? root, entry.name));
    }
  }
  return found;
}

test('screencapture is never invoked by bare name', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    for (const [i, line] of fs.readFileSync(file, 'utf8').split('\n').entries()) {
      // Only an argument position counts as an invocation: the bare name opens
      // an argument list — execFile('screencapture', …) or ["screencapture", …].
      // Prose about the trap in a comment must not trip this.
      if (/[([]\s*['"`]screencapture['"`]\s*,/.test(line)) {
        offenders.push(`${path.relative(PACKAGE_ROOT, file)}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `use ${SCREENCAPTURE} instead:\n${offenders.join('\n')}`);
});

test('the absolute screencapture path exists on this machine', () => {
  assert.ok(fs.existsSync(SCREENCAPTURE), `${SCREENCAPTURE} is missing`);
});
