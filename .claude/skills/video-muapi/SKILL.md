---
name: video-muapi
description: >
  Gera vídeo por API na MuAPI (o motor do Open Generative AI, de Anil-matcha) —
  text-to-video, image-to-video, primeiro/último frame, referência de personagem,
  extensão de clipe, lip-sync e pós (upscale, remover marca d'água, legenda, trocar
  áudio). Traz o catálogo dos 270+ modelos de vídeo (Seedance, Kling, Veo, Sora,
  Hailuo, Wan, Grok, LTX, Pixverse, Vidu, Runway) com os parâmetros aceitos por cada
  um, e um CLI que sobe o arquivo, envia o job, faz o polling e baixa o MP4. Use
  sempre que o pedido for "gerar um vídeo", "animar essa imagem", "vídeo com IA",
  "text to video", "image to video", "qual modelo de vídeo usar", "estender esse
  clipe", "lip sync", "vídeo pro anúncio/criativo", "MuAPI", "Seedance", "Kling",
  "Veo", "Sora", "Hailuo", ou quando o entregável final for um arquivo de vídeo
  gerado por modelo.
---

# Geração de vídeo via MuAPI

Portado do cliente do [Open Generative AI](https://github.com/Anil-matcha/Open-Generative-AI)
(`packages/studio/src/muapi.js` + `models.js`). Uma API só, o mesmo padrão para todos os
modelos: **POST no endpoint → `request_id` → polling até ficar pronto**.

## Antes de começar

A chave vem de `MUAPI_KEY` (ou `~/.muapi_key`). Sem ela nada roda — peça ao usuário
(cria em https://muapi.ai) em vez de tentar adivinhar. Confira saldo antes de um job caro:

```bash
S=.claude/skills/video-muapi/scripts/muapi_video.py
python3 $S balance
```

## O caminho normal

```bash
# 1. achar o modelo (nunca leia o catálogo JSON inteiro — ele tem 200 KB)
python3 $S models --kind t2v --search seedance
python3 $S show seedance-2.5-image-to-video      # schema exato do modelo

# 2. conferir o payload antes de gastar crédito
python3 $S gen --model seedance-2.5-text-to-video --prompt "..." --ar 9:16 --dry-run

# 3. gerar (sobe arquivos locais, faz polling e baixa sozinho)
python3 $S gen --model seedance-2.5-image-to-video \
  --prompt "a câmera se aproxima devagar enquanto ela sorri" \
  --image frame.png --duration 8 --ar 9:16 --resolution 1080p \
  --out saida.mp4
```

Vídeo demora de 1 a 15 minutos. O `gen` já espera (`--timeout` padrão 1800s) e imprime
`request_id=...` no stderr assim que envia — se a espera estourar ou a sessão cair, o job
continua rodando e você retoma com `python3 $S poll <request_id> --out saida.mp4`.
Todo job enviado fica registrado em `~/.muapi/jobs.jsonl`.

## Escolher o modelo

| Objetivo | Modelo padrão | Por quê |
|---|---|---|
| Clipe do zero, com áudio nativo | `seedance-2.5-text-to-video` | 4–16s, até 4K, `generate_audio` ligado por padrão |
| Animar uma foto/keyframe | `seedance-2.5-image-to-video` | aceita `last_image`, mesma faixa de duração e resolução |
| Movimento e física mais críveis | `kling-v3.0-pro-image-to-video` | 3–15s, `generate_audio`; o padrão do mercado para movimento humano |
| Fala/diálogo com áudio junto | `veo3.1-image-to-video` ou `veo-4-text-to-video` | Veo entrega diálogo e sound design; Veo 4 vai a 30s |
| Estética de cinema, tomada longa | `openai-sora-2-pro-text-to-video` | 10/15/25s, 1080p |
| Vertical rápido e barato (teste de criativo) | `seedance-2-mini-image-to-video` | 480/720p, barato para testar hook antes de subir a resolução |
| Amarrar dois frames | `seedance-2.5-first-last-frame`, `pixverse-v6-transition`, `vidu-q3-pro-first-last-frames` | primeiro + último frame |
| Manter o mesmo personagem/produto | `seedance-2.5-omni-reference`, `kling-o1-reference-to-video` (até 7 imgs), `veo3.1-reference-to-video` (3) | referências de identidade |
| Continuar um clipe já gerado | `seedance-2-extend`, `veo3.1-extend-video`, `grok-imagine-extend` | recebem o `request_id` do job anterior, não um arquivo |
| Trocar/dirigir o personagem de um vídeo | `wan2.2-animate-recast`, `runway-act-two-recast`, `kling-v3.0-pro-recast` | recast: seu vídeo dá o movimento, a imagem dá quem aparece |
| Boca sincronizada com áudio real | `infinitetalk-image-to-video` (retrato), `sync-lipsync` / `latent-sync` (vídeo pronto) | lip-sync |
| Sem filtro de conteúdo | variantes `*-spicy-*`, `grok-imagine-*` com `--mode spicy` | a MuAPI não filtra prompt; a responsabilidade do uso é de quem gera |

Detalhe por modelo (duração, proporções, resolução, campos exclusivos) está em
`references/modelos.md`. O catálogo completo, legível por máquina, em
`references/catalogo.json` — consulte pelo CLI (`models` / `show`), não abrindo o arquivo.

## Os modos

**Text-to-video** — `--prompt` obrigatório. Nada de imagem.

**Image-to-video** — `--image foto.png` (arquivo local sobe sozinho; URL passa direto).
O prompt é opcional e descreve o *movimento*, não a cena. `--last-image` só nos modelos
que declaram `lastImageField` (o CLI reclama se não houver).

**Referência** — repita `--image` (identidade do personagem, produto, cenário); alguns
aceitam também `--video` e `--audio` de referência. O CLI põe cada um no campo certo
(`images_list`, `reference_images`, …), que muda de modelo para modelo.

**Extensão** — `--request-id <job anterior>` em vez de mídia. Só continua job do mesmo
modelo/família.

**Recast** — `--video cena.mp4 --image personagem.png`. O vídeo entra como *movimento e
atuação*; a imagem decide quem aparece. Serve para trocar o ator de uma tomada já filmada
ou para dirigir um personagem sem filmar de novo. `runway-act-two-recast` ignora prompt.

**Lip-sync** — retrato: `--image rosto.png --audio voz.mp3`. Vídeo pronto:
`--video clipe.mp4 --audio voz.mp3`. Áudio manda no resultado: grave limpo, sem música
por baixo, e sincronize antes de gerar.

Pós-produção fica em `--kind v2v`: `ai-video-upscaler`, `topaz-video-upscale`,
`video-watermark-remover`, `ai-captions`, `mmaudio-v2-video-to-video` (áudio novo),
`heygen-video-translate`, `wan2.7-video-edit`, `kling-v3.0-pro-motion-control`.

## Prompt de vídeo

Um prompt de vídeo tem **sujeito + ação + câmera + luz + ambiente**, nessa ordem, em
frases diretas. O que muda o resultado, na prática:

- **Uma ação por clipe.** Duas ações em 5s viram borrão. Precisa de duas? São dois clipes.
- **Movimento de câmera explícito** — *push in lento*, *travelling lateral*, *câmera na
  mão*, *estática*. Sem isso o modelo inventa um zoom genérico.
- **Luz nomeada** — *contraluz de fim de tarde*, *fluorescente de escritório*,
  *neon de rua molhada*. É o que separa "vídeo de IA" de imagem fotografada.
- **Diga o que é fixo.** Em i2v, o modelo tende a redesenhar o rosto: *mantém o rosto e a
  roupa da imagem, muda só o enquadramento*. Em Seedance, `-p camera_fixed=true` trava a câmera.
- **Áudio.** Seedance e Kling geram som com `generate_audio`; Veo e Sora respondem a
  descrição de fala e ruído no próprio prompt. Se a voz precisa ser de uma pessoa real,
  gere mudo e faça lip-sync depois.
- **Negativo** só onde existe (`--negative-prompt` no Wan e no Pixverse): *sem legenda,
  sem marca d'água, sem deformação de mão*.

Vertical (9:16) para anúncio; a primeira meia dúzia de frames é o hook — descreva o
primeiro frame como se fosse uma foto.

## A API, quando precisar escrever código

```
POST https://api.muapi.ai/api/v1/<endpoint>     header: x-api-key: <chave>
  -> { "request_id": "..." }
GET  https://api.muapi.ai/api/v1/predictions/<request_id>/result
  -> status: completed | succeeded | success  →  outputs[0] é a URL do MP4
     status: failed | error                   →  erro em .error
POST https://api.muapi.ai/api/v1/upload_file   multipart, campo "file" -> { url }
GET  https://api.muapi.ai/api/v1/account/balance
POST https://api.muapi.ai/api/v1/app/calculate_dynamic_cost  { task_name, payload }
```

Regras que quebram quem improvisa:

- É `x-api-key`. **Nunca** `Authorization: Bearer`.
- O endpoint é `model.endpoint` quando existe, senão o próprio `id`. Alguns divergem —
  `seedance-2-extend` → `seedance-v2.0-extend`, `latent-sync` → `latentsync-video`.
- 5xx durante o polling é transitório: continue tentando, não aborte.
- A saída pode vir em `outputs[0]`, `url` ou `output.url` — normalize os três.
- Poucos endpoints respondem o resultado direto, sem `request_id`. Trate os dois casos.
- Cada modelo tem seu campo de imagem: `image_url`, `images_list`, `reference_images`,
  `image_urls`. Mandar no campo errado devolve 200 e um vídeo que ignora a imagem.
- Enum errado (proporção que o modelo não tem) volta 4xx. Confira com `show` antes.

## Depois de gerar

O arquivo baixado é o material bruto. Para legenda queimada em estilo cinema use a skill
`legenda-cinema`; para montar várias tomadas com voz clonada, `orquestrador-criativos`;
para roteiro de anúncio, `diretor-criativo-gram` ou `legends-copywriting`. Este skill
entrega o MP4 — não corta, não legenda, não publica.

Custo é por geração e sobe com resolução e duração. Antes de uma bateria, gere **um**
clipe curto em 480p/720p para validar prompt e enquadramento; só então suba para 1080p/4K.
