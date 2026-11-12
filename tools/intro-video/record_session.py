"""Records a real interactive Claude Code session in a pseudo-terminal.

Usage: record_session.py <project dir> <output cast.json> <prompt text>
The cast file holds terminal size and timestamped output chunks (base64), enough to replay the session in xterm.js.
"""
import base64
import fcntl
import json
import os
import pty
import select
import struct
import sys
import termios
import time

project, out_path, prompt = sys.argv[1], sys.argv[2], sys.argv[3]
COLS, ROWS = 104, 30
MAX_SECONDS = 600

pid, fd = pty.fork()
if pid == 0:
    os.chdir(project)
    # A clean environment: the recorder itself runs inside another Claude session.
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('CLAUDE', 'ANTHROPIC', 'MCP'))}
    env.update({'TERM': 'xterm-256color', 'COLORTERM': 'truecolor', 'LANG': 'en_US.UTF-8', 'COLUMNS': str(COLS), 'LINES': str(ROWS)})
    os.execvpe('claude', ['claude', '--mcp-config', 'mcp.json', '--strict-mcp-config', '--allowedTools', 'mcp__commons', 'Write', 'Edit', 'Read', 'Glob'], env)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
start = time.time()
events = []
plain = b''
state = 'boot'          # boot -> typing -> working -> done
last_output = start
typed = 0
next_key = 0.0
submitted_at = None
trust_answered = False
ready_since = None


def now():
    return time.time() - start


while True:
    r, _, _ = select.select([fd], [], [], 0.03)
    if r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        events.append([round(now(), 3), base64.b64encode(data).decode()])
        plain += data
        plain = plain[-20000:]
        last_output = time.time()
        # Answer the terminal's cursor-position query so the interface does not wait for it.
        if b'\x1b[6n' in data:
            os.write(fd, b'\x1b[1;1R')
    t = now()
    tail = plain[-4000:].lower()
    if state == 'boot':
        if not trust_answered and (b'trust' in tail) and time.time() - last_output > 0.8:
            # The demo folder was created for this recording; the dialog's default is "No, exit", so move to "Yes".
            os.write(fd, b'\x1b[B')
            time.sleep(0.4)
            os.write(fd, b'\r')
            trust_answered = True
            plain = b''
            events.clear()  # the recording starts after the dialog
            start = time.time()
            last_output = start
            continue
        # The input box is ready once output has settled for a moment.
        if t > 4 and time.time() - last_output > 1.5:
            if ready_since is None:
                ready_since = t
            if b'trust' in tail and not trust_answered:
                continue
            state = 'typing'
            next_key = time.time() + 0.6
            events.append([round(now(), 3), 'MARK:typing'])
    elif state == 'typing':
        if time.time() >= next_key:
            if typed < len(prompt):
                os.write(fd, prompt[typed].encode())
                typed += 1
                next_key = time.time() + (0.11 if prompt[typed - 1] in ' ,.' else 0.045)
            else:
                time.sleep(0.5)
                os.write(fd, b'\r')
                submitted_at = time.time()
                state = 'working'
                events.append([round(now(), 3), 'MARK:submitted'])
    elif state == 'working':
        idle = time.time() - last_output
        if (time.time() - submitted_at > 25 and idle > 8) or t > MAX_SECONDS:
            events.append([round(now(), 3), 'MARK:done'])
            state = 'done'
            break

try:
    os.write(fd, b'\x03')
    time.sleep(0.3)
    os.write(fd, b'\x03')
    time.sleep(0.5)
    os.kill(pid, 15)
except OSError:
    pass

json.dump({'cols': COLS, 'rows': ROWS, 'duration': round(now(), 2), 'events': events}, open(out_path, 'w'))
print(f'recorded {len(events)} chunks, {now():.0f} s, state {state}, trust prompt answered: {trust_answered}')
