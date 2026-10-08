# Contributing

## Scope

Keep changes incremental and preserve the existing Firefox extension and local Qwen3-TTS
integration. The supported baseline is Linux with a user systemd instance, Firefox 142 or newer, a
separately supplied qwentts.cpp-compatible engine, and user-provided models and voice material.

Do not introduce implicit downloads of models or voices. Do not migrate the codebase wholesale to
TypeScript, add SQLite, or add audio streaming without a benchmark and an approved design. The host
uses only the Python standard library and must keep working on Python 3.10.

## Private and generated material

Never commit models, voice material, generated audio, transcripts, tokens, personal configuration,
caches, backups, build products, or machine-specific paths. Use synthetic fixtures in tests. The
root `.gitignore` is a safeguard, not a substitute for reviewing staged changes:

```sh
git status --short
git diff --cached --check
```

## Validation

Run the full check before opening a pull request:

```sh
npm ci
python3 -m pip install ruff==0.16.10
./scripts/verify.sh
```

It runs the Python and Node test suites, the linters, the publication and version checks and a
reproducible build of the release artifacts. See `TESTING.md` for the individual commands and the
manual smoke checklist. Never run `setup`, `upgrade`, `restore` or `uninstall` against your own
installation while developing; the tests use temporary directories and fake systemd controllers.

Write a failing test first for every behaviour change or bug fix.

## Issues and security

Use <https://github.com/outrobrunoai/novel-tts/issues> for bugs and ideas, with a minimal
reproduction, the product version, your distribution and Firefox versions, and safe console
messages. Report vulnerabilities privately as described in `SECURITY.md`.

## Contributions and licensing

By submitting a contribution for inclusion, you agree that it may be distributed under Apache-2.0.
Preserve third-party notices and document the exact version or immutable revision whenever updating
vendored code.
