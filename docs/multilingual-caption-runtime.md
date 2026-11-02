# Multilingual caption runtime

Clean captions render with the application's Sharp/Pango path. Linux hosts need `fonts-noto-core` and `fonts-noto-cjk`; bootstrap provisions both. Existing hosts receive them through deliberate runtime maintenance:

```sh
sudo bash deploy/cloud/install-caption-fonts.sh
```

The maintenance command refreshes fontconfig and records the installed package versions in `/etc/riflo/caption-font-packages.tsv`. It does not deploy an application release or restart services. This root-owned, group-readable file is atomically replaced during maintenance; activation rejects missing manifests or package-version drift. Capture this file with deployment evidence. Package versions follow the host's configured Debian repositories; they are recorded rather than pinned to a version which might no longer be available. Reproduction requires the recorded packages and the same Sharp/Pango application dependencies.

The primary face is Noto Sans Bold. Missing script glyphs use fontconfig fallback; the gate verifies coverage in the actual resolved face. For Han characters without language metadata, the accepted default is Noto Sans CJK JP. This is a deterministic typography policy checked on the host, not inferred content language. It does not promise region-specific Simplified/Traditional Chinese glyph forms. No global fontconfig configuration is overwritten. A host with a different fallback order fails the gate and needs deliberate configuration review.

Activation uses the probes adjacent to the activating script and the candidate release's compiled caption implementation. Before stopping either service, `runuser -u riflo` checks installed packages, resolved primary/fallback glyph coverage, and real caption preparation for Latin, Greek, Cyrillic, Devanagari, Bengali, Tamil, Telugu, Thai, Arabic, Hebrew, Chinese, Japanese, Korean and mixed-script fixtures, including Arabic/Hebrew with English and numbers across wrapped lines. The same probes can inspect older rollback targets. Keep the activating script together with its `cloud/` helpers. Both coverage and raster errors leave current services and symlinks untouched.

For a repeatable manual check, replace the release directory below:

```sh
sudo runuser -u riflo -- python3 deploy/cloud/check-caption-fonts.py > caption-font-report.json
sudo runuser -u riflo -- node deploy/cloud/check-caption-render.mjs /opt/riflo/releases/RELEASE_ID
```

The raster probe creates temporary synthetic caption PNGs and removes them afterward. It exercises the actual fixed-size wrapping, grapheme handling and image limits. Glyph coverage and successful rasterization alone do not prove correct shaping or reading order; initial rollout requires visual inspection of the synthetic captions and a native FFmpeg overlay. The gate does not call transcription providers or read customer content. It makes no additional ASR language-support claim. Emoji fonts and regional Han selection remain outside this fixture contract.

Local deployment verification: `bash deploy/test-activate-release.sh` covers rejected coverage and rejected raster probes before any service command, plus existing activation and recovery cases. Linux raster/visual results must be recorded separately; macOS results do not establish production font behavior.
