# GitLab custom URL connection

- work_id: `work-20260929-gitlab-custom-url`
- requirements_revision: `req-1`
- language: `zh-TW`
- request: Let users enter a GitLab server location instead of restricting HTTP connections to `127.0.0.1`.

## Goal and decisions

Accept a complete HTTP or HTTPS GitLab base URL with a user-selected hostname or IP address, port, and optional installation path. Any HTTP host is allowed, including public addresses, as explicitly selected by the user. The connection prompt and README explain that HTTP sends the access token without encryption.

The first connection starts with an empty URL field; reconnecting pre-fills the saved URL. URL credentials, query strings, fragments, and schemes other than HTTP or HTTPS remain invalid. The token is saved only after `GET /user` succeeds. API redirects and clone URLs remain restricted to the configured server.

## Acceptance

- A custom HTTP hostname and a non-loopback IP address connect using their supplied origin and installation path.
- Invalid URLs and rejected tokens do not persist a connection or token.
- Issue Webview image policy uses the configured HTTP origin rather than a fixed loopback address.
- API pagination and repository clone URLs remain restricted to the configured origin and scheme.
- User-visible instructions identify the HTTP token transport risk.

## Behavior scenarios

The executable source is `test/behavior/connect.feature`:

- `SCN-URL-001`: connect to a custom HTTP hostname or non-loopback IP, preserve installation path, and keep API calls on the configured origin.
- `SCN-URL-002`: reject an unsupported scheme before making a request.
- `SCN-URL-003`: do not store a token rejected by GitLab.

## Sources

- `src/api/urlPolicy.ts`: current URL validation and same-origin clone policy.
- `src/extension.ts`: current Connect input box.
- `src/issues/issuePanel.ts`: current Webview content security policy.
- User-approved plan in the conversation, 2026-09-29.
