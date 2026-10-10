# Frozen GitLab Workspace 0.14.0

The installer and TAR.XZ are byte copies of the clean 0.14.0 checkout before the
ReleaseReviewer integration. The archive manifest records version 0.14.0,
14 Skills and payload SHA-256
`700bbd3cd4fabc3513a2874a934377f4fd0591e7e0276c905398fc4a6a548029`.

Transaction tests install this historical package using its historical installer,
then exercise the current installer's status, dry run, upgrade, failure recovery
and rollback. Do not regenerate these files using the current builder.
