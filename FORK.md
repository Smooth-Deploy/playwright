# SmoothDeploy fork of Playwright

Fork of [microsoft/playwright](https://github.com/microsoft/playwright), published as
`@smoothdeploy/playwright-core`, `@smoothdeploy/playwright` and `@smoothdeploy/playwright-test`.
Version numbers follow upstream.

`main` is the upstream release tag plus a short series of fork commits. The fork surface is
`git log <upstream-tag>..main`.

## What the fork adds

- `smoothdeploy` reporter: `[SMOOTHDEPLOY_EVENT]` lines on stdout plus a result manifest
  with per-step screenshots.
- Result screenshots: a highlighted screenshot of the target element after every action,
  enabled with `SD_SCREENSHOTS=1`. `SD_FAILURE_PAUSE=1` pauses headed runs on failure.
- Recorder `sourceChanged` carries structured `steps` (`ScriptStep`) and `actionIndex`.

## Syncing with a new upstream release

`check-upstream.yml` opens an issue when upstream publishes a release. Sync is local:

```bash
git fetch --no-tags upstream refs/tags/v1.66.0:refs/tags/upstream-v1.66.0
git rebase --onto upstream-v1.66.0 upstream-v1.65.0 main   # resolve conflicts commit by commit
node utils/generate_channels.js
node utils/generate_types/
npm run flint
npm run ttest -- reporter-smoothdeploy result-screenshots
git push --force-with-lease origin main
```

Upstream tags are fetched under an `upstream-` prefix so they never collide with fork tags.
`git config rerere.enabled true` remembers conflict resolutions between syncs.

## Releasing

Push a tag. CI builds and publishes all three packages with the tag's version.

```bash
git tag v1.66.0 && git push origin v1.66.0
```
