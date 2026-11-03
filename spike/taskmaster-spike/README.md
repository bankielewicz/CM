# taskmaster-spike

The Phase 0 spike for Taskmaster, a planned Claude Code mod that holds Claude to the workflow of whatever skill it loads. This spike builds no enforcement. It **observes** the events Taskmaster would rely on, journals them, and runs **opt-in probes** that each fire once. Together they answer the Gate A feasibility checks in `docs/taskmaster-plan.md` §10.1.

- Observe-only by default: every hook passes events on unchanged.
- Probes are armed with `/tm-spike probe <name>`, fire once, then disarm.
- Results are kept in `.taskmaster/spike/` in the project: `findings.json`, `FINDINGS.md`, and the journal chunks.
- Commands: `/tm-spike status`, `/tm-spike probe <name>`, `/tm-spike report`, `/tm-spike pane`, `/tm-spike reset`.

See `RUNBOOK.md` for the step-by-step run and how to read the results.
