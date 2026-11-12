// Structured logs. Imported first by index.js, for its side effect: on Cloud Run (or with LOG_FORMAT=json) every
// console.log / info / warn / error call in the server becomes one line of JSON with a "severity" field, which is
// what Cloud Logging needs to classify an entry. Errors carry their stack, so Error Reporting groups them.
// Locally the console stays as it is (LOG_FORMAT=text forces that).

import util from 'node:util';

const format = process.env.LOG_FORMAT || (process.env.K_SERVICE || process.env.NODE_ENV === 'production' ? 'json' : 'text');
export const structured = format === 'json';

function entry(severity, args) {
  const err = args.find((a) => a instanceof Error);
  const message = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : util.inspect(a, { depth: 4, breakLength: Infinity }))).join(' ');
  const out = { severity, message, time: new Date().toISOString() };
  if (err) out.stack_trace = err.stack;
  if (err?.code !== undefined) out.code = err.code;
  if (severity === 'ERROR' || severity === 'CRITICAL') out['@type'] = 'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent';
  return JSON.stringify(out);
}

const write = (stream, severity) => (...args) => stream.write(entry(severity, args) + '\n');

if (structured) {
  console.log = write(process.stdout, 'INFO');
  console.info = write(process.stdout, 'INFO');
  console.debug = write(process.stdout, 'DEBUG');
  console.warn = write(process.stderr, 'WARNING');
  console.error = write(process.stderr, 'ERROR');
}

// For failures that end the process.
export const critical = (...args) => (structured ? process.stderr.write(entry('CRITICAL', args) + '\n') : console.error(...args));
