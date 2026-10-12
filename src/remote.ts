import { posix } from "node:path";
import { MAX_FILE_BYTES, rememberContextText, type ContextText } from "./content.ts";
import type { ContextFile } from "./discovery.ts";

/** Location resolved by the optional workbench service. */
export type Location = { kind: "local"; path: string } | SshLocation;

/** Remote host and absolute POSIX path, including an optional SSH port. */
export interface SshLocation {
  kind: "ssh";
  host: string;
  port?: number;
  path: string;
}

/** Versioned inter-extension contract; no workbench imports are needed. */
export interface WorkbenchServiceV1 {
  version: 1;
  defaultLocation(): string;
  resolve(raw: string | undefined, signal?: AbortSignal): Promise<Location>;
  format(location: Location): string;
  exec(location: SshLocation, script: string, options?: { signal?: AbortSignal; input?: string }): Promise<string>;
}

/** Accept only the version of the service this extension understands. */
export function isWorkbenchService(value: unknown): value is WorkbenchServiceV1 {
  if (!value || typeof value !== "object") return false;
  return "version" in value && value.version === 1 &&
    ["resolve", "format", "exec", "defaultLocation"].every(
      (key) => key in value && typeof Reflect.get(value, key) === "function",
    );
}

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const array = (values: string[]) => values.map(quote).join(" ");

/** Bash cd tracking uses remote POSIX paths and ignores workbench's output prefix. */
export async function remoteToolDirectory(
  service: WorkbenchServiceV1,
  location: SshLocation,
  toolName: string,
  input: Record<string, unknown>,
  output: string,
): Promise<SshLocation> {
  if (toolName === "read" || toolName === "edit" || toolName === "write") {
    const raw = input.path ?? input.file_path;
    return typeof raw === "string" && raw.length > 0
      ? { ...location, path: posix.dirname(location.path) } : location;
  }
  if (toolName !== "bash") return location;
  const command = typeof input.command === "string" ? input.command.trim() : "";
  const cd = command.match(/^cd(?:\s+(.+?))?(?:\s*(?:&&|;)\s*pwd)?\s*$/);
  if (!cd) return location;
  if (/(?:&&|;)\s*pwd\s*$/.test(command)) {
    const lines = output.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "")
      .split("\n").filter((line) => line.trim() && !line.startsWith("[ssh://"));
    const last = lines.at(-1)?.trim();
    if (last?.startsWith("/")) return { ...location, path: posix.normalize(last) };
  }
  const target = (cd[1] ?? "~").replace(/^(['"])(.*)\1$/, "$2");
  if (target === "~" || target.startsWith("~/")) {
    const home = await service.resolve(service.format({ ...location, path: `/~/${target.slice(2)}` }));
    return home.kind === "ssh" ? home : location;
  }
  return { ...location, path: posix.resolve(location.path, target) };
}

/** One-exec remote scanner with per-session text/stamp memo and host failure suppression. */
export class RemoteContexts {
  private readonly memo = new Map<string, ContextFile>();
  private readonly failedHosts = new Set<string>();

  constructor(private readonly service: WorkbenchServiceV1) {}

  /** Report a host failure once; later touches of that host are skipped this session. */
  fail(host: string, error: unknown): void {
    if (this.failedHosts.has(host)) return;
    this.failedHosts.add(host);
    console.error(`pi-xt-context: remote context unavailable for ${host}: ${String(error)}`);
  }

  /** Skip repeated resolution failures before workbench attempts another connection. */
  failedUri(uri: string): boolean {
    const authority = uri.match(/^ssh:\/\/[^/]+/)?.[0];
    return authority !== undefined && this.failedHosts.has(authority);
  }

  /** Whether this host has already failed in the current session. */
  failed(location: SshLocation): boolean {
    return this.failedHosts.has(this.authority(location));
  }

  private authority(location: SshLocation): string {
    return this.service.format({ ...location, path: "/" }).slice(0, -1);
  }

  private base(location: SshLocation): string {
    const prefix = this.authority(location);
    const defaultLocation = this.service.defaultLocation();
    return defaultLocation.startsWith(`${prefix}/`) ? defaultLocation.slice(prefix.length) : "/";
  }

  /** Scan ancestors, or batch re-stat the supplied files; unchanged text is not transferred. */
  async scan(
    location: SshLocation,
    patterns: string[],
    exclude: string[],
    files?: Array<{ path: string; scopeDir: string }>,
  ): Promise<ContextFile[]> {
    if (this.failed(location) || (files ? files.length === 0 : patterns.length === 0)) return [];
    const prefix = this.authority(location);
    if (this.memo.size >= 512) this.memo.clear();
    const known = [...this.memo.values()].filter((file) => file.path.startsWith(`${prefix}/`));
    const init = known.map((file) =>
      `known[${quote(file.path.slice(prefix.length))}]=${quote(`${file.stamp.mtimeMs}:${file.stamp.size}`)}`,
    ).join("\n");
    const scan = files
      ? files.map((file) => `emit ${quote(file.path.slice(prefix.length))} ${quote(file.scopeDir.slice(prefix.length))}`).join("\n")
      : `dir=${quote(location.path)}
while :; do
  for pattern in "\${patterns[@]}"; do
    [[ "$pattern" == *'**'* ]] && continue
    for file in "\${dir%/}"/$pattern; do
      emit "$file" "$dir"
    done
  done
  [[ "$dir" == / ]] && break
  dir="\${dir%/*}"
  [[ -n "$dir" ]] || dir=/
done`;
    const script = `set -eo pipefail
export LC_ALL=C
shopt -s nullglob dotglob
IFS=''
patterns=(${array(patterns.map((pattern) => posix.normalize(pattern)))})
excludes=(${array(exclude)})
base=${quote(this.base(location))}
declare -A known seen
${init}
b64() { base64 | tr -d '\\n'; }
excluded() {
  local file="$1" rel part pattern
  if [[ "$base" == / ]]; then rel="\${file#/}"
  elif [[ "$file" == "$base" ]]; then rel=.
  elif [[ "$file" == "$base/"* ]]; then rel="\${file#"$base/"}"
  else return 1; fi
  part="$rel"
  while :; do
    for pattern in "\${excludes[@]}"; do
      [[ "$part" == $pattern ]] && return 0
    done
    [[ "$part" == */* ]] || break
    part="\${part%/*}"
  done
  return 1
}
emit() {
  local file="$1" scope="$2" stamp size mtime body status
  [[ -f "$file" && -r "$file" ]] || return 0
  [[ -z "\${seen[$file]+yes}" ]] || return 0
  seen["$file"]=1
  excluded "$file" && return 0
  stamp=$(stat -Lc '%y|%s' -- "$file") || return 0
  size="\${stamp##*|}"
  mtime=$(date -d "\${stamp%|*}" +%s%3N) || return 0
  if [[ "\${known[$file]-}" == "$mtime:$size" ]]; then
    status=U; body=''
  else
    status=C
    body=$(head -c ${MAX_FILE_BYTES} -- "$file" | b64) || return 0
  fi
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$status" "$(printf %s "$file" | b64)" "$(printf %s "$scope" | b64)" "$mtime" "$size" "$body"
}
${scan}
true`;
    try {
      const output = await this.service.exec(location, script);
      const found = new Map<string, ContextFile>();
      for (const line of output.split("\n")) {
        if (!line) continue;
        const [status, encodedPath, encodedScope, mtime, size, body, extra] = line.split("\t");
        if ((status !== "C" && status !== "U") || body === undefined || extra !== undefined ||
          !/^\d+$/.test(mtime) || !/^\d+$/.test(size)) throw new Error("Invalid remote context frame");
        const path = Buffer.from(encodedPath, "base64").toString("utf8");
        const scope = Buffer.from(encodedScope, "base64").toString("utf8");
        if (!posix.isAbsolute(path) || !posix.isAbsolute(scope)) throw new Error("Invalid remote context path");
        const uri = this.service.format({ ...location, path: posix.normalize(path) });
        const cached = this.memo.get(uri);
        let text: ContextText;
        if (status === "U") {
          if (!cached) throw new Error("Missing remote context text");
          text = cached;
        } else {
          let content = Buffer.from(body, "base64").toString("utf8");
          if (Number(size) > MAX_FILE_BYTES) content += "\n\n[...truncated]";
          if (!content.trim()) continue;
          text = { path: uri, content, stamp: { mtimeMs: Number(mtime), size: Number(size) } };
          rememberContextText(text);
        }
        const file = { ...text, scopeDir: this.service.format({ ...location, path: posix.normalize(scope) }) };
        this.memo.set(uri, file);
        found.set(uri, file);
      }
      return [...found.values()].sort((a, b) => {
        const depth = (path: string) => path.split("/").length;
        return depth(b.scopeDir) - depth(a.scopeDir) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      });
    } catch (error) {
      this.fail(prefix, error);
      return [];
    }
  }
}
