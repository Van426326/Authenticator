# Security Policy

## Supported versions

This repository supports the latest source revision on the `modern-ui-performance` branch. Builds distributed by other projects or browser stores are outside this fork's support scope.

## Reporting a vulnerability

Do not publish authentication secrets, synchronization passwords, personal access tokens, unencrypted backups, or exploit details in a public issue.

Report a potential vulnerability privately through [GitHub Security Advisories](https://github.com/Van426326/Authenticator/security/advisories/new). Include affected versions, reproduction steps, impact, and a minimal proof of concept when appropriate.

## GitHub synchronization security

Synchronization targets a single private GitHub repository only. Public repositories, GitHub Enterprise Server, and arbitrary WebDAV or Git servers are not supported, and the repository must already be initialized (non-empty); the extension does not create it.

The extension uses the fixed `authenticator-sync` branch and a fine-grained personal access token scoped to that repository's `Contents: Read and write`. The PAT is kept in `chrome.storage.session` by default and only in `chrome.storage.local` when the user explicitly opts in to remembering it; it never enters `chrome.storage.sync`, logs, or commit contents.

Remote operations are always encrypted with Argon2id-wrapped AES-256-GCM using an independent sync password that is never stored and is unrecoverable if forgotten. Only encrypted operation contents are uploaded; Git metadata (file names, device directories, commit times and sizes) and the permanent commit history remain visible to anyone with repository access. Entry deletions are durable, irreversible tombstones. Rewritten or missing remote history is treated as a security failure and the extension fails closed: it stops synchronizing, never overwrites remote data, and never resets automatically.

This is a volunteer-maintained fork, so response and remediation times are not guaranteed.
