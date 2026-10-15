# Frozen GitlabWorkSpace 0.24.0 predecessor

The installer is the committed `resources/workflow-kit-installer.py` from
`e878736aaa28362f5e05e5b4ac3668db073fafb5` (the v0.24.0 release).
The TAR.XZ manifest and payload match the official
`gitlab-workspace-kit-0.24.0.zip` release asset, whose SHA-256 is
`70765a4dce7b7ae3ef932b3cc997fd7f75b6936e3e579796563006615e97e710`.

Both Group and repository profiles are frozen in the trusted predecessor list.
Release tests install this package, upgrade to the current package, then verify
that rollback restores the original installed bytes. No user data is included.
