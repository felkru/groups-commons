#!/bin/bash
# Runs the hosted setup script the way a person would (curl | bash) with the REAL agents, then checks the result.
# Usage: check.sh <label> <site>
label="$1"; site="$2"
Q="agent=claude-code,codex&install=1&cli=1&skill=1&group=AI+Safety+Nordhaven&university=Nordhaven+University&color=%230b6e4f&font_heading=Fraunces&website=https%3A%2F%2Faisafety-nordhaven.example"
echo "[$label] user=$(id -un) node=$(command -v node || echo none) npm=$(command -v npm || echo none)"
export COMMONS_SETUP_MEMORY=yes
curl -fsSL "$site/setup.sh?$Q" | bash 2>&1 | sed "s/^/[$label] /"
echo "[$label] exit of setup: ${PIPESTATUS[1]}"
export PATH="$HOME/.local/bin:$PATH"
[ -n "$(command -v npm)" ] && export PATH="$(npm prefix -g 2>/dev/null)/bin:$PATH"
echo "[$label] CHECK claude: $(command -v claude || echo MISSING) $(claude --version 2>&1 | head -1)"
echo "[$label] CHECK claude mcp list: $(claude mcp list 2>&1 | grep -i commons | head -1)"
echo "[$label] CHECK codex: $(command -v codex || echo MISSING) $(codex --version 2>&1 | head -1)"
echo "[$label] CHECK codex mcp list: $(codex mcp list 2>&1 | grep -i commons | head -1)"
echo "[$label] CHECK skill: $(ls -la $HOME/.claude/skills/commons/SKILL.md 2>&1 | awk '{print $5, $NF}')"
echo "[$label] CHECK cli: $(ls $HOME/.local/bin/commons 2>&1) -> $($HOME/.local/bin/commons search flyer 2>&1 | head -1)"
echo "[$label] CHECK memory: $(grep -c 'Nordhaven' $HOME/.claude/CLAUDE.md 2>&1) lines in CLAUDE.md, $(grep -c 'Nordhaven' $HOME/.codex/AGENTS.md 2>&1) in AGENTS.md"
echo "[$label] second run (must be safe to repeat):"
curl -fsSL "$site/setup.sh?$Q" | bash 2>&1 | grep -E "\[done\]|\[problem\]" | sed "s/^/[$label] 2nd /"
echo "[$label] CHECK memory after 2nd run: $(grep -c 'groups-commons:start' $HOME/.claude/CLAUDE.md 2>&1) marker block(s)"
