# Privacy notice — Novel TTS 1.0.0

*English first; a Portuguese (Brazil) version follows below.*

Novel TTS is a Firefox extension plus a companion service that runs on your own computer. The
project does not operate a cloud speech service, an analytics endpoint or any server that receives
your data. This notice describes what the extension and the companion do with it.

## What is sent, and where

When you choose **Read page** or **Read selection**, continue a narration, explicitly prepare future
chapters, or enable future-chapter pre-generation, the extension sends the text needed for that
operation to the companion service at `127.0.0.1:8081`. That includes text extracted from web pages
and from local documents you opened in the reader. Each request carries:

- the text to be read;
- the synthesis settings you chose — the voice name, `temperature` and `seed` (these are functional
  inputs of the narration you asked for, not usage metrics);
- the local pairing token, in an `Authorization` header.

The request body does not contain the page URL or title. Health, capability, voice-list, cache
statistics and cache-clearing requests carry the token but no page text.

The companion forwards the text to the Qwen speech engine configured in its host profile. The host
validates its configuration and **refuses any engine address that is not loopback**
(`127.0.0.1` or `localhost`), so the text never leaves the machine through this project. The engine
(`qwentts.cpp`) is a separate program; its own logging and retention are governed by that program.
It has no authentication and answers browser requests from any origin (CORS), so while it runs a
web page you visit could try to reach `127.0.0.1:8080` and have text synthesized in your registered
voice; see [`SECURITY.md`](https://github.com/outrobrunoai/novel-tts/blob/main/SECURITY.md).

Normal narration returns the generated WAV audio to the extension for playback. Future-chapter
warm-cache requests send text to the companion but return only small metadata to the extension; the
audio stays in the host cache.

## Firefox data-collection declaration

The manifest declares two **required** data categories, which Firefox shows when you install the
extension:

- `websiteContent` — the text you select or open for reading, including text taken from local files
  you open in the reader;
- `authenticationInfo` — the pairing token sent to the local companion.

No other category is declared. Mozilla's taxonomy also lists extension settings under
`technicalAndInteraction`; the voice name, `temperature` and `seed` are sent only to the companion on
your own computer, as part of the narration request, and are never collected as telemetry, so that
category is not declared. The extension collects no usage metrics, diagnostics or environment data.

## What is stored, and where

In your Firefox profile (extension storage and IndexedDB): preferences, the pairing token, per-site
profiles, reading progress and history, the interface language and the documents you saved to the
library. (Site permissions you grant are held by Firefox itself.) None of this is sent to the companion, except the text
chosen for narration and the synthesis settings above.

On your computer, under your user account: the host configuration and token
(`~/.config/novel-local-reader/config.json`, mode 0600), snapshots made before upgrades
(`~/.config/novel-local-reader/backups/`, each holding a copy of the configuration), and the audio
cache (`~/.cache/novel-local-reader/` unless you configured another directory). Cache files are
named by a hash and contain the generated speech. The companion's access log records only the
request method, route and HTTP status — never the text, the token, request headers or file paths.

## Requests to websites

If you enable or invoke next-chapter pre-generation, the extension may fetch the next-chapter page
from the **same website** you are reading, using your browser's existing credentials for that site.
That request goes to the website, not to the companion, and the URL is not included in the
companion request. The returned chapter text may then be sent to the companion for warm-cache.

By default the extension does not run on any site except the tab where you click its toolbar
button. If you authorize a site in the options, a reader script is registered for that site only;
you can remove the permission at any time.

## Third parties

- **Mozilla.** If a release is signed for self-distribution, the extension package (not any user
  data) is uploaded to addons.mozilla.org for signing.
- **GitHub.** Releases are downloaded from GitHub, which has its own privacy practices.
- **Model and engine hosts.** You download the engine and the models yourself; the project does
  not.

## Retention and deletion

Delete saved documents and reading state from the library, or through Firefox's site data.
Clear the audio cache with **Clear local cache** in the panel (it removes only the files the service
created) or by deleting the cache directory. Removing the extension removes its browser storage but
does not delete the host configuration, snapshots or cache; `novel-tts uninstall` removes only the
program files and units and also keeps them. Delete those directories yourself if you want them gone.

## Contact and changes

Questions about this notice: open an issue at <https://github.com/outrobrunoai/novel-tts/issues>.
Security problems: see [`SECURITY.md`](https://github.com/outrobrunoai/novel-tts/blob/main/SECURITY.md) and use the private advisory form instead. Never include
tokens, document text, voice material or model files in a report. Changes to this notice are made
in the repository and noted in [`RELEASE_NOTES.md`](https://github.com/outrobrunoai/novel-tts/blob/main/RELEASE_NOTES.md).

---

# Aviso de privacidade — Novel TTS 1.0.0

O Novel TTS é uma extensão do Firefox mais um serviço auxiliar que roda no seu próprio computador.
O projeto não opera serviço de voz na nuvem, endpoint de análise nem servidor que receba seus dados.
Este aviso descreve o que a extensão e o serviço fazem com eles.

## O que é enviado e para onde

Quando você escolhe **Ler página** ou **Ler seleção**, continua uma narração, prepara capítulos
futuros de forma explícita ou ativa a pré-geração de capítulos futuros, a extensão envia o texto
necessário ao serviço auxiliar em `127.0.0.1:8081`. Isso inclui texto extraído de páginas da web e
de documentos locais abertos no leitor. Cada requisição leva:

- o texto a ser lido;
- as configurações de síntese que você escolheu — nome da voz, `temperature` e `seed` (parâmetros
  funcionais da narração pedida, não métricas de uso);
- o token local de pareamento, no cabeçalho `Authorization`.

O corpo da requisição não contém a URL nem o título da página. Requisições de saúde, capacidades,
lista de vozes, estatísticas e limpeza do cache levam o token, mas nenhum texto de página.

O serviço encaminha o texto ao motor Qwen configurado no perfil do host. O host valida a
configuração e **recusa qualquer endereço de motor que não seja loopback** (`127.0.0.1` ou
`localhost`); portanto, por este projeto, o texto não sai da máquina. O motor (`qwentts.cpp`) é um
programa separado, e seu registro e retenção são regidos por ele. Ele não tem autenticação e
responde a requisições de qualquer origem (CORS); enquanto roda, uma página que você visite pode
tentar acessar `127.0.0.1:8080` e gerar fala com a voz registrada (veja [`SECURITY.md`](https://github.com/outrobrunoai/novel-tts/blob/main/SECURITY.md)).

A narração normal devolve o áudio WAV à extensão para reprodução. As requisições de warm-cache de
capítulos futuros enviam texto ao serviço, mas devolvem à extensão apenas metadados pequenos; o
áudio fica no cache do host.

## Declaração de coleta de dados do Firefox

O manifesto declara duas categorias **obrigatórias**, exibidas pelo Firefox na instalação:

- `websiteContent` — o texto que você seleciona ou abre para leitura, inclusive de arquivos locais
  abertos no leitor;
- `authenticationInfo` — o token de pareamento enviado ao serviço local.

Nenhuma outra categoria é declarada. A taxonomia da Mozilla também lista dados de configuração da
extensão em `technicalAndInteraction`; o nome da voz, `temperature` e `seed` vão apenas ao serviço
no seu computador, como parte da requisição de narração, e nunca são coletados como telemetria —
por isso essa categoria não é declarada. A extensão não coleta métricas de uso, diagnósticos nem
dados do ambiente.

## O que é guardado e onde

No perfil do Firefox (armazenamento da extensão e IndexedDB): preferências, token de pareamento,
perfis de site, progresso e histórico de leitura, idioma da interface e os documentos salvos na biblioteca.
(As permissões de site que você concede ficam com o próprio Firefox.) Nada disso é enviado ao serviço, exceto o texto escolhido para
narração e as configurações de síntese acima.

No seu computador, na sua conta de usuário: a configuração e o token do host
(`~/.config/novel-local-reader/config.json`, modo 0600), os snapshots feitos antes de atualizações
(`~/.config/novel-local-reader/backups/`, cada um com uma cópia da configuração) e o cache de áudio
(`~/.cache/novel-local-reader/`, ou o diretório que você configurou). Os arquivos do cache têm nome
em hash e contêm a fala gerada. O log de acesso do serviço registra apenas método, rota e status
HTTP — nunca o texto, o token, cabeçalhos ou caminhos de arquivos.

## Requisições a sites

Se você ativar ou acionar a pré-geração do próximo capítulo, a extensão pode buscar a página do
próximo capítulo no **mesmo site** que você está lendo, com as credenciais que o navegador já tem
para ele. Essa requisição vai ao site, não ao serviço, e a URL não é incluída na requisição ao
serviço. O texto recebido pode então ser enviado ao serviço para o warm-cache.

Por padrão a extensão não roda em nenhum site além da aba em que você clica no botão da barra de
ferramentas. Se você autorizar um site nas opções, um script do leitor é registrado só para ele; a
permissão pode ser removida a qualquer momento.

## Terceiros

- **Mozilla.** Se uma versão for assinada para distribuição própria, o pacote da extensão (nenhum
  dado de usuário) é enviado ao addons.mozilla.org para assinatura.
- **GitHub.** As versões são baixadas do GitHub, que tem suas próprias práticas de privacidade.
- **Hospedagem do motor e dos modelos.** Você mesmo baixa o motor e os modelos; o projeto não.

## Retenção e exclusão

Apague documentos salvos e o estado de leitura pela biblioteca ou pelos dados do site no Firefox.
Limpe o cache de áudio com **Limpar cache local** no painel (remove só os arquivos que o serviço
criou) ou apagando o diretório do cache. Remover a extensão apaga o armazenamento dela no navegador,
mas não a configuração, os snapshots nem o cache do host; `novel-tts uninstall` remove apenas os
arquivos do programa e as units, e também os preserva. Apague esses diretórios você mesmo se quiser.

## Contato e mudanças

Dúvidas sobre este aviso: abra uma issue em <https://github.com/outrobrunoai/novel-tts/issues>.
Problemas de segurança: veja [`SECURITY.md`](https://github.com/outrobrunoai/novel-tts/blob/main/SECURITY.md) e use o formulário privado de advisories. Nunca inclua
tokens, texto de documentos, material de voz ou modelos num relato. Mudanças neste aviso são feitas
no repositório e registradas em [`RELEASE_NOTES.md`](https://github.com/outrobrunoai/novel-tts/blob/main/RELEASE_NOTES.md).
