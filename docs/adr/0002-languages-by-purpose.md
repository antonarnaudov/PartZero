# ADR 0002: Languages by purpose; Rust for Forge

- **Status:** Accepted
- **Date:** 2026-09-23
- **Plan reference:** PLAN-2026-09-23 §2 D2 and D2a

## Context

- **AI coding agents write, review and debug all the code.** The user is the product owner. Languages are chosen by purpose, and mixing them is fine.
- **The engine must run everywhere.** It runs natively on macOS, Windows and Linux, in an Electron utility process, in the browser and on iPad. It must produce **bit-identical results** on every target.
- **The engine must be verifiable.** It needs property tests, fuzzing, formal proofs of predicates and invariants, and a "never silently wrong" policy.
- **The kernel must serve four uses:** fast evaluation, certified evaluation, exact gradients and an exact in-house oracle.

## Decision

### D2: Languages by purpose

| Language | Used for |
|---|---|
| **Rust** | The whole engine, "Forge": kernel, solvers, tessellation, regeneration, renderer, I/O, checks. It compiles to native code (napi-rs, Swift FFI) and to `wasm32-unknown-unknown` with no Emscripten. |
| **TypeScript** | UI, DocStore, CadScript compiler, agent orchestrator, LLM gateway, MCP server |
| **Python** | ML, datasets, and the OCCT/build123d oracle harness |
| **Swift** | The iPad host, later |

### D2a: Why Rust for Forge

C++ is equally fast, so **speed is not the reason**. The reasons are:

1. **Correctness of agent-written code at scale.**
   - Rust gives memory and thread safety, and safe code has no undefined behaviour.
   - In C++, undefined behaviour could silently break determinism or produce wrong geometry. That is exactly the failure our policy forbids.
2. **The compiler and tooling act as a verification machine.**
   - Tooling includes proptest, cargo-fuzz and Miri, plus **Kani/Verus formal proofs** for predicates and topology invariants.
   - The type checker is an excellent verifier for coding agents.
3. **The kernel is written once, generic over a `Scalar` trait.** It runs on:
   - f64, for speed;
   - Interval, for certification;
   - Dual, for exact gradients, which builds differentiability in;
   - Rational, as the in-house exact oracle.
4. **One language from kernel to pixels.** Rust targets native and `wasm32` without Emscripten, and wgpu renders on both.

### Comparison

| Criterion | **Rust** | C++20 | Zig | Julia | Swift |
|---|---|---|---|---|---|
| Raw speed | Excellent | Excellent | Excellent | Excellent after JIT warm-up | Good (ARC overhead) |
| Memory/thread safety, no UB in safe code | Yes | No | Partial (checks off in fast release builds) | GC; memory-safe by default | Mostly (ARC; data-race checks in newer modes) |
| `wasm32` without Emscripten | Yes (first-class) | No (Emscripten) | Yes | No practical path | Maturing |
| Verification tooling (property tests, fuzzing, UB detection, formal proofs) | proptest, cargo-fuzz, Miri, Kani, Verus | Sanitizers, fuzzers; formal tools are niche | Young | Limited | Limited |
| Generic numeric kernel (f64/Interval/Dual/Rational) | Traits, zero-cost | Templates, zero-cost | comptime, zero-cost | Multiple dispatch (excellent) | Protocols/generics |
| GPU across native + web | wgpu | Dawn/others, per target | Via C APIs | No web path | Metal only |
| Cross-platform maturity (Win/Linux/web/iPad) | High | High | Language still changing between releases | Server/desktop only; heavy runtime | Apple-first; weaker elsewhere |
| Role here | **Chosen for Forge** | Runner-up | Rejected | Research sandbox only | iPad host only |

### Honest costs

- **Cyclic B-rep topology fights the borrow checker.**
  - *Mitigation:* arenas with typed generational indices, which is the data-oriented design we want anyway.
- **The geometry ecosystem is thin.**
  - *Mitigation:* we own the core anyway ([ADR 0000](0000-own-the-core.md)).
- **Stable Rust has no autodiff.**
  - *Mitigation:* a Dual scalar; Enzyme is optional later.
- **iPad needs a bridge.**
  - *Mitigation:* UniFFI or a C ABI (`forge-ffi`) to the Swift host.
- **Compile times are long,** and fewer computational-geometry specialists write Rust than C++.

## Consequences

**Positive:**
- **Safety and determinism.** Agent-written kernel code is memory- and thread-safe by construction. The workspace sets `unsafe_code = "forbid"`, and any `unsafe` needs its own ADR.
- **One codebase serves every host:** napi (Electron, CLI), WASM (web) and FFI (iPad).
- **Differentiability and certification** come from the `Scalar` trait rather than a rewrite.

**Negative:**
- **Four languages** mean four toolchains in CI: Cargo, pnpm/Turborepo, uv and later Xcode.
- **The type contract crosses languages.** The IR is defined once in Rust. Other languages consume the generated JSON Schema (TS/zod types are generated from it), never hand-written copies.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| **C++20** (runner-up) | Equally fast with a large geometry ecosystem, but undefined behaviour threatens determinism and correctness in agent-written code, and WASM needs Emscripten. Only worth it if we linked C++ libraries at runtime, which [ADR 0000](0000-own-the-core.md) rules out. |
| **Zig** | Good C interop and WASM support, but no borrow checker, safety checks that are off in fast release builds, and a language still changing between releases. The verification tooling is young. |
| **Julia** | Excellent for numerical research (multiple dispatch, autodiff), but its JIT/GC runtime can't practically ship in Electron, the browser or iPad. **Allowed as a research sandbox, never shipped.** |
| **Swift** | Strong on Apple platforms and used for the iPad host, but weaker on Windows, Linux and WASM, with no cross-platform GPU story comparable to wgpu |
| **TypeScript everywhere** | Too slow for SSI, booleans and tessellation. `Math` transcendentals are implementation-defined across JS engines, which breaks bit-identical results. |
