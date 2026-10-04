# Replacing separate GitLab Workspace tool installations

Before installing the complete workflow kit, finish any approved Megin work and release its Group lock through Megin's completion or confirmed-abort workflow.

Remove only the separately installed tool contents and their managed records:

- `.agents/skills/codebase-wiki/`
- `.agents/skills/megin/`
- `.agents/skills/megin-behavior-contract/`
- `.agents/skills/megin-bug-diagnosis/`
- `.agents/skills/megin-code-review/`
- `.agents/skills/megin-finishing-delivery/`
- `.agents/skills/megin-human-acceptance/`
- `.agents/skills/megin-implementation-execution/`
- `.agents/skills/megin-project-knowledge/`
- `.agents/skills/megin-requirements-discovery/`
- `.agents/skills/megin-technical-planning/`
- `.agents/skills/megin-test-driven-development/`
- `.agents/skills/megin-verification-before-completion/`
- `.agents/skills/merge-reviewer/`
- `.gitlab-workspace/tool-manifests/codebase-wiki.json`
- `.gitlab-workspace/tool-manifests/megin.json`
- `.gitlab-workspace/tool-manifests/merge-reviewer.json`
- the old `codebase-wiki:managed` block from `AGENTS.md`, if present
- the old `codebase-wiki:managed` block from `Codex.md`, if present
- `.codex/config.toml` and `.codex/hooks.json` only if they exist solely for the old Wiki installation; preserve unrelated Group Codex settings and user instructions

Keep `<Group>/wiki/`, `<Group>/docs/work/`, `<Group>/review-reports/`, `.megin/` history and configuration, other `.agents/skills/`, and all repository files. Do not delete an active Megin workspace lock or any work records to make an installation succeed.
