# Windows acceptance

Supported architecture: x64. Required Windows baselines: Windows 10 22H2 and Windows 11 24H2/25H2. Automated Windows jobs use Windows Server 2022 as the runner image, so those results are compatibility regression evidence and do not replace desktop Windows acceptance.

On each supported desktop Windows version, run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-acceptance.ps1` from the repository. The script runs the full test and package suite, checks Node, Python, Git, VS Code and operating system versions, exercises a temporary Group workspace with Chinese characters and spaces, mixed line endings and a Windows junction, installs the resulting VSIX into disposable VS Code user data and extension directories, and writes its JSON evidence and VSIX SHA-256 under `dist/`.

Use a dedicated GitLab test project for authenticated acceptance. Keep the tests inside that project and record its permissions and GitLab version without recording tokens.

| Feature | Acceptance check |
| --- | --- |
| Connection and group selection | Connect with a test account; select and refresh a group with nested projects. Confirm invalid credentials and HTTP failures leave the previous saved connection intact. |
| Projects and Git | Clone, update and sync a same-named child-group repo. Check HTTP and SSH remotes, dirty worktrees, case-only path differences, Unicode folder names, a path containing spaces, and preflight behavior for existing folders. |
| Issues and discussions | Create an unassigned Issue, open its detail, edit it, attach a file, add and reply to a discussion, and exercise permission-dependent lifecycle and relationship controls. Confirm failed writes preserve the entered draft. |
| Codebase LLM Wiki guide | Open the guide offline and without a selected Group; exercise all 13 cards, selectors, required inputs, dynamic previews, clipboard messages, input persistence after reopening, and isolation between GitLab Group scopes. Check development specification draft/ready guidance, installation guidance, read-only/report-first boundaries, narrow layouts, and high-contrast styles. |
| Issue Board and graph | Filter assigned Issues by Group Issue Board, switch between list and relationship graph, filter by Board, open a graph node, and check partial-load states, related Issue preservation, and retry controls on desktop layouts. |
| Time tracking | Start, pause and resume a timer; create, edit, submit and reconcile a manual entry. Confirm an uncertain submission is not retried automatically. |
| Delivery and review | Load native Megin gitlab_mr handoff evidence for one and multiple Repos; verify exact staged commits, partial recovery and lock release after saved local completion. Push the saved SHA over HTTPS/SSH; reconcile uncertain Push/MR responses. Import a fixed-version report, including a valid incomplete report; reject altered bodies and changed source/target SHAs at publication. Confirm approval/merge retain only the existing head SHA and GitLab rules. Automated write checks use GitLab substitutes. |
| Release tools | Confirm the source picker defaults to Gitea, keeps manual source settings, and shows local packages in Gitea/GitHub/bundled order without querying a release API. Import ZIPs from both sources, restart VS Code and remove the original downloads, then install the saved versions. Install all three bundled tools offline into a disposable Group workspace. Check TAR.XZ/ZIP hashes, traversal, links, CRC failures, capacity limits, managed-file conflicts and installation-lock recovery. Rebuild the bundle twice and compare SHA-256; compare complete VSIX size with the three-original-ZIP variant. |

The local GitLab instance currently responds to unauthenticated requests, but a valid isolated test project and test token are still required for authenticated acceptance. Windows 10 22H2 and a live Gitea connection remain explicitly pending until those environments are available.
