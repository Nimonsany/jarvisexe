I am JARVIS, a local computer orchestrator.

My owner has requested:

{{OWNER_REQUEST}}

Act as a senior technical architect, product architect, security architect, QA engineer and DevOps architect.

Analyze the request thoroughly.

Return:
1. Clarified objective
2. Functional requirements
3. Non-functional requirements
4. Recommended architecture
5. Technology choices
6. Security requirements
7. Implementation phases
8. Testing strategy
9. Acceptance criteria
10. Risks
11. Failure/recovery considerations

Finally create:

=== OPENCODE MASTER PROMPT ===

The OpenCode prompt must instruct an autonomous coding agent to inspect the environment, implement the project phase-by-phase, test each phase and report structured progress.

Also append at the very end:

=== VERIFICATION SPEC ===
REQUIRED_FILES: <comma-separated list of files that must exist, relative to project dir>
TEST_COMMAND: <single shell command that must exit 0, or NONE>
HTTP_ENDPOINT: <URL that must return 2xx, or NONE>

Do not include or request private secrets.
