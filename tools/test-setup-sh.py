#!/usr/bin/env python3
"""Runs the hosted /setup.sh for real, in a sandbox, and checks what it did.

    STORE=local PORT=8787 node server/index.js          # in one terminal
    python3 tools/test-setup-sh.py http://localhost:8787 [-v]

Every run gets a throw-away HOME and a PATH that starts with stub programs (claude, codex, npm, sudo and a curl
wrapper) which write down how they were called. Nothing is installed on this computer and the only network
requests go to the server under test: the Claude Code installer is replaced by a fake one. Needs python3, bash
and curl. -v prints what the script said in every run.
"""

import hashlib
import os
import pty
import select
import shutil
import subprocess
import sys
import tempfile
import urllib.parse

ORIGIN = next((a for a in sys.argv[1:] if a.startswith('http')), 'http://localhost:8787').rstrip('/')
VERBOSE = '-v' in sys.argv
ROOT = tempfile.mkdtemp(prefix='commons-setup-test-')
REAL_CURL = shutil.which('curl')
REAL_NODE = shutil.which('node')
failures = []
START, END = '<!-- groups-commons:start -->', '<!-- groups-commons:end -->'

STUB = """#!/bin/sh
echo "{name} $*" >> "$COMMONS_TEST_LOG"
{extra}
exit 0
"""
STUBS = {
    'claude': 'if [ "$1 $2" = "mcp remove" ]; then echo "No MCP server found with name: commons" >&2; exit 1; fi',
    'codex': 'if [ "$1 $2" = "mcp remove" ]; then echo "No MCP server named commons" >&2; exit 1; fi',
    'sudo': '',
    # "npm install -g @openai/codex" puts codex into <prefix>/bin, which is NOT on the PATH, like a fresh npm setup.
    'npm': 'if [ "$1" = install ]; then mkdir -p "$COMMONS_TEST_NPM/bin" && cp "$COMMONS_TEST_POOL/codex" "$COMMONS_TEST_NPM/bin/codex"; fi\n'
           'if [ "$1" = prefix ]; then echo "$COMMONS_TEST_NPM"; fi',
}
CURL = """#!/bin/sh
echo "curl $*" >> "$COMMONS_TEST_LOG"
out=""; prev=""; fake=0
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  [ "$a" = "https://claude.ai/install.sh" ] && fake=1
  prev="$a"
done
if [ "$fake" = 1 ]; then
  printf '%s\\n' '#!/bin/bash' 'echo "(fake Claude Code installer)"' 'mkdir -p "$HOME/.local/bin" && cp "$COMMONS_TEST_POOL/claude" "$HOME/.local/bin/claude"' > "$out"
  exit 0
fi
exec "{real}" "$@"
"""


def write_exe(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write(text)
    os.chmod(path, 0o755)


class Box:
    """One sandbox: a home folder, stub folders and a log of every stub call."""

    def __init__(self, name, agents=(), node=True, npm=True):
        self.dir = os.path.join(ROOT, name)
        self.home = os.path.join(self.dir, 'home')
        self.log = os.path.join(self.dir, 'calls.log')
        os.makedirs(self.home)
        pool, base = os.path.join(self.dir, 'pool'), os.path.join(self.dir, 'bin')
        for n, extra in STUBS.items():
            write_exe(os.path.join(pool, n), STUB.format(name=n, extra=extra))
        write_exe(os.path.join(base, 'curl'), CURL.replace('{real}', REAL_CURL))
        shutil.copy(os.path.join(pool, 'sudo'), os.path.join(base, 'sudo'))
        if npm:
            shutil.copy(os.path.join(pool, 'npm'), os.path.join(base, 'npm'))
        if node and REAL_NODE:
            write_exe(os.path.join(base, 'node'), f'#!/bin/sh\nexec "{REAL_NODE}" "$@"\n')
        for a in agents:
            shutil.copy(os.path.join(pool, a), os.path.join(base, a))
        self.env = {
            'HOME': self.home, 'PATH': f'{base}:/usr/bin:/bin', 'SHELL': '/bin/zsh', 'TMPDIR': os.path.join(self.dir, 'tmp'),
            'COMMONS_TEST_LOG': self.log, 'COMMONS_TEST_POOL': pool, 'COMMONS_TEST_NPM': os.path.join(self.dir, 'npm-global'),
        }
        os.makedirs(self.env['TMPDIR'])

    def command(self, query):
        return f"curl -fsSL '{ORIGIN}/setup.sh?{query}' | bash"

    def run(self, query, env=None):
        """Without a terminal: its own session, standard input closed."""
        p = subprocess.run(['/bin/bash', '-c', self.command(query)], env={**self.env, **(env or {})}, cwd=self.dir,
                           stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        return self._done(query, p.stdout.decode('utf8', 'replace'), p.returncode)

    def run_tty(self, query, answers):
        """With a terminal: the command runs on a pseudo-terminal and each [y/N] question gets the next answer."""
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(self.dir)
            os.execve('/bin/bash', ['/bin/bash', '-c', self.command(query)], self.env)
        out, answers, seen = b'', list(answers), 0
        while True:
            ready, _, _ = select.select([fd], [], [], 30)
            if not ready:
                break
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
            while out.count(b'[y/N]') > seen:
                seen += 1
                os.write(fd, (answers.pop(0) if answers else 'n').encode() + b'\n')
        _, status = os.waitpid(pid, 0)
        return self._done(query, out.decode('utf8', 'replace').replace('\r\n', '\n'), os.waitstatus_to_exitcode(status))

    def _done(self, query, out, code):
        if VERBOSE:
            print(f'\n----- {os.path.basename(self.dir)}: ?{query} (exit {code})\n{out}-----')
        return out, code

    def calls(self):
        return open(self.log).read().splitlines() if os.path.exists(self.log) else []

    def read(self, rel):
        p = os.path.join(self.home, rel)
        return open(p, encoding='utf8').read() if os.path.exists(p) else None

    def digest(self):
        h = hashlib.sha256()
        for d, _, files in sorted(os.walk(self.home)):
            for f in sorted(files):
                p = os.path.join(d, f)
                h.update(p.encode() + b'\0' + open(p, 'rb').read() + b'\0')
        return h.hexdigest()


def check(label, ok, detail=''):
    print(('  ok    ' if ok else '  FAIL  ') + label + (f'  [{detail}]' if detail and not ok else ''))
    if not ok:
        failures.append(label)


def fetch(query, *curl_args):
    p = subprocess.run([REAL_CURL, '-sS', '--globoff', '-o', '-', '-w', '\n%{http_code}', *curl_args, f'{ORIGIN}/setup.sh?{query}'], stdout=subprocess.PIPE)
    body, _, code = p.stdout.decode('utf8', 'replace').rpartition('\n')
    return body, code


GROUP = 'group=AI+Safety+K%C3%B6ln&university=Universit%C3%A4t+zu+K%C3%B6ln&city=K%C3%B6ln&color=1f6f5c&accent=c76d7e&font_heading=Fraunces&font_body=Inter&website=aisafety.example.org&join=aisafety.example.org%2Fjoin'
BOTH = 'agent=claude-code,codex'
MCP_CLAUDE = f'claude mcp add --transport http -s user commons {ORIGIN}/mcp'
MCP_CODEX = f'codex mcp add commons --url {ORIGIN}/mcp'

print(f'Testing {ORIGIN}/setup.sh in {ROOT}\n')

print('1. Agents already installed, everything asked for, no terminal')
b = Box('present', agents=('claude', 'codex'))
out, code = b.run(f'{BOTH}&cli=1&skill=1&{GROUP}')
calls = b.calls()
check('exit code 0', code == 0, code)
check('claude: old connection removed, then added with the verified syntax', 'claude mcp remove commons -s user' in calls and MCP_CLAUDE in calls and calls.index('claude mcp remove commons -s user') < calls.index(MCP_CLAUDE))
check('codex: old connection removed, then added with the verified syntax', 'codex mcp remove commons' in calls and MCP_CODEX in calls)
check('skill saved', (b.read('.claude/skills/commons/SKILL.md') or '').startswith('---'))
cli = os.path.join(b.home, '.local/bin/commons')
check('command line tool saved, executable, knows its site', os.access(cli, os.X_OK) and ORIGIN in (b.read('.local/bin/commons') or ''))
if REAL_NODE:
    v = subprocess.run([REAL_NODE, cli, '--version'], stdout=subprocess.PIPE).stdout.decode().strip()
    check('the saved tool runs (commons --version)', v[:1].isdigit(), v)
check('PATH hint shown (~/.local/bin is not on the PATH here)', 'is not on your PATH' in out and '.zshrc' in out)
check('memory text shown', '| Our group: AI Safety Köln, a student group at Universität zu Köln in Köln.' in out)
check('no terminal: memory files not written, and the script says so', b.read('.claude/CLAUDE.md') is None and b.read('.codex/AGENTS.md') is None and out.count('there is no terminal to ask you on') == 2)
check('nothing installed, no sudo', not any(c.startswith(('npm install', 'sudo')) or 'claude.ai/install.sh' in c for c in calls))
check('only this site was contacted', all(ORIGIN in c for c in calls if c.startswith('curl ')))
check('ends with the summary and an example sentence', '==> Summary' in out and 'Now open your agent (type: claude' in out)

print('2. Running it twice gives the same result (memory answered in advance with COMMONS_SETUP_MEMORY=yes)')
b = Box('twice', agents=('claude', 'codex'))
os.makedirs(os.path.join(b.home, '.claude'))
mine = '# My own notes\n\nAlways answer in German.\n'
open(os.path.join(b.home, '.claude/CLAUDE.md'), 'w').write(mine)
q = f'{BOTH}&cli=1&skill=1&{GROUP}'
b.run(q, {'COMMONS_SETUP_MEMORY': 'yes'})
first, text1 = b.digest(), b.read('.claude/CLAUDE.md')
out, code = b.run(q, {'COMMONS_SETUP_MEMORY': 'yes'})
text2 = b.read('.claude/CLAUDE.md')
check('home folder identical after the second run', first == b.digest())
check('own notes kept, one block after them', text2.startswith(mine + '\n' + START + '\n## Our student group\n') and text2.count(START) == 1 and text2.endswith(END + '\n'), text2)
check('second run says it replaced the block', 'Replaced the earlier block' in out)
check('AGENTS.md written for Codex', (b.read('.codex/AGENTS.md') or '').count(START) == 1)
b.run(f'{BOTH}&group=Another+Group', {'COMMONS_SETUP_MEMORY': 'yes'})
text3 = b.read('.claude/CLAUDE.md')
check('a later run with other details replaces the block, not the notes', text3.startswith(mine) and text3.count(START) == 1 and 'Another Group' in text3 and 'Köln' not in text3, text3)
half = mine + START + '\nan unfinished block\n\nmore notes\n'
open(os.path.join(b.home, '.claude/CLAUDE.md'), 'w').write(half)
b.run(f'agent=claude-code&group=Another+Group', {'COMMONS_SETUP_MEMORY': 'yes'})
b.run(f'agent=claude-code&group=Third+Group', {'COMMONS_SETUP_MEMORY': 'yes'})
text4 = b.read('.claude/CLAUDE.md')
check('a start marker without an end marker loses nothing', text4.startswith(half.rstrip('\n')) and 'more notes' in text4 and 'Third Group' in text4 and 'Another Group' not in text4, text4)

print('3. Agents missing, install not asked for')
b = Box('absent')
out, code = b.run(f'{BOTH}&{GROUP}')
check('says where to get both and goes on', 'https://claude.com/claude-code' in out and 'https://github.com/openai/codex' in out and '==> Summary' in out)
check('exit code 0; nothing called but the download of the script and a look into npm\'s folder', code == 0 and not [c for c in b.calls() if not c.startswith('curl -fsSL ' + ORIGIN) and c != 'npm prefix -g'], b.calls())
check('says that no agent is connected', 'No agent is connected yet' in out)

print('4. Agents missing, install=1')
b = Box('install')
out, code = b.run(f'{BOTH}&install=1&cli=1&skill=1')
calls = b.calls()
check('Claude Code: official installer downloaded and run', any('https://claude.ai/install.sh' in c for c in calls) and '(fake Claude Code installer)' in out)
check('Claude Code: found in ~/.local/bin afterwards and connected', MCP_CLAUDE in calls and 'Installed: ' + os.path.join(b.home, '.local/bin/claude') in out)
check('Codex: npm install -g @openai/codex, found through "npm prefix -g", connected', 'npm install -g @openai/codex' in calls and MCP_CODEX in calls)
check('exit code 0, no sudo', code == 0 and not any(c.startswith('sudo') for c in calls), code)
check('installer file removed from the temporary folder', os.listdir(b.env['TMPDIR']) == [])
out2, _ = b.run(f'{BOTH}&install=1&cli=1&skill=1')
check('second run finds both and installs nothing again', b.calls().count('npm install -g @openai/codex') == 1 and sum('claude.ai/install.sh' in c for c in b.calls()) == 1)

print('5. No Node.js on the computer')
b = Box('no-node', agents=('claude',), node=False, npm=False)
out, code = b.run(f'{BOTH}&install=1&cli=1')
check('command line tool skipped with a clear note', 'needs Node.js 18 or newer, and Node.js is not on this computer' in out and not os.path.exists(os.path.join(b.home, '.local/bin/commons')))
check('Codex: says Node.js is needed', 'Install Node.js (https://nodejs.org), then run this command again.' in out)
check('Claude Code still connected; exit code 1 because Codex could not be installed', MCP_CLAUDE in b.calls() and code == 1, code)

print('6. With a terminal: the script asks, reading the answer from /dev/tty')
b = Box('tty-yes', agents=('claude', 'codex'))
out, code = b.run_tty(f'{BOTH}&{GROUP}', ['y', 'n'])
check('two questions asked', out.count('[y/N]') == 2, out.count('[y/N]'))
check('"y": CLAUDE.md written', (b.read('.claude/CLAUDE.md') or '').count('Our group: AI Safety Köln') == 1)
check('"n": AGENTS.md not written', b.read('.codex/AGENTS.md') is None and 'Left ' in out)
b = Box('tty-enter', agents=('claude',))
out, code = b.run_tty(f'agent=claude-code&{GROUP}', [''])
check('just Enter means no', b.read('.claude/CLAUDE.md') is None)

print('7. Hostile addresses: nothing from the address reaches the shell')
canary = os.path.join(ROOT, 'PWNED')
plain, _ = fetch('agent=claude-code')
hostile = {
    'group': f"'; touch {canary}; '",
    'university': f'$(touch {canary})',
    'city': f'`touch {canary}`',
    'color': f'#ffffff;touch {canary}',
    'accent': f'ffffff\ntouch {canary}',
    'font_heading': f"Inter'; touch {canary} #",
    'font_body': f'Inter"; touch {canary}; "',
    'website': f'example.org/$(touch {canary})',
    'join': f"https://example.org/';touch {canary};'",
    'evil': f'$(touch {canary})',
    'cli': f'1; touch {canary}',
    'skill': f'$(touch {canary})',
    'install': f'`touch {canary}`',
}
q = 'agent=' + urllib.parse.quote(f'claude-code;touch {canary}') + '&' + urllib.parse.urlencode(hostile)
body, status = fetch(q)
diff = [l for l in body.splitlines() if l not in plain.splitlines()]
check('script served', status == '200' and body.startswith('#!/usr/bin/env bash'), status)
check('differs from the plain script only in the comment about left-out fields', len(diff) == 2 and all(l.startswith('#   ') for l in diff), diff)
check('no trace of the values in the script', 'PWNED' not in body and 'touch /' not in body and "MEMORY_B64=''" in body)
for name, value in [('newline in a name', 'A\ntouch ' + canary), ('carriage return', 'A\rB'), ('5000 characters', 'A' * 5000), ('61 characters', 'A' * 61),
                    ('array parameter', None), ('nested parameter', None), ('slash in a name', 'a/b'), ('semicolon', 'a;b'), ('dollar', 'a$b'), ('backslash', 'a\\b'), ('double quote', 'a"b')]:
    q = {'array parameter': 'group[]=a&group[]=b', 'nested parameter': 'group[x]=a'}.get(name) or 'group=' + urllib.parse.quote(value)
    body, status = fetch('agent=claude-code&' + q)
    check(f'dropped: {name}', status == '200' and "MEMORY_B64=''" in body and 'group name' in [l for l in body.splitlines() if 'Left out' in l][0])
b = Box('hostile', agents=('claude', 'codex'))
out, code = b.run(BOTH + '&cli=1&' + urllib.parse.urlencode(hostile), {'COMMONS_SETUP_MEMORY': 'yes'})
check('ran to the end; no canary file anywhere', '==> Summary' in out and not os.path.exists(canary) and 'PWNED' not in ''.join(os.listdir(b.dir)))
check('no memory file written', b.read('.claude/CLAUDE.md') is None)
tricky = "O'Brien & Sons (Test), St. Mary-Hill"
out, code = b.run('agent=claude-code&group=' + urllib.parse.quote(tricky) + '&join=example.org%2Fa%3Fb%3D1%26c%3D2%23x', {'COMMONS_SETUP_MEMORY': 'yes'})
text = b.read('.claude/CLAUDE.md') or ''
check('allowed punctuation arrives as plain text', f'Our group: {tricky}.' in text and 'Sign-up link (QR codes point here): example.org/a?b=1&c=2#x' in text and not os.path.exists(canary), text)
for host in ["evil.example'; touch " + canary + "; '", 'evil.example$(id)', 'evil.example/path']:
    body, status = fetch('agent=claude-code', '-H', 'Host: ' + host)
    check(f'odd Host header refused ({host[:22]})', status != '200' and 'touch' not in body and '$(id)' not in body, status)

shutil.rmtree(ROOT, ignore_errors=True)
print(f'\n{len(failures)} failed' if failures else '\nAll checks passed.')
sys.exit(1 if failures else 0)
