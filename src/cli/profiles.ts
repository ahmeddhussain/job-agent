// `agent profile:list` and `agent profile:use <name>` (D45).
import {
  activeName,
  EXAMPLE_PROFILE,
  listProfiles,
  resolveProfile,
  setActive,
} from '../profiles.js';
import type { Io } from './program.js';

export function profileListCommand(explicit: string | undefined, io: Io): void {
  const all = listProfiles();
  if (all.length === 0) {
    io.out('no profiles: create yours with ./agent.sh init');
    return;
  }
  let current: string | null;
  try {
    current = resolveProfile(explicit).name;
  } catch {
    current = null;
  }
  for (const n of all)
    io.out(
      `${n === current ? '*' : ' '} ${n}${n === EXAMPLE_PROFILE ? '  (fictional example)' : ''}`,
    );
  if (!current) io.out('no profile is active: ./agent.sh use <name>');
  else if (activeName() !== current && !explicit && !process.env['JOB_AGENT_PROFILE'])
    io.out(`(${current} is used because it is the only one)`);
}

export function profileUseCommand(name: string, io: Io): void {
  setActive(name);
  io.out(`active profile: ${name} (profiles/${name})`);
}
