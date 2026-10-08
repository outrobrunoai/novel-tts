<p align="center">
  <img src="icon.svg" width="80" alt="Novel TTS">
</p>

<h1 align="center">Novel TTS 1.0.0</h1>

<p align="center">
  Ouça suas novels, livros e páginas da web com uma voz gerada no seu computador.
</p>

<p align="center">
  <a href="#comece-por-aqui">Instalação</a> ·
  <a href="#recursos">Recursos</a> ·
  <a href="docs/GUIDE.md">Guia completo</a> ·
  <a href="SECURITY.md">Segurança</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Plataforma-Linux-blue" alt="Linux">
  <img src="https://img.shields.io/badge/Firefox-144%2B-orange" alt="Firefox 144 ou superior">
  <img src="https://img.shields.io/badge/Motor-Qwen3--TTS-purple" alt="Qwen3-TTS">
  <a href="LICENSE"><img src="https://img.shields.io/badge/Licen%C3%A7a-Apache--2.0-green" alt="Licença Apache-2.0"></a>
</p>

O **Novel TTS** combina uma extensão para Firefox com um serviço local de síntese de voz.
Leia uma página inteira, escute apenas um trecho ou abra um arquivo da sua biblioteca.
O leitor acompanha o texto e permite continuar de onde você parou.

A geração de áudio usa o [qwentts.cpp](https://github.com/ServeurpersoCom/qwentts.cpp),
uma implementação local do **Qwen3-TTS**, com uma voz preparada a partir de uma amostra de áudio.
O texto escolhido para leitura é processado pelos serviços no seu computador.

> **English:** Novel TTS is a Firefox extension and local Linux companion service for reading
> web pages, novels and EPUB/PDF/TXT/HTML files aloud with Qwen3-TTS. It supports voice cloning,
> reading progress, chapter navigation and audio caching. The documentation below is in Portuguese.

## Recursos

| Recurso | O que você pode fazer |
| --- | --- |
| Leitura de páginas | Ouvir o conteúdo da página ou uma seleção de texto |
| Biblioteca local | Importar EPUB, PDF, TXT e HTML e retomar a leitura depois |
| Voz personalizada | Usar uma voz preparada com uma amostra e sua transcrição |
| Acompanhamento do texto | Ver o parágrafo atual destacado durante a reprodução |
| Leitura contínua | Avançar para o próximo capítulo em sites autorizados |
| Preparação de capítulos | Gerar o áudio dos próximos capítulos antecipadamente |
| Cache de áudio | Reutilizar trechos já gerados sem sintetizá-los novamente |
| Controles de reprodução | Ajustar velocidade e volume, pausar, repetir e navegar entre trechos |
| Perfis de sites | Escolher a área de leitura e ignorar elementos com seletores CSS |

PDFs precisam conter texto selecionável. A extensão não faz OCR nem importa EPUBs criptografados.
O avanço automático depende da estrutura do site e das permissões concedidas.

## Comece por aqui

Você precisa de **Linux com `systemd --user`**, **Firefox 144+** (Desktop 144 ou superior) e **Python 3.10+** em
`/usr/bin/python3`. Uma GPU com Vulkan ou CUDA é recomendada; a geração em CPU é mais lenta.
Windows e macOS não são suportados nesta versão. A validação manual desta release foi feita no Arch Linux.

O motor, os modelos e a amostra de voz são preparados separadamente. O Novel TTS não os baixa
automaticamente. Reserve aproximadamente **2,5 GB para os modelos**, além do cache de áudio
(limite padrão de 4 GB).

1. **Prepare o motor e a voz.** Compile o qwentts.cpp, baixe os dois modelos GGUF e prepare a
   amostra de voz seguindo o [guia de instalação](docs/GUIDE.md#instalação).
2. **Instale o serviço local.** Use o pacote do host disponível nas
   [Releases](https://github.com/outrobrunoai/novel-tts/releases), quando publicado, ou execute
   `./install-service.sh` a partir de um clone do repositório. Os argumentos estão no guia.
3. **Instale a extensão.** Use o `.xpi` assinado, quando disponível. O `.zip` permite carregar
   uma extensão temporária pelo `about:debugging`, válida até fechar o Firefox.
4. **Conecte a extensão ao serviço.** Obtenha o token com o comando abaixo e cole-o nas
   preferências da extensão, em **Salvar e verificar conexão**.

```sh
~/.local/bin/novel-tts token
```

**[Abrir o guia completo de instalação →](docs/GUIDE.md#instalação)**

## Sua primeira leitura

1. Abra uma página e clique no ícone do Novel TTS na barra do Firefox.
2. Clique em **Ler página** ou selecione um trecho e use **Ler seleção**.
3. Ajuste a velocidade e o volume no painel. Use **Continuar** para retomar a leitura.

Para ouvir um livro ou documento, abra **Biblioteca** ou **Abrir arquivo**.
Para continuar entre capítulos, autorize o site nas opções da extensão.

| Atalho | Ação |
| --- | --- |
| `Alt` + `Espaço` | Pausar ou continuar |
| `Alt` + `←` / `→` | Trecho anterior ou seguinte |
| `Alt` + `R` | Repetir o trecho |
| `Alt` + `S` | Parar a leitura |

Mais detalhes no [guia de uso](docs/GUIDE.md#uso).

## Privacidade e segurança

O texto selecionado para leitura segue da extensão para o serviço local. O cache exige um
token de pareamento, e os documentos importados ficam na biblioteca do Firefox.
Consulte a [política de privacidade](PRIVACY_POLICY.md) para os detalhes de armazenamento e tratamento de dados.

**Limitação conhecida:** o motor qwentts.cpp usado nesta versão não exige autenticação e aceita
requisições de qualquer origem (CORS `*`). Uma página aberta no navegador pode tentar acessar
esse motor local, inclusive para gerar áudio ou manipular a voz registrada. A autenticação do cache
não protege o acesso direto ao motor. Evite sites não confiáveis enquanto ele estiver ativo e
não exponha as portas locais à rede. Consulte a [política de segurança](SECURITY.md) e o [roadmap](ROADMAP.md).

## Manutenção e diagnóstico

Para atualizar o serviço, extraia o novo pacote do host, entre na pasta e execute:

```sh
/usr/bin/python3 novel_tts.py upgrade --dry-run --json
/usr/bin/python3 novel_tts.py upgrade --yes
```

Use `/usr/bin/python3`, o mesmo interpretador dos serviços.
A atualização preserva a configuração, o token, as vozes e o cache e cria um snapshot antes das alterações.
Instale também a nova versão da extensão.

O comando `novel-tts rollback` desfaz a última instalação ou atualização,
restaurando o snapshot validado mais recente de `setup` ou `upgrade`.
Backups manuais são restaurados com `novel-tts restore --backup-id ID`.

Para diagnosticar problemas:

```sh
~/.local/bin/novel-tts doctor
~/.local/bin/novel-tts logs
```

- `NLR_QWEN_PORT_CONFLICT`: a porta do motor está ocupada; escolha outra com `--qwen-port`.
- `NLR_CACHE_HEALTH_FAILED`: o cache não respondeu; confira os logs e a porta 8081.

O host e a extensão usam o protocolo de aplicação 1.
Veja o [guia completo](docs/GUIDE.md) para manutenção e compatibilidade.

## Documentação e contribuições

| Documento | Conteúdo |
| --- | --- |
| [Guia completo](docs/GUIDE.md) | Instalação, uso, manutenção, diagnóstico e protocolo |
| [Host](HOST_README.md) | Serviço local e comandos de administração |
| [Contribuições](CONTRIBUTING.md) | Como contribuir com o projeto |
| [Testes](TESTING.md) | Verificação e testes |
| [Roadmap](ROADMAP.md) | Próximas melhorias |
| [Segurança](SECURITY.md) | Limitações e relato privado de vulnerabilidades |

Encontrou um problema de uso? Abra uma issue com a versão e os passos para reproduzir,
usando dados de exemplo. Para vulnerabilidades, use o canal privado indicado em `SECURITY.md`.

## Licença

Novel TTS é distribuído sob a licença [Apache-2.0](LICENSE).
As licenças de PDF.js, fflate, do motor e dos modelos estão descritas em
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
