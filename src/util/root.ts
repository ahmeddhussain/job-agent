// The repository (or installed package) root, found from this file, not from the current
// directory: the CLI runs inside the active profile's folder (D45), so code assets
// (prompts, templates, dashboard, shipped defaults, test fixtures) are located from here.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
