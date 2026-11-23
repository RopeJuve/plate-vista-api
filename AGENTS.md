# AGENTS.md

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on `RopeJuve/plate-vista-api`. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical labels, except the `ready-for-human` role uses `needs-human`: `needs-triage`, `needs-info`, `ready-for-agent`, `needs-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Third-party APIs

Stripe or fiskaly calls: before adding or changing one, read `docs/third-party-apis.md`. Their live APIs are newer than your training data.
