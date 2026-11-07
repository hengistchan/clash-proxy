import { existsSync } from 'node:fs';
import path from 'node:path';

function runtimePaths(directory, environment) {
  const database = path.resolve(
    directory,
    environment.STASH_DB_PATH || 'data/stash-config.sqlite3'
  );
  return {
    database,
    key: environment.STASH_KEY_PATH
      ? path.resolve(directory, environment.STASH_KEY_PATH)
      : `${database}.key`
  };
}

function inside(directory, file) {
  const relative = path.relative(directory, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function existingFiles(paths) {
  return [...new Set(paths)].filter((file) => existsSync(file));
}

const recoveryMessage =
  'Stop the service and back up the database, its -wal/-shm files, and the matching encryption key outside .next. ' +
  'Restore them together to a persistent directory, then set absolute STASH_DB_PATH and STASH_KEY_PATH. ' +
  'Do not rebuild until the backup is verified and the old files have been moved outside .next. See SERVICE.md.';

// next build clears .next, including databases created by the old launcher.
export function assertBuildDataSafe(root, environment = process.env) {
  const standalone = path.join(root, '.next', 'standalone');
  const legacy = runtimePaths(standalone, environment);
  const current = runtimePaths(root, environment);
  const defaults = runtimePaths(standalone, {});
  const candidates = [legacy, current, defaults].flatMap(({ database, key }) => [
    database,
    `${database}-wal`,
    `${database}-shm`,
    key
  ]);
  const unsafe = existingFiles(candidates.filter((file) => inside(path.join(root, '.next'), file)));
  if (unsafe.length) {
    throw new Error(`Refusing to erase persistent data during build: ${unsafe.join(', ')}. ${recoveryMessage}`);
  }
}

export function standaloneEnvironment(root, environment = process.env) {
  const persistent = runtimePaths(root, environment);
  const legacy = runtimePaths(path.join(root, '.next', 'standalone'), environment);
  const moved = [];
  if (legacy.database !== persistent.database) {
    moved.push(legacy.database, `${legacy.database}-wal`, `${legacy.database}-shm`);
  }
  if (!environment.STASH_SECRET_KEY?.trim() && legacy.key !== persistent.key) {
    moved.push(legacy.key);
  }
  const oldFiles = existingFiles(moved);
  if (oldFiles.length) {
    throw new Error(`Previous standalone data needs recovery before startup: ${oldFiles.join(', ')}. ${recoveryMessage}`);
  }
  if ([persistent.database, persistent.key].some((file) => inside(path.join(root, '.next'), file))) {
    throw new Error('STASH_DB_PATH and STASH_KEY_PATH must be outside .next so a rebuild cannot erase persistent data.');
  }
  return {
    ...environment,
    STASH_DB_PATH: persistent.database,
    STASH_KEY_PATH: persistent.key,
    STASH_TEMPLATE_DIR: path.resolve(
      root,
      environment.STASH_TEMPLATE_DIR || 'examples'
    )
  };
}
