# ADR 0001: Open-core licensing

- **Status:** Accepted
- **Date:** 2026-09-23
- **Plan reference:** PLAN-2026-09-23 §2 D1

## Context

- **The business model is ours to choose.** The user asked us to optimise for power, freedom and leverage.
- **The open-source world has no modern kernel** since Fornjot and CADmium were archived.
- **An open, AI-native kernel attracts** contributors, researchers, grants (e.g. NLnet/NGI Zero) and crowdfunding.
- **The durable advantages are elsewhere:** harness quality, the data flywheel, hosted models and speed.
- **Distribution constraints:** we ship desktop apps, a web app and eventually an iPad app, so the licences must be App Store-compatible.
- **Dependency constraints:** we can't ship LGPL/GPL runtime dependencies. Static linking and WASM make LGPL obligations awkward, and GPL would force the whole app open under GPL.

## Decision

| Component | Licence |
|---|---|
| Forge, the app and the engine packages (including `@aicad/llm-gateway`) | **MPL-2.0**, with a contributor CLA |
| CadScript language, file format (including `forge/crates/forge-ir`), SDK, MCP schemas, skills, corpus | **Apache-2.0** |
| Oracle and ML tooling (`oracle/`, `*/oracle/`, `ml/`) | MPL-2.0 |
| Documentation (`docs/`) | CC-BY-4.0 |

**Paid:**
- hosted AI (managed keys, our fine-tuned specialist models);
- cloud sync and collaboration;
- cloud compute;
- pro content.

**BYO-key AI use stays free.**

**Rules:**
- **No LGPL/GPL runtime dependencies** in anything we ship. GPL/LGPL tools (OCCT via OCP/build123d, SolveSpace, CalculiX) are used only as external test oracles in CI and are never distributed.
- **The CLA keeps dual-licensing Forge commercially to other CAD vendors open as an option,** similar to the Parasolid business model.

Per-component details are in [LICENSING.md](../../LICENSING.md).

## Consequences

**Positive:**
- **Contributions stay open.** MPL-2.0 is file-level copyleft: improvements to Forge files stay open, while embedding Forge in larger works stays possible.
- **MPL-2.0 is App Store-compatible.**
- **Adoption is easy where it matters.** Apache-2.0 on the language, format, SDK and schemas maximises adoption by third-party tools and agents.
- **A second revenue line is possible** through the OEM option.

**Negative / costs:**
- **A CLA adds contributor friction,** and some contributors refuse CLAs.
- **The CLA bot must exist before the public launch.** *(Superseded by the 2026-09-24 amendment below.)*
- **Licence hygiene becomes a CI concern.** Every package and crate states its licence in its manifest. CI runs `cargo deny` and a JS licence check.
- **Test datasets** (DeepCAD, Fusion 360 Gallery, ABC) are downloaded at test time under their own licences. They are never committed, and each one is recorded in `corpus/EXTERNAL_SOURCES.md` before first use.

## Amendment (2026-09-23): the exception list and the gates

- **`forge-ir` is Apache-2.0.** It sits in the MPL-2.0 `forge/` tree but it *is* the file-format contract: the IR types, the JSON Schemas and the normative `SPEC.md` that `packages/ir-types`, the oracle and third-party tools implement. It joins the Apache-2.0 exceptions with CadScript, `ir-types`, the SDK and the MCP schemas.
- **`@aicad/llm-gateway` is MPL-2.0**, like the other application packages; it is not part of the language, format or SDK contract. Its manifest declares MPL-2.0.
- **The gates exist.** CI's `licenses` job runs `cargo deny` with `forge/deny.toml` and the JS checks in `scripts/license-check/`: shipped dependencies (Rust and JS, transitively), the licence each of our manifests declares against the path map in [LICENSING.md](../../LICENSING.md), and the oracle-directory boundary of [ADR 0000](0000-own-the-core.md).
- **The dataset record is tracked.** It moved from the git-ignored `corpus/external/SOURCES.md` to [`corpus/EXTERNAL_SOURCES.md`](../../corpus/EXTERNAL_SOURCES.md); the downloads stay in the ignored `corpus/external/`.

## Amendment (2026-09-24): public repository before the CLA bot

The owner decided to make the repository public before the CLA bot exists, for free CI compute and to build in public.

- **The repository may be public without a CLA bot.** The gate moves from "public launch" to **the first accepted outside contribution**: the bot must be live before any outside contribution is accepted.
- **Until then, nothing from outside is merged.** Outside pull requests are closed without review. No outside code, patches or data from pull requests, issues or comments are merged, cherry-picked, applied or copied, by humans or agents ([CONTRIBUTING.md](../../CONTRIBUTING.md), [CLAUDE.md](../../CLAUDE.md) Git rules).
- **Why this keeps the OEM option intact.** Every line in the repository still comes from the owner or from agents working for the owner, so the MPL-2.0 plus commercial dual-licensing option in this ADR is unaffected.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Fully proprietary | Loses contributors, researchers, grant eligibility and the "open AI-native kernel" story, which is itself a go-to-market headline |
| GPL/AGPL for Forge | Widely considered incompatible with App Store distribution. It deters integrators and weakens the OEM path. |
| LGPL for Forge (like OCCT) | Relinking obligations are awkward with static linking and WASM bundles, and it adds no benefit over MPL-2.0 for our goals |
| Apache-2.0 for everything | No copyleft protection for kernel improvements, and less value in a commercial OEM licence |
| MPL-2.0 without a CLA | Rules out relicensing Forge to OEMs later |
