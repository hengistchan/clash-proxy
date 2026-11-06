import { assertBuildDataSafe } from './standalone-paths.mjs';

try {
  assertBuildDataSafe(process.cwd());
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
