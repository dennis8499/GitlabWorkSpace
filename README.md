# GitLab Workspace for VS Code

Browse GitLab groups, clone several repositories into a local workspace folder, and read or create issues without leaving VS Code.

## Connect

1. Open the **GitLab Workspace** icon in the Activity Bar.
2. Choose **Connect** and enter your GitLab base URL. HTTPS is supported; plain HTTP is accepted only for `127.0.0.1` so a local GitLab CE instance can be tested.
3. Enter a Personal Access Token with the `api` scope. The extension validates it with `GET /user` before storing it in VS Code SecretStorage.
4. Choose **Select Group** to load that group’s repositories and assigned issues. Repository results include projects in subgroups.

The token is never stored in extension settings, repository files, or a Git remote URL. Git receives an HTTP authorization header through temporary per-process configuration while a clone runs. Choose **GitLab Workspace: Disconnect** from the Command Palette to remove the stored token.

## Repositories

Use **Clone Repositories** in the Repositories view to select several projects, or click a project to clone only that one. Clones are placed directly under the current workspace folder. With a multi-root workspace, choose the destination folder. The extension checks every destination before starting; a name collision stops the whole batch.

Git must be installed and available on `PATH`. The extension uses the project’s GitLab HTTP clone URL and allows it only when its scheme, host, and port match the configured GitLab server.

## Issues

The My Issues view lists open and closed issues assigned to the signed-in user within the selected group’s projects. Select an issue to open its read-only details. Use **Create Issue** to choose a project, enter a title and optional one-line description, then assign one project member or leave it unassigned.

## Development and local package

```powershell
npm.cmd install
npm.cmd test
npm.cmd run package
```

The VSIX is written to `dist/gitlab-workspace-0.1.0.vsix`. Install it from VS Code’s Extensions view using **Install from VSIX…**. The original `index.html` remains in the repository as a reference and is excluded from the package.
