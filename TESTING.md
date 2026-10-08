# Testes e verificação · Novel TTS 1.0.0

## Verificação completa

```sh
npm ci                                   # eslint e web-ext (Node ^20.19 || ^22.13 || >=24)
python3 -m pip install ruff==0.16.10     # Python 3.10 ou superior
./scripts/verify.sh
```

O script roda, nesta ordem: os testes Python (com `ResourceWarning` tratado como erro), os testes
Node, `py_compile`, `node --check`, o manifesto, Ruff, ESLint, `web-ext lint`, ShellCheck, a
higiene de publicação (`check_publication.py`), a consistência de versão (`check_versions.py`), duas
builds independentes dos artefatos (que precisam sair **idênticas byte a byte**), a inspeção dos
artefatos (`inspect_release.py`), o lint do ZIP extraído e `git diff --check`. Ele termina com
`verification: OK`.

Comandos individuais:

```sh
python3 -W error::ResourceWarning -m unittest discover -s tests -p 'test_*.py'
node --test tests/*.cjs
```

O CI (`.github/workflows/ci.yml`) roda os testes Python em 3.10, 3.12 e 3.14, o JavaScript em
Node 24, a higiene e o empacotamento. Nenhuma etapa usa segredo, systemd real ou o motor Qwen.

## Isolamento

Os testes usam diretórios temporários, um controlador systemd falso e barreiras (*tripwires*) sobre
`subprocess.run`/`Popen`/`call`/`check_call`/`check_output`; nunca operam a instalação real. Servidores
HTTP falsos escutam em loopback (ambientes que proíbem sockets locais precisam de exceção). Para uma
segunda barreira, coloque executáveis `systemctl` e `journalctl` que terminem com erro à frente do
`PATH`:

```sh
mkdir -p /tmp/tripwires
printf '#!/bin/sh\necho "tripwire: $0 $*" >&2\nexit 97\n' > /tmp/tripwires/systemctl
cp /tmp/tripwires/systemctl /tmp/tripwires/journalctl && chmod +x /tmp/tripwires/*
PATH=/tmp/tripwires:$PATH python3 -m unittest discover -s tests -p 'test_*.py'
```

Modelos, vozes, tokens, caches e áudios pessoais não participam dos testes e não podem ser
adicionados ao git; `scripts/check_publication.py` falha se um arquivo rastreado cair nessas classes.

## O que cada suíte cobre

- `tests/test_service.py` — cache autenticado: token, `Host`/`Origin`, limites, WAV truncado,
  concorrência, invalidação por modelo/voz/argumentos, poda (só arquivos do próprio cache), timeout
  de conexão ociosa, protocolo e erros estruturados, warm-cache.
- `tests/test_installer.py`, `test_cli.py`, `test_uninstall.py`, `test_qwen_ports.py`,
  `test_python_guard.py` — configuração portátil, instalação transacional com rollback, snapshots e
  restore, upgrade, `rollback`, rotação de token, `doctor`, prontidão do Qwen e propriedade das
  portas, desinstalação conservadora.
- `tests/test_packaging.py`, `test_quality.py` — artefatos reproduzíveis, allowlists, higiene dos
  documentos e dos workflows. Os testes de build exigem um clone git e são ignorados fora dele.
- `tests/test_*.cjs` — background, fila, protocolo, painel, reprodução, progresso, navegação,
  importadores EPUB/PDF/TXT/HTML (inclusive um PDF sintético de 5.001 páginas), i18n e consistência
  do manifesto.

## Build dos artefatos

```sh
python3 scripts/package_release.py --output dist
(cd dist && sha256sum -c SHA256SUMS)
python3 scripts/inspect_release.py --directory dist
```

Gera `novel-tts-extension-X.Y.Z.zip`, `novel-tts-host-X.Y.Z.tar.gz`, `release-manifest.json` e
`SHA256SUMS`. `dist/` é ignorado pelo git. A assinatura (AMO, canal não listado) acontece apenas no
workflow de release, quando as credenciais existem como *secrets*; o `.xpi` assinado não é
reproduzível e seu hash é acrescentado ao `SHA256SUMS` no próprio workflow.

## Roteiro manual (smoke)

Use um perfil descartável do Firefox, texto sintético e, de preferência, uma máquina de testes.

1. Instale o host (`install-service.sh`), confira `novel-tts doctor` = 0 e leia os logs.
2. Carregue a extensão (`web-ext run --source-dir <ZIP extraído>` ou `about:debugging`), copie o
   token de `novel-tts token` e confirme "conectado" nas opções.
3. Leia uma página e uma seleção; pause/retome (`Alt+Espaço`), avance e volte; pare e verifique que
   a fila é cancelada.
4. Importe um EPUB, um PDF e um TXT; feche a aba, reabra pela biblioteca e use **Continuar**.
5. Auto-next com um link e com um `<button>` de próximo capítulo (página local servida por
   `python3 -m http.server`, origem autorizada nas opções).
6. Pare o `novel-local-reader.service` e toque um trecho já gerado (deve sair do cache); um trecho
   novo deve falhar com mensagem legível, sem corromper o cache.
7. Reinicie o motor até 60 s depois de gerar áudio e confirme que ele volta sozinho.
8. Coloque um `teste.wav` na pasta do cache, use **Limpar cache** e confirme que ele permanece.
9. `novel-tts upgrade --dry-run --json`, `backup`, `restore --dry-run`, `token --rotate`,
   `uninstall --dry-run --json`.

Registre a distribuição, o Firefox e o resultado ao validar em uma máquina nova.
