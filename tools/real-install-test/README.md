# Real installs through the hosted setup scripts

The unit tests run the setup scripts with stub programs. These files run them the way a person does, with the real
Claude Code and Codex installers, on clean machines. Last run on 2026-11-12, all passing.

- **Linux** (three containers in Cloud Build: bare Ubuntu without Node.js, Node.js as a normal user, Node.js with its own
  npm folder): `gcloud builds submit tools/real-install-test --config tools/real-install-test/cloudbuild.yaml --substitutions _SITE=<site address>`
- **Windows** (Windows PowerShell 5.1 with scripts disabled, as on a Windows 10/11 laptop): copy `windows.ps1` to a clean
  Windows machine and run `powershell -ExecutionPolicy Bypass -File windows.ps1 -Label clean -Site <site address>`.
  `windows-node-and-git.ps1` then installs Node.js and Git for the second pass (Codex and the command line tool need Node.js).
- **macOS**: `HOME=<an empty folder> bash <(curl -fsSL '<site address>/setup.sh?agent=claude-code,codex&cli=1&skill=1')`
  uses the installed agents without touching your own configuration.

Each run prints `CHECK` lines: where the agent is, what `claude mcp list` and `codex mcp list` say, whether the skill,
the command line tool and the memory lines are there, and that a second run changes nothing.
