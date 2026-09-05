# Roadmap

- [x] Clone storyweaver-sync-aid into this project, store API keys as secrets
- [x] Remove dark/mysterious tone from prompts, style, sanitizer and video grades
- [x] Webtoon/manhwa page style, high-detail prompts, max render quality (8 steps, 1344x768)
- [x] Verify end-to-end (bible → brief → prompts → image) — 3/3 panels generated in browser test
- [x] Per-panel Retry button: rebuilds the panel's 15-line chunk, regenerates the
      brief/prompt with the preceding chunk as context, re-renders on a fresh seed,
      timestamps untouched, progress persisted
- [ ] Reduce final video encoding from 1080p 30fps to 720p 24fps (browser + Colab encoder)

## Done
- [x] Confirmed the text service allows 5 requests/min PER KEY (not 60) — 7 keys = 35/min total
- [x] Prompt writing switched from strict JSON to lenient numbered lines + forgiving parser
- [x] Page fan-out capped at 6 writing lanes (one analysis + one writing call per 15 lines)
- [x] Temporary chat timing log removed
- [x] Full re-run verified: 3/3 panels rendered, same room/props kept across panels
- [x] Final video encoding reduced to 1280x720 @ 24fps (was 1920x1080 @ 30fps)
