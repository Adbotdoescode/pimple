# Hallucination-rate eval

A hand-run measurement script, not a test suite. It calls the API and spends credit, so run it by hand only.

Run: `cd /Users/adam/Developer/glass-tutor && bun eval/run_eval.ts [--only <id>] [--dry]`

`--dry` prints the planned calls with no API calls and no writes. `--only <id>` runs one concept from `eval/concepts.json` and overwrites `eval/results.md` with that concept alone.

Key: `ANTHROPIC_API_KEY`, else the keychain item `glass-tutor.anthropic-api-key` (account `glass-tutor`).

Per concept: one tutor answer (the app's request, cached in `eval/.cache/<id>.json`), then an Opus judge for verifier off and on.

Verifier on: Haiku checks each sentence with the app's segment prompt and drops flagged sentences. The app rewrites them instead, so "on" is a stricter approximation.

Rate = (unsupported + contradicted) / claims. Output: console table and `eval/results.md`.

`concepts.json` holds one PLACEHOLDER concept. Replace it with the demo topics and check each reference against its image.
