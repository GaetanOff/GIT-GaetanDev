// Compiles the prompt helper of Windows' OpenSSH (src/askpass/askpass.cs) into out/askpass, or into
// the folder given as first argument. It uses the C# compiler of the .NET Framework 4 that Windows
// ships, so building needs nothing more. On other systems there is nothing to build.
const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path')

if (process.platform !== 'win32') {
  console.log('askpass helper: Windows only, skipped')
  process.exit(0)
}

const framework = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319')
const csc = join(framework, 'csc.exe')
if (!existsSync(csc)) {
  console.error(`askpass helper: the C# compiler was not found at ${csc}`)
  process.exit(1)
}

const out = resolve(process.argv[2] ?? join(__dirname, '..', 'out', 'askpass'))
mkdirSync(out, { recursive: true })
const source = join(__dirname, '..', 'src', 'askpass', 'askpass.cs')
// A window-less program: started from a hidden console, a console one could flash a window.
const r = spawnSync(csc, [
  '/nologo', '/target:winexe', '/optimize+', '/platform:anycpu',
  `/reference:${join(framework, 'System.Web.Extensions.dll')}`,
  `/out:${join(out, 'gdg-askpass.exe')}`, source,
], { encoding: 'utf8' })
if (r.status !== 0) {
  console.error(`askpass helper: compilation failed\n${r.stdout ?? ''}${r.stderr ?? ''}${r.error ?? ''}`)
  process.exit(1)
}
console.log(`askpass helper: ${join(out, 'gdg-askpass.exe')}`)
