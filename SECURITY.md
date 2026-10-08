# Security policy

## Supported versions

Security fixes are provided for the public **1.0.x** release series.
Development builds are not supported releases.

## Report a vulnerability

Report security issues privately through
[GitHub private vulnerability reporting](https://github.com/outrobrunoai/novel-tts/security/advisories/new).
Do not disclose vulnerabilities in public issues.

Please include:

- The affected Novel TTS version and operating system.
- Steps to reproduce the issue using synthetic text and files.
- The observed behavior and security impact.

Do not include pairing tokens, local configuration, voice samples, generated audio,
reading history, private documents or identifying file paths.
Reports are handled on a best-effort basis; this project does not promise a response deadline.

## Local services and protections

Novel TTS uses two separate local services:

| Service | Default address | Access controls |
| --- | --- | --- |
| Companion audio cache | `127.0.0.1:8081` | Pairing bearer token, Host validation and Firefox extension Origin checks |
| Qwen synthesis engine | `127.0.0.1:8080` | Loopback address; no engine authentication in the tested upstream version |

The cache requires authentication on every request except the data-less CORS preflight.
The bearer token is the credential; an Origin check is not a substitute for authentication.
Configuration validation rejects engine addresses other than `127.0.0.1` or `localhost`.

Both services run as systemd user units with sandbox restrictions. The cache has stricter
filesystem, device and socket restrictions; the engine needs device access for GPU support.
Network restrictions depend on kernel support.

The extension runs on the tab where the user activates it and on additional origins the user
authorizes. Imported documents are checked against resource limits before storage, and imported
markup is not inserted as HTML.

## Known limitation: direct access to the engine

The tested qwentts.cpp `tts-server` does not authenticate requests and permits browser
requests from any origin (CORS `*`). **The authenticated cache does not protect direct access
to the engine.**

A web page may attempt to reach the local engine to generate speech, list voices or delete
a registered voice. Browser local-network protections may prompt or block access, but must
not be relied upon as the application's security boundary.

Until engine isolation or upstream authentication is implemented:

- Avoid untrusted websites while the engine is running.
- Do not expose either service through port forwarding, a reverse proxy or a public interface.
- Keep the service addresses on loopback.

Engine isolation is tracked in [ROADMAP.md](ROADMAP.md).

## Protect local data

Keep pairing tokens private. If a token leaks, run:

```sh
~/.local/bin/novel-tts token --rotate
```

Then pair the extension again. Backups and snapshots include configuration copies and may
contain previous tokens; retain only those you need. Use a dedicated audio cache directory
and grant site permissions only where needed.

An attacker who can already execute code as your user account can access your local configuration
and data. Novel TTS does not provide protection against a compromised user account. Separately
installed engines and models have their own security properties; the known integration limitation
above remains relevant when using them with Novel TTS.

## Development dependencies

Development tools such as `web-ext` are not included in the extension or host release artifacts.
Dependency audit findings and CI policy are documented in the
[development notes](docs/GUIDE.md#dependências-de-desenvolvimento).

## Privacy

See [PRIVACY_POLICY.md](PRIVACY_POLICY.md) for data processing and storage details.
