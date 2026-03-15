# Release Guide

This repository is intentionally not publishable to npm yet because `package.json` still contains `"private": true`.

The goal of this guide is to keep the repo release-ready so removing that flag later is low-risk.

## Version policy

Until `1.0.0`:

- use minor releases for notable feature additions or tool-contract improvements
- use patch releases for bug fixes, test-only changes, docs-only changes, and release hygiene
- avoid breaking the `ask_agent` / `list_agents` contract without an explicit release note

## Pre-release checklist

1. Update `CHANGELOG.md`.
2. Confirm `package.json` version is correct.
3. Run:

   ```bash
   npm install
   npm run check
   ```

4. Optionally run `npm run smoke:agent` on a machine with a working local agent runtime and completed auth.
5. Review `npm pack --dry-run` output and verify only intended files are included.
6. Verify README examples and environment knob docs still match the implementation.
7. If the change is public-facing, confirm the unreleased changelog entry is specific enough to become release notes.

## Tagging and GitHub release flow

1. Merge the final release PR into `main`.
2. Create a version commit if needed.
3. Create an annotated git tag for the version.
4. Draft GitHub release notes from the changelog and `.github/release.yml` categories.
5. Attach the version summary and any upgrade notes that matter for Codex users.

## The day you decide to publish

Before the first npm publish:

1. Remove `"private": true` from `package.json`.
2. Re-run the full pre-release checklist.
3. Confirm `files`, `bin`, `main`, and `exports` are still correct.
4. Verify the package name is still available and intended.
5. Perform a final `npm pack --dry-run`.
6. Publish manually; do not add automated publish until the manual flow is stable.

## What not to automate yet

- No hosted live provider CI.
- No automated npm publish.
- No release workflow that changes versions or tags on your behalf.
