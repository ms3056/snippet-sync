'use strict';

/**
 * Snippet Sync
 *
 * Install and auto-update CSS snippets from a GitHub repository.
 * Modeled on BRAT's theme mechanic: the repo is the source of truth,
 * files are fetched from raw.githubusercontent.com (no API, no rate
 * limits for content), and updates are detected by checksum. The repo
 * must contain a manifest.json at the source folder root listing every
 * snippet.
 *
 * The plugin always follows the repository's default branch (HEAD).
 * Version pinning was tried and removed in v1.0.5: the user controls
 * granularity with per-snippet checkboxes and single-snippet update
 * buttons instead. Every check compares checksums; changed installed
 * snippets are flagged "update available" (or applied, per settings).
 *
 * Installed snippets are written to the vault's native snippets folder and
 * enabled through the same customCss API Obsidian's Appearance tab uses, so
 * they show up in Appearance -> CSS snippets like normal snippets and can
 * never fight the built-in toggle.
 */

const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, normalizePath, SecretComponent } = require("obsidian");

const DEFAULT_SETTINGS = {
  repo: "",                         // owner/name of the snippets repository; user supplies it
  folder: "",                       // optional subfolder inside the repo where snippets live
  version: "latest",                // kept for compat with older data.json; unused now (always HEAD)
  checkAtStartup: true,             // BRAT's updateAtStartup equivalent
  intervalMinutes: 60,              // periodic check; 0 = off (BRAT lacks this, user asked for it)
  autoUpdate: true,                 // true = apply updates when found; false = notify only
  enableAfterInstall: true,         // enable the snippet in Appearance when installed
  lastCheck: 0,                     // epoch ms of last successful check
  lastResult: "",                   // last check summary line
  tokenSecret: "",                  // NAME of the GitHub token in SecretStorage (never the value)
  snippets: {},                     // id -> { id, file, selected, checksum }
};

/** BRAT-style content checksum (sum of char codes). Change detection only. */
function checksum(text) {
  let sum = 0;
  for (let i = 0; i < text.length; i++) sum = (sum + text.charCodeAt(i)) % 999999937;
  return String(sum);
}

/** Scrubs a repo input to owner/repo (accepts URLs, .git suffixes, trailing slashes). */
function scrubRepo(raw) {
  if (!raw) return "";
  let s = raw.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  s = s.replace(/\.git$/i, "");
  s = s.replace(/\/+$/, "");
  return s;
}

/** Raw base URL for a source folder in a repo. folder="" = repo root. ref = "HEAD" or a tag. */
function rawBase(repo, folder, ref = "HEAD") {
  const f = (folder || "").replace(/^\/+|\/+$/g, "");
  return `https://raw.githubusercontent.com/${scrubRepo(repo)}/${ref}/${f ? f + "/" : ""}`;
}

class SnippetSyncPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.repo = scrubRepo(this.settings.repo || "");
    this.timer = null;

    this.addSettingTab(new SnippetSyncSettingTab(this.app, this));

    // Commands mirroring BRAT's plugin commands.
    this.addCommand({
      id: "check-for-updates",
      name: "Snippet Sync: Check for snippet updates",
      checkCallback: (checking) => {
        if (checking) return true;
        void this.checkForUpdates(false, true);
        return true;
      },
    });
    this.addCommand({
      id: "update-all",
      name: "Snippet Sync: Update all snippets",
      checkCallback: (checking) => {
        if (checking) return true;
        void this.checkForUpdates(true, true);
        return true;
      },
    });

    // Startup check (BRAT waits 60s; re-use that window) + periodic interval.
    if (this.settings.checkAtStartup) {
      window.setTimeout(() => void this.checkForUpdates(this.settings.autoUpdate), 60000);
    }
    if (this.settings.intervalMinutes > 0) {
      this.timer = window.setInterval(
        () => void this.checkForUpdates(this.settings.autoUpdate),
        this.settings.intervalMinutes * 60 * 1000,
      );
    }
  }

  onunload() {
    if (this.timer) window.clearInterval(this.timer);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * The git ref we read from. Always HEAD: the version pinning selector was
   * removed in v1.0.5 — the plugin follows the repo (latest) and selective
   * per-snippet updates provide the granularity. The method stays for callers.
   */
  currentRef() {
    return "HEAD";
  }

  // ---- GitHub token (stored ONLY in SecretStorage; data.json holds the name) ----

  /** The secret name under which the user's GitHub token is kept in SecretStorage. */
  tokenSecretName() {
    return this.settings.tokenSecret || "snippet-sync-github-token";
  }

  /** True when the user has stored a token in SecretStorage (by name). */
  hasToken() {
    const ss = this.app && this.app.secretStorage;
    if (!ss) return false;
    try {
      return ss.peekSecret(this.tokenSecretName()) !== null;
    } catch (e) {
      return false;
    }
  }

  /**
   * The token value, ONLY for use in outbound Authorization headers.
   * Never logs it, never stores it in settings; callers must not echo it.
   */
  async getTokenValue() {
    const ss = this.app && this.app.secretStorage;
    if (!ss) return null;
    try {
      // peekSecret avoids bumping core's last-access bookkeeping on every check.
      return (await ss.peekSecret(this.tokenSecretName())) || null;
    } catch (e) {
      return null;
    }
  }

  /** Save a pasted token into SecretStorage. settings.tokenSecret stays a NAME only. */
  async saveToken(value) {
    const ss = this.app && this.app.secretStorage;
    if (!ss) {
      new Notice("Snippet Sync\nSecretStorage is not available on this Obsidian build.");
      return;
    }
    const name = this.tokenSecretName();
    try {
      await ss.setSecret(name, value);
      this.settings.tokenSecret = name;
      await this.saveSettings();
      new Notice("Snippet Sync\nGitHub token stored securely in SecretStorage.");
    } catch (e) {
      new Notice(`Snippet Sync\nCould not store token: ${e.message}`);
    }
  }

  /** Delete the stored token from SecretStorage and forget the name. */
  async deleteToken() {
    const ss = this.app && this.app.secretStorage;
    if (!ss) return;
    try {
      await ss.deleteSecret(this.tokenSecretName());
      this.settings.tokenSecret = "";
      await this.saveSettings();
      new Notice("Snippet Sync\nGitHub token removed from SecretStorage.");
    } catch (e) {
      new Notice(`Snippet Sync\nCould not remove token: ${e.message}`);
    }
  }

  /**
   * Validate THIS user's stored token against GitHub (same API surface BRAT
   * uses to validate: rate_limit returns core quota; 401 = bad token).
   * Returns {ok, status, core} — never echoes the token value.
   */
  async verifyToken() {
    const token = await this.getTokenValue();
    if (!token) return { ok: false, status: 0, core: null };
    try {
      const res = await requestUrl({
        url: "https://api.github.com/rate_limit",
        method: "GET",
        headers: { "User-Agent": "Obsidian/Snippet-Sync", Authorization: `Bearer ${token}` },
      });
      if (res.status === 200 && res.json && res.json.resources && res.json.resources.core) {
        return { ok: true, status: 200, core: res.json.resources.core };
      }
      return { ok: false, status: res.status, core: null };
    } catch (e) {
      return { ok: false, status: e && e.status ? e.status : "network", core: null };
    }
  }

  // ---- file plumbing (adapter on config dir, exactly like BRAT does for plugins) ----

  snippetsFolder() {
    return normalizePath(`${this.app.vault.configDir}/snippets`);
  }

  async ensureSnippetsFolder() {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(this.snippetsFolder()))) {
      await adapter.mkdir(this.snippetsFolder());
    }
  }

  async readLocal(name) {
    const adapter = this.app.vault.adapter;
    const path = `${this.snippetsFolder()}/${name}.css`;
    try {
      return (await adapter.exists(path)) ? await adapter.read(path) : null;
    } catch (e) {
      return null;
    }
  }

  async writeLocal(name, content) {
    await this.ensureSnippetsFolder();
    const adapter = this.app.vault.adapter;
    await adapter.write(`${this.snippetsFolder()}/${name}.css`, content);
  }

  async removeLocal(name) {
    const adapter = this.app.vault.adapter;
    const path = `${this.snippetsFolder()}/${name}.css`;
    try {
      if (await adapter.exists(path)) await adapter.remove(path);
    } catch (e) {
      /* ignore */
    }
  }

  /** Enable/disable via the same customCss API the Appearance tab itself uses, then refresh. */
  async setEnabledState(name, enabled) {
    const cc = this.app.customCss;
    if (!cc) return;
    try {
      cc.setCssEnabledStatus(name, enabled);
      await cc.readSnippets();
    } catch (e) {
      /* older runtime: snippets still load on next reload */
    }
  }

  // ---- fetch layer ----

  async fetchText(url) {
    const headers = { "User-Agent": "Obsidian/Snippet-Sync" };
    // If THIS user has stored their own token in SecretStorage, authenticate so
    // GitHub counts these requests against their personal quota, not the shared one.
    const token = await this.getTokenValue();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await requestUrl({ url, method: "GET", headers });
    if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text;
  }

  async fetchManifestRaw(ref = this.currentRef()) {
    const base = rawBase(this.settings.repo, this.settings.folder, ref);
    const text = await this.fetchText(`${base}manifest.json`);
    const m = JSON.parse(text);
    if (!Array.isArray(m.snippets)) throw new Error("manifest.json has no snippets array");
    return { name: m.name || this.settings.repo, version: m.version || "0.0.0", ref, snippets: m.snippets };
  }

  /**
   * Returns manifest entry for a snippet id or null.
   */
  manifestEntry(manifest, id) {
    return manifest.snippets.find((s) => String(s.id) === id) || null;
  }

  // ---- core check ----

  /**
   * Fetch the manifest for the active version, compare against installed/selected
   * state, optionally apply updates. Returns a JSON summary for the UI / notice.
   * @param {boolean} applyUpdates - true = write changes; false = dry run (flag badges).
   * @param {boolean} manual      - true = user pressed a button/command: ALWAYS toast.
   */
  async checkForUpdates(applyUpdates, manual = false) {
    try {
      if (!this.settings.repo) return null;
      const ref = this.currentRef();
      const manifest = await this.fetchManifestRaw(ref);
      const base = rawBase(this.settings.repo, this.settings.folder, ref);
      const summary = { version: manifest.version, ref, name: manifest.name, added: 0, updated: 0, removed: 0, conflicts: 0, unchanged: 0, updatedIds: [], removedIds: [] };
      const toSave = { ...this.settings.snippets };

      // Consider every manifest snippet; only SELECTED ones are fetched/written.
      for (const entry of manifest.snippets) {
        const id = String(entry.id);
        const target = String(entry.file || "").replace(/\.css$/i, "");
        const state = toSave[id] || { id, file: target, selected: false, checksum: "", conflict: false };

        if (!state.selected) {
          // Listed for the settings checklist, but never fetched or written.
          continue;
        }

        const remote = await this.fetchText(`${base}${entry.file}`);
        const remoteSum = checksum(remote);
        const local = await this.readLocal(target);
        const localSum = local === null ? null : checksum(local);

        // Conflict: local file exists and matches neither what we installed nor remote.
        if (localSum !== null && localSum !== state.checksum && localSum !== remoteSum) {
          summary.conflicts++;
          state.conflict = true;
          toSave[id] = state;
          continue;
        }

        if (remoteSum !== state.checksum || localSum === null) {
          summary.updated++;
          summary.updatedIds.push(id);
          if (applyUpdates) {
            await this.writeLocal(target, remote);
            state.checksum = remoteSum;
            state.conflict = false;
            state.needsUpdate = false;
            if (this.settings.enableAfterInstall) await this.setEnabledState(target, true);
          } else {
            // Record that THIS snippet is behind so the settings list can show it.
            state.needsUpdate = true;
          }
        } else {
          state.needsUpdate = false;
          summary.unchanged++;
        }
        toSave[id] = state;
      }

      // Detect remote deletions: selected but no longer in manifest -> mark for removal on apply/update.
      for (const id of Object.keys(toSave)) {
        if (toSave[id].selected && !this.manifestEntry(manifest, id)) {
          summary.removed++;
          summary.removedIds.push(id);
          if (applyUpdates) {
            const target = toSave[id].file;
            const local = await this.readLocal(target);
            if (local !== null && checksum(local) === toSave[id].checksum) {
              await this.setEnabledState(target, false);
              await this.removeLocal(target);
            }
            delete toSave[id];
          }
        }
      }

      this.settings.snippets = toSave;
      this.settings.lastCheck = Date.now();
      this.settings.lastResult = `${manifest.name || this.settings.repo} ${manifest.version} (@${ref}) — ${summary.updated} update(s)${summary.updatedIds.length ? `: ${summary.updatedIds.join(", ")}` : ""}, ${summary.removed} removed, ${summary.conflicts} conflict(s)`;
      await this.saveSettings();

      if (this.settingsTab) {
        this.settingsTab.refreshSnippetSection();
        this.settingsTab.refreshStatus();
      }

      const n = summary.updated + summary.removed;
      const selected = Object.keys(toSave).filter((id) => toSave[id].selected).length;
      if (manual) {
        // User asked for feedback — never stay silent, even when nothing to do.
        if (n === 0) {
          new Notice(
            selected === 0
              ? "Snippet Sync\nUp to date. No snippets are installed — enable them in Settings to start syncing."
              : "Snippet Sync\nUp to date — nothing to update.",
          );
        } else {
          const names = [...summary.updatedIds, ...summary.removedIds].join(", ");
          new Notice(`Snippet Sync\n${n} snippet(s) ${applyUpdates ? "updated" : "need updating"}: ${names}${summary.conflicts ? ` (${summary.conflicts} conflicted)` : ""}`);
        }
      } else if (n > 0) {
        const names = [...summary.updatedIds, ...summary.removedIds].join(", ");
        new Notice(`Snippet Sync\n${n} snippet(s) ${applyUpdates ? "updated" : "need updating"}: ${names}${summary.conflicts ? ` (${summary.conflicts} conflicted)` : ""}`);
      }
      return summary;
    } catch (e) {
      console.error("Snippet Sync check failed", e);
      this.settings.lastCheck = Date.now();
      this.settings.lastResult = `Check failed: ${e.message}`;
      await this.saveSettings();
      if (this.settingsTab) {
        this.settingsTab.refreshSnippetSection();
        this.settingsTab.refreshStatus();
      }
      new Notice(`Snippet Sync\nCheck failed: ${e.message}`);
      return null;
    }
  }

  async selectSnippet(id, selected) {
    const ref = this.currentRef();
    const manifest = await this.fetchManifestRaw(ref);
    const entry = this.manifestEntry(manifest, id);
    if (!entry) return;
    const base = rawBase(this.settings.repo, this.settings.folder, ref);
    const target = String(entry.file).replace(/\.css$/i, "");
    const state = this.settings.snippets[id] || { id, file: target, selected: false, checksum: "", conflict: false };

    if (selected) {
      const remote = await this.fetchText(`${base}${entry.file}`);
      const remoteSum = checksum(remote);
      const local = await this.readLocal(target);
      const localSum = local === null ? null : checksum(local);
      if (localSum !== null && localSum !== remoteSum && localSum !== state.checksum) {
        new Notice(`Snippet Sync\n"${id}" exists locally and differs from the repo — not overwriting.`);
        return;
      }
      await this.writeLocal(target, remote);
      state.selected = true;
      state.checksum = remoteSum;
      state.conflict = false;
      state.needsUpdate = false;
      if (this.settings.enableAfterInstall) await this.setEnabledState(target, true);
    } else {
      state.selected = false;
      state.needsUpdate = false;
      // Only delete a file we own (matches what we installed); keep user edits.
      const local = await this.readLocal(target);
      if (local !== null && checksum(local) === state.checksum) {
        await this.setEnabledState(target, false);
        await this.removeLocal(target);
      } else if (local !== null) {
        await this.setEnabledState(target, false);
        new Notice(`Snippet Sync\nKept your edited "${id}.css" but disabled it.`);
      }
    }
    this.settings.snippets[id] = state;
    await this.saveSettings();
    if (this.settingsTab) this.settingsTab.refreshSnippetSection();
  }
}

class SnippetSyncSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.tokenRevealed = false;
    this.tokenVerified = undefined;
    this.tokenChecked = false;
    this.plugin.settingsTab = this;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Snippet Sync Settings" });
    containerEl.createEl("p", {
      text: "Install and auto-update CSS snippets from a GitHub repository. The repository must contain a manifest.json at the source folder's root listing every snippet.",
    });

    // ---- Repository source ----
    new Setting(containerEl)
      .setName("Repository")
      .setDesc("GitHub owner/repo (or full URL) holding the snippets manifest.")
      .addText((t) =>
        t.setPlaceholder("username/repository").setValue(this.plugin.settings.repo).onChange(async (v) => {
          this.plugin.settings.repo = scrubRepo(v);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Subfolder inside the repository (optional)")
      .setDesc("If the snippets live in a subfolder (e.g. mysnippets), type it here. Leave empty for the repo root.")
      .addText((t) =>
        t.setPlaceholder("").setValue(this.plugin.settings.folder).onChange(async (v) => {
          this.plugin.settings.folder = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    // ---- GitHub API token (optional, per-user, SecretStorage-backed) ----
    new Setting(containerEl)
      .setName("GitHub token (optional)")
      .setDesc("Authenticates GitHub requests so they use YOUR personal rate limit (5,000/hr) instead of the shared anonymous one (60/hr). The token is stored ONLY in Obsidian's SecretStorage keychain — never in this plugin's data file, never published. Each user pastes their own token here on their own machine.")
      .addButton((b) =>
        b
          .setButtonText("Create a token")
          .setTooltip("Opens GitHub's token creation page")
          .onClick(() => {
            try {
              window.open("https://github.com/settings/tokens/new?description=Snippet+Sync&scopes=", "_blank");
            } catch (e) {
              /* window.open may be blocked in some embedded contexts */
            }
          }),
      )
      .addButton((b) =>
        b.setButtonText("Check token").setTooltip("Validate the stored token against GitHub").onClick(async () => {
          await this.checkToken();
        }),
      );

    // Token status line (like BRAT's token validity display).
    this.tokenStatusEl = containerEl.createEl("span", {
      cls: "ss-token-status",
      text: this.tokenStatusText(),
    });
    if (this.plugin.hasToken() && !this.tokenChecked) {
      void this.checkToken(); // validate on first render
    }

    new Setting(containerEl)
      .setName("Token value")
      .setDesc(this.plugin.hasToken() ? "Stored securely. Shows only the tail; the eye reveals/hides the full value." : "Not set yet. Paste your GitHub personal access token here; it will be saved to the OS keychain via SecretStorage.")
      .addText((t) => {
        this.tokenInput = t;
        this.tokenInput.inputEl.type = "password"; // native asterisks while typing
        this.tokenInput.setPlaceholder("ghp_••••••••••••");
        if (this.plugin.hasToken()) {
          const tail = this.tokenTail();
          this.tokenInput.setValue(`ghp_••••••••••••${tail ? tail : ""}`);
        }
        this.tokenInput.onChange(async (v) => {
          if (!v) return;
          if (v.startsWith("ghp_•••")) return; // cosmetic mask, not a real paste
          await this.plugin.saveToken(v.trim());
          this.tokenRevealed = false;
          await this.checkToken();
        });
      })
      .addExtraButton((b) => {
        this.tokenEyeButton = b;
        b
          .setIcon(this.plugin.hasToken() ? "lucide-eye" : "lucide-eye-off")
          .setTooltip(this.plugin.hasToken() ? "Show/hide token" : "No token stored")
          .onClick(async () => {
            if (!this.plugin.hasToken()) return;
            this.tokenRevealed = !this.tokenRevealed;
            await this.applyTokenVisibility();
          });
      })
      .addExtraButton((b) =>
        b
          .setIcon("lucide-trash-2")
          .setTooltip("Remove stored token")
          .onClick(async () => {
            await this.plugin.deleteToken();
            this.tokenRevealed = false;
            this.refresh();
          }),
      );

    // ---- Update behavior (BRAT-flavored) ----
    new Setting(containerEl)
      .setName("Check for updates at startup")
      .setDesc("Check once, 60s after Obsidian starts (like BRAT).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.checkAtStartup).onChange(async (v) => {
          this.plugin.settings.checkAtStartup = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Check every")
      .setDesc("Periodic interval (BRAT has no timer; this plugin adds one). Set to Off for manual checks only.")
      .addDropdown((d) => {
        for (const [label, value] of [
          ["Off", 0],
          ["15 minutes", 15],
          ["30 minutes", 30],
          ["1 hour", 60],
          ["2 hours", 120],
          ["4 hours", 240],
        ])
          d.addOption(String(value), label);
        d.setValue(String(this.plugin.settings.intervalMinutes)).onChange(async (v) => {
          this.plugin.settings.intervalMinutes = Number(v);
          await this.plugin.saveSettings();
          this.refresh();
        });
      });

    new Setting(containerEl)
      .setName("Auto-update when found")
      .setDesc("Apply updates automatically. Off = notify you and let you apply via command/button or the per-snippet Update button.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoUpdate).onChange(async (v) => {
          this.plugin.settings.autoUpdate = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Enable after install")
      .setDesc("Turn the snippet on in Appearance as soon as it is installed.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableAfterInstall).onChange(async (v) => {
          this.plugin.settings.enableAfterInstall = v;
          await this.plugin.saveSettings();
        }),
      );

    // ---- Status + manual actions ----
    const statusRow = new Setting(containerEl).setName("Status");
    statusRow.setDesc(this.plugin.settings.lastResult || "No check yet.");
    this.statusRow = statusRow;
    statusRow.addButton((b) =>
      b.setButtonText("Check now").onClick(async () => {
        b.setDisabled(true);
        await this.plugin.checkForUpdates(false, true);
        b.setDisabled(false);
      }),
    );
    statusRow.addButton((b) =>
      b.setButtonText("Update all").setWarning().onClick(async () => {
        b.setDisabled(true);
        await this.plugin.checkForUpdates(true, true);
        b.setDisabled(false);
      }),
    );

    // ---- Per-snippet checklist (single list — one render call) ----
    this.snippetSectionEl = containerEl.createDiv();
    this.refreshSnippetSection();
  }

  refresh() {
    this.display();
  }

  refreshSnippetSection() {
    if (this.snippetSectionEl) void this.refreshSnippetList();
  }

  /** Update the Status row text so a manual check always shows its result. */
  refreshStatus() {
    if (this.statusRow) {
      this.statusRow.setDesc(this.plugin.settings.lastResult || "No check yet.");
    }
  }

  /**
   * Last 4 chars of the stored token for the masked display.
   * Returns "" when there is no token. Never returns more than the tail.
   */
  tokenTail() {
    const ss = this.app && this.app.secretStorage;
    if (!ss) return "";
    try {
      const v = ss.peekSecret(this.plugin.tokenSecretName());
      if (!v) return "";
      const s = String(v).trim();
      return s.length > 4 ? s.slice(-4) : s;
    } catch (e) {
      return "";
    }
  }

  /** Apply the current tokenRevealed state to the input (click-toggle, no timers). */
  async applyTokenVisibility() {
    if (!this.tokenInput) return;
    const reveal = this.tokenRevealed;
    if (reveal) {
      const real = await this.plugin.getTokenValue();
      if (real) {
        this.tokenInput.inputEl.type = "text";
        this.tokenInput.setValue(real);
        if (this.tokenEyeButton) this.tokenEyeButton.setIcon("lucide-eye-off").setTooltip("Hide token");
        return;
      }
      // No value to reveal -> revert toggle.
      this.tokenRevealed = false;
    }
    const tail = this.tokenTail();
    this.tokenInput.inputEl.type = "password";
    this.tokenInput.setValue(`ghp_••••••••••••${tail ? tail : ""}`);
    if (this.tokenEyeButton) this.tokenEyeButton.setIcon("lucide-eye").setTooltip("Show token");
  }

  /** Status text to render when no live check result exists yet. */
  tokenStatusText() {
    if (!this.plugin.hasToken()) return "No token stored.";
    if (this.tokenVerified === undefined) return "Token stored — checking validity\u2026";
    if (this.tokenVerified.ok) {
      const core = this.tokenVerified.core || {};
      const remaining = typeof core.remaining === "number" ? core.remaining : "?";
      const limit = typeof core.limit === "number" ? core.limit : "?";
      const reset = core.reset ? new Date(core.reset * 1000).toLocaleTimeString() : "";
      return `Valid token — ${remaining}/${limit} requests remaining${reset ? `, resets ${reset}` : ""}.`;
    }
    if (this.tokenVerified.status === 401) return "Token rejected by GitHub (401) — paste a new one.";
    return `Token check failed (${this.tokenVerified.status || "error"}) — see details.`;
  }

  /** Validate this user's stored token against GitHub's rate_limit endpoint (like BRAT validates). */
  async checkToken() {
    if (!this.plugin.hasToken()) {
      this.tokenVerified = null;
      if (this.tokenStatusEl) this.tokenStatusEl.setText("No token stored.");
      return;
    }
    if (this.tokenStatusEl) this.tokenStatusEl.setText("Checking token\u2026");
    const result = await this.plugin.verifyToken();
    this.tokenVerified = result;
    this.tokenChecked = true;
    if (this.tokenStatusEl) {
      this.tokenStatusEl.setText(this.tokenStatusText());
      this.tokenStatusEl.removeClass("ss-token-ok", "ss-token-bad");
      if (result && result.ok) this.tokenStatusEl.addClass("ss-token-ok");
      else if (result && (result.status === 401 || result.status === 403)) this.tokenStatusEl.addClass("ss-token-bad");
      else if (result && result.status !== 200) this.tokenStatusEl.addClass("ss-token-bad");
    }
    return result;
  }

  async refreshSnippetList() {
    const el = this.snippetSectionEl;
    if (!el) return;
    el.empty();
    el.createEl("h3", { text: "Snippets from this repository" });
    el.createEl("p", { cls: "setting-item-description", text: "Check a snippet to install and enable it. Uncheck to remove it (your own edits to the file are kept). Changes are saved — you can come back later and change your mind." });

    let manifest = null;
    try {
      if (!this.plugin.settings.repo) {
        el.createEl("p", { text: "Enter a repository above to see its snippets." });
        return;
      }
      manifest = await this.plugin.fetchManifestRaw();
    } catch (e) {
      el.createEl("p", { text: `Could not read manifest.json: ${e.message}` });
      return;
    }

    if (manifest) {
      el.createEl("p", {
        cls: "ss-source-line",
        text: `Source: ${manifest.name || this.plugin.settings.repo} · version ${manifest.version} · @${manifest.ref}${this.plugin.settings.folder ? ` · folder: ${this.plugin.settings.folder}` : ""}`,
      });
    }

    for (const entry of manifest.snippets) {
      const id = String(entry.id);
      const target = String(entry.file || "").replace(/\.css$/i, "");
      const state = this.plugin.settings.snippets[id] || { id, file: target, selected: false, checksum: "", conflict: false };
      const row = new Setting(el).setName(id).setDesc(entry.description || entry.file || "");

      row.addToggle((t) =>
        t.setValue(!!state.selected).onChange(async (v) => {
          await this.plugin.selectSnippet(id, v);
        }),
      );

      // Per-snippet update button — only when there is something to apply.
      if (state.selected && state.needsUpdate && !state.conflict) {
        row.addExtraButton((b) =>
          b
            .setIcon("lucide-download")
            .setTooltip(`Update ${id}`)
            .onClick(async () => {
              await this.plugin.selectSnippet(id, true);
            }),
        );
      }

      // Status badge text.
      const badge = row.settingEl.createSpan({ cls: "ss-badge" });
      if (state.conflict) {
        badge.setText("conflict");
        badge.addClass("ss-badge-conflict");
      } else if (state.needsUpdate) {
        badge.setText("update available");
        badge.addClass("ss-badge-update");
      } else if (state.selected) badge.setText("installed");
      else badge.setText("available");
    }
  }
}

module.exports = SnippetSyncPlugin;
