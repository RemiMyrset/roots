## Summary

<!-- One or two sentences: what changed and why. -->

## Three-place sync

Behavior lives in three places. All that apply changed in this PR — or say why not:

- [ ] Source changed → tests updated
- [ ] Externally observable behavior changed → spec under `docs/internal/specs/` updated
- [ ] A load-bearing decision was made or reversed → record added under
      `docs/internal/decisions/` (append-only: supersede, never rewrite)
- [ ] N/A — docs-only or mechanical change

## Docs hygiene

- [ ] `pnpm docs:gen` run — nothing hand-edited between automd markers or in `docs/llms*.txt`
- [ ] `pnpm docs:check && pnpm docs:portability` pass locally
- [ ] No new file restates a fact that already has a canonical home (linked instead)

## Notes for reviewer

<!-- Risks, follow-ups, anything the diff doesn't say. -->
