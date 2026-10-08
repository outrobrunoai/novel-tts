# Third-party notices

This repository distributes the Novel TTS source code under
Apache-2.0. The following notices apply to material included in this
repository or to optional external dependencies documented by it.

## Included in this repository

| Component | Included files | Version / revision | License |
| --- | --- | --- | --- |
| PDF.js | `vendor/pdf.mjs`, `vendor/pdf.worker.mjs` | 6.2.108, build `0365cbde0` | Apache-2.0; full text in `vendor/LICENSE.pdfjs` |
| fflate | `vendor/fflate.mjs` | 0.8.3; official tag `v0.8.3`, commit `dcb3714a6c25db3a2748641019c5277413d09714` | MIT; full text in `vendor/LICENSE.fflate` |

The vendor license texts are retained verbatim. The fflate file itself does
not identify its version; the provenance below was established by exact
comparison with official release artifacts rather than by its header alone.

### PDF.js provenance

- Official release: [PDF.js v6.2.108](https://github.com/mozilla/pdf.js/releases/tag/v6.2.108),
  corresponding to upstream commit
  [`0365cbde028bd92e58f2dab1bb70cd30ac7acfd7`](https://github.com/mozilla/pdf.js/commit/0365cbde028bd92e58f2dab1bb70cd30ac7acfd7).
- Official distribution archive:
  [`pdfjs-6.2.108-dist.zip`](https://github.com/mozilla/pdf.js/releases/download/v6.2.108/pdfjs-6.2.108-dist.zip).
  The complete `pdf.mjs` and `pdf.worker.mjs` modules distributed here were
  restored from that release artifact; both embed build identifier `0365cbde0`.
- The upstream source at that revision and its Apache-2.0 license are available
  from the release/tag; this project retains the license text at
  `vendor/LICENSE.pdfjs`.

### fflate provenance

- Distributed member: `vendor/fflate.mjs`, 90,922 bytes,
  SHA-256 `b7ca4450b19559a1d50eb381adcee94b82449674be4cd17789d9beba7e6122a1`.
- Exact release copy: `package/esm/browser.js` from the official
  [`fflate@0.8.3` npm tarball](https://registry.npmjs.org/fflate/-/fflate-0.8.3.tgz),
  SHA-256 of tarball `38c2cd824402407b43153c782274aec2ea83ea688e4aa0b743c5f2c305857d92`.
  The extracted file compares byte for byte equal to the distributed member.
- Official source tag: [`v0.8.3`](https://github.com/101arrowz/fflate/releases/tag/v0.8.3),
  resolving to commit `dcb3714a6c25db3a2748641019c5277413d09714`.
- Readable source: [`src/index.ts` at that immutable commit](https://github.com/101arrowz/fflate/blob/dcb3714a6c25db3a2748641019c5277413d09714/src/index.ts).
- The package metadata declares MIT. Its `package/LICENSE` is byte for byte
  equal to `vendor/LICENSE.fflate` (1,069 bytes; SHA-256
  `0a1df3a083d0c010560aa342e87959c8c1070e6fd54545741f083f22d0c8b551`).

For comparison, the official npm tarballs for `fflate@0.8.2` and
`fflate@0.7.4` were also checked and did not match. The 0.8.2 tarball SHA-256
is `61fd5061e2fc8e5e3e3129f7f2fec7bd78a313e1bf4becbf1cc1cc9998d141dc`; its
`package/esm/browser.js` is 89,198 bytes with SHA-256
`8cc1f687e0159e977addb6b85e274dbd11e622cf151f4fcb7b85d49622ea43e7`. The
0.7.4 tarball SHA-256 is
`8c0b9a374d498e019b26f1b2d8a7cde58f217cd7077ea4a58786c0ec28af039c`; its
`package/esm/browser.js` is 84,905 bytes with SHA-256
`93c46cb0a359ec6b04d78a57d1f5a435d85daccb8658359bd2c217be82f3fcad`.

## Optional external runtime dependency

Novel TTS does not include, install, download or redistribute the Qwen TTS engine. It is built and
run by the user, and this release was tested with:

- repository: `https://github.com/ServeurpersoCom/qwentts.cpp.git`;
- commit: `90efdc60d62f7d6c70113994d0be17e820fd8673` (the commit recommended by the README);
- engine license: MIT, according to the repository's `LICENSE` file.

Another compatible `tts-server` can be used. Users must obtain and review the engine themselves,
including the notices of its own dependencies.

## Models and voice material

Models are external, user-provided dependencies and are never part of this repository or its
release packages. The README points to the GGUF conversions published at
`https://huggingface.co/Serveurperso/Qwen3-TTS-GGUF` (talker `qwen-talker-1.7b-base-Q8_0.gguf` and
codec `qwen-tokenizer-12hz-Q8_0.gguf`). The repository's metadata declares the Apache-2.0 license
and the files are conversions of the upstream Qwen3-TTS weights published by the Qwen team;
read the model card and the upstream terms yourself before using or redistributing them.

Voice reference material is private, user-provided data. It is not included or named here. Each
user is responsible for having the necessary rights and consent for any voice material they use.
