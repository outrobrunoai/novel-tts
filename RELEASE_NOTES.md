# Novel TTS 1.0.0

Primeira versão pública. Ela parte da build interna 1.5.0 ("Novel Local Reader") e mantém seus
identificadores internos — ID da extensão, pastas `~/.config/novel-local-reader` e
`~/.local/share/novel-local-reader`, nomes das units systemd, comando `novel-tts` e o banco local
de documentos —, então **uma instalação 1.5.0 existente atualiza no lugar** e preserva
configuração, token, vozes, cache, biblioteca, progresso e preferências.

## Destaques

- Lê páginas da web, EPUB, PDF, TXT e HTML com o Qwen3-TTS rodando no seu computador, com voz
  clonada, fila, retomada e avanço automático de capítulo. Tudo em loopback, com token.
- Instalador transacional com snapshot e rollback automático; `upgrade`, `backup`, `restore`,
  `doctor`, `uninstall` e rotação de token (`novel-tts token --rotate`).
- Importação segura de documentos (PDF de até 20.000 páginas, com progresso e cancelamento).
- Warm-cache de capítulos futuros sem transferir áudio ao navegador.
- Interface em português, inglês e espanhol; seis temas.

## Correções desde a 1.5.0 interna

- A importação de PDF falhava no Firefox 142 e 143 em PDFs comuns (por exemplo, os gerados pelo
  LibreOffice): o PDF.js empacotado usa `Map.prototype.getOrInsertComputed`, que só existe a partir
  do Firefox 144. O mínimo declarado passou de 142 para 144 e um teste passou a garantir que o
  mínimo cobre o que o PDF.js usa.
- Uma instalação nova agora cria a pasta do cache antes de iniciar as units (antes uma instalação nova
  não conseguia gravar o cache e o setup era desfeito por timeout).
- Reiniciar o motor logo depois de ler (a porta ficava em TIME_WAIT por ~1 minuto) já não falha com
  "porta ocupada", e o `upgrade` feito nessa janela não é mais revertido sem motivo.
- "Limpar cache" e a poda automática só mexem em arquivos criados pelo próprio serviço: um `.wav`
  seu na mesma pasta nunca é apagado.
- Pastas de cache com espaço, acento ou `%` agora funcionam (a unit systemd é gerada com aspas).
- A primeira partida lenta (shaders Vulkan) não reverte mais a instalação: o limite de prontidão
  passou de 60 s para 240 s e pode ser ajustado com `--ready-timeout`.
- O instalador e o host recusam Python anterior ao 3.10 com uma mensagem clara.
- Conexões ociosas com o cache local são fechadas após 2 minutos.
- Disco de cache ausente e JSON malformado passam a ser reportados com o código de erro correto.
- `novel-tts rollback` agora desfaz a última instalação ou atualização: restaura o snapshot
  **validado** mais recente de `setup`/`upgrade` (mesmas verificações do `restore`), mostra qual é e
  quais ignorou. Antes ele restaurava qualquer snapshot, sem validar.
- `novel-tts token --rotate` falha com uma mensagem clara se o cache não reiniciar (o token antigo
  continuaria aceito) e guarda um snapshot próprio, que o `rollback` não usa.
- Se o motor cair no meio de uma geração, o erro é `UPSTREAM_UNAVAILABLE` (com nova tentativa
  automática), e as falhas passam a deixar o tipo no log.
- O serviço do motor espera até 30 minutos pela partida a frio, em vez de matar o Qwen aos 180 s;
  `--ready-timeout` agora faz diferença acima disso.
- Bytecode deixado por outra versão do Python (atualização do Python do sistema, venv) não bloqueia
  mais snapshots, upgrade nem setup.
- `doctor` funciona em kernels sem `/proc/<pid>/task/<pid>/children`, e comandos como `token`
  antes da instalação explicam o que fazer em vez de mostrar um erro bruto.
- O avanço automático de capítulo funciona quando o "próximo" é um botão (antes navegava para
  `…/undefined`), ignora botões desabilitados (último capítulo) e só retoma na mesma origem. A
  pré-geração exige um link: ela precisa do endereço do próximo capítulo.
- O progresso de leitura guardado fica limitado às 1.000 páginas mais recentes.
- Os artefatos passam a se chamar `novel-tts-*`; a prévia visual de desenvolvimento deixou de ir no
  pacote da extensão.

## Atualizando da 1.5.0 interna

Extraia o novo `novel-tts-host-1.0.0.tar.gz`, entre na pasta e rode
`/usr/bin/python3 novel_tts.py upgrade --dry-run --json` e depois
`/usr/bin/python3 novel_tts.py upgrade --yes`.
Instale também a nova extensão (mesmo ID: ela atualiza por cima e mantém seus dados). Snapshots da
1.4.0 e da 1.5.0 continuam restauráveis.

## Arquivos desta versão

`novel-tts-host-1.0.0.tar.gz`, `novel-tts-extension-1.0.0.zip`, `release-manifest.json` e
`SHA256SUMS`; quando a assinatura está configurada, também `novel-tts-extension-1.0.0.xpi`
(assinada pela Mozilla, canal não listado, instalação permanente). Confira antes de usar:

```sh
sha256sum -c --ignore-missing SHA256SUMS
```

O ZIP não é assinado: no Firefox estável ele só carrega como extensão temporária.

## Problemas conhecidos

- Desenvolvido e testado no Arch Linux com Firefox 157. Outras distribuições devem funcionar, mas
  as restrições de *user namespaces* de algumas (Ubuntu 24.04, por exemplo) ainda não foram
  validadas com o sandbox das units; relate o que encontrar.
- A porta do cache é fixa em 8081; o motor pode usar outra com `--qwen-port`.
- PDF sem texto extraível não tem OCR. Windows e macOS não são suportados.
- O motor (qwentts.cpp) não tem autenticação e aceita requisições de qualquer origem: veja
  `SECURITY.md`.
- Atualize a extensão e o host juntos: uma extensão 1.5.0 interna mostra o aviso de "host legado"
  diante de um host 1.0.0.
- Em sites que trocam o capítulo sem recarregar a página, o avanço automático por botão não retoma
  sozinho; use **Ler página**.
- Páginas conseguem detectar a presença da extensão pelas folhas de estilo que ela expõe como
  recursos acessíveis; isso será reduzido numa versão futura.
- Dependência de desenvolvimento sem correção upstream (`node-forge`, via `web-ext`): veja
  `SECURITY.md`. Não faz parte dos artefatos.
