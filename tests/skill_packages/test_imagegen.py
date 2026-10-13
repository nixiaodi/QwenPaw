"""Offline CLI policy checks; never make paid image requests."""

import importlib.util
import json
from pathlib import Path
import sys

import pytest


@pytest.fixture
def cli(monkeypatch):
    monkeypatch.setattr(sys, 'dont_write_bytecode', True)
    path = Path(__file__).parents[2] / "deploy" / "skill-packages" / "imagegen" / "scripts" / "image_gen.py"
    spec = importlib.util.spec_from_file_location("imagegen_policy_cli", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def dry_run(cli, monkeypatch, capsys, *args):
    monkeypatch.setattr(sys, "argv", ["image_gen.py", *args, "--dry-run"])
    assert cli.main() == 0
    return json.loads(capsys.readouterr().out)


def test_unspecified_generation_uses_sunburst_xhigh_largest_square(
    cli, monkeypatch, capsys
):
    result = dry_run(
        cli, monkeypatch, capsys, "generate", "--prompt", "A product poster"
    )
    assert (result["model"], result["quality"], result["size"]) == (
        "gpt-image-2.5-sunburst",
        "xhigh",
        "2880x2880",
    )


def test_fast_switch_changes_only_model(cli, monkeypatch, capsys):
    result = dry_run(
        cli, monkeypatch, capsys, "generate", "--prompt", "A quick poster", "--fast"
    )
    assert (result["model"], result["quality"], result["size"]) == (
        "gpt-image-2.5-flare",
        "xhigh",
        "2880x2880",
    )


@pytest.mark.parametrize(
    "aspect,size", [("16:9", "3840x2160"), ("9:16", "2160x3840"), ("1:1", "2880x2880")]
)
def test_default_resolution_follows_requested_aspect(
    cli, monkeypatch, capsys, aspect, size
):
    result = dry_run(
        cli,
        monkeypatch,
        capsys,
        "generate",
        "--prompt",
        "A poster",
        "--aspect-ratio",
        aspect,
    )
    assert result["size"] == size


def test_user_size_and_quality_override_policy(cli, monkeypatch, capsys):
    result = dry_run(
        cli,
        monkeypatch,
        capsys,
        "generate",
        "--prompt",
        "A draft",
        "--fast",
        "--size",
        "1024x1024",
        "--quality",
        "low",
    )
    assert (result["model"], result["quality"], result["size"]) == (
        "gpt-image-2.5-flare",
        "low",
        "1024x1024",
    )


def test_edit_preserves_input_aspect_at_high_resolution(
    cli, monkeypatch, capsys, tmp_path
):
    from PIL import Image

    image = tmp_path / "source.png"
    Image.new("RGB", (160, 90)).save(image)
    result = dry_run(
        cli,
        monkeypatch,
        capsys,
        "edit",
        "--prompt",
        "Change only the title",
        "--image",
        str(image),
    )
    assert (result["model"], result["quality"], result["size"]) == (
        "gpt-image-2.5-sunburst",
        "xhigh",
        "3840x2160",
    )


@pytest.mark.parametrize(
    "model",
    [
        "gpt-image-2.5-sunburst",
        "gpt-image-2.5-flare",
        "gpt-image-2.5-sunburst-2026-09-08",
        "gpt-image-2.5-flare-2026-09-08",
    ],
)
@pytest.mark.parametrize("quality", ["xhigh", "max"])
def test_25_models_accept_extended_quality_and_4k(
    cli, monkeypatch, capsys, model, quality
):
    result = dry_run(
        cli,
        monkeypatch,
        capsys,
        "generate",
        "--prompt",
        "A poster",
        "--model",
        model,
        "--quality",
        quality,
        "--size",
        "3840x2160",
    )
    assert result["quality"] == quality


def test_legacy_override_uses_compatible_defaults(cli, monkeypatch, capsys):
    result = dry_run(
        cli,
        monkeypatch,
        capsys,
        "generate",
        "--prompt",
        "A cutout",
        "--model",
        "gpt-image-1.5",
        "--background",
        "transparent",
    )
    assert (result["quality"], result["size"]) == ("high", "auto")


def test_legacy_model_cannot_receive_xhigh(cli, monkeypatch):
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "image_gen.py",
            "generate",
            "--prompt",
            "A poster",
            "--model",
            "gpt-image-1.5",
            "--quality",
            "xhigh",
            "--dry-run",
        ],
    )
    with pytest.raises(SystemExit):
        cli.main()


def test_batch_resolves_each_job_model_before_default_quality(
    cli, monkeypatch, capsys, tmp_path
):
    jobs = tmp_path / "prompts.jsonl"
    jobs.write_text(
        json.dumps(
            {
                "prompt": "A native transparent cutout",
                "model": "gpt-image-1.5",
                "background": "transparent",
            }
        ),
        encoding="utf-8",
    )
    result = dry_run(
        cli,
        monkeypatch,
        capsys,
        "generate-batch",
        "--input",
        str(jobs),
        "--out-dir",
        str(tmp_path / "outputs"),
    )
    assert (result["model"], result["quality"], result["size"]) == (
        "gpt-image-1.5",
        "high",
        "auto",
    )


@pytest.mark.parametrize("size", ["4096x4096", "3841x2160", "3840x3840", "3840x1024"])
def test_25_models_reject_unsupported_sizes(cli, monkeypatch, size):
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "image_gen.py",
            "generate",
            "--prompt",
            "A poster",
            "--model",
            "gpt-image-2.5-sunburst",
            "--size",
            size,
            "--dry-run",
        ],
    )
    with pytest.raises(SystemExit):
        cli.main()


def test_fast_and_explicit_model_cannot_silently_conflict(cli, monkeypatch):
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "image_gen.py",
            "generate",
            "--prompt",
            "A poster",
            "--fast",
            "--model",
            "gpt-image-2.5-sunburst",
            "--dry-run",
        ],
    )
    with pytest.raises(SystemExit):
        cli.main()


def test_25_native_transparency(cli, monkeypatch, capsys):
    result = dry_run(
        cli,
        monkeypatch,
        capsys,
        "generate",
        "--prompt",
        "A cutout",
        "--background",
        "transparent",
        "--output-format",
        "png",
    )
    assert result["model"] == "gpt-image-2.5-sunburst"
    assert result["background"] == "transparent"
