---
name: Bug report
about: Something is wrong (a crash, wrong geometry, a wrong error, a failing build or test)
title: "[bug] "
labels: bug
---

<!--
Security problems: don't file them here. Report them privately (see SECURITY.md).
Pull requests from outside contributors aren't accepted yet (see CONTRIBUTING.md), so please don't attach patches.
-->

## What happened

<!-- One or two sentences. For geometry, say what's wrong: volume, topology, a missing face, a self-intersection… -->

## What you expected

<!-- If it's geometry, say what the correct result is and how you know (a hand calculation, another CAD tool, the spec). -->

## How to reproduce

<!-- The exact inputs and commands. Attach the IR document (.json) or CadScript file (.cad.ts), or paste it below. -->

```bash
# e.g. (from forge/)
cargo run -p forge-cli -- eval path/to/doc.json
```

<details>
<summary>Input document</summary>

```json

```

</details>

## Output

<!-- The full output: the error code and its structured context, or the metrics report, the stack trace or the CI log. -->

```text

```

## Where

- Commit (`git rev-parse --short HEAD`):
- Component: <!-- forge (which crate?) / cadscript / agent / app / desktop / oracle / CI / docs -->
- OS and architecture: <!-- e.g. macOS 15 arm64, Windows 11 x64, Ubuntu 24.04 x64, wasm32 in Chrome 1xx -->
- Toolchain, if you built it: <!-- rustc --version, node --version, pnpm --version -->

## Anything else

<!-- Is it deterministic? Did it work at an earlier commit? Is it the same on another OS (bit-identity)? -->
