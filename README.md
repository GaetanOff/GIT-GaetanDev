# GaetanDev Git

A fast, keyboard-first desktop Git client that works with every Git provider: GitHub, GitLab, Azure DevOps, Bitbucket, Gitea/Codeberg, or any plain Git server. Its UI follows the GaetanDev design system (SSH Console).

Built with Electron, Svelte 5 and TypeScript. All Git work goes through your installed `git` CLI, so behaviour, hooks, config and credentials match the command line exactly.

## Features

- **Changes**: staged, unstaged and conflict sections. Stage or unstage whole files, hunks, or single lines (click or drag in the diff gutter). Discard files or lines (new files go to the recycle bin). Ignore a file, extension or folder.
- **Commit**: summary with a 72-character guide, description, amend (loads the last message), "commit all" when nothing is staged, undo the last commit (changes and message come back). Drafts are kept per repository.
- **Diff viewer**: unified or split, word-level highlights, context lines, ignore whitespace, image previews, large-diff guard. Virtualised, so huge files stay smooth.
- **History**: virtualised log with a branch graph, current branch or all branches, search by message or `@author`, commit details with per-file diffs. Cherry-pick, revert, reset (soft/mixed/hard), checkout, branch or tag from any commit.
- **Conflicts**: a chunk-by-chunk resolver with ours, theirs and the common base side by side (rebuilt with `git merge-file --diff3`, whatever your conflict style). Take a side, both in either order, or edit the result; then mark resolved. Delete/modify and binary conflicts get a pick-a-side screen. Merge messages are prefilled.
- **File history & blame**: every commit that touched a file (following renames) with its diff, and a blame view with an age heatmap; re-blame before any change to dig further back (`Ctrl+Shift+H`, `Ctrl+Shift+B`).
- **Edit history**: a visual interactive rebase. Reorder by drag and drop (or `Alt+↑/↓`), pick, reword, squash, fixup or drop with `P R S F D`, and write the combined message of squashed commits. Runs without ever opening an editor; conflicts continue in the Changes view (`Ctrl+Alt+R`, or "Edit history from here" on any commit).
- **Undo history**: every change to HEAD from the reflog, grouped into operations (a rebase is one entry). Go back to before any of them — branch switched back, `reset --keep` so uncommitted work is safe — with a redo (`Ctrl+Shift+Z` undoes the last operation).
- **Compare**: any two branches, tags or commits, since their fork point (like a pull request) or tip to tip, with the commits and the per-file diff (`Ctrl+Alt+C`, or from branch and commit menus).
- **Search code history**: find the commits that added or removed a string (`git log -S`) or whose diff matches a regex (`-G`), next to message and author search.
- **Syntax highlighting** in diffs, blame and conflicts, computed only for the lines on screen.
- **Branches**: fuzzy switcher (`Ctrl+B`), create from anything, rename, delete (local or remote), merge (merge or squash), rebase, checkout of remote branches with tracking. Switching with local changes offers "stash and switch".
- **Sync**: one smart button (publish, pull, push or fetch) with ahead/behind counts and live progress. Force push uses `--force-with-lease`. Auto-fetch on a timer.
- **Stashes, tags, remotes**: browse stash contents, apply, pop, drop; create, push and delete tags; add and remove remotes.
- **Providers**: detected from the remote URL to open the repository, a commit, a file, or a new pull/merge request in the browser.
- **Authentication**: HTTPS goes through Git Credential Manager (bundled with Git for Windows). SSH passphrases, host-key confirmations and any other git prompt are shown in the app.
- **Live**: a file watcher refreshes status as you edit; refs and history refresh after any Git change, including from the command line.
- **Keyboard**: command palette (`Ctrl+K`), go to changed file (`Ctrl+P`), and shortcuts for everything (`Ctrl+/` lists them).

## Development

Requires Node 22+ and Git.

```bash
npm install
npm run dev        # Electron with hot reload
npm run check      # svelte-check + tsc
npm run build      # production bundles in out/
npm run dist       # Windows installer in release/
```

`scripts/make-icon.cjs` regenerates `build/icon.png` (`npx electron scripts/make-icon.cjs`).

## Layout

```
src/main/        Electron main process: git engine (src/main/git), IPC, watcher, askpass, store
src/preload/     Typed bridge exposing the API to the renderer
src/shared/      Types and the IPC contract shared by both sides
src/renderer/    Svelte UI: views, components, design tokens (styles/tokens.css)
```
