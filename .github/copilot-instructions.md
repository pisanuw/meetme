# Global Claude Code Instructions

## Logging

Record all user instructions verbatim, EXACTLY as it was typed by user, in `AI-log.md` in the project directory.
Each entry must include a timestamp with hour and minute obtained from `date "+%Y-%m-%dT%H:%M"`.
You MUST update `AI-log.md` BEFORE doing any other work or writing any response.
This applies to EVERY user message without exception — questions, bug reports, feature requests, and clarifications alike.
Do not write any private API keys or secrets to this file; indicate removed information with REDACTED.
Include this instruction at the beginning of the `AI-log.md` file so you never forget to log things.

## Questions

Assume all my instructions finish with "Any questions?". Ask for clarification if necessary.
If there are multiple implementation options, give your recommendation.