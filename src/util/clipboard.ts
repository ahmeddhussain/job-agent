// Puts text on the desktop clipboard (Wayland or X11) when a clipboard tool exists.
import { spawnSync } from 'node:child_process';

export function toClipboard(text: string): boolean {
  for (const [cmd, args] of [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ] as const) {
    const r = spawnSync(cmd, [...args], { input: text, timeout: 3000 });
    if (r.status === 0) return true;
  }
  return false;
}
