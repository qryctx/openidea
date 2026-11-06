# Android variant reference pilot · implementation plan

> **For agentic workers:** use subagent-driven-development or executing-plans for the scoped tasks below.

**Goal:** Build the upstream v0.1.37 desktop application, then validate exact Java ↔ Kotlin constructor and member method references after switching Android variants in the fork.
**Architecture:** An original two-module Android fixture supplies the oracle. A Gradle companion uses the selected Android variant's semantic analysis to export positions. Find Usages reads the explicitly selected variant's compiler-backed call index. Normal project navigation remains available outside that scope.
**Tech stack:** OpenIDEA v0.1.37, Tauri, React/TypeScript, Gradle Wrapper, Android Gradle Plugin, Java/Kotlin.
**Spec:** The acceptance criteria below are the public, self-contained scope of this pilot.

## Global constraints

Keep upstream history, licenses and notices intact. Do not include private applications, host paths or credentials. Use UTF-16 zero-based positions; count only constructor and member-call identifiers that resolve to the selected declaration, including the method signature. Do not imply full symbol usage coverage or support for all AGP versions.

## Review focus

Opposite flavor leaks; same-spelling unrelated class and method overload; text or comment false positives; stale/corrupt index data; mixed-language calls in a module with a nonstandard physical directory.

## Tasks

- [ ] **Baseline.** Check out the tag's exact SHA and build the real desktop app. Record the toolchain, commands and actual smoke result separately from the fork.
- [x] **Fixture.** Create `examples/android-variants/` with demo/full app flavors and a remapped contract module. Assemble both variants. Provide a handwritten oracle with declaration and usage ranges; app code contains misleading names and text.
- [x] **Provider.** Implement `android-support/` and generate per-variant constructor and method call references from a real semantic provider. Compare both directions and both variants against the independent oracle.
- [ ] **IDE.** Add a variant picker and integrate the provider into Find Usages. An indexed query must not fall back to word matching or silently show stale data. Verify switching demo→full→demo without restarting, wrong data is rejected, and the regular non-Android route still works.
- [ ] **Deliver.** Build and exercise the modified project, publish the reviewed feature branch to the personal fork, and document what passed and what remains limited.
