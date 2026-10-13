# Image API quick reference

This file documents the Image API parameters exposed by the bundled `scripts/image_gen.py` CLI.

## Scope
- This CLI is intended for GPT Image models, including `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare`, `gpt-image-2`, and legacy Image 1 models.
- The skill routes image work through `scripts/image_gen.py`.

## Model summary

| Model | Quality | Input fidelity | Resolutions | Recommended use |
| --- | --- | --- | --- | --- |
| `gpt-image-2.5-sunburst` | `low`, `medium`, `high`, `xhigh`, `max`, `auto` | Omit `input_fidelity` | Flexible constrained resolutions | Default: precise editing and high-quality final artwork |
| `gpt-image-2.5-flare` | `low`, `medium`, `high`, `xhigh`, `max`, `auto` | Omit `input_fidelity` | Flexible constrained resolutions | Only when the user explicitly requests speed |
| `gpt-image-2` | `low`, `medium`, `high`, `auto` | Do not set `input_fidelity` | Flexible constrained resolutions | Explicit compatibility override |
| `gpt-image-1.5` | `low`, `medium`, `high`, `auto` | `low`, `high` | `1024x1024`, `1024x1536`, `1536x1024`, `auto` | True transparent-background output and backward-compatible workflows |
| `gpt-image-1` | `low`, `medium`, `high`, `auto` | `low`, `high` | `1024x1024`, `1024x1536`, `1536x1024`, `auto` | Legacy compatibility |
| `gpt-image-1-mini` | `low`, `medium`, `high`, `auto` | `low`, `high` | `1024x1024`, `1024x1536`, `1536x1024`, `auto` | Cost-sensitive draft batches and lower-stakes previews |

The documented `2026-09-08` snapshots of both Image 2.5 models have the same quality/resolution support. The CLI's default `quality=xhigh` is an Image API output-quality field, not a reasoning-effort field.

## GPT Image 2 and 2.5 sizes

GPT Image 2 and 2.5 accept `auto` or any `WIDTHxHEIGHT` size that satisfies all constraints:

- Maximum edge length must be less than or equal to `3840px`.
- Both edges must be multiples of `16px`.
- Long edge to short edge ratio must not exceed `3:1`.
- Total pixels must be at least `655,360` and no more than `8,294,400`.

Popular sizes:

| Label | Size | Notes |
| --- | --- | --- |
| Small square | `1024x1024` | Explicit smaller-resolution request |
| Landscape | `1536x1024` | Standard landscape |
| Portrait | `1024x1536` | Standard portrait |
| 2K square | `2048x2048` | Larger square output |
| Largest square | `2880x2880` | Default for unspecified new images; within 8,294,400-pixel cap |
| 2K landscape | `2048x1152` | Widescreen output |
| 4K landscape | `3840x2160` | Widescreen 4K output |
| 4K portrait | `2160x3840` | Vertical 4K output |
| Auto | `auto` | Explicit API sizing request |

For unspecified dimensions, `--aspect-ratio 16:9` chooses `3840x2160` and `9:16` chooses `2160x3840`. Editing retains the first input image's ratio at the highest permitted resolution. The API describes resolutions above `2560x1440` as experimental; 4K requests are not a guarantee that the service will always succeed.

## Endpoints
- Generate: `POST /v1/images/generations` (`client.images.generate(...)`)
- Edit: `POST /v1/images/edits` (`client.images.edit(...)`)

## Core parameters for GPT Image models
- `prompt`: text prompt
- `model`: image model
- `n`: number of images (1-10)
- `size`: the CLI defaults to high-resolution dimensions for GPT Image 2/2.5; flexible sizes are allowed for these models. Older GPT Image models use `1024x1024`, `1536x1024`, `1024x1536`, or `auto`.
- `quality`: `low`, `medium`, `high`, or `auto`; Image 2.5 also supports `xhigh` and `max`. The CLI defaults to `xhigh` for Image 2.5 and `high` for explicit legacy overrides.
- `background`: output transparency behavior (`transparent`, `opaque`, or `auto`) for generated output; this is not the same thing as the prompt's visual scene/backdrop
- `output_format`: `png` (default), `jpeg`, `webp`
- `output_compression`: 0-100 (jpeg/webp only)
- `moderation`: `auto` (default) or `low`

## Edit-specific parameters
- `image`: one or more input images. For GPT Image models, you can provide up to 16 images.
- `mask`: optional mask image
- `input_fidelity`: `low` or `high` only for models that support it; omit for GPT Image 2 and 2.5.

Model-specific note for `input_fidelity`:
- `gpt-image-2` always uses high fidelity for image inputs and does not support setting `input_fidelity`.
- `gpt-image-1` and `gpt-image-1-mini` preserve all input images, but the first image gets richer textures and finer details.
- `gpt-image-1.5` preserves the first 5 input images with higher fidelity.

## Transparent backgrounds

Sunburst and Flare support native `background=transparent`. Select `output_format=png` or `webp`. They do not require chroma-key post-processing.

Transparency for `gpt-image-2` is an API preview feature; the CLI retains a compatibility guard. The default Sunburst or an explicit `gpt-image-1.5` override provides a documented native transparency path.

## Output
- `data[]` list with `b64_json` per image
- The bundled `scripts/image_gen.py` CLI decodes `b64_json` and writes output files for you.

## Limits and notes
- Input images and masks must be under 50MB.
- Use the edits endpoint when the user requests changes to an existing image.
- Masking is prompt-guided; exact shapes are not guaranteed.
- Large sizes and high quality increase latency and cost.
- Keep `xhigh` by default. Select `max` for an explicit maximum-quality request; lower quality/resolution only when the user requests it.
- High `input_fidelity` can materially increase input token usage on models that support it.
- If a request fails because a specific option is unsupported by the selected GPT Image model, retry manually without that option only when the option is not required by the user.

## Important boundary
- `quality`, `input_fidelity`, explicit masks, `background`, `output_format`, and related parameters are CLI execution controls.

## Sources checked on 2026-10-13

- [Create image](https://developers.openai.com/api/reference/resources/images/methods/generate)
- [Create image edit](https://developers.openai.com/api/reference/resources/images/methods/edit)
- [Introducing ChatGPT Images 2.5](https://openai.com/index/introducing-chatgpt-images-2-5/)
