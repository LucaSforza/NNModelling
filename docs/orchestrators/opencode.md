# OpenCode adapter

NNModelling provides a project-local OpenCode team under `.opencode/agents/`.
Agents share the repository guidance in `AGENTS.md`; project skills live under
`.agents/skills/`, are registered through `skills.paths`, and are allowlisted
in `opencode.json`.

Canonical scope, dependencies, acceptance criteria, and validation live under
`docs/plans/`. This adapter maps their neutral roles to OpenCode agents without
putting provider or model choices in plans.

## One-time OpenAI setup

In OpenCode, run `/connect`, choose **OpenAI**, then choose **ChatGPT Plus/Pro**.
Credentials remain in OpenCode's user configuration and must not be committed
to this repository.

## Agent roster

| Capability | Agent | Configured model |
| --- | --- | --- |
| Primary architect | `architect` | `openai/gpt-5.6-sol` |
| Alternative architect | `architect-deepseek` | `deepseek/deepseek-v4-pro` |
| Frontend implementer | `frontend-openai` | `openai/gpt-5.6-luna` |
| Frontend implementer | `frontend-deepseek` | `deepseek/deepseek-v4-flash` |
| Backend implementer | `backend-openai` | `openai/gpt-5.6-luna` |
| Backend implementer | `backend-deepseek` | `deepseek/deepseek-v4-flash` |
| Reviewer | `reviewer-openai` | `openai/gpt-5.6-terra` |
| Reviewer | `reviewer-deepseek` | `deepseek/deepseek-v4-pro` |
| Read-only explorer | `explorer` | `deepseek/deepseek-v4-flash` |

The roster documents OpenCode configuration only. Do not copy these model or
agent names into canonical plans.

Primary agents are selected with OpenCode's agent switcher. Subagents can also
be mentioned directly with `@agent-name`.

## Provider choice and role mapping

The user selects OpenAI or DeepSeek implementers and reviewers. A choice may be
global or per task. If an implementation or review choice is missing, the
architect may inspect and plan, but must ask before delegation rather than
silently select a provider.

```text
Use OpenAI implementers and the DeepSeek reviewer.
```

```text
Use frontend-openai for the UI, backend-deepseek for Python, then both reviewers.
```

Map neutral roles as follows:

| Plan role | OpenCode mapping |
| --- | --- |
| `architecture` | Selected primary architect; bounded research may go to `explorer` |
| `frontend` | User-selected `frontend-openai` or `frontend-deepseek` |
| `backend` | User-selected `backend-openai` or `backend-deepseek` |
| `integration` | Implementer matching the owned package; split the task if ownership crosses agents |
| `review` | User-selected reviewer, or both reviewers when requested |
| `documentation` | Implementer chosen for the affected package and given exact paths |
| `operations` | Matching implementer with the applicable repository skill |

Historical documents may contain `@frontend`, `@backend`, or `@reviewer`.
Treat these as role labels, not callable agents, and resolve them only after the
user chooses a provider.

## OpenCode execution loop

1. Frame the outcome, constraints, acceptance criteria, and affected areas.
2. Inspect `AGENTS.md`, current code, active plans, and linked knowledge.
3. For cross-package, architectural, risky, or multi-task work, create an
   initiative from `docs/plans/templates/`; do not require a plan for a trivial
   edit.
4. Confirm implementer and reviewer choices.
5. Delegate ready tasks with non-overlapping `write_scope`; parallelize only
   tasks explicitly permitted by their dependency graph.
6. Require the handoff specified by the task, including exact validation
   evidence.
7. Load `.agents/skills/verify-task/SKILL.md` and run proportional final QA
   through the real public interface. In OpenCode, browser QA uses the skill's
   Chromium/CDP route.
8. Review the coherent implementation when requested rather than automatically
   assigning one reviewer per task.
9. Route actionable findings to the implementer that owns the affected task,
   then validate and review again.
10. Close only after acceptance and integration gates pass or a genuine blocker
   requires user action.

An OpenCode assignment copies the canonical task fields and adds only runtime
details:

```text
Plan path: docs/plans/active/<initiative>/plan.md
Task path: docs/plans/active/<initiative>/tasks/Txx-<name>.md
Resolved agent: <user-selected OpenCode agent>
Commit requested: <yes only when explicitly authorized; otherwise no>
```

The task file remains the source of truth for scope, owned files, dependencies,
acceptance criteria, validation, and handoff.

## Commit ownership

Do not commit unless the user explicitly authorizes it. Once authorized and
after validation and review, the architect may delegate creation of a focused
commit to the responsible implementer. The implementer inspects status, diff,
and recent history; stages only owned files; uses a repository-style message;
and reports the commit hash. When authorization covers a multi-task initiative,
each completed implementation task ends with its own focused implementer-owned
commit. Push and pull-request creation require separate authorization.
Explicitly requested issue creation remains architect-owned.

## Skills

OpenCode discovers repository skills from `.agents/skills/`; no copy under
`.opencode/skills/` is required. `opencode.json` registers that path and
controls skill availability. Agents load a skill when its description matches
the task, and browser-backed work follows the routing rules in `AGENTS.md`.

The `nnmodelling-mcp` skill is host-aware. In an OpenCode session without the
Codex in-app Browser, it keeps using the external Chromium/CDP branch and the
same `nnm-stack.sh` helper.

The `verify-task` skill is also host-aware and is the mandatory final QA phase
for every completed request. It reuses `nnmodelling-mcp` or `chrome-direct` for
browser work and remains usable for CLI, API, documentation, configuration, and
pure-logic tasks without a browser.
