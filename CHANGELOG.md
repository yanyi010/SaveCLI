# Changelog

All notable changes to SaveCLI are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[SemVer](https://semver.org/).

## [0.1.0] — 2026-09-23

First public release.

### Added
- Interactive REPL with streaming output, steering (message queue while the
  agent works), `/compact [focus]`, `/undo`, `/fork`, `/usage`, `/todos`,
  `/set`, custom slash commands (`.savecli/commands/*.md`).
- One-shot mode (`savecli "task"`) and print mode (`-p`) for scripting,
  including piped-stdin prompts.
- Token economy: response cache (LRU, private files), auto-compaction with a
  small model, tool-output head+tail truncation, context sanitization,
  prompt-caching breakpoints (Anthropic), usage ledger with cost estimates.
- Providers: Anthropic Messages API (x-api-key and Bearer/OAuth schemes) and
  any OpenAI-compatible gateway (custom base URL). SSE parsing with idle
  watchdog, exponential backoff + retry-after, no retry after partial
  output, parameter-compat fallbacks (`max_completion_tokens`,
  `stream_options`).
- Tools: `bash` (deny/allow/ask gates, session-scoped "always" patterns,
  process-group kill, timeout), `read` (line numbers, binary refusal),
  `edit` (read-before-edit, uniqueness enforcement, replaceAll), `write`
  (atomic, exec-bit preserving), `grep`, `glob`, `tree`, `todowrite`.
- Security: deny-by-default protected paths (`~/.ssh`, `~/.aws`,
  `~/.savecli`, credential-like files), `.git`/`.savecli` write refusal,
  approval gates for root `AGENTS.md`/`CLAUDE.md`, secret redaction in all
  logs and provider errors, 0600 atomic writes for all state, zero telemetry.
- Auth: `savecli setup` wizard with connection test, `auth login|status|logout`
  with device-code flow (manual-paste fallback) for claude/codex, hidden
  prompts, `ps`-visibility warnings.
- Config: layered defaults/user/project/env with env overrides; `config
  list|get|set|unset|profiles|profile|model|edit`; Levenshtein key
  suggestions; project-level configs cannot carry API keys.
- Mission Driver: planner/engineer/reviewer role separation,
  read-only reviewer toolset, per-task fresh context, review-feedback retries,
  hard budgets (tokens/tasks/hours/attempts), persistent state, pause/resume.
- Sessions: JSONL event log (private), `--continue`, `--session <id>`,
  `savecli sessions`, faithful conversation rebuild on resume.
- Built-in profiles: anthropic, claude, openai, codex, deepseek, moonshot,
  zhipu, openrouter, ollama, lmstudio.
- Test suite: 133 tests (unit + real-HTTP provider mocks + full agent-loop
  and mission-driver integration), eslint-clean, `tsc --noEmit` clean.

### Security
- Read tool checks the path-security verdict before stat, so the agent cannot
  probe whether protected files exist.
- Bash command patterns match across `/` (deny rules cannot be bypassed by
  path separators).
- PEM private-key blocks are redacted in every log path.
