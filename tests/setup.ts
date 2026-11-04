import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

/*
 * Tests run git as a fresh install would: no global or system config of the
 * machine (a core.hooksPath, status.showUntrackedFiles=no or core.autocrlf
 * there made tests fail or pass for the wrong reason), and none of the
 * variables git exports to the hooks it runs. Started from a pre-commit hook,
 * "npm test" inherited GIT_INDEX_FILE and staged into the real repository.
 */
const dir = mkdtempSync(join(tmpdir(), 'gdg-config-'))
const global = join(dir, 'gitconfig')
writeFileSync(global, '')
afterAll(() => rmSync(dir, { recursive: true, force: true }))
process.env.GIT_CONFIG_GLOBAL = global
process.env.GIT_CONFIG_NOSYSTEM = '1'
for (const k of Object.keys(process.env)) {
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|LITERAL_PATHSPECS|GLOB_PATHSPECS|NOGLOB_PATHSPECS|ICASE_PATHSPECS)$/i.test(k)) {
    delete process.env[k]
  }
}
