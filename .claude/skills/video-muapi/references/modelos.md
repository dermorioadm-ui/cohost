# Catálogo de modelos de vídeo — MuAPI

Recorte curado do catálogo do Open Generative AI (`packages/studio/src/models.js`).
O arquivo completo, com os 290 modelos e todos os campos, está em `catalogo.json` —
consulte por `muapi_video.py models` / `show`, não abrindo o JSON (200 KB).

Legenda: `dur` duração em segundos · `ar` proporções · `res` resolução · **negrito** = padrão.

---

## Text-to-video

| Modelo (`id`) | dur | ar | res | Extras |
|---|---|---|---|---|
| `seedance-2.5-text-to-video` | 4–16 (**5**) | 16:9 9:16 1:1 3:4 4:3 21:9 | 480p 720p **1080p** 4K | `generate_audio` (**true**), `camera_fixed` |
| `seedance-2-text-to-video` | 4–15 (**5**) | 21:9 16:9 4:3 1:1 3:4 9:16 | — | variantes `-fast`, `-vip`, `-mini`, `-spicy` |
| `seedance-2-mini-text-to-video` | 4–15 (**5**) | 6 proporções | 480p **720p** | `generate_audio`, `high_bitrate` — o mais barato para testar hook |
| `seedance-pro-t2v` | 3–12 (**5**) | 7 proporções | **480p** 720p 1080p | geração anterior, ainda barata |
| `kling-v3.0-pro-text-to-video` | 3–15 (**5**) | 16:9 9:16 1:1 | — | movimento humano; `-standard` mais barato |
| `kling-v3-turbo-pro-text-to-video` | 3–15 (**5**) | 16:9 9:16 1:1 | — | metade do tempo de fila |
| `kling-v2.5-turbo-pro-t2v` | 5–10 (**5**) | 16:9 9:16 1:1 | — | padrão **9:16** |
| `veo-4-text-to-video` | 5–30 (**8**) | 16:9 9:16 1:1 | — | único que vai a 30s |
| `veo3.1-text-to-video` | 8 fixo | 16:9 9:16 | 1080p | áudio e diálogo nativos; `-fast` e `-lite` |
| `openai-sora-2-text-to-video` | 10 / 15 | 16:9 9:16 | — | — |
| `openai-sora-2-pro-text-to-video` | 10 / 15 / 25 | 16:9 9:16 | **720p** 1080p | tomada longa |
| `minimax-hailuo-2.3-pro-t2v` | — | — | 1080p | prompt manda em tudo; `-standard` mais barato |
| `minimax-h3-text-to-video` | 5–15 | 6 proporções | 2k | saída 2K direta |
| `wan2.7-text-to-video` | 2–15 (**5**) | 16:9 9:16 1:1 4:3 3:4 | **720p** 1080p | `audio_url` de entrada, `negative_prompt` |
| `wan2.6-text-to-video` | 5 / 10 / 15 | 16:9 9:16 | **720p** 1080p | — |
| `ltx-2-fast-text-to-video` | 6–20 (par) | — | — | mais rápido do catálogo; `generate_audio` |
| `grok-imagine-text-to-video` | 6 / 10 / 15 | 9:16 16:9 2:3 3:2 1:1 | — | `mode` fun/**normal**/spicy |
| `pixverse-v6-t2v` | 1–15 (**5**) | 8 proporções | 360p–1080p | `generate_audio_switch` |
| `runway-text-to-video` | 5 / 8 | 5 proporções | **720p** 1080p | Gen-3 |
| `vidu-q3-pro-text-to-video` | 1–16 (**5**) | 5 proporções | 360p–1080p | `audio` |
| `hunyuan-fast-text-to-video` | — | 16:9 9:16 1:1 | — | barato |

## Image-to-video

| Modelo (`id`) | Campo da imagem | Último frame | dur | res |
|---|---|---|---|---|
| `seedance-2.5-image-to-video` | `image_url` | `last_image` | 4–16 (**5**) | 480p–**1080p**–4K, `generate_audio` |
| `seedance-2-image-to-video` | `images_list` | — | 4–15 | — (variantes `-fast`, `-vip`, `-480p`) |
| `seedance-2-mini-image-to-video` | `images_list` | — | 4–15 | 480p **720p** |
| `kling-v3.0-pro-image-to-video` | `image_url` | `last_image` | 3–15 (**5**) | `generate_audio` (**true**) |
| `kling-v2.1-master-i2v` | `image_url` | `last_image` | 5–10 | ar 16:9 9:16 1:1 |
| `veo3.1-image-to-video` | `image_url` | `last_image` | 8 fixo | 1080p, áudio nativo; `-fast`, `-lite` |
| `veo-4-image-to-video` | `images_list` | — | 5–30 (**8**) | ar 16:9 9:16 1:1 |
| `openai-sora-2-image-to-video` | `images_list` | — | 10 / 15 | `remove_watermark` (**true**) |
| `openai-sora-2-pro-image-to-video` | `images_list` | — | 10 / 15 / 25 | **720p** 1080p |
| `minimax-hailuo-2.3-pro-i2v` | `image_url` | — | — | 1080p |
| `minimax-h3-image-to-video` | `image_url` | `last_image_url` | 5–15 | 2k |
| `wan2.7-image-to-video` | `image_url` | `last_image` | 2–15 | **720p** 1080p, `audio_url`, `negative_prompt` |
| `grok-imagine-image-to-video` | `images_list` (até 7) | — | 6 / 10 / 15 | `mode` fun/normal/spicy |
| `pixverse-v6-i2v` | `images_list` | — | 1–15 | 360p–1080p, `thinking_type` |
| `runway-image-to-video` | `image_url` | — | 5 / 8 | **720p** 1080p |
| `ltx-2-fast-image-to-video` | `image_url` | — | 6–20 | `generate_audio` |
| `ai-video-effects` (ep `generate_wan_ai_effects`) | `image_url` | — | 5 / 10 | 60+ efeitos prontos em `name=` (Cakeify, Hulk Transformation, 360 Rotation…) |

## Primeiro e último frame

`seedance-2.5-first-last-frame` (4–30s, `images_list` com os dois frames) ·
`seedance-2-first-last-frame` (ar `adaptive` disponível) ·
`pixverse-v6-transition` (`image_url` + `last_image`, `style` anime/3d_animation/clay/comic/cyberpunk) ·
`vidu-q3-pro-first-last-frames` (1–16s, 360p–1080p) ·
`seedance-2-vip-first-last-frame-1080p` / `-4k`.

## Referência de personagem, produto ou cena

| Modelo | Entradas | Limite |
|---|---|---|
| `seedance-2.5-omni-reference` | `images_list` + `videos_list` + `audios_list` | 4–30s |
| `kling-o1-reference-to-video` | `images_list` | 7 imagens, `keep_original_sound` |
| `veo3.1-reference-to-video` | `images_list` | 3 imagens, 8s, `generate_audio` |
| `minimax-h3-reference-to-video` | `reference_images` / `reference_videos` / `reference_audios` | 5–15s, 2k |
| `wan2.7-reference-to-video` | `images_list` + `videos_list` | 2–10s |
| `seedance-2-vip-omni-reference` | `images_list` + `video_files` | usado pelo Marketing Studio |

## Extensão de clipe

Recebem o **`request_id` de um job anterior**, não um arquivo:
`seedance-2-extend` (→ endpoint `seedance-v2.0-extend`; aceita também `images_list`,
`video_files`, `audio_files`, `quality` basic/high) · `veo3.1-extend-video` ·
`grok-imagine-extend` (`extend_times` 6/10, 480p/720p) · `seedance-2-vip-extend`.

Por URL de vídeo (esses ficam em `v2v`): `wan2.7-video-extend`, `ltx-2.3-video-extend`,
`pixverse-v6-extend`, `seedance-v1.5-pro-video-extend`.

## Lip-sync

Retrato + áudio → vídeo falando:

| Modelo | Endpoint | res | Prompt |
|---|---|---|---|
| `infinitetalk-image-to-video` | igual | 480p 720p | opcional |
| `wan2.2-speech-to-video` | igual | 480p 720p | opcional |
| `ltx-2.3-lipsync` | igual | 480p 720p 1080p | opcional |
| `ltx-2-19b-lipsync` | igual | 480p 720p 1080p | opcional |
| `kling-v1-avatar-standard` / `-pro`, `kling-v2-avatar-standard` / `-pro` | igual | — | opcional |
| `omnihuman-1-5` | igual | `output_resolution` | opcional |

Vídeo pronto + áudio → boca sincronizada:

| Modelo | Endpoint | Observação |
|---|---|---|
| `sync-lipsync` | igual | o mais confiável para vídeo já filmado |
| `latent-sync` | **`latentsync-video`** | id diverge do endpoint |
| `creatify-lipsync`, `veed-lipsync` | igual | — |
| `infinitetalk-video-to-video` | igual | 480p 720p, aceita prompt |
| `volcengine-video-to-video-lip-sync` | igual | `mode` |

## Video-to-video e pós-produção

`ai-video-upscaler`, `ai-video-upscaler-pro`, `topaz-video-upscale` · `ai-captions` ·
`video-watermark-remover`, `seedance-2-watermark-remover` (→ `seedance-2.0-watermark-remover`),
`seedance-2-video-watermark-remover-pro` · `add-video-watermark` (`watermark_image_url`) ·
`video-background-remover` · `mmaudio-v2-video-to-video` (→ `mmaudio-v2/video-to-video`,
gera áudio novo pelo prompt) · `heygen-video-translate` · `ai-video-face-swap` ·
`ai-dance-effects` · `kling-v2.6-std-motion-control`, `kling-v3.0-pro-motion-control`
(transfere movimento de um vídeo para uma imagem) · `runway-aleph-v2v`, `luma-modify-video`,
`wan2.2-edit-video`, `wan2.7-video-edit`, `kling-o1-video-edit`, `gemini-omni-video-edit`,
`happy-horse-1.1-video-edit-1080p` · `remix-video`.

## Áudio (para trilha e voz do mesmo pipeline)

Música: `suno-create-music`, `suno-remix-music`, `suno-extend-music`, `suno-add-vocals`,
`suno-add-instrumental`, `suno-generate-mashup`, `suno-generate-sounds`, `suno-convert-to-wav`.
Voz: `minimax-speech-2.6-hd` / `-turbo`, `elevenlabs-tts-turbo-2-5`,
`elevenlabs-text-to-dialogue-v3`, `gemini-3-1-flash-tts`, `gemini-2-5-pro-tts`.
Clonagem: `suno-voice-clone`, `minimax-voice-clone`. Som ambiente: `mmaudio-v2-text-to-audio`
(→ `mmaudio-v2/text-to-audio`).

## Ids cujo endpoint diverge

Mandar o id como caminho da API dá 404 nestes casos — o CLI já resolve, código próprio precisa tratar:

```
seedance-2-t2v            -> seedance-v2.0-t2v          seedance-2-i2v        -> seedance-v2.0-i2v
seedance-2-extend         -> seedance-v2.0-extend       seedance-2-new-t2v    -> seedance-2.0-new-t2v
seedance-2-new-omni       -> seedance-2.0-new-omni      seedance-2-new-first-last -> seedance-2.0-new-first-last
seedance-2-omni-reference -> seedance-2.0-omni-reference  seedance-2-t2v-480p -> seedance-2.0-t2v-480p
seedance-2-i2v-480p       -> seedance-2.0-i2v-480p      seedance-lite-reference-video -> seedance-lite-reference-to-video
seedance-2-watermark-remover -> seedance-2.0-watermark-remover
latent-sync               -> latentsync-video           mmaudio-v2-video-to-video -> mmaudio-v2/video-to-video
mmaudio-v2-text-to-audio  -> mmaudio-v2/text-to-audio
ai-video-effects / motion-controls / vfx -> generate_wan_ai_effects
seedance-2-vip-*-1080p / -4k / -extend   -> sd-2-vip-*   (o prefixo vira "sd-2")
```

## Nota sobre o catálogo

É uma fotografia do repositório em agosto de 2026. A MuAPI publica modelos novos toda
semana: se `models --search` não achar o que o usuário pediu, o modelo pode existir mesmo
assim — rode com `--endpoint <caminho>` e monte o payload com `-p chave=valor`.
