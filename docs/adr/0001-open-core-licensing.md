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
| Forge, the app and the engine packages | **MPL-2.0**, with a contributor CLA |
| CadScript language, file format, SDK, MCP schemas, skills, corpus | **Apache-2.0** |
| Oracle and ML tooling (`oracle/`, `ml/`) | MPL-2.0 |
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
- **The CLA bot must exist before the public launch.**
- **Licence hygiene becomes a CI concern.** Every package and crate states its licence in its manifest. CI runs `cargo deny` and a JS licence check.
- **Test datasets** (DeepCAD, Fusion 360 Gallery, ABC) are downloaded at test time under their own licences. They are never committed, and each one is recorded in `corpus/external/SOURCES.md`.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Fully proprietary | Loses contributors, researchers, grant eligibility and the "open AI-native kernel" story, which is itself a go-to-market headline |
| GPL/AGPL for Forge | Widely considered incompatible with App Store distribution. It deters integrators and weakens the OEM path. |
| LGPL for Forge (like OCCT) | Relinking obligations are awkward with static linking and WASM bundles, and it adds no benefit over MPL-2.0 for our goals |
| Apache-2.0 for everything | No copyleft protection for kernel improvements, and less value in a commercial OEM licence |
| MPL-2.0 without a CLA | Rules out relicensing Forge to OEMs later |
