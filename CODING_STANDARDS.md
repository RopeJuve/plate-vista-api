# Coding standards

Judgement calls a reviewer checks by reading the change. Anything a lint rule or a test can enforce belongs in the linter or the tests, not here.

1. **Change the payments contract first.** A change to a path, a field, an error code or an event covered by [`docs/payments-contract.md`](docs/payments-contract.md) lands in that document first, in its own commit, before the code. Follow its **Change rule**. Code that drifts from the contract without that commit is a finding.
2. **Use the Glossary terms.** Names in code, tests, docs and messages use the terms in [`GLOSSARY.md`](GLOSSARY.md), not the words listed under _Avoid_. A new domain concept gets a glossary entry rather than an ad-hoc name.
3. **Respect the ADRs.** A change must not contradict a decision in [`docs/adr/`](docs/adr/). To go against one, write a new ADR that supersedes it; don't work around it quietly.
4. **Error codes are a closed set.** Reuse an existing code from `ErrorCodes` in `src/shared/errors.js` when its meaning fits. Add a new code only when no existing code means the same thing, and treat the addition as a contract change (rule 1) when a client sees it.
