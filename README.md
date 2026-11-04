# GaetanDev Git

A fast, keyboard-first desktop Git client that works with every Git provider: GitHub, GitLab, Azure DevOps, Bitbucket, Gitea/Codeberg, or any plain Git server. Its UI follows the GaetanDev design system (SSH Console).

Built with Electron, Svelte 5 and TypeScript. All Git work goes through your installed `git` CLI, so behaviour, hooks, config and credentials match the command line exactly.

## Features

- **Changes**: staged, unstaged and conflict sections. Stage or unstage whole files, hunks, or single lines (click or drag in the diff gutter). Discard files or lines: the version being discarded always goes to the recycle bin first. Ignore a file, extension or folder.
- **Commit**: summary with a 72-character guide, description, amend (loads the last message), "commit all" when nothing is staged, undo the last commit (changes and message come back). Drafts are kept per repository.
- **Diff viewer**: unified or split, word-level highlights, context lines, ignore whitespace, image previews, large-diff guard. Virtualised, so huge files stay smooth.
- **History**: virtualised log with a branch graph, current branch or all branches, search by message or `@author`, commit details with per-file diffs. Cherry-pick, revert, reset (soft/mixed/hard), checkout, branch or tag from any commit.
- **Conflicts**: a chunk-by-chunk resolver with ours, theirs and the common base side by side (rebuilt with `git merge-file --diff3`, whatever your conflict style). Take a side, both in either order, or edit the result; or edit the whole result file, syntax-highlighted, in the Result tab; then mark resolved. Delete/modify and binary conflicts get a pick-a-side screen. Merge messages are prefilled.
- **File history & blame**: every commit that touched a file (following renames) with its diff, and a blame view with an age heatmap; re-blame before any change to dig further back (`Ctrl+Shift+H`, `Ctrl+Shift+B`).
- **Edit history**: a visual interactive rebase (with merges in range, git's own `--rebase-merges` plan is followed: its label, reset and merge steps stay fixed and commits are reordered, squashed or dropped within each stretch). Reorder by drag and drop (or `Alt+↑/↓`), pick, reword, squash, fixup or drop with `P R S F D`, and write the combined message of squashed commits. Runs without ever opening an editor; conflicts continue in the Changes view (`Ctrl+Alt+R`, or "Edit history from here" on any commit).
- **Undo history**: every change to HEAD from the reflog, grouped into operations (a rebase is one entry), plus deleted branches to restore. Their newest commit is searched on same-name remote branches, in a journal of remote branches removed by fetch --prune, among unreferenced commits and, on demand, on the remotes themselves (a fetch without pruning plus the pull/merge request refs GitHub, GitLab and Azure DevOps keep). Go back to before any of them — branch switched back, `reset --keep` so uncommitted work is safe — with a redo (`Ctrl+Shift+Z` undoes the last operation).
- **Compare**: any two branches, tags or commits, since their fork point (like a pull request) or tip to tip, with the commits and the per-file diff (`Ctrl+Alt+C`, or from branch and commit menus).
- **Search code history**: find the commits that added or removed a string (`git log -S`) or whose diff matches a regex (`-G`), next to message and author search.
- **Syntax highlighting** in diffs, blame and conflicts, computed only for the lines on screen, with block comments, template strings and triple quotes carried across lines.
- **Import from GitHub Desktop**: every repository GitHub Desktop lists is added in one go (command palette, or the welcome screen). Its IndexedDB list is read by Chromium from a copy, so GitHub Desktop itself is never touched; folders that no longer exist are skipped.
- **Tabs**: several repositories open at once, each remembering its view and selection; `Ctrl+Tab`, `Ctrl+W`, drag to reorder.
- **Submodules, worktrees, Git LFS**: submodules with their state (not cloned, moved, conflict) and one-click update; worktrees listed, created and removed, opened as tabs; LFS pointers shown as such, LFS objects pulled, a warning when git-lfs is missing.
- **Commits**: co-authors picked from the repository's authors, Conventional Commits type, `commit.template`, signed-commit badges ("Verified"), and the full output of a failing pre-commit hook with a "commit without hooks" escape hatch.
- **Several commits at once**: Ctrl/Shift-click in History to cherry-pick or revert a selection; drag a branch onto another in the sidebar to merge or rebase.
- **Encodings**: Windows-1252, UTF-8 with BOM and UTF-16 files are decoded properly and written back byte for byte, line staging included (UTF-16 diffs are shown as text; line staging is off for them).
- **Large repositories**: changes in `.gitignore`d folders (node_modules, build output) never trigger a refresh, and Git's file system monitor can be turned on per repository (suggested automatically above 20,000 files).
- **Branches**: fuzzy switcher (`Ctrl+B`), create from anything, rename, delete (local or remote), merge (merge or squash), rebase, checkout of remote branches with tracking. Switching with local changes offers "stash and switch".
- **Sync**: one smart button (publish, pull, push or fetch) with ahead/behind counts and live progress. Force push uses `--force-with-lease --force-if-includes`, so commits fetched in the background but never seen are not overwritten. Auto-fetch on a timer.
- **Stashes, tags, remotes**: browse stash contents, apply, pop, drop; create, push and delete tags; add and remove remotes.
- **Providers**: detected from the remote URL to open the repository, a commit, a file, or a new pull/merge request in the browser: GitHub, GitLab, Azure DevOps (and Azure DevOps Server), Bitbucket Cloud and Server, Gitea/Codeberg. SSH aliases of `~/.ssh/config` are followed to their host.
- **Authentication**: HTTPS goes through Git Credential Manager (bundled with Git for Windows). SSH passphrases, host-key confirmations (with the key's fingerprint) and any other git prompt are shown in the app.
- **Live**: a file watcher refreshes status as you edit; refs and history refresh after any Git change, including from the command line, in linked worktrees and submodules too.
- **Safe by default**: git is run by its full path (a `git.exe` inside a cloned repository is never run), writes to a repository run one at a time and network commands one at a time, a dead connection fails instead of hanging, and quitting waits for running git work. Errors of the app are kept in log files ("Show log files" in the command palette).
- **Keyboard**: command palette (`Ctrl+K`), go to changed file (`Ctrl+P`), and shortcuts for everything (`Ctrl+/` lists them).

## Development

Requires Node 22+ and Git 2.36 or later (2.50.1 or later recommended: the app says so at startup).

```bash
npm install
npm run dev        # Electron with hot reload
npm run check      # svelte-check + tsc
npm run lint       # ESLint
npm test           # Vitest: unit tests, and git tests in temporary repositories
npm run build      # production bundles in out/
npm run dist       # Windows installer in release/
```

CI (`.github/workflows/ci.yml`) runs lint, check, tests and build on Windows and Linux for every push to `main` and every pull request.

## Releases

Push a tag such as `v0.2.0` (after bumping `version` in package.json): `.github/workflows/release.yml` checks that the tag matches that version, runs lint, check and tests, builds the Windows installer and publishes it as a GitHub release (published at once, not left as a draft). Installed copies check for a newer release at startup and every six hours, download it in the background and install it on quit (or at once from the "Restart now" toast). Auto-update reads the releases of `GaetanOff/GIT-GaetanDev`, so the repository must be public (or the update feed hosted elsewhere).

- **Code signing**: set the `WIN_CSC_LINK` (base64 or URL of a .pfx) and `WIN_CSC_KEY_PASSWORD` repository secrets. Without them the installer is unsigned and SmartScreen warns on first launch.
- **Hardening**: Electron fuses turn off `NODE_OPTIONS` and `--inspect`, validate the asar archive and load the app only from it. `runAsNode` stays on: the credential prompt helper (askpass) runs the app's executable as Node. The UI is served from `app://bundle`, not `file://`, so the page cannot read local files; `GrantFileProtocolExtraPrivileges` stays on for the GitHub Desktop importer, which reads its database from a `file://` page of its own. Changing the editor or terminal command asks for confirmation in a native dialog.
- **Explorer**: the installer adds "Open in GaetanDev Git" to the context menu of folders and drives, for every user of an all-users install; a folder given on the command line opens as a repository.

`scripts/make-icon.cjs` regenerates `build/icon.png` (`npx electron scripts/make-icon.cjs`).

## Layout

```
src/main/        Electron main process: git engine (src/main/git), IPC, watcher, askpass, store
src/preload/     Typed bridge exposing the API to the renderer
src/shared/      Types and the IPC contract shared by both sides
src/renderer/    Svelte UI: views, components, design tokens (styles/tokens.css)
```
