# Security policy

## Status

PartZero is in Phase 0 (foundations and spikes). There are no releases, and no packages or installers have been published, so no version is supported for production use yet. We still want to hear about security problems in the code on `main`.

## Reporting a vulnerability

**Please don't report security problems in public issues, pull requests or discussions.**

Report them privately through GitHub Security Advisories:

1. Open [Report a vulnerability](https://github.com/antonarnaudov/PartZero/security/advisories/new) (or the repository's **Security** tab, then **Report a vulnerability**).
2. Describe the problem and its impact, and give the exact steps to reproduce it: the inputs, the commands, and the commit or version.
3. If you have a proof of concept, attach it to the advisory. Please don't publish it.

Only the maintainers can see the report. We'll reply in the advisory thread.

## What to expect

- **Acknowledgement** within 7 days.
- **An assessment** (accepted or declined, with our reasons) within 30 days.
- **A fix and a coordinated disclosure** date agreed with you in the advisory. We'll credit you in the published advisory unless you'd rather we didn't.

The maintainers are a very small team, so these targets are best effort.

## Scope

In scope:

- the Forge engine and its bindings (`forge/`);
- the TypeScript packages (`packages/`), in particular:
  - the desktop app's sandboxing and IPC (`packages/desktop`);
  - how LLM API keys and CLI-agent credentials are handled (`packages/llm-gateway`, `packages/agent`, `packages/mcp-server`);
  - prompt injection that leads to actions the user didn't approve;
- the CI workflows in `.github/workflows/`.

Out of scope:

- the differential-testing oracle (`oracle/` and every `*/oracle/` directory). It is CI tooling that is never shipped. Report bugs in the third-party libraries it uses (OCCT, build123d, PlaneGCS, SolveSpace) to their own projects;
- vulnerabilities in third-party dependencies that don't affect PartZero. Report those upstream;
- geometry that is wrong but has no security impact. Please file an ordinary [bug report](.github/ISSUE_TEMPLATE/bug_report.md) for it. Silently wrong geometry is still a serious bug to us.

## Secrets

If you find a credential, token or API key committed to this repository, report it privately as described above. Don't use it, test it or share it.
