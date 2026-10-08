# Novel TTS 1.0.0 · Qwen3-TTS

Extensão para Firefox que **lê em voz alta** páginas da web, EPUB, PDF, TXT e HTML usando o
[Qwen3-TTS](https://github.com/ServeurpersoCom/qwentts.cpp) rodando **no seu próprio
computador**, com a voz que você escolher (clonada a partir de uma amostra sua). Tem fila,
retomada de leitura, avanço automático de capítulo e um cache local autenticado.

Nada é enviado para a nuvem e nada é baixado automaticamente: o motor, os modelos e a voz são
fornecidos por você.

> **English summary.** Novel TTS is a Firefox extension plus a small local companion service
> (systemd user units) that reads web pages and EPUB/PDF/TXT files aloud with a locally built
> [qwentts.cpp](https://github.com/ServeurpersoCom/qwentts.cpp) server. You build the engine,
> download the GGUF models and prepare a voice sample yourself (steps 1–3 below); then run
> `./install-service.sh` from the host package (step 4), install the extension (step 5) and
> paste the pairing token into its options (step 6). Linux, systemd user session, Firefox 144+,
> Python 3.10+. Everything stays on `127.0.0.1`. The rest of this document is in Portuguese.

## Como funciona

```
Firefox (extensão)  ──Bearer token──▶  127.0.0.1:8081  cache autenticado (novel-local-reader-cache.service)
                                              │
                                              ▼
                                       127.0.0.1:8080  tts-server do qwentts.cpp (novel-local-reader.service)
```

- A **extensão** extrai o texto, divide em trechos e pede o áudio ao serviço local.
- O **cache** (porta 8081, fixa) valida o token, guarda cada WAV gerado e só chama o motor quando
  o trecho ainda não existe. Trechos já gerados tocam mesmo com o motor parado.
- O **motor** (porta 8080, configurável) é o `tts-server` do qwentts.cpp, que você compila.

## Requisitos

| Item | Mínimo |
| --- | --- |
| Sistema | Linux com sessão `systemd --user` |
| Python | 3.10 ou superior em `/usr/bin/python3` (só biblioteca padrão) |
| Firefox | Desktop 144 ou superior |
| Para compilar o motor | `git`, CMake, compilador C++17; para Vulkan, os headers do Vulkan e o `glslc` |
| GPU | Recomendada (Vulkan ou CUDA). Em CPU funciona, mas é lento |
| Disco | ~2,5 GB para os modelos + o cache (padrão: até 4 GB) |
| Portas livres | 8080 (motor, configurável com `--qwen-port`) e 8081 (cache, fixa) |

O Firefox 144 é o mínimo porque o leitor de PDF empacotado (PDF.js) usa recursos que só existem a
partir dele; versões anteriores recusam a instalação do `.xpi`.

Windows e macOS não são suportados. Não use `sudo` em nenhum passo.

## Instalação

### 1. Compilar o qwentts.cpp

Use o commit testado com esta versão:

```sh
git clone --recurse-submodules https://github.com/ServeurpersoCom/qwentts.cpp.git
cd qwentts.cpp
git checkout 90efdc60d62f7d6c70113994d0be17e820fd8673
git submodule update --init --recursive
./buildvulkan.sh        # ou ./buildcuda.sh (NVIDIA) ou ./buildcpu.sh
```

Isso gera `build/tts-server` e `build/qwen-codec`. Mantenha a pasta: o instalador aponta para ela.

### 2. Baixar os modelos

São dois arquivos GGUF do repositório
[`Serveurperso/Qwen3-TTS-GGUF`](https://huggingface.co/Serveurperso/Qwen3-TTS-GGUF)
(licença Apache-2.0), que vão em `qwentts.cpp/models/`:

```sh
mkdir -p models && cd models
base=https://huggingface.co/Serveurperso/Qwen3-TTS-GGUF/resolve/main
curl -L -C - -O "$base/qwen-talker-1.7b-base-Q8_0.gguf"       # ~2,1 GB
curl -L -C - -O "$base/qwen-tokenizer-12hz-Q8_0.gguf"         # ~0,3 GB
cd ..
```

(`-C -` retoma o download se ele for interrompido.)

O modelo precisa ser o **Base** (`…-base-…`): é o que aceita clonagem de voz.

### 3. Preparar a voz

Você precisa de uma gravação limpa da voz que quer usar (alguns segundos de fala contínua) e da
**transcrição exata** do que é dito. **Use apenas vozes que você tem direito de usar e, se for a
voz de outra pessoa, com o consentimento dela.**

```sh
ffmpeg -i minha-voz.mp3 -ac 1 -ar 24000 minha-voz.wav        # WAV mono, 24 kHz
printf '%s\n' 'Transcrição exata do áudio.' > minha-voz.txt
./build/qwen-codec --model models/qwen-tokenizer-12hz-Q8_0.gguf \
  --talker models/qwen-talker-1.7b-base-Q8_0.gguf -i minha-voz.wav
# gera minha-voz.rvq e minha-voz.spk ao lado do WAV
```

### 4. Instalar o serviço local

Baixe da página de [Releases](https://github.com/outrobrunoai/novel-tts/releases) os arquivos
`novel-tts-host-1.0.0.tar.gz` e `SHA256SUMS`, confira e extraia:

```sh
sha256sum -c --ignore-missing SHA256SUMS
tar -xzf novel-tts-host-1.0.0.tar.gz
cd novel-tts-host-1.0.0
```

(Alternativa para desenvolvedores: `git clone https://github.com/outrobrunoai/novel-tts.git` e
rodar o instalador de dentro do clone.)

Execute o instalador num terminal, ajustando os caminhos:

```sh
./install-service.sh \
  --qwen-root  /caminho/para/qwentts.cpp \
  --model      /caminho/para/qwentts.cpp/models/qwen-talker-1.7b-base-Q8_0.gguf \
  --codec      /caminho/para/qwentts.cpp/models/qwen-tokenizer-12hz-Q8_0.gguf \
  --voice-name minha-voz \
  --voice-spk  /caminho/para/minha-voz.spk \
  --voice-rvq  /caminho/para/minha-voz.rvq \
  --voice-text /caminho/para/minha-voz.txt \
  --language   Portuguese
```

O instalador valida tudo antes de mexer em qualquer coisa e pede confirmação (`s`); para ver o
plano antes, rode-o primeiro com `--dry-run`. Ele cria um snapshot, instala os arquivos, registra e inicia as duas units, aguarda o motor
e a voz ficarem prontos e, se algo falhar, **desfaz** a instalação.

Opções úteis:

- `--language`: idioma do texto que você vai ouvir, no padrão do Qwen3-TTS (por exemplo `English`,
  `Portuguese`, `Spanish`, `French`, `German`, `Italian`, `Japanese`, `Korean`, `Russian`,
  `Chinese`; a lista vem do modelo, `auto` deixa o modelo decidir). Padrão: `English`.
- `--qwen-port N`: porta do motor (1024–65535, diferente de 8081). Padrão: 8080.
- `--cache-dir DIR`: pasta do cache. **Use uma pasta dedicada**, nunca uma pasta com outros
  arquivos. `--cache-limit-mb N` define o limite (100–50000, padrão 4096).
- `--data-root DIR --require-mount`: só usar o cache se `DIR` for um disco montado.
- `--ready-timeout S`: segundos de espera pela primeira partida (30–1800, padrão 240). Em máquinas
  lentas ou sem cache de shaders, aumente.
- `--dry-run` (ou `python3 novel_tts.py plan …` com os mesmos argumentos) mostra o plano sem alterar
  nada. `--yes` confirma sem perguntar, para uso em scripts.

Confira e, se quiser que os serviços subam sem você estar logado, ative o *linger*:

```sh
~/.local/bin/novel-tts doctor          # "Diagnóstico: Saudável" e código de saída 0
loginctl enable-linger "$USER"         # opcional
```

### 5. Instalar a extensão

Na mesma página de Releases, baixe:

- **`novel-tts-extension-1.0.0.xpi`**, se existir: é a build assinada pela Mozilla (canal não
  listado). Abra o arquivo no Firefox (ou arraste-o para a janela) e confirme. A instalação é
  **permanente** e a extensão se atualiza por cima quando você instalar uma versão nova.
- **`novel-tts-extension-1.0.0.zip`**: build sem assinatura. Extraia, abra
  `about:debugging#/runtime/this-firefox`, clique em **Carregar extensão temporária…** e escolha o
  `manifest.json`. Ela **some quando o Firefox fecha** e precisa ser carregada de novo.

Ao instalar o `.xpi`, o Firefox mostra o aviso de dados: a extensão envia o texto que você escolhe ler e o
token de pareamento ao serviço local, e nada além disso (veja [privacidade](#privacidade-e-segurança)).

### 6. Parear

```sh
~/.local/bin/novel-tts token
```

Abra as **Opções** da extensão (`about:addons` → Novel TTS → Preferências), cole o token e clique
em **Salvar e verificar conexão**. Deve aparecer "conectado".

## Uso

1. Abra um capítulo e clique no botão da extensão na barra de ferramentas: o painel aparece.
2. **Ler página** (ou selecione um trecho e use **Ler seleção**). O parágrafo atual fica destacado.
3. Controles: pausar/continuar, trecho anterior/seguinte, repetir, parar (cancela a fila), voz,
   velocidade, volume, temperatura e *seed*.
4. Atalhos (com `Alt`): `Espaço` pausa/continua, `←`/`→` trecho anterior/seguinte, `R` repete,
   `S` para.
5. **Continuar** retoma do ponto onde você parou, inclusive depois de fechar a aba.
6. **Continuar no próximo capítulo** abre o próximo capítulo e segue sozinho. Para isso o site
   precisa estar autorizado em **Opções → Sites autorizados** (a extensão, por padrão, não toca em
   nenhum site além da aba em que você clicou).
7. **Preparar próximo capítulo** / **Pré-gerar capítulos** geram o áudio dos capítulos seguintes
   no cache, sem trazê-lo para o navegador.
8. **Perfil do site** permite escolher a área do capítulo e elementos a ignorar com seletores CSS.
9. **Biblioteca** e **Abrir arquivo** abrem o leitor de EPUB, PDF, TXT e HTML locais, com histórico
   e retomada.

Se o Firefox bloquear o áudio numa página recém-aberta (política de autoplay), clique uma vez no
painel e use **Continuar**.

### Importação de arquivos

Tudo é validado antes de entrar na biblioteca (IndexedDB do Firefox); arquivos recusados não ficam
guardados. Limites padrão: EPUB 64 MiB (4.096 entradas, 128 MiB descompactados, razão de compressão
200:1); PDF 100 MiB e até 20.000 páginas, com progresso e cancelamento; TXT/HTML 10 MiB. EPUBs
criptografados e PDFs sem texto são recusados — **não há OCR**. Nenhum importador acessa a rede.

## Manutenção

```sh
~/.local/bin/novel-tts doctor            # diagnóstico (use --json para saída estruturada)
~/.local/bin/novel-tts status            # resumo e estado das units
~/.local/bin/novel-tts logs              # últimas linhas dos dois serviços
~/.local/bin/novel-tts config            # caminho da configuração ativa
~/.local/bin/novel-tts token --rotate    # gera outro token e reinicia o cache (repareie a extensão)
```

Códigos de saída do `doctor`: `0` saudável · `1` configuração inválida · `2` alguma unit parada ·
`3` motor TTS indisponível · `4` voz configurada não registrada · `5` cache autenticado
indisponível · `6` versão ou modo incompatível.

**Atualizar.** Extraia o novo `novel-tts-host-X.Y.Z.tar.gz`, entre na pasta e rode:

```sh
/usr/bin/python3 novel_tts.py upgrade --dry-run --json     # confira o plano
/usr/bin/python3 novel_tts.py upgrade --yes
```

(Use `/usr/bin/python3`, o mesmo interpretador das units: um `python3` de venv ou conda pode ser outro.)

A configuração, o token, as vozes e o cache são preservados; um snapshot é criado antes, e a
atualização é revertida automaticamente se uma etapa falhar. Instale também a nova extensão.
Instalações da build interna 1.5.0 ("Novel Local Reader") atualizam do mesmo modo.

**Backups.** `novel-tts backup` cria um snapshot, `novel-tts backups --json` lista, e
`novel-tts restore --backup-id ID --dry-run --json` / `--yes` restaura um deles.
`novel-tts rollback` **desfaz a última instalação ou atualização**: restaura o snapshot validado mais
recente de `setup` ou `upgrade`, diz qual é (e quais ignorou) antes de pedir confirmação. Backups
manuais e snapshots de restore ou de rotação de token só voltam com `restore --backup-id`, e um
`uninstall` não se desfaz com `rollback` (rode o `install-service.sh` de novo). Cada snapshot guarda uma cópia da
configuração (inclusive o token) com permissão restrita; apague os antigos se não precisar deles.

**Desinstalar.** `novel-tts uninstall --dry-run --json` mostra o que seria removido e
`novel-tts uninstall --yes` remove só os scripts, o launcher e as units do projeto. Configuração,
token, backups, cache, modelos e voz **não** são apagados.

## Solução de problemas

- **`NLR_QWEN_PORT_CONFLICT` / `Address already in use`** — outra coisa usa a porta do motor (8080):
  `ss -ltnp | grep -E ':8080|:8081'`. Escolha outra com `--qwen-port` ou encerre o processo.
- **`NLR_CACHE_HEALTH_FAILED`** — o cache em 8081 não respondeu: veja `novel-tts logs` e confira que a
  porta 8081 está livre.
- **A primeira partida demora ou o setup acusa timeout** — o motor compila shaders Vulkan na
  primeira vez. Rode de novo com `--ready-timeout 600`.
- **"Pareamento necessário" / "chave rejeitada"** — o token mudou. Rode `novel-tts token` e cole de
  novo nas Opções.
- **Sem som numa página nova** — política de autoplay do Firefox; clique no painel e use Continuar.
- **Aviso de conformidade Vulkan do Mesa** nos logs — não indica falha.
- **`doctor` ≠ 0** — veja `novel-tts logs`; a tabela de códigos acima indica a camada com problema.

## Protocolo e compatibilidade

O host e a extensão falam o protocolo de aplicação 1 (faixa suportada 1–1), independente do HTTP.
`GET /health` informa a faixa e `GET /v1/nlr/capabilities` (autenticado) informa os recursos do
backend. Um host antigo, sem o campo `protocol`, é tratado como legado: a leitura continua com
recursos conservadores e o painel pede atualização. Faixas sem interseção bloqueiam a síntese
**antes** de o texto ser enviado.

Os erros têm `error.code`, `error.message` e `error.retryable`; só `UPSTREAM_UNAVAILABLE` e
`UPSTREAM_TIMEOUT` recebem uma segunda tentativa automática. Diagnósticos e capabilities não expõem
token, caminhos, modelos nem material de voz.

**Warm-cache.** Hosts que anunciam `capabilities.cache_warming=true` aceitam
`POST /v1/nlr/cache/warm` (autenticado) para preparar um WAV no cache sem transferi-lo ao
navegador; a resposta traz apenas `status`, `cached`, `duration`, `elapsed` e `fingerprint`. O
próximo parágrafo continua sendo *prefetch* de reprodução (recebe o WAV para evitar pausas); só
capítulos futuros usam o warm-cache.

**Modelo Base.** O talker Base aceita clonagem de voz, temperatura e *seed*, mas não instruções
livres de estilo. Pontuação, diálogos e a divisão dos parágrafos influenciam a prosódia. O cache é
invalidado quando mudam o servidor, os argumentos, os modelos, o codec ou o material de voz.

## Privacidade e segurança

- O texto que você manda ler segue da extensão para `127.0.0.1:8081` e dali para o motor em
  `127.0.0.1`. O host **recusa** qualquer endereço de motor que não seja loopback.
- A API do cache exige o token (Bearer), confere o cabeçalho `Host` e rejeita requisições cujo
  `Origin` não seja de uma extensão do Firefox. O texto não aparece nos logs.
- **Limite conhecido:** o motor (qwentts.cpp) em `127.0.0.1:8080` não tem autenticação e responde
  com CORS `*`. Uma página que você abra no navegador pode tentar falar com ele (por exemplo listar
  ou apagar a voz registrada, ou sintetizar texto com a sua voz). O Firefox pode pedir permissão ou
  bloquear esse acesso à rede local conforme a versão, mas não dependa disso: evite navegar em sites
  não confiáveis enquanto o serviço estiver ativo. O isolamento do motor está no [roadmap](ROADMAP.md).
- O token, a configuração, o cache e os backups ficam na sua conta de usuário, com permissão
  restrita. Nunca os publique nem os anexe a um relato de bug.

Detalhes e o que o Firefox registra em [PRIVACY_POLICY.md](PRIVACY_POLICY.md). Para reportar uma
vulnerabilidade, veja [SECURITY.md](SECURITY.md).

## Desenvolvimento

```sh
npm ci                                  # eslint e web-ext
python3 -m pip install ruff==0.16.10
./scripts/verify.sh                     # testes, lint, higiene e build reproduzível
python3 scripts/package_release.py --output dist   # exige um clone git
```

Veja [CONTRIBUTING.md](CONTRIBUTING.md) e [TESTING.md](TESTING.md). A pasta `dist/` é ignorada pelo
git. As Releases são geradas por tag (`v*`) pelo workflow `.github/workflows/release.yml`.

## Licença

Apache-2.0 ([LICENSE](LICENSE)). PDF.js e fflate são incluídos em `vendor/` com suas licenças; o
qwentts.cpp (MIT) e os modelos (Apache-2.0) **não** fazem parte deste projeto — veja
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
