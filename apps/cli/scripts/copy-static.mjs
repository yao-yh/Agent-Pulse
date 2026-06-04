import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, '..');
const repoRoot = join(cliRoot, '..', '..');

copyDir(join(repoRoot, 'apps', 'web', 'dist'), join(cliRoot, 'web', 'dist'));
copyDir(join(repoRoot, 'apps', 'docs', '.vitepress', 'dist'), join(cliRoot, 'docs'));

function copyDir(source, target) {
  if (!existsSync(source)) {
    throw new Error(`Missing build output: ${source}`);
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}
