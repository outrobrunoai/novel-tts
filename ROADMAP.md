# Novel TTS · roadmap

Itens que **não** estão na 1.0.0, em ordem aproximada de prioridade. Sugestões e votos são
bem-vindos nas [issues](https://github.com/outrobrunoai/novel-tts/issues).

## Próximos

- Validar a instalação em Ubuntu, Fedora e Debian e, onde os *user namespaces* forem restritos,
  gerar as units sem as diretivas de sandbox que dependem deles (detectando antes pelo
  `systemd-run --user`).
- Isolar o motor: o `tts-server` não tem autenticação e responde com CORS `*`; o plano é colocá-lo
  num namespace de rede privado (`PrivateNetwork=` com `JoinsNamespaceOf=`) ou exigir autenticação
  upstream.
- Retomar o avanço automático em sites que trocam o capítulo sem recarregar a página.
- Reduzir os recursos web-acessíveis da extensão para que as páginas não consigam detectá-la.
- Porta do cache configurável (hoje fixa em 8081 na extensão e no host).
- Comando para podar snapshots antigos (cada um guarda uma cópia da configuração).
- Catálogo `_locales` do Firefox para o nome e a descrição da extensão.

## Ideias que dependem de medição

Streaming de áudio, persistência adicional de hashes ou SQLite só entram com benchmark e desenho
aprovado (veja `CONTRIBUTING.md`). OCR para PDFs digitalizados é um projeto à parte.

## Entregue

Veja `RELEASE_NOTES.md`.
