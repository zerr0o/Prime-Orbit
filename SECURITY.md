# Security policy

## Supported versions

Prime Orbit is currently in preview. Security fixes are applied to the latest published version.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| Earlier | No |

## Reporting a vulnerability

Please use the repository's **Security → Report a vulnerability** flow. Do not open a public issue containing an exploit, API key, OAuth token, private transcript, sensitive local path, or other secret.

Include the affected version, operating system, impact, minimal reproduction steps, and any suggested mitigation. You should receive an initial acknowledgement through GitHub within seven days.

## Execution model

Prime Orbit is a desktop client for Prime Agent. Prime Agent tools run with the permissions of the current user account; supervision profiles are not an operating-system sandbox. Treat agent instructions, third-party MCP servers, and project files as potentially untrusted input.
