// Guards the published package: zero runtime dependencies, every exports/bin
// target present in the tarball, nothing outside dist/ shipped, size budget.
// Run after `npm run build`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MAX_PACKED_BYTES = 100 * 1024;
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [pack] = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }),
);
const files = new Set(pack.files.map((f) => f.path));
const errors = [];

for (const field of ['dependencies', 'optionalDependencies', 'bundleDependencies']) {
  const deps = Object.keys(pkg[field] ?? {});
  if (deps.length) errors.push(`${field} must be empty, found: ${deps.join(', ')}`);
}

const targets = (value) =>
  typeof value === 'string' ? [value] : Object.values(value ?? {}).flatMap(targets);
const entries = [pkg.main, pkg.types, ...targets(pkg.exports), ...targets(pkg.bin)];
for (const entry of entries.filter(Boolean)) {
  const path = entry.replace(/^\.\//, '');
  if (!files.has(path)) errors.push(`${entry} is referenced in package.json but not packed`);
}

for (const bin of targets(pkg.bin)) {
  const path = bin.replace(/^\.\//, '');
  if (files.has(path) && !readFileSync(path, 'utf8').startsWith('#!/usr/bin/env node')) {
    errors.push(`${bin} is missing its #!/usr/bin/env node shebang`);
  }
}

const allowed = /^(dist\/|package\.json$|README\.md$|LICENSE$|CHANGELOG\.md$)/;
for (const file of files) if (!allowed.test(file)) errors.push(`unexpected file packed: ${file}`);

if (pack.size > MAX_PACKED_BYTES) {
  errors.push(`packed size ${pack.size} B exceeds budget of ${MAX_PACKED_BYTES} B`);
}

if (errors.length) {
  for (const e of errors) console.error(`::error::${e}`);
  process.exit(1);
}
console.log(`package ok: ${files.size} files, ${pack.size} B packed, 0 runtime dependencies`);
