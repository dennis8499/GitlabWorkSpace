# Windows acceptance

Supported architecture: x64. Required Windows baselines: Windows 10 22H2 and Windows 11 24H2/25H2. Automated Windows jobs use Windows Server 2022 as the runner image, so those results are compatibility regression evidence and do not replace desktop Windows acceptance.

On each supported desktop Windows version, run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-acceptance.ps1` from the repository. The script runs the full test and package suite, checks Node, Python, Git, VS Code and operating system versions, exercises a temporary Group workspace with Chinese characters and spaces, mixed line endings and a Windows junction, installs the resulting VSIX into disposable VS Code user data and extension directories, and writes its JSON evidence and VSIX SHA-256 under `dist/`.

Use a dedicated GitLab test project for authenticated acceptance. Keep the tests inside that project and record its permissions and GitLab version without recording tokens.

| Feature | Acceptance check |
| --- | --- |
| Connection and group selection | Connect with a test account; select and refresh a group with nested projects. Confirm invalid credentials and HTTP failures leave the previous saved connection intact. |
| Projects and Git | Clone, update and sync a same-named child-group repo. Check HTTP and SSH remotes, dirty worktrees, case-only path differences, Unicode folder names, a path containing spaces, and preflight behavior for existing folders. |
| Issues and discussions | Create an unassigned Issue, open its detail, edit it, attach a file, add and reply to a discussion, and exercise permission-dependent lifecycle and relationship controls. Confirm failed writes preserve the entered draft. |
| Analysis | Import a valid IssueDraftBundle, reject malformed and out-of-repository evidence paths, create selected drafts, and retry an ambiguous result without duplicating an Issue. |
| Time tracking | Start, pause and resume a timer; create, edit, submit and reconcile a manual entry. Confirm an uncertain submission is not retried automatically. |
| Delivery and review | Preview an accepted diff, Commit and Push over HTTPS; repeat remote validation with SSH. Create an MR, review its SHA, reply, approve and merge when the test account permits it. Confirm changed HEAD/base SHA and uncertain network responses stop unsafe retries. |
| Release tools | Use the Gitea mock cases in `test/unit/releaseManager.test.ts`; test initial install and update of all three release bundles in temporary workspaces. Confirm modified managed files and installation-lock conflicts preserve their contents. |

The local GitLab instance currently responds to unauthenticated requests, but a valid isolated test project and test token are still required for authenticated acceptance. Windows 10 22H2 and a live Gitea connection remain explicitly pending until those environments are available.
