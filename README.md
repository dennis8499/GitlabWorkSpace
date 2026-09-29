# GitLab Workspace for VS Code

Browse GitLab groups, clone several repositories into a local workspace folder, and work with issues without leaving VS Code.

## Connect

1. Open the **GitLab Workspace** icon in the Activity Bar.
2. Choose **Connect** and enter the full GitLab base URL. HTTP and HTTPS are supported for any host. HTTP sends your access token without encryption, so use it only on a trusted network.
3. Enter a Personal Access Token with the `api` scope. The extension validates it with `GET /user` before storing it in VS Code SecretStorage.
4. Choose **Select Group** to load that group’s repositories and assigned issues. Repository results include projects in subgroups.

The token is never stored in extension settings, repository files, or a Git remote URL. Git receives an HTTP authorization header through temporary per-process configuration while a clone runs. Choose **GitLab Workspace: Disconnect** from the Command Palette to remove the stored token.

## Repositories

After selecting a group, use **Clone All Repositories** to clone every project in that group and its subgroups. To clone only some projects, check them in the Repositories list and choose **Clone Checked Repositories**. Clicking a project row only selects it. The Command Palette also offers **Choose Repositories to Clone** for a multi-select picker. Clones are placed directly under the current workspace folder. With a multi-root workspace, choose the destination folder. The extension checks every destination before starting; a name collision stops the whole batch.

Git must be installed and available on `PATH`. The extension uses the project’s GitLab HTTP clone URL and allows it only when its scheme, host, and port match the configured GitLab server.

## Issues

The My Issues view lists open and closed issues assigned to the signed-in user within the selected group’s projects. Select an issue to open its live details. **Create Issue** opens a form for the project, title, description template, Markdown, attachment, assignee, labels, milestone, start and due dates, and confidentiality. A newly created issue opens immediately even when it is not assigned to you.

The detail view supports editing, state changes, discussions with Markdown preview and attachments, issue links, child tasks, reactions, notifications, to-dos, time reports and dated time entries, cloning, moving, and deletion when the signed-in account has permission. Move and clone targets can be searched across groups. GitLab quick actions remain available in descriptions and comments. API failures remain visible so you can retry after refreshing.

## Development and local package

```powershell
npm.cmd install
npm.cmd test
npm.cmd run package
```

`npm test` builds and checks the VSIX as part of the release behavior gate. The VSIX is written to `dist/gitlab-workspace-<version>.vsix` (currently `dist/gitlab-workspace-0.3.0.vsix`). Install it from VS Code’s Extensions view using **Install from VSIX…**. The original `index.html` remains in the repository as a reference and is excluded from the package.

## GitHub releases

To release a new version:

1. Update the version in `package.json` and `package-lock.json`, for example with `npm version 0.3.0 --no-git-tag-version`.
2. Commit and merge the version change to `main`.
3. Create and push a matching version tag, for example `git tag v0.3.0` followed by `git push origin v0.3.0`.

GitHub Actions checks the tag against both package files and the `main` branch, runs the tests, packages the VSIX, and creates a GitHub Release with generated notes and the VSIX attached. The initial `v0.1.0` release and tags with a semantic prerelease suffix such as `-beta.1` are marked as pre-releases; plain version tags are published as regular releases. Downloads are provided through GitHub Releases; the extension is not published to the VS Code Marketplace.
