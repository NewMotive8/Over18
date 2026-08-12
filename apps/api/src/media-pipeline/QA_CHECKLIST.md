# Media QA Checklist (US-16E)

Two layers, deliberately separated. The pipeline's automated layer covers only
what is objectively measurable; a candidate that fails it can never be
approved. Everything subjective below is HUMAN review — the reviewer's name is
recorded in the run record (`approve --approved-by`), and human judgment is the
final authority for visual quality.

## Automated technical checks (pipeline-enforced, `qa` / `approve`)
- File integrity: present, non-empty, decodable.
- Container/codec: H.264 MP4 (benchmark: existing approved Luna/Ember clips).
- Duration: ~5 s (4.0–6.5 accepted; approved set is 5.04 s).
- Frame rate: ~24 fps (23–31 accepted).
- Orientation: portrait; aspect within 0.50–0.80 (9:16 = 0.5625; approved set spans 0.54–0.74).
- Resolution: ≥ 720×1280 (approved set: 1056×1956 … 1240×1668, hero 1080×1920).
- Poster: present, same dimensions as the video (poster = extracted first frame).
- Loop/restart delta: first-vs-last-frame RMSE reported as a WARNING metric
  (the approved set uses hard-cut restarts; a large value flags a jarring loop
  for human attention, it does not fail QA).

## IMAGE QA (human)
- Identity consistency: matches the character's visual DNA / intent brief.
- Photorealism: no plastic skin, warped anatomy, extra fingers, melted jewelry,
  garbled text, or telltale generation artifacts.
- Composition: portrait framing that will crop well in the profile UI
  (subject centered/upper-third, headroom for overlays).
- Visual quality: sharp, well-lit, coherent styling.
- Suitability as canonical reference: this exact face/look is what every video
  must match — only promote an image you are happy to be bound to.

## VIDEO QA (human)
- Same character as the canonical reference (face, hair, build, styling).
- Motion quality: natural, single-scene, no cuts/transitions; believable
  body/hair/clothing movement.
- Facial/body consistency across the clip (no identity drift mid-clip).
- Absence of obvious generation artifacts (warping limbs, flickering,
  background melt, temporal shimmer).
- Technical format: automated checks above are green.
- Loop quality: restart cut is acceptable in the autoplay/loop profile UI.
- Poster/frame consistency: the poster still is a faithful first frame.
- Content boundary: sexy/sensual presentation within the product's
  NON-EXPLICIT, non-nude boundary. A clip that crosses it is rejected
  regardless of quality (`reject --reason`).

## Process
1. Generate candidates (budget-guarded) → human shortlist.
2. `select` ONE canonical image (QA-gated; `--replace` only deliberately).
3. Generate video candidates from the canonical reference only.
4. `reject` losers with a written reason (auditable).
5. `approve --approved-by "<name>"` the winner — technical QA re-runs, the
   poster is extracted, and nothing ever overwrites an approved asset without
   an explicit `--replace`.
