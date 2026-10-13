# CLI reference (`scripts/image_gen.py`)

This file documents the direct CLI path used by this skill.

`generate-batch` is a CLI subcommand for multiple generation jobs.

## What this CLI does
- `generate`: generate a new image from a prompt
- `edit`: edit one or more existing images
- `generate-batch`: run many generation jobs from a JSONL file after the user explicitly chooses CLI/API/model controls

Real API calls require access to the configured OpenAI-compatible endpoint. `--dry-run` does not.

## Quick start (works from any repo)
Run the skill CLI from this skill directory:

```bash
python scripts/image_gen.py --help
```

Install dependencies into that environment with its package manager. In uv-managed environments, `uv pip install ...` remains the preferred path.

## Quick start

Dry-run (no API call; no network required; does not require the `openai` package):

```bash
python scripts/image_gen.py generate \
  --prompt "Test" \
  --out output/imagegen/test.png \
  --dry-run
```

Notes:
- One-off dry-runs print the API payload and the computed output path(s).
- Repo-local finals should live under `output/imagegen/`.

Generate (requires `OPENAI_API_KEY` + network):

```bash
python scripts/image_gen.py generate \
  --prompt "A cozy alpine cabin at dawn" \
  --out output/imagegen/alpine-cabin.png
```

Edit:

```bash
python scripts/image_gen.py edit \
  --image input.png \
  --prompt "Replace only the background with a warm sunset" \
  --out output/imagegen/sunset-edit.png
```

## Guardrails
- Use the bundled CLI directly (`python scripts/image_gen.py ...`) after activating the correct environment.
- Do **not** create one-off runners (for example `gen_images.py`) unless the user explicitly asks for a custom wrapper.
- Use `gpt-image-2.5-sunburst` by default. Use `--fast` / `gpt-image-2.5-flare` only when the user explicitly requests speed.

## Defaults
- Model: `gpt-image-2.5-sunburst`; `--fast` selects `gpt-image-2.5-flare`
- Supported model family for this CLI: GPT Image models (`gpt-image-*`)
- Size: `2880x2880` for unspecified new images; edits preserve the first image ratio at high resolution
- Quality: `xhigh` for Image 2.5; `high` for an explicit legacy model
- Aspect ratio: `--aspect-ratio WIDTH:HEIGHT` chooses high-resolution dimensions when `--size` is omitted
- Output format: `png`
- Default one-off output path: `output/imagegen/output.png`
- Background: unspecified unless `--background` is set

## GPT Image 2.5 size and model guidance

Sunburst is the default for generation and precise editing; Flare is the explicit speed option. `--fast` changes the model without reducing size or quality. Explicit `--size`, `--quality`, and `--model` override their defaults; `--model` and `--fast` cannot be combined.

- Omit `--quality` for `xhigh`; use `max` for an explicit maximum-quality request. Use `low` or `medium` only when requested.
- Omit dimensions for the largest square within the pixel limit (`2880x2880`).
- Use `--aspect-ratio 16:9` for `3840x2160`; use `9:16` for `2160x3840`.
- Edit defaults read the first input image dimensions and retain its ratio; `--size` or `--aspect-ratio` explicitly changes it.
- Omit `--input-fidelity` with GPT Image 2/2.5.
- Sunburst and Flare support `--background transparent --output-format png` directly.

Popular flexible-resolution sizes:
- `1024x1024`
- `1536x1024`
- `1024x1536`
- `2048x2048`
- `2880x2880`
- `2048x1152`
- `3840x2160`
- `2160x3840`
- `auto`

GPT Image 2 and 2.5 size constraints:
- max edge `<= 3840px`
- both edges multiples of `16px`
- long edge to short edge ratio `<= 3:1`
- total pixels between `655,360` and `8,294,400`
- outputs above `2560x1440` total pixels are experimental

Fast draft:

```bash
python scripts/image_gen.py generate \
  --prompt "A product thumbnail of a matte ceramic mug on a stone surface" \
  --fast \
  --quality low \
  --size 1024x1024 \
  --out output/imagegen/mug-draft.png
```

Final 2K landscape:

```bash
python scripts/image_gen.py generate \
  --prompt "A polished landing-page hero image of a matte ceramic mug on a stone surface" \
  --quality xhigh \
  --size 2048x1152 \
  --out output/imagegen/mug-hero.png
```

4K landscape:

```bash
python scripts/image_gen.py generate \
  --prompt "A detailed architectural visualization at golden hour" \
  --size 3840x2160 \
  --quality xhigh \
  --out output/imagegen/architecture-4k.png
```

True transparent request:

```bash
python scripts/image_gen.py generate \
  --prompt "A clean product cutout on a transparent background" \
  --background transparent \
  --output-format png \
  --out output/imagegen/product-cutout.png
```

The default Sunburst and the explicit speed model Flare both support native transparent output. `gpt-image-2` transparency is a preview API feature; the CLI retains a compatibility guard for that legacy model.

## Quality, input fidelity, and masks
These are explicit CLI controls.

- `--quality` works for `generate`, `edit`, and `generate-batch`: `low|medium|high|xhigh|max|auto`; `xhigh|max` require Image 2.5.
- `--input-fidelity` is **edit-only** and validated as `low|high`; omit it for GPT Image 2 and 2.5.
- `--mask` is **edit-only**

Example:

```bash
python scripts/image_gen.py edit \
  --model gpt-image-1.5 \
  --image input.png \
  --prompt "Change only the background" \
  --quality high \
  --input-fidelity high \
  --out output/imagegen/background-edit.png
```

Mask notes:
- For multi-image edits, pass repeated `--image` flags. Their order is meaningful, so describe each image by index and role in the prompt.
- The CLI accepts a single `--mask`.
- Image and mask must be the same size and format and each under 50MB.
- Masks must include an alpha channel.
- If multiple input images are provided, the mask applies to the first image.
- Masking is prompt-guided; do not promise exact pixel-perfect mask boundaries.
- Use a PNG mask when possible; the script treats mask handling as best-effort and does not perform full preflight validation beyond file checks/warnings.
- In the edit prompt, repeat invariants (`change only the background; keep the subject unchanged`) to reduce drift.

## Output handling
- Use `tmp/imagegen/` for temporary JSONL inputs or scratch files.
- Use `output/imagegen/` for final outputs.
- Reruns fail if a target file already exists unless you pass `--force`.
- `--out-dir` changes one-off naming to `image_1.<ext>`, `image_2.<ext>`, and so on.
- Downscaled copies use the default suffix `-web` unless you override it.

## Common recipes

Generate with augmentation fields:

```bash
python scripts/image_gen.py generate \
  --prompt "A minimal hero image of a ceramic coffee mug" \
  --use-case "product-mockup" \
  --style "clean product photography" \
  --composition "wide product shot with usable negative space for page copy" \
  --constraints "no logos, no text" \
  --out output/imagegen/mug-hero.png
```

Generate + also write a downscaled copy for fast web loading:

```bash
python scripts/image_gen.py generate \
  --prompt "A cozy alpine cabin at dawn" \
  --size 1024x1024 \
  --downscale-max-dim 1024 \
  --out output/imagegen/alpine-cabin.png
```

Generate multiple prompts concurrently (async batch):

```bash
mkdir -p tmp/imagegen output/imagegen/batch
cat > tmp/imagegen/prompts.jsonl << 'EOF'
{"prompt":"Cavernous hangar interior with a compact shuttle parked near the center","use_case":"stylized-concept","composition":"wide-angle, low-angle","lighting":"volumetric light rays through drifting fog","constraints":"no logos or trademarks; no watermark","size":"1536x1024"}
{"prompt":"Gray wolf in profile in a snowy forest","use_case":"photorealistic-natural","composition":"eye-level","constraints":"no logos or trademarks; no watermark","size":"1024x1024"}
EOF

python scripts/image_gen.py generate-batch \
  --input tmp/imagegen/prompts.jsonl \
  --out-dir output/imagegen/batch \
  --concurrency 5

rm -f tmp/imagegen/prompts.jsonl
```

Notes:
- `generate-batch` requires `--out-dir`.
- generate-batch requires --out-dir.
- Use `--concurrency` to control parallelism (default `5`).
- Per-job overrides are supported in JSONL (for example `size`, `quality`, `aspect_ratio`, `background`, `output_format`, `output_compression`, `moderation`, `n`, `model`, `out`, and prompt-augmentation fields). Missing size/quality defaults are resolved after each job's model selection, so legacy models receive compatible values.
- `--n` generates multiple variants for a single prompt; `generate-batch` is for many different prompts.
- In batch mode, per-job `out` is treated as a filename under `--out-dir`.
- For many requested deliverable assets, provide one prompt/job per distinct asset and use semantic filenames when possible.

## CLI notes
- Supported sizes depend on the model. GPT Image 2 and 2.5, including their documented dated snapshots, support flexible constrained sizes; older GPT Image models support `1024x1024`, `1536x1024`, `1024x1536`, or `auto`.
- True transparent CLI outputs require `output_format` to be `png` or `webp`; Sunburst and Flare support them. The legacy Image 2 preview feature retains a compatibility guard.
- `--prompt-file`, `--output-compression`, `--moderation`, `--max-attempts`, `--fail-fast`, `--force`, and `--no-augment` are supported.
- This CLI is intended for GPT Image models. Do not assume older non-GPT image-model behavior applies here.

## See also
- API parameter quick reference: `references/image-api.md`
- Prompt examples shared across both top-level modes: `references/sample-prompts.md`
- Network/sandbox notes: `references/codex-network.md`
- Transparent image workflow: `SKILL.md` and `scripts/remove_chroma_key.py`
