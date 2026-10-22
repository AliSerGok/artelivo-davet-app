import { execFile } from "node:child_process";

/** macOS bildirimi — iş bitince (ör. "liste hazır"). */
export function notify(title: string, message: string): void {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  execFile(
    "osascript",
    [
      "-e",
      `display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`,
    ],
    () => {},
  );
}
