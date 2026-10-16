# Frozen GitlabWorkSpace 0.24.3 predecessor

The installer is the original committed v0.24.3 installer. The TAR.XZ contains
the exact manifest and payload from the official gitlab-workspace-kit-0.24.3.zip,
SHA-256 `ef28ff14041ae386dfebc5895f1a33099b231401d36a239e96634dac3bc8127f`.

Tests install each original profile, upgrade to the current package and verify
that rollback restores the original bytes, including personal content.
