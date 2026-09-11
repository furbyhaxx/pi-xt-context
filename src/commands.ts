import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  SettingsList,
  Text,
  type AutocompleteItem,
  type SettingItem,
} from "@earendil-works/pi-tui";
import {
  buildSettingsPatch,
  discoveryConfigChanged,
  formatPatterns,
  loadConfig,
  parseFilesEditorText,
  patchIsEmpty,
  projectSettingsPath,
  saveContextSettings,
  userSettingsPath,
  type Config,
  type LoadedConfig,
  type ScopeDraft,
} from "./config.ts";
import {
  formatFileList,
  mergeListedFiles,
  type ExtensionLoadedFile,
} from "./loaded.ts";

export interface ContextCommandHost {
  getState(): {
    currentDir: string;
    launchDir: string;
    extensionFiles: ExtensionLoadedFile[];
  } | null;
  getConfig(): LoadedConfig;
  setConfig(next: LoadedConfig, discoveryChanged: boolean): void;
}

export function parseContextArgs(
  args: string,
): "overview" | "list" | "config" | "usage" {
  const a = (args ?? "").trim().toLowerCase();
  if (a === "") return "overview";
  if (a === "list") return "list";
  if (a === "config") return "config";
  return "usage";
}

export function formatOverview(opts: {
  launchDir: string;
  currentDir: string;
  piCount: number;
  extensionCount: number;
  uniqueCount: number;
  config: LoadedConfig;
}): string {
  const { config } = opts;
  const e = config.effective;
  const lines = [
    "pi-xt-context",
    `launch: ${opts.launchDir}`,
    `tracked: ${opts.currentDir}`,
    `loaded: ${opts.uniqueCount} unique (${opts.piCount} pi, ${opts.extensionCount} extension)`,
    `workingDirOnly: ${e.workingDirOnly ? "on" : "off"}  (${config.provenance.workingDirOnly})`,
    `hideContents: ${e.hideContents ? "on" : "off"}  (${config.provenance.hideContents})`,
    `files: ${formatPatterns(e.files)}  (${config.provenance.files})`,
  ];
  if (e.files.length === 0) {
    lines.push("discovery: disabled (empty files list)");
  }
  if (config.diagnostics.length > 0) {
    lines.push("config warnings:");
    for (const d of config.diagnostics) lines.push(`  - ${d}`);
  }
  lines.push(
    "",
    "/context list — loaded files",
    "/context config — edit settings",
  );
  return lines.join("\n");
}

function piContextFiles(ctx: ExtensionCommandContext): Array<{ path: string }> {
  try {
    return (ctx.getSystemPromptOptions()?.contextFiles ?? []).filter(
      (f): f is { path: string; content: string } =>
        !!f && typeof f.path === "string",
    );
  } catch {
    return [];
  }
}

function listedFrom(ctx: ExtensionCommandContext, host: ContextCommandHost) {
  const state = host.getState();
  const pi = piContextFiles(ctx);
  const ext = state?.extensionFiles ?? [];
  return mergeListedFiles(pi, ext);
}

function notifyOverview(ctx: ExtensionCommandContext, host: ContextCommandHost) {
  const state = host.getState();
  const listed = listedFrom(ctx, host);
  const piCount = listed.filter((f) => f.source === "pi").length;
  const extensionCount = listed.filter((f) => f.source === "extension").length;
  ctx.ui.notify(
    formatOverview({
      launchDir: state?.launchDir ?? ctx.cwd,
      currentDir: state?.currentDir ?? ctx.cwd,
      piCount,
      extensionCount,
      uniqueCount: listed.length,
      config: host.getConfig(),
    }),
    "info",
  );
}

function notifyList(ctx: ExtensionCommandContext, host: ContextCommandHost) {
  ctx.ui.notify(formatFileList(listedFrom(ctx, host)), "info");
}

function draftFromScope(loaded: LoadedConfig, scope: "user" | "project"): ScopeDraft {
  const scoped = scope === "user" ? loaded.user : loaded.project;
  return {
    inherit: {
      workingDirOnly: scoped.workingDirOnly === undefined,
      hideContents: scoped.hideContents === undefined,
      files: scoped.files === undefined,
    },
    workingDirOnly: scoped.workingDirOnly ?? loaded.effective.workingDirOnly,
    hideContents: scoped.hideContents ?? loaded.effective.hideContents,
    files: [...(scoped.files ?? loaded.effective.files)],
  };
}

type ConfigAction = "save" | "cancel" | "edit-files";

function boolValue(inherit: boolean, value: boolean): string {
  return inherit ? "inherit" : value ? "on" : "off";
}

async function runConfigurator(
  ctx: ExtensionCommandContext,
  host: ContextCommandHost,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/context config requires TUI mode", "error");
    return;
  }

  const trusted = ctx.isProjectTrusted();
  const userPath = userSettingsPath();
  const projectPath = projectSettingsPath(ctx.cwd);
  const options = trusted
    ? [`User  ${userPath}`, `Project  ${projectPath}`]
    : [`User  ${userPath}`];
  const picked = await ctx.ui.select("Save context settings to which scope?", options);
  if (!picked) return;

  const scope: "user" | "project" = picked.startsWith("Project") ? "project" : "user";
  if (scope === "project" && !trusted) {
    ctx.ui.notify(
      "Project settings are unavailable until the project is trusted",
      "warning",
    );
    return;
  }

  let loaded = loadConfig(ctx.cwd, trusted);
  host.setConfig(loaded, false);
  const initial = draftFromScope(loaded, scope);
  const draft: ScopeDraft = {
    inherit: { ...initial.inherit },
    workingDirOnly: initial.workingDirOnly,
    hideContents: initial.hideContents,
    files: [...initial.files],
  };
  const dest = scope === "user" ? userPath : projectPath;

  while (true) {
    const action = await ctx.ui.custom<ConfigAction | null>(
      (tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(
          new Text(
            theme.fg("accent", theme.bold(`Context settings (${scope})`)),
            1,
            0,
          ),
        );
        container.addChild(new Text(theme.fg("muted", dest), 1, 0));

        const items: SettingItem[] = [
          {
            id: "workingDirOnly",
            label: "workingDirOnly",
            currentValue: boolValue(draft.inherit.workingDirOnly, draft.workingDirOnly),
            values: ["on", "off", "inherit"],
            description: `effective ${loaded.effective.workingDirOnly ? "on" : "off"} (${loaded.provenance.workingDirOnly})`,
          },
          {
            id: "hideContents",
            label: "hideContents",
            currentValue: boolValue(draft.inherit.hideContents, draft.hideContents),
            values: ["on", "off", "inherit"],
            description: `effective ${loaded.effective.hideContents ? "on" : "off"} (${loaded.provenance.hideContents})`,
          },
          {
            id: "filesSource",
            label: "files",
            currentValue: draft.inherit.files ? "inherit" : "override",
            values: ["inherit", "override"],
            description: draft.inherit.files
              ? `inherited ${formatPatterns(loaded.effective.files)}`
              : draft.files.length === 0
                ? "explicitly empty — discovery disabled"
                : formatPatterns(draft.files),
          },
          {
            id: "filesEdit",
            label: "edit files",
            currentValue: draft.inherit.files
              ? "(inherited)"
              : formatPatterns(draft.files),
            values: draft.inherit.files ? undefined : ["edit"],
            description: "One glob per line. Brace globs may contain commas.",
          },
          {
            id: "save",
            label: "Save",
            currentValue: "",
            values: ["save"],
            description: `Write ${scope} overrides to ${dest}`,
          },
          {
            id: "cancel",
            label: "Cancel",
            currentValue: "",
            values: ["cancel"],
          },
        ];

        const settingsList = new SettingsList(
          items,
          Math.min(items.length + 4, 16),
          getSettingsListTheme(),
          (id, newValue) => {
            if (id === "workingDirOnly") {
              if (newValue === "inherit") draft.inherit.workingDirOnly = true;
              else {
                draft.inherit.workingDirOnly = false;
                draft.workingDirOnly = newValue === "on";
              }
            } else if (id === "hideContents") {
              if (newValue === "inherit") draft.inherit.hideContents = true;
              else {
                draft.inherit.hideContents = false;
                draft.hideContents = newValue === "on";
              }
            } else if (id === "filesSource") {
              if (newValue === "inherit") draft.inherit.files = true;
              else {
                if (draft.inherit.files) draft.files = [...loaded.effective.files];
                draft.inherit.files = false;
              }
            } else if (id === "filesEdit" && newValue === "edit") {
              done("edit-files");
              return;
            } else if (id === "save") {
              done("save");
              return;
            } else if (id === "cancel") {
              done("cancel");
              return;
            }
            tui.requestRender();
          },
          () => done("cancel"),
        );
        container.addChild(settingsList);

        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            settingsList.handleInput?.(data);
            tui.requestRender();
          },
        };
      },
    );

    if (action === "edit-files") {
      const text = await ctx.ui.editor(
        "Context file patterns (one glob per line)",
        draft.files.join("\n"),
      );
      if (text !== undefined) {
        const parsed = parseFilesEditorText(text);
        if (parsed.errors.length > 0) {
          ctx.ui.notify(parsed.errors.join("\n"), "error");
        } else {
          draft.files = parsed.files;
          draft.inherit.files = false;
        }
      }
      continue;
    }

    if (action !== "save") return;

    const patch = buildSettingsPatch(initial, draft);
    if (patchIsEmpty(patch)) {
      ctx.ui.notify("No changes to save", "info");
      return;
    }

    await ctx.waitForIdle();
    const result = saveContextSettings(scope, ctx.cwd, patch);
    if (!result.ok) {
      ctx.ui.notify(result.error, "error");
      return;
    }

    const prev: Config = { ...host.getConfig().effective };
    const next = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    host.setConfig(next, discoveryConfigChanged(prev, next.effective));

    const masked: string[] = [];
    if (scope === "user") {
      if (patch.workingDirOnly !== undefined && patch.workingDirOnly !== null
        && next.provenance.workingDirOnly === "project") {
        masked.push("workingDirOnly");
      }
      if (patch.hideContents !== undefined && patch.hideContents !== null
        && next.provenance.hideContents === "project") {
        masked.push("hideContents");
      }
      if (patch.files !== undefined && patch.files !== null
        && next.provenance.files === "project") {
        masked.push("files");
      }
    }

    let msg = `Saved ${scope} context settings to ${dest}`;
    if (masked.length > 0) {
      msg += `. Project still overrides: ${masked.join(", ")}`;
    }
    if (discoveryConfigChanged(prev, next.effective)) {
      msg += ". Discovery cache cleared — already injected files stay; new patterns apply on the next directory touch. A new session is needed to drop previously injected context.";
    }
    ctx.ui.notify(msg, "info");
    return;
  }
}

export function registerContextCommand(pi: ExtensionAPI, host: ContextCommandHost): void {
  pi.registerCommand("context", {
    description: "Context files: overview, list, or config",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] =>
      [
        { value: "list", label: "list", description: "Show loaded context files" },
        { value: "config", label: "config", description: "Edit context settings" },
      ].filter((i) => i.value.startsWith(prefix.trim().toLowerCase())),
    handler: async (args, ctx) => {
      const action = parseContextArgs(args);
      if (action === "usage") {
        ctx.ui.notify("usage: /context [list|config]", "info");
        return;
      }
      if (action === "list") {
        notifyList(ctx, host);
        return;
      }
      if (action === "config") {
        await runConfigurator(ctx, host);
        return;
      }
      notifyOverview(ctx, host);
    },
  });
}
