# Security Policy

## Supported versions

Security fixes are applied to the latest state of the `main` branch.

## Reporting a vulnerability

Please do not file public GitHub issues for suspected security problems.

Instead:

1. Email the maintainer directly with a clear subject line such as `Security issue in agent-broker`.
2. Include the affected version or commit, reproduction steps, impact, and any suggested mitigation.
3. If the report involves local credentials, redact tokens and private paths before sending logs.

## What counts as security-relevant here

This project is local-first, so the most relevant classes are:

- path traversal or sandbox escape in file loading
- writes outside the requested or allowed project files
- accidental exposure of local credentials or auth material
- command execution paths that bypass intended safety boundaries

## Disclosure expectations

- We will acknowledge a good-faith report as quickly as practical.
- Please allow time for a fix before public disclosure.
- If a coordinated disclosure is needed, we can agree on a disclosure window after triage.
