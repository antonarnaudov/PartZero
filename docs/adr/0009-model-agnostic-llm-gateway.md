# ADR 0009: Model-agnostic LLM gateway

- **Status:** Accepted. Extended by [ADR 0014](0014-cli-agents-as-providers.md), which adds CLI agents and local models as providers and makes API keys optional.
- **Date:** 2026-09-23
- **Plan reference:** PLAN-2026-09-23 §2 D9, §4

## Context

- **The user requires model-agnostic AI from day one.** Every major provider is first-class and gets its own tuning.
- **Models are not interchangeable.** They differ in tool-schema handling (some reject forced tool use), vision quality, caching, reasoning controls and refusal behavior.
- **A different judge helps.** A model from a *different* family judging multi-view renders is a proven gain (CADSmith: Chamfer error 28.4 → 0.74).
- **Providers drift.** Model rankings change release by release.
- **The orchestrator must run in four places:** an Electron utility process, headless Node (evals, CLI), a browser worker and the server.

## Decision

**A model-agnostic LLM gateway in TypeScript (`packages/llm-gateway`), built on the official SDKs:**
- Anthropic, OpenAI and Google;
- an OpenAI-compatible client for open and local models.

**Each model gets a *profile*:**
- prompt variants;
- tool-schema style;
- vision and caching settings;
- reasoning knobs;
- known quirks.

**Routing:**
- **Roles are routed by the eval leaderboard,** not hardcoded: triage, designer, spec/test writer, critic/judge, engineer advisor, economy loop. The cross-provider leaderboard (MakerBench and external benchmarks) runs nightly and weekly, and routing is configuration, not code.
- **The judge comes from a different model family than the builder** by default.

**The orchestrator is our own TypeScript state machine** on top of the gateway, not the Claude Agent SDK. The Agent SDK is used in the "external agent" eval track, driving our MCP server.

**Main-loop rules:**
- one model per task (caches are per model);
- append-only history;
- `tool_choice: auto` with strict schemas;
- explicit refusal handling, never retried around.

## Consequences

**Positive:**
- **No lock-in.** Users can bring keys for any provider (BYO keys at alpha), and we can route each role to the best current model.
- **Resilient to provider drift** and pricing changes.
- **Cross-family judging comes by default.**

**Negative / costs:**
- **Profiles need upkeep.** Each new model needs a profile and eval runs.
- **Evals cost money:** about $1–2k per month.
- **More surface to test.** Refusal, caching and tool-use differences multiply the test surface.
- **Data handling depends on the key.** The data flywheel is off for BYO-key users, so learning comes only from opted-in hosted usage.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Single provider | Violates the user requirement, and exposes us to one vendor's drift, pricing and outages |
| A third-party abstraction layer as the core | Tends toward lowest-common-denominator features. Provider-specific caching, reasoning and tool-schema behavior matter for cost and quality. |
| Claude Agent SDK as the orchestrator | Ties the main loop to one provider and runtime. We need the same state machine in browser workers and on every provider. It is kept for the external-agent eval track. |
| Hardcoded role → model mapping | Stale within months. The leaderboard makes routing an evidence-based config change. |
