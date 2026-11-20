#!/usr/bin/env node
// Fake `claude` CLI for tests. Behaviour is chosen by the --model value, because the
// real wrapper passes the child an allowlisted environment (no way to pass a mode).
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1] ?? '';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const result = (extra) =>
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    usage: { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 7 },
    ...extra,
  });

if (args.includes('stream-json')) {
  out({
    type: 'system',
    subtype: 'init',
    apiKeySource: model === 'fake-apikey' ? 'ANTHROPIC_API_KEY' : 'none',
    claude_code_version: model === 'fake-oldversion' ? '0.0.1' : '2.1.317',
  });
  if (model === 'fake-limit')
    out({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: "You've hit your usage limit",
    });
  else result({ result: 'OK' });
  process.exit(0);
}
switch (model) {
  case 'fake-echo':
    result({
      structured_output: {
        args,
        env: Object.keys(process.env).sort(),
        cwd: process.cwd(),
        hasToken: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
      },
    });
    break;
  case 'fake-limit':
    out({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Claude usage limit reached. Your limit will reset at 5pm',
    });
    break;
  case 'fake-badschema':
    result({ structured_output: { unexpected: true } });
    break;
  case 'fake-garbage':
    process.stdout.write('not json');
    process.exitCode = 1;
    break;
  default:
    result({ structured_output: { ok: true } });
}
