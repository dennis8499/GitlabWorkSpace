# Human acceptance

- work_id: `work-20260929-gitlab-custom-url`
- acceptance_version: `acceptance-1`
- status: `passed`
- workspace: `C:/Users/denni/OneDrive/Desktop/Project/GitlabWorkSpace`
- environment: VS Code and a reachable, user-controlled non-loopback HTTP GitLab instance
- credential handling: enter a valid test token directly in VS Code; do not record it

## Scenarios

- [x] Open **GitLab Workspace: Connect**. The URL field starts blank when no server is saved, and the prompt explains that HTTP sends the token without encryption.
- [x] Enter the full HTTP URL for the non-loopback GitLab instance and a valid token. The extension connects and stores the selected URL.
- [x] Select a group and open an Issue from that server.
- [x] If the Issue has an uploaded image, confirm it loads from the selected HTTP origin.

Acceptance recorded from the user's exact response: `work-20260929-gitlab-custom-url acceptance-1`. The response confirms all listed scenarios passed. No server address or failed scenario was included in the response; no token is recorded.
