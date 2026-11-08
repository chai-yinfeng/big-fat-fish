# big-fat-fish — development agreement

Companion for the user's family and friends (about 20 people at most). Start with
README.md, then load only the relevant section of ARCHITECTURE.md or
docs/DEV_WORKFLOW.md. Do not scan legacy directories unless the task concerns them.

## Hard boundaries
- Authority alone owns persona, world and canonical memory. Console and QQ are
  adapters. The current default conversation executor is still the DSH adapter.
  The planned replacement is a new executor built on pi-agent-core behind the
  capabilities/conversation executor port; do not hand-write an agent loop.
  DSH is not a future chat entry point; channels (QQ etc.) are.
- Keep operator APIs/tokens, production state, reference recordings, model weights
  and platform credentials out of the model worker and Git. Never read old local
  credentials to populate a new environment. The configured origin is public.
- A generated/queued attachment is not delivery; require the platform receipt.
  If delivery status is unknown, do not blindly resend.
- Machine transcripts/captions are derived content: label them as such and never
  present them as the person's own words.

## Permissions
- Ask before: bootstrapping/resetting a production data root, resuming a world,
  installing models, spending provider budget, or any data migration.
- Test messages/voice to the user's own bound QQ: one approval from the user covers
  the rest of that session. Sending to anyone else or to a group needs its own approval.

## Release to production (details: docs/DEV_WORKFLOW.md "发布与回退")
- Develop only on the Mac; the VM (myvm) is production only. Never patch the VM.
- The agent never runs sudo or companion-deploy and never asks for or handles the
  sudo password.
- Agent part: tests pass → user approves the push to main → node --run stage:release
  → give the user the exact commands plus expected values: commit sha + subject,
  tarball sha256, and, when companion-deploy changed, its expected sha256 from
  git show <sha>:deploy/authority/companion-deploy/companion-deploy | shasum -a 256.
- The user runs the commands, compares the hashes and answers y.
- Then verify without sudo: cat /var/log/companion-deploy.status.json,
  tail /var/log/companion-deploy.log, journalctl _UID=1001, and ss -ltn for
  ports 3001/3081/3082/6099.
- A failed health check auto-restores the previous release: diagnose from the logs,
  fix on the Mac, release again.
- Use a separate checkout/data root for development, and never let two QQ bridges
  answer the same real conversation.

## Git
- Begin with git status and the current commit. Make a focused local commit after
  relevant checks. One agent writes a working tree at a time; commit before handing off
  and never overwrite another tree's uncommitted edits.
- Push only where the user has authorized. Never force-push, rewrite published
  history, hard-reset, or delete data without explicit confirmation; prefer git revert.
- Enable the pre-commit check with git config --local core.hooksPath .githooks and
  do not bypass it.
- notes/ and ignored material stay local, never in public history.

## Verification and records
- Run the affected module first: node --run test:qq, test:speech, test:media,
  test:memory, test:authority or test:console. Full node --run test is for release,
  migration or cross-cutting changes.
- Batch remote commands and return bounded summaries, not whole logs.
- Report what really ran and what remains unverified; claim nothing without evidence.
- Each version gets short entries in CHANGELOG.md. No long per-round acceptance notes.
