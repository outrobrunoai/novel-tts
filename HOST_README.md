# Novel TTS · serviço local (host) 1.0.0

Este pacote contém **somente** o serviço local e o instalador da extensão Novel TTS. O motor
`qwentts.cpp` (com o `tts-server`), os modelos GGUF, a voz, o token, o cache e a configuração são
fornecidos e mantidos por você; nenhum deles vem aqui nem é baixado. O guia completo (como compilar
o motor, baixar os modelos e preparar a voz) está no
[guia de instalação do repositório](https://github.com/outrobrunoai/novel-tts/blob/main/docs/GUIDE.md).

## O que será instalado

Tudo na sua conta de usuário, sem `sudo`:

| O quê | Onde |
| --- | --- |
| Aplicação | `~/.local/share/novel-local-reader/` |
| Configuração e token (0600) | `~/.config/novel-local-reader/config.json` |
| Snapshots | `~/.config/novel-local-reader/backups/` |
| Cache de áudio | `~/.cache/novel-local-reader/` (ou `--cache-dir`) |
| Units systemd de usuário | `novel-local-reader.service` (motor) e `novel-local-reader-cache.service` (cache) |
| Comando | `~/.local/bin/novel-tts` |

O cache autenticado escuta em `127.0.0.1:8081` e o motor em `127.0.0.1:<--qwen-port>` (padrão
8080). Nenhum dos dois pode ser exposto em outra interface; o host recusa uma configuração cujo
motor não esteja em loopback. Veja `PRIVACY_POLICY.md` para os dados que trafegam.

**Limitação conhecida:** o motor (qwentts.cpp) escuta só em loopback, mas não exige autenticação e
aceita requisições de qualquer origem (CORS `*`). Uma página aberta no navegador pode tentar acessá-lo,
e a autenticação do cache não protege esse acesso direto. Evite sites não confiáveis enquanto o
serviço estiver ativo e não exponha as portas à rede. Detalhes em
[SECURITY.md](https://github.com/outrobrunoai/novel-tts/blob/main/SECURITY.md).

## Requisitos

Linux com sessão `systemd --user`, `/usr/bin/python3` na versão 3.10 ou superior, um `qwentts.cpp`
já compilado, os dois modelos (talker **Base** e codec/tokenizer) e os arquivos da voz (`.spk`,
`.rvq` e a transcrição). Use apenas voz que você tem direito de usar.

## Instalar

Antes de extrair o `.tar.gz`, confira o hash junto com o `SHA256SUMS` da mesma Release:

```sh
sha256sum -c --ignore-missing SHA256SUMS
tar -xzf novel-tts-host-1.0.0.tar.gz && cd novel-tts-host-1.0.0
```

Rode o instalador num terminal:

```sh
./install-service.sh \
  --qwen-root  /caminho/para/qwentts.cpp \
  --model      /caminho/para/qwen-talker-1.7b-base-Q8_0.gguf \
  --codec      /caminho/para/qwen-tokenizer-12hz-Q8_0.gguf \
  --voice-name minha-voz \
  --voice-spk  /caminho/para/minha-voz.spk \
  --voice-rvq  /caminho/para/minha-voz.rvq \
  --voice-text /caminho/para/minha-voz.txt \
  --language   Portuguese
```

Ele valida os caminhos, as portas e a versão do Python, pede confirmação, cria um
**snapshot**, instala os arquivos, inicia as units e espera o motor, a voz e o cache ficarem
prontos; se algo falhar, a instalação é desfeita. Opções: `--server` (outro `tts-server`),
`--qwen-port`, `--cache-dir`, `--cache-limit-mb` (100–50000), `--data-root` com `--require-mount`
(cache só em disco montado), `--ready-timeout` (30–1800 s, padrão 240; aumente na primeira partida
em máquinas lentas) e `--yes` para confirmar sem perguntar. `./install-service.sh --dry-run`
com os mesmos argumentos mostra o plano sem alterar nada.

Depois:

```sh
~/.local/bin/novel-tts doctor     # código 0 = saudável
~/.local/bin/novel-tts token      # cole este token nas opções da extensão
```

## Atualizar, snapshots e restore

Extraia o novo pacote e, de dentro da pasta extraída:

```sh
/usr/bin/python3 novel_tts.py upgrade --dry-run --json     # plano, sem valores privados
/usr/bin/python3 novel_tts.py upgrade --yes
```

O `upgrade` instala os arquivos do pacote e **preserva** a configuração (perfis, vozes, argumentos,
token, cache, limite e proteção de montagem). Sem configuração existente ele falha sem instalar
nada. Antes de alterar qualquer coisa ele cria um snapshot e, se uma etapa falhar, restaura o
estado anterior automaticamente. Instalações da build interna 1.5.0 ("Novel Local Reader")
atualizam do mesmo modo. O launcher já instalado executa a cópia antiga: use sempre o
`novel_tts.py` da pasta nova para aplicar o pacote novo.

```sh
~/.local/bin/novel-tts backup                  # snapshot manual
~/.local/bin/novel-tts backups --json          # lista os snapshots e seus IDs
~/.local/bin/novel-tts restore --backup-id ID --dry-run --json
~/.local/bin/novel-tts restore --backup-id ID --yes
~/.local/bin/novel-tts rollback --yes          # desfaz a última instalação ou atualização
```

O `rollback` considera só snapshots de `setup` ou `upgrade`, mostra qual vai restaurar e quais
ignorou; não desfaz um `uninstall` (rode o `install-service.sh` de novo). O `restore` valida versão, formato e checksums do snapshot, cria antes um snapshot de recuperação
do estado atual e reaplica separadamente os estados `enabled`/`active` de cada unit. Snapshots
guardam uma cópia da configuração (com o token); apague os antigos quando não precisar deles.

## Operação

```sh
~/.local/bin/novel-tts status
~/.local/bin/novel-tts logs
~/.local/bin/novel-tts token --rotate --yes    # novo token; repareie a extensão
~/.local/bin/novel-tts uninstall --dry-run --json
~/.local/bin/novel-tts uninstall --yes
```

Códigos de saída do `doctor`: `0` saudável · `1` configuração inválida · `2` unit parada ·
`3` motor indisponível · `4` voz não registrada · `5` cache autenticado indisponível ·
`6` versão ou modo incompatível. A saída não inclui token, nome da voz, caminhos nem detalhes de
exceções. O `uninstall` remove apenas o que o projeto instalou (scripts, launcher e units) e
preserva configuração, token, backups, cache, modelos e voz.

Logs: `journalctl --user -u novel-local-reader.service -u novel-local-reader-cache.service -n 80 --no-pager`.
