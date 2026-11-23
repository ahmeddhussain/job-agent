// "Run now" from the dashboard (D41): starts the same `agent run` as the terminal, as a
// child process with a fixed command (no arguments from the request except dry-run), and
// keeps its output for the page to poll. The run lock still applies: a run started in the
// terminal and one from the dashboard can't overlap.
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface RunStatus {
  running: boolean;
  dry_run: boolean;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  lines: string[];
}

export class RunManager {
  private child: ChildProcess | null = null;
  private s: RunStatus = {
    running: false,
    dry_run: false,
    started_at: null,
    finished_at: null,
    exit_code: null,
    lines: [],
  };

  constructor(
    /** For tests: what to start instead of `npm run agent -- run`. */
    private readonly command: { cmd: string; args: (dry: boolean) => string[] } = {
      cmd: 'npm',
      args: (dry) => ['run', '-s', 'agent', '--', 'run', ...(dry ? ['--dry-run'] : [])],
    },
  ) {}

  status(): RunStatus {
    return { ...this.s, lines: this.s.lines.slice(-400) };
  }

  start(dryRun: boolean): RunStatus {
    if (this.child) throw new Error('a run started from the dashboard is still going');
    this.s = {
      running: true,
      dry_run: dryRun,
      started_at: new Date().toISOString(),
      finished_at: null,
      exit_code: null,
      lines: [],
    };
    const child = spawn(this.command.cmd, this.command.args(dryRun), {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    let buf = '';
    const take = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const l of parts) if (l.trim()) this.s.lines.push(l);
      if (this.s.lines.length > 2000) this.s.lines.splice(0, this.s.lines.length - 2000);
    };
    child.stdout.on("data", take);
    // stderr carries JSON logs; only warnings and errors are worth showing.
    child.stderr.on("data", (c: Buffer) => {
      for (const l of c.toString('utf8').split('\n')) {
        const m = /"level":(\d+).*"msg":"([^"]*)"/.exec(l);
        if (m && Number(m[1]) >= 40) this.s.lines.push(`  (${Number(m[1]) >= 50 ? 'error' : 'warning'}) ${m[2] ?? ''}`);
        else if (l.trim() && !l.startsWith('{')) this.s.lines.push(l);
      }
    });
    child.on('close', (code) => {
      if (buf.trim()) this.s.lines.push(buf);
      this.s.running = false;
      this.s.exit_code = code;
      this.s.finished_at = new Date().toISOString();
      this.child = null;
    });
    child.on('error', (err) => {
      this.s.lines.push(`could not start the run: ${err.message}`);
    });
    return this.status();
  }
}
