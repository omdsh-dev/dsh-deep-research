/**
 * dsh-deep-research — Deep Research orchestrator extension for DeepSeek Harness.
 *
 * A REAL plugin (not a skill): registers one model-facing tool, `deep_research`,
 * that runs the user's deep-research workflow ON TOP OF DSH'S OFFICIAL WORKFLOW
 * ENGINE (`exec.agent.ctx.workflowEngine`, `@deepseek-ai/dsh-workflow-worker-thread`) — no custom
 * subagent plumbing, no TUI surface, no prompt injection.
 *
 * The pipeline is a LIVE ADAPTIVE LOOP designed from cybernetics + information
 * theory — it is NOT a fixed four-stage prompt chain:
 *
 * ── 问题定义 (control theory: reference-signal calibration) ────────────────
 *   The planner first defines the ANSWER SPACE (`scope`: what decision the
 *   report supports) and per-question acceptance criteria, so the loop never
 *   chases a mis-set reference.
 *
 * ── 多样性拆解 (Ashby's Law of Requisite Variety) ──────────────────────────
 *   The planner enumerates the topic's information DIMENSIONS, maps each
 *   sub-question to a dimension, and self-audits COVERAGE (`coverage_gaps`):
 *   uncovered dimensions are declared as hypotheses to be tested, not hidden.
 *
 * ── 自适应研究循环 (adaptive control / perception–action cycle) ────────────
 *   Research is an ITERATIVE CLOSED LOOP, not a one-shot fan-out:
 *     round 1:  all planned sub-questions in parallel.
 *     round n>1: dynamic re-planning — high-priority gaps reported by the
 *                previous round become NEW sub-questions, and the planner's
 *                declared blind spots get one reconnaissance attempt (a
 *                planning assumption is verified experimentally, not trusted).
 *   Convergence is information-theoretic: the loop stops when a round produces
 *   no new high-priority gaps (marginal information gain ≈ 0) or the round cap
 *   (depth + 1) is hit. Simple topics converge after one round; hard ones
 *   automatically expand — the flow is alive, not a fixed script.
 *   Each researcher keeps a three-state evidence model (confirmed / uncertain /
 *   gaps = conditional entropy made explicit) and stops internally the moment
 *   one round adds nothing.
 *
 * ── 综合 (rate–distortion) ─────────────────────────────────────────────────
 *   The final report is lossy compression for a stated decision: it keeps only
 *   information that distinguishes conclusions, and PRESERVES uncertainty
 *   (confidence / 矛盾 / verified blind spots) instead of masking it.
 *
 * ── 审查 (channel redundancy / error correction, opt-in) ───────────────────
 *   An adversarial reviewer acts as a parity check: citation spot-checks
 *   (hallucinated sources = channel noise), coverage audit against the declared
 *   dimensions, contradiction and over-confidence marking.
 *
 * Model tiering (OpenAI guide) via config: `plannerModel` / `researcherModel` /
 * `synthesizerModel` / `reviewerModel` → `args.models`; omitted models inherit
 * the parent route. The plugin never fetches the web: search/fetch stays on
 * DSH's built-in `web_search` / `web_fetch`, which children inherit.
 *
 * TypeScript compiles to the package's `lib/types/index.js` production entry.
 * The source remains erasable-only so the dependency-free regression test can
 * also strip and evaluate it with Node's native TypeScript support.
 *
 * @module @dsh-external/dsh-deep-research
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-deep-research";
/** Activate once the tool registry is available; each calling Agent supplies its scoped workflow engine. */
export declare const inject: string[];
/** Plugin config (all optional). */
export interface Config {
    /** Child-provider override passed to every workflow run. */
    subagentProvider?: string;
    /** Role-level model overrides, one per planner/researcher/synthesizer/reviewer role. */
    plannerModel?: string;
    researcherModel?: string;
    synthesizerModel?: string;
    reviewerModel?: string;
    /** Per-run total-child ceiling for every workflow run. */
    maxTotalAgents?: number;
    /** Research concurrency per round. */
    maxParallel?: number;
}
/** Apply the plugin: register the `deep_research` tool on `ctx.tools`. */
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=index.d.ts.map