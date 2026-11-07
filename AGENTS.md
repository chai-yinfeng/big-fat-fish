# big-fat-fish — development agreement

Independent Companion project. Start with README.md, then load only the relevant
section of ARCHITECTURE.md or docs/DEV_WORKFLOW.md. Do not scan legacy directories
unless the task actually concerns them.

## Current boundaries
- Authority alone owns persona, world and canonical memory. Console and QQ are
  adapters. The default conversation executor still uses DSH; do not claim the
  runtime is DSH-free. Retain the executor port rather than rewriting an agent loop.
- Keep operator APIs/tokens, production state, reference recordings, model weights
  and platform credentials out of the model worker and Git. Never read old local
  credentials to populate a new environment. The configured origin is public.
- Do not bootstrap/reset a production data root, resume a world, send messages,
  install models, or spend provider budget without the relevant user permission.
- A generated/queued attachment is not delivery; require the platform receipt.
  Transcripts/captions are derived perception, not verbatim human evidence.

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
  fix on the Mac, release again. Data migrations are separate and need approval.

## Git and single-agent handoff
- The user requires Git history for completed development increments. Begin with
  git status and the current commit; make a focused local commit after relevant
  verification. Never rely on a filesystem backup as the only rollback mechanism.
- One agent writes a working tree at a time. Before switching agent or session, commit
  completed code, state remaining work and checks, and synchronize the intended
  branch. Never overwrite another tree's uncommitted edits.
- Push only to a destination the user has authorized. Never force-push, rewrite
  published history, hard-reset, or delete data without explicit confirmation.
  Prefer git revert for undoing a published change.
- Enable the repository-local pre-commit check with
  git config --local core.hooksPath .githooks. Do not bypass it to publish secrets.
- notes/ and ignored material remain local, not public source history. If a private
  record itself needs history, use a separately approved private repository.

## Fast verification
- Run the affected module first: node --run test:qq, test:speech, test:media,
  test:memory, test:authority, or test:console. Full node --run test is for release,
  migration, or cross-cutting changes, not every small edit.
- Batch related remote commands and return bounded summaries, not whole logs.
  SSH transport is not model-token usage; repeated calls/output/context are.
- Develop in a separate checkout/data root. Never patch an immutable production
  release in place or let two QQ bridges answer the same real conversation.
- A different directory under the same Linux user is not a security boundary.
  Before giving an agent production-host access, isolate its user/files or mounts.
- Report what really ran and what remains unverified. No GitHub/CLI installation,
  clean working tree, visual success, or voice-quality claims without evidence.
