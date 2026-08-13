---
name: verify-task
description: Perform proportional final QA after completing any requested task and before the final handoff, commit push, pull-request readiness, release, or deployment. Use for code, UI, browser workflows, APIs, documentation, data, configuration, skills, and operational changes when the result must be exercised as a user would use it, checked against the request and repository invariants, and reported with current evidence. Supports Codex in-app Browser and OpenCode Chromium/CDP without requiring either host.
---

# Verify Task

Treat QA as the last implementation phase, not as a line-by-line code review.
Prove the requested outcome through the smallest realistic usage path and stop
when the acceptance conditions have evidence.

## Build the QA contract

1. Restate the user's observable outcome and explicit constraints.
2. Read the nearest `AGENTS.md`, active plan, and package test guidance.
3. Identify the few regressions most likely to escape unit tests.
4. Choose checks proportional to the change. Keep a small task's QA small.

Do not invent broad acceptance criteria or inspect unrelated code. Preserve
unrelated user changes and use checked-in fixtures when they represent the
workflow accurately.

## Run checks in this order

1. Run the narrowest automated check for the changed behavior.
2. Run the package gate required by the nearest `AGENTS.md`.
3. Exercise the result through its real interface:
   - UI changes: open the live application, perform the visible workflow, and
     inspect the rendered result and console.
   - API or CLI changes: invoke the public command or endpoint with a realistic
     input and inspect its output and exit status.
   - documentation: render or build it, then inspect the changed page or
     generated artifact.
   - configuration or skills: validate resolution/discovery in each supported
     host and run one representative prompt or command.
   - pure logic: run a focused example through the public caller in addition to
     unit tests when practical.
4. Recheck preservation invariants such as serialization, undo/redo,
   containment, identifiers, input data, or backward compatibility when the
   task can affect them.
5. Run `git diff --check` for repository edits and confirm only intended files
   remain changed.

Prefer observation over speculative review. Do not add an independent reviewer
or analyze every changed line unless the user explicitly asks for code review.

## Select the browser surface

Honor an explicit browser choice.

- In Codex desktop, use the in-app Browser through its available browser skill
  for live UI interaction and screenshots.
- In OpenCode, use the repository's Chrome/Chromium CDP skill and documented
  external-browser workflow.
- Use a purpose-built semantic tool or MCP for state inspection when available,
  but still use the UI for controls and rendering that users interact with.
- If no browser surface is available, run the automated gates and return a
  precise manual checklist instead of claiming visual verification.

Load any browser- or product-specific skill required by the repository before
opening or manipulating the application. Never duplicate its startup sequence.

## Diagnose failures

When a check fails:

1. Reproduce it on the final state.
2. Determine whether it is caused by the change, the fixture, the environment,
   or a pre-existing defect. Compare before/after behavior when uncertain.
3. Fix task-caused failures at the narrowest responsible layer, then rerun the
   failed check and its relevant gate.
4. Report environmental or pre-existing failures with exact evidence. Do not
   relabel them as success and do not expand scope without authorization.

Use valid fixtures for final acceptance. A deliberately malformed or
pre-existing failing fixture may diagnose behavior but cannot prove a clean
happy path.

## Finish and report

Complete QA before the final push or PR-readiness transition when the workflow
allows it. If testing requires a deployed state, run a final post-deploy smoke
check.

The final report must distinguish:

- verified behavior through real usage;
- automated commands and their current results;
- blockers or checks that could not run;
- pre-existing failures observed during QA;
- any remaining user action.

Keep evidence concise. Record screenshots or a repository evidence file only
when the task, plan, or future maintenance benefits from them. Stop after the
acceptance contract passes; do not turn final QA into a new feature cycle.
