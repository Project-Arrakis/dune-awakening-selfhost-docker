# Contributing Companion-Bot Changes Upstream

**Status:** Current | **Last Updated:** August 2026

This guide is for contributors building an external companion Discord bot that needs a change in Dune Docker Core's Discord adapter or Console API.

It explains **where each change belongs** and how to prepare a small Core pull request against `Red-Blink/dune-awakening-selfhost-docker` without mixing external bot implementation details into this repository.

For runtime setup, start with the [Discord Adapter setup guide](README.md). For the server-side contract, see the [adapter contract](../discord-control-bot/api-adapter-contract.md) and [Console API reference](../../console/API-REFERENCE.md).

## Ownership boundary

A companion bot and Core are separate products. A feature that spans both should normally produce two coordinated pull requests.

| Change | Repository that owns it |
|---|---|
| Discord slash-command registration and handlers | Companion bot repository |
| Discord embeds, messages, interaction UX | Companion bot repository |
| Bot persistence, scheduling, deployment | Companion bot repository |
| Bot release packaging | Companion bot repository |
| Console API route | Dune Docker Core |
| Discord adapter route | Dune Docker Core |
| Core capability/RBAC enforcement | Dune Docker Core |
| Core-side data provider/query behavior | Dune Docker Core |
| Server-side response contract | Dune Docker Core |
| Core runtime configuration | Dune Docker Core |
| Core operator/API documentation | Dune Docker Core |

Do not copy a bot repository into a Core contribution branch. Do not include bot deployment scripts, bot release staging directories, or bot-internal roadmap/evidence files in a Core PR.

## When no Core PR is needed

A Core PR is not required when a change only affects the external bot, such as:

- command names or aliases;
- embed formatting;
- Discord-specific validation;
- bot scheduling;
- bot persistence;
- bot deployment;
- bot-only documentation.

Open a Core PR only when Core-owned behavior must change.

## Fork and remote setup

Fork `Red-Blink/dune-awakening-selfhost-docker` to your GitHub account, then clone your fork.

Example:

```bash
export GITHUB_USER="<your-github-user>"
export WORKSPACE="${WORKSPACE:-$HOME/projects}"

mkdir -p "$WORKSPACE"
cd "$WORKSPACE"

git clone \
  "git@github.com:${GITHUB_USER}/dune-awakening-selfhost-docker.git"

cd dune-awakening-selfhost-docker
```

Configure remotes so `origin` is writable and `upstream` is canonical:

```bash
git remote set-url origin \
  "git@github.com:${GITHUB_USER}/dune-awakening-selfhost-docker.git"

if git remote get-url upstream >/dev/null 2>&1; then
  git remote set-url upstream \
    "https://github.com/Red-Blink/dune-awakening-selfhost-docker.git"
else
  git remote add upstream \
    "https://github.com/Red-Blink/dune-awakening-selfhost-docker.git"
fi

git fetch --all --prune
git remote -v
```

Expected topology:

```text
origin    <github-user>/dune-awakening-selfhost-docker
upstream  Red-Blink/dune-awakening-selfhost-docker
```

If either remote points somewhere else, correct it before branching or pushing.

## Start every Core contribution from current upstream `main`

Do not base a Core upstream PR on a long-lived integration branch or a potentially stale fork `main`.

```bash
git fetch upstream main
git fetch origin --prune

git switch --detach upstream/main
git switch -c "upstream-pr/<issue>-short-description"
```

Immediately record the upstream base for your PR evidence:

```bash
git rev-parse upstream/main
git log -1 --oneline upstream/main
```

Before submission, refresh upstream again and verify your branch is not behind:

```bash
git fetch upstream main

git rev-list --count HEAD..upstream/main
```

Expected result:

```text
0
```

If the result is non-zero, rebase or rebuild the contribution on current upstream before submission.

## Keep the Core delta small

A Core contribution for a bot feature should contain only the server-side behavior required by the feature.

Typical examples:

- a new read-only adapter endpoint;
- a capability mapping;
- a response-contract correction;
- command-catalog metadata;
- Core-side API/operator documentation;
- regression tests for the Core behavior.

Review the contribution against upstream before committing:

```bash
git status --short
git diff upstream/main...HEAD
```

If the diff includes unrelated fork changes or bot-only files, stop and correct the branch.

## Validation

Run the repository's **current** checks for the subsystem you changed. Do not rely on historical test counts or a personal wrapper script as proof that current upstream CI will pass.

At minimum, verify the relevant combination of:

- Console API tests;
- Console web tests/build when UI behavior changed;
- runtime tests when runtime scripts changed;
- ShellCheck for changed shell scripts;
- security checks used by the repository;
- dependency audit when dependencies changed;
- documentation links/accuracy for changed contracts.

For adapter/API changes, include tests for both the success path and meaningful failure paths: authentication, authorization, malformed input, unavailable backing services, or unsupported capability states as applicable.

## Security and least privilege

For every new or changed adapter route, verify:

- authentication happens before protected work;
- authorization/capability checks match the route's real sensitivity;
- new permissions are the narrowest practical scope;
- user input cannot become an arbitrary shell command or unparameterized SQL;
- secrets and internal-only values are not returned to the bot;
- response-size/timeout behavior is bounded where expensive queries are possible;
- read-only claims match the real implementation.

Do not describe a route as read-only merely because the Discord command sounds observational. Verify the Core call path itself.

## Documentation

When an adapter/API contract changes, update the Core documentation that describes that behavior in the same PR when practical.

Common references include:

- [Discord Adapter setup and routes](README.md)
- [Discord adapter contract](../discord-control-bot/api-adapter-contract.md)
- [Console API reference](../../console/API-REFERENCE.md)

Bot-only documentation remains in the bot repository.

## Coordinate the bot PR and Core PR

When a feature requires both repositories, cross-link them.

In the bot PR:

```text
Depends on Core upstream PR: Red-Blink/dune-awakening-selfhost-docker#<N>
```

In the Core PR:

```text
Companion bot implementation: <owner>/<bot-repo>#<N>
```

Until the Core dependency is released, the bot should feature-gate the behavior or return a clear compatibility message. It should not silently assume an endpoint exists on every Core version.

## Duplicate-PR check

Before opening a new PR, search current upstream work:

```bash
gh pr list \
  --repo Red-Blink/dune-awakening-selfhost-docker \
  --state open
```

Search by issue number, endpoint name, route name, or feature description. If an active PR already covers the same Core change, coordinate there instead of creating a competing implementation.

## Commit and push

Stage only the intended files:

```bash
git add <explicit-paths>
git commit -m "feat(discord): <short Core-side change>"
git push -u origin "$(git branch --show-current)"
```

Avoid `git add -A` when the worktree contains unrelated changes.

## Core PR body

A useful Core PR body should make upgrade and failure behavior reviewable, not only describe the happy path.

Use headings such as:

```markdown
## Executive Summary

## What Changed and Why

## Fresh Install

## Migration / Upgrade Path

## Break/Fix and Mid-run Failure

## Credential Loss / Rotation

## Security and Least Privilege

## Testing

## Security Checks

## Integration / Live Validation

## Documentation Impact

## Known Limitations

## Rollback

## Related Bot Work
```

Use `N/A` with a short reason when a topic genuinely does not apply. Do not claim a check passed unless it was actually run against the submitted branch.

## Open the upstream PR as draft

```bash
BRANCH="$(git branch --show-current)"

gh pr create \
  --repo Red-Blink/dune-awakening-selfhost-docker \
  --base main \
  --head "${GITHUB_USER}:${BRANCH}" \
  --title "feat(discord): <short Core-side change>" \
  --body-file /tmp/core-upstream-pr.md \
  --draft
```

After creation, inspect the actual upstream diff:

```bash
gh pr view \
  --repo Red-Blink/dune-awakening-selfhost-docker \
  <PR_NUMBER>

gh pr diff \
  --repo Red-Blink/dune-awakening-selfhost-docker \
  <PR_NUMBER>
```

Keep the PR draft while required validation or review work remains.

## Before marking ready

- [ ] Branch is based on current upstream `main`.
- [ ] Only Core-owned behavior is included.
- [ ] Relevant Core tests pass.
- [ ] Security checks pass or any pre-existing unrelated finding is clearly identified and verified as unrelated.
- [ ] API/adapter contract documentation is current.
- [ ] Permissions are least-privilege.
- [ ] Fresh-install and upgrade behavior are documented.
- [ ] Failure and rollback behavior are documented.
- [ ] Test and security results are real outputs from the submitted branch.
- [ ] The upstream diff has been reviewed after PR creation.
- [ ] The related bot PR is cross-linked when one exists.

## After merge

Refresh your fork from canonical upstream using a non-destructive fast-forward when possible:

```bash
git fetch upstream
git switch main
git merge --ff-only upstream/main
```

Delete the contribution branch only after confirming the upstream PR is merged and the branch is no longer needed.

GitHub is the source of truth for PR state; do not rely on a manually maintained status file when `gh pr view` or the GitHub API can answer directly.
