# Fogwater — agent notes

- Hackathon rules: https://nearhackathon.com/HACKATHON.md (deadline 2026-11-14 23:59 UTC; repo must stay public).
- Design source of truth: DESIGN.md. Keep README "do X, see Y" steps current — AI judges run them.
- Independent of Bazaar of Liars, Realm Ledger, Parkwright and Sushi Sabotage: its own repo, contract, rules and server. They sit together in the NEAR Arcade.
- packages/rules is deterministic and isomorphic (browser + Node): no DOM, no node: imports. Its hashes must match contracts/fleet byte for byte (shared test vector in both test suites).
- The LLM never picks a shot or answers one; packages/rules (admiral.ts) and the Merkle openings do.
- A human captain's fleet secret (seed + placements) lives only in their browser. Never send it to the server before the reveal phase.
- Testnet only. Keys live in .env / ~/.near-credentials, never in the repo.
- Verify NEAR endpoints/SDK versions against docs.near.org/llms.txt and docs.near.ai/llms.txt, not memory.
- Commits: no Co-Authored-By or other AI attribution lines; small granular commits. Every change after the first push goes on a branch, through a PR, and is rebase-merged.
