# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.0.x | Yes |
| Internal "Novel Local Reader" builds (1.5.0 and earlier) | No — upgrade to 1.0.x |

## Reporting a vulnerability

Report privately through GitHub Security Advisories:
<https://github.com/outrobrunoai/novel-tts/security/advisories/new>

Please do not open public issues for security problems. Include the affected version, a minimal
reproduction using synthetic data, and the observed impact. This is a volunteer project; reports
are handled on a best-effort basis.

## Threat model

- The companion cache listens only on `127.0.0.1:8081`. It checks the `Host` header, requires the
  pairing bearer token on every request (except the data-less CORS preflight), and rejects any
  request whose `Origin` is not a Firefox extension. The token, not the origin, is the credential.
- The Qwen engine endpoint is restricted to `127.0.0.1`/`localhost` by configuration validation;
  the host refuses any other address.
- Both units run sandboxed by systemd (`NoNewPrivileges`, `PrivateTmp`, kernel and namespace
  restrictions, and `IPAddressDeny=any` with localhost allowed where the kernel supports it). The
  cache unit is stricter still: read-only file system and home except its cache directory, no
  devices, and only IPv4/Unix sockets. The engine unit is lighter because the GPU stack needs
  device access.
- The extension does not run on any site except the tab where you click its toolbar button, plus
  origins you authorize in the options page.
- Imported EPUB, PDF, TXT and HTML files are validated against size, entry-count, compression-ratio
  and extracted-text limits before they are stored, and their markup is never inserted as HTML.
- Out of scope: an attacker who already runs code as your user account (they can read
  `~/.config/novel-local-reader/config.json`), and the behaviour of the separately installed Qwen
  engine and models.

## Known limitations

**The engine is not authenticated.** The `tts-server` of qwentts.cpp listens on `127.0.0.1:8080`
without any authentication and answers browser requests from any origin (CORS `*`). A web page you
visit may therefore try to reach it: list or delete the registered voice, or synthesize text in
your voice. Firefox may prompt for or block local-network access depending on its version, but do
not rely on that: avoid untrusted sites while the service runs. Isolating the engine (a private
network namespace, or authentication upstream) is on the roadmap.

**Development tooling.**

The development tooling (`web-ext`) depends on `node-forge` through its Android/ADB support. The
advisory has no patched release upstream; the code path is never used by this project and the
package is not part of any release artifact. CI therefore gates on critical advisories only.

## Private material

Never commit, attach to an issue, or paste into a report: pairing tokens, local configuration,
caches or snapshots, model files or generated audio, voice reference material or transcripts,
reading history or document contents, or file-system paths that identify you. Use synthetic inputs.

## Operational guidance

Keep the token private; rotate it with `~/.local/bin/novel-tts token --rotate` if it may have
leaked, and delete old snapshots (each holds a copy of the configuration). Use a dedicated cache
directory. Grant optional site permissions only to sites you read on. Obtain engines, models and
voice material only from sources you trust and are entitled to use. Never expose ports 8080 or 8081
through a reverse proxy, port forward or public interface.
