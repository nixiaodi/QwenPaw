---
name: "imagegen"
description: "Use when the user requests image generation or editing, including posters, photos, product images, mockups, cutouts, or image variants."
metadata:
  qwenpaw:
    requires:
      env:
        - OPENAI_API_KEY
---

# Image Generation Skill

Use `scripts/image_gen.py` as the single execution path for image generation and editing.

## Runtime

Use the configured local OpenAI-compatible Image API endpoint:

- Base URL: `http://127.0.0.1:8317/v1`
- Default model: `gpt-image-2.5-sunburst`
- Speed option: `--fast` selects `gpt-image-2.5-flare`
- Default quality: `xhigh`
- Output directory convention: `output/imagegen/`

The script still supports overrides:

- `--base-url <url>`
- `--api-key <key>`
- `OPENAI_API_KEY`

Precedence for API key:

1. `--api-key`
2. `OPENAI_API_KEY`
Keep credentials in the private skill configuration or runtime environment. Never put credentials into a shared skill package.

## Model, quality, and resolution policy

1. Use Sunburst for generation and editing unless the user explicitly requests fast generation, a quick draft, or a speed-first workflow. Only that request authorizes `--fast` / Flare; do not infer it from task simplicity.
2. Respect explicit user model, dimensions, aspect ratio, and quality. A speed request changes the model and does not automatically lower quality or resolution.
3. With no quality request, use `xhigh`. Use `--quality max` if the user explicitly requests the maximum quality. These are Image API quality values, not reasoning-effort parameters.
4. With no dimensions, choose the highest permitted resolution for the intended aspect ratio: `--aspect-ratio 16:9` gives `3840x2160`; `9:16` gives `2160x3840`; unspecified new images default to `2880x2880`, the largest supported square within the pixel cap. Edits retain the first input image's aspect ratio unless the user requests a change.
5. 4K-sized output is experimental under the API contract. Never silently fall back to a lower quality/model/size after a failure; report the failure and actual result.

Run `--dry-run` to inspect the resolved payload without generating an image.

## Commands

Generate one image:

```bash
python scripts/image_gen.py generate \
  --prompt "<prompt>" \
  --out output/imagegen/example.png
```

Generate a 9:16 poster:

```bash
python scripts/image_gen.py generate \
  --prompt "<poster prompt>" \
  --aspect-ratio 9:16 \
  --out output/imagegen/poster.png
```

Edit an existing image:

```bash
python scripts/image_gen.py edit \
  --image input.png \
  --prompt "<edit prompt>" \
  --out output/imagegen/edited.png
```

Batch generate from JSONL:

```bash
python scripts/image_gen.py generate-batch \
  --input tmp/imagegen/prompts.jsonl \
  --out-dir output/imagegen/batch \
  --concurrency 5
```

Use `--dry-run` to inspect payloads without calling the API.

When the user explicitly requests speed:

```bash
python scripts/image_gen.py generate --fast \
  --prompt "<prompt>" --out output/imagegen/quick.png
```

## Workflow

1. Classify the task as generation, edit, or batch generation.
2. Choose the model, resolution, and quality using the policy above, then write a concise prompt from the user requirements.
3. Use `scripts/image_gen.py` directly; do not use the built-in `image_gen` tool for this skill.
4. Save final assets under `output/imagegen/` unless the user names another destination.
5. Avoid overwriting existing assets unless the user requested replacement; otherwise use a descriptive new filename.
6. Verify the output exists and read its actual dimensions. Inspect it before reporting completion; for large originals create an additional preview with `--downscale-max-dim 1600`, keeping the original intact.
7. Call `send_file_to_user` with the existing image so the chat has a real downloadable attachment. Report the actual file, model, dimensions, and quality. Tool errors, dry-runs, planned paths, and API success without a saved file are not completed images.

## Prompt Guidance

Use short labeled specs for complex assets:

```text
Use case: <photorealistic-natural|product-mockup|ui-mockup|infographic-diagram|ads-marketing|logo-brand|illustration-story|stylized-concept>
Asset type: <where the asset will be used>
Primary request: <user's main request>
Scene/backdrop: <environment>
Subject: <main subject>
Style/medium: <photo/illustration/3D/poster/etc>
Composition/framing: <wide/close/top-down/9:16/etc>
Lighting/mood: <lighting and mood>
Color palette: <palette notes>
Text (verbatim): "<exact text>"
Constraints: <must keep/must avoid>
Avoid: <negative constraints>
```

Keep prompt augmentation conservative:

- Preserve user-specified content, wording, aspect ratio, and required visual symbols.
- Add only composition, lighting, style, and production details that directly improve output quality.
- For Chinese poster or invitation work, include exact Chinese title/copy where text accuracy matters.
- For edits, repeat invariants such as `change only X; keep Y unchanged`.

## Transparent Images

Sunburst and Flare support native transparent output:

```bash
python scripts/image_gen.py generate \
  --background transparent --output-format png \
  --prompt "<subject> on a transparent background" \
  --out output/imagegen/cutout.png
```

Use chroma-key extraction only when requested or when native transparency is unavailable:

```bash
python scripts/image_gen.py generate \
  --prompt "<subject> on a perfectly flat solid #00ff00 chroma-key background; no shadows, gradients, floor plane, reflections, texture, watermark, or text" \
  --out tmp/imagegen/keyed.png

python scripts/remove_chroma_key.py \
  --input tmp/imagegen/keyed.png \
  --out output/imagegen/cutout.png \
  --auto-key border \
  --soft-matte \
  --transparent-threshold 12 \
  --opaque-threshold 220 \
  --despill
```

Use `#ff00ff` instead of `#00ff00` for green subjects. Validate the final alpha image before using it.

If the user explicitly selects a legacy model, `gpt-image-1.5` supports native transparency and compatible `high`/`auto` defaults:

```bash
python scripts/image_gen.py generate \
  --model gpt-image-1.5 \
  --background transparent \
  --output-format png \
  --prompt "<prompt>" \
  --out output/imagegen/transparent.png
```

## References

- `references/cli.md`: CLI flags and recipes.
- `references/image-api.md`: Image API parameter reference.
- `references/prompting.md`: prompt-writing guidance.
- `references/sample-prompts.md`: reusable prompt examples.
- `scripts/remove_chroma_key.py`: local alpha extraction helper.
