# Results from CI

GitHub Actions logs have paths like `/home/runner/work/app/app/src/a.js`.

The viewer looks for `src/a.js` and its parent folders in your workspace with a few file checks (no search processes). When it finds the file, it remembers the folder for this workspace.

If it cannot find a file, click "Locate file" once. You can also set `sarifViewer.pathMappings` in your settings.
