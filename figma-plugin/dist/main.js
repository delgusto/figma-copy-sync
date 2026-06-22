"use strict";
(() => {
  var __async = (__this, __arguments, generator) => {
    return new Promise((resolve, reject) => {
      var fulfilled = (value) => {
        try {
          step(generator.next(value));
        } catch (e) {
          reject(e);
        }
      };
      var rejected = (value) => {
        try {
          step(generator.throw(value));
        } catch (e) {
          reject(e);
        }
      };
      var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
      step((generator = generator.apply(__this, __arguments)).next());
    });
  };

  // figma-plugin/src/main.ts
  var PLUGIN_DATA_KEY_SELECTION = "copyCollections";
  var PLUGIN_DATA_KEY_PAGES = "copyPages";
  var CLIENT_STORAGE_KEY_TEAM = "copyTeamSettings";
  var SKIP_PREFIX = "[skip]";
  var EMPTY_TEAM_SETTINGS = { templates: [], defaultTemplateId: null };
  function loadTeamSettings() {
    return __async(this, null, function* () {
      let settings = EMPTY_TEAM_SETTINGS;
      try {
        const raw = yield figma.clientStorage.getAsync(CLIENT_STORAGE_KEY_TEAM);
        if (raw && typeof raw === "object" && Array.isArray(raw.templates)) {
          settings = raw;
        }
      } catch (e) {
      }
      postToUi({ type: "team-settings", settings });
    });
  }
  function saveTeamSettings(settings) {
    return __async(this, null, function* () {
      try {
        yield figma.clientStorage.setAsync(CLIENT_STORAGE_KEY_TEAM, settings);
      } catch (e) {
        postToUi({ type: "toast", level: "error", text: "Could not save team settings" });
      }
    });
  }
  figma.showUI(__html__, { width: 400, height: 700, themeColors: true });
  function postToUi(msg) {
    figma.ui.postMessage(msg);
  }
  function getCollectionsWithStringVars() {
    return __async(this, null, function* () {
      const collections = yield figma.variables.getLocalVariableCollectionsAsync();
      const result = [];
      for (const col of collections) {
        let count = 0;
        for (const varId of col.variableIds) {
          const v = yield figma.variables.getVariableByIdAsync(varId);
          if (v && v.resolvedType === "STRING") count++;
        }
        if (count > 0) {
          result.push({
            id: col.id,
            name: col.name,
            stringVariableCount: count,
            isCopyByDefault: col.name.toLowerCase().startsWith("copy")
          });
        }
      }
      return result.sort((a, b) => a.name.localeCompare(b.name));
    });
  }
  function readPersistedSelection() {
    const raw = figma.root.getPluginData(PLUGIN_DATA_KEY_SELECTION);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : null;
    } catch (_e) {
      return null;
    }
  }
  function persistSelection(ids) {
    figma.root.setPluginData(PLUGIN_DATA_KEY_SELECTION, JSON.stringify(ids));
  }
  function readPersistedPageSelection() {
    const raw = figma.root.getPluginData(PLUGIN_DATA_KEY_PAGES);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : null;
    } catch (_e) {
      return null;
    }
  }
  function persistPageSelection(ids) {
    figma.root.setPluginData(PLUGIN_DATA_KEY_PAGES, JSON.stringify(ids));
  }
  function getPageInfos() {
    return figma.root.children.filter((n) => n.type === "PAGE").map((p) => ({
      id: p.id,
      name: p.name,
      frameCount: p.children.filter(
        (c) => c.type === "FRAME" || c.type === "COMPONENT" || c.type === "COMPONENT_SET" || c.type === "INSTANCE"
      ).length
    }));
  }
  function pushInit() {
    return __async(this, null, function* () {
      try {
        const collections = yield getCollectionsWithStringVars();
        const pages = getPageInfos();
        postToUi({
          type: "init",
          collections,
          pages,
          persistedSelection: readPersistedSelection(),
          persistedPageSelection: readPersistedPageSelection()
        });
      } catch (err) {
        postToUi({ type: "toast", level: "error", text: `Failed to read variables: ${stringifyError(err)}` });
      }
    });
  }
  pushInit();
  var refreshTimer = null;
  figma.on("documentchange", () => {
    if (refreshTimer != null) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      pushInit();
    }, 800);
  });
  function findTopLevelFrame(node) {
    let cur = node;
    while (cur && cur.parent) {
      if (cur.parent.type === "PAGE") {
        return cur.type === "FRAME" || cur.type === "COMPONENT" || cur.type === "COMPONENT_SET" || cur.type === "INSTANCE" ? cur : null;
      }
      cur = cur.parent;
    }
    return null;
  }
  function findNearestParentFrame(node) {
    let cur = node.parent;
    let closestInstance = null;
    while (cur) {
      if (cur.type === "PAGE") break;
      if (cur.type === "INSTANCE" && !closestInstance) {
        closestInstance = cur;
      }
      cur = cur.parent;
    }
    if (closestInstance) return closestInstance;
    cur = node.parent;
    while (cur) {
      if (cur.type === "PAGE") return null;
      if (cur.type === "FRAME" || cur.type === "COMPONENT" || cur.type === "COMPONENT_SET") {
        return cur;
      }
      cur = cur.parent;
    }
    return null;
  }
  function buildBindings(selectedVarIds, selectedPageIds) {
    return __async(this, null, function* () {
      var _a;
      const bindings = [];
      const seen = /* @__PURE__ */ new Set();
      function pushBinding(variableId, node, topFrame, parentFrame) {
        const key = `${variableId}::${node.id}`;
        if (seen.has(key)) return;
        seen.add(key);
        bindings.push({ variableId, node, topFrame, parentFrame });
      }
      const pages = figma.root.children.filter(
        (n) => n.type === "PAGE" && selectedPageIds.has(n.id)
      );
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        postToUi({
          type: "progress",
          phase: "scanning",
          current: i + 1,
          total: pages.length,
          label: `Scanning "${page.name}"\u2026`
        });
        yield page.loadAsync();
        const textNodes = page.findAllWithCriteria({ types: ["TEXT"] });
        for (const node of textNodes) {
          const bound = node.boundVariables;
          if (!bound) continue;
          const chars = bound.characters;
          if (!chars) continue;
          const aliases = Array.isArray(chars) ? chars : [chars];
          for (const alias of aliases) {
            if (!alias || !alias.id) continue;
            if (!selectedVarIds.has(alias.id)) continue;
            const topFrame = findTopLevelFrame(node);
            if (!topFrame) continue;
            const parent = findNearestParentFrame(node);
            pushBinding(alias.id, node, topFrame, parent || topFrame);
          }
        }
        const instances = page.findAllWithCriteria({ types: ["INSTANCE"] });
        for (const instance of instances) {
          const props = instance.componentProperties;
          if (!props) continue;
          for (const [propKey, prop] of Object.entries(props)) {
            if (prop.type !== "TEXT") continue;
            const varAlias = (_a = prop.boundVariables) == null ? void 0 : _a.value;
            if (!(varAlias == null ? void 0 : varAlias.id) || !selectedVarIds.has(varAlias.id)) continue;
            const innerText = instance.findAllWithCriteria({ types: ["TEXT"] });
            for (const textNode of innerText) {
              const refs = textNode.componentPropertyReferences;
              if (!refs || refs.characters !== propKey) continue;
              const topFrame = findTopLevelFrame(textNode);
              if (!topFrame) continue;
              const parent = findNearestParentFrame(textNode);
              pushBinding(varAlias.id, textNode, topFrame, parent || topFrame);
            }
          }
        }
        for (const instance of instances) {
          let mainComp = null;
          try {
            mainComp = yield instance.getMainComponentAsync();
          } catch (_e) {
            continue;
          }
          if (!mainComp) continue;
          const compTextNodes = mainComp.findAllWithCriteria({ types: ["TEXT"] });
          for (const compNode of compTextNodes) {
            const bound = compNode.boundVariables;
            if (!bound) continue;
            const chars = bound.characters;
            if (!chars) continue;
            const aliases = Array.isArray(chars) ? chars : [chars];
            for (const alias of aliases) {
              if (!(alias == null ? void 0 : alias.id) || !selectedVarIds.has(alias.id)) continue;
              const instanceTextNodes = instance.findAllWithCriteria({ types: ["TEXT"] });
              const match = instanceTextNodes.find((t) => t.name === compNode.name);
              const targetNode = match || instance;
              const topFrame = findTopLevelFrame(targetNode);
              if (!topFrame) continue;
              const parent = findNearestParentFrame(targetNode);
              pushBinding(alias.id, targetNode, topFrame, parent || topFrame);
            }
          }
        }
      }
      return bindings;
    });
  }
  function sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9._\- ]/g, "_").replace(/\s+/g, "_").slice(0, 100);
  }
  function exportFrames(frames, bindings, varNameById, exportScale) {
    return __async(this, null, function* () {
      const nameCounts = /* @__PURE__ */ new Map();
      for (const f of frames) nameCounts.set(f.name, (nameCounts.get(f.name) || 0) + 1);
      const nameByFrameId = /* @__PURE__ */ new Map();
      const usedDisplay = /* @__PURE__ */ new Set();
      for (const f of frames) {
        const collide = (nameCounts.get(f.name) || 0) > 1;
        const pageName = f.parent && f.parent.type === "PAGE" ? f.parent.name : "";
        const base = collide && pageName ? `${f.name} (${pageName})` : f.name;
        let candidate = base;
        let n = 2;
        while (usedDisplay.has(candidate)) {
          candidate = `${base} #${n}`;
          n++;
        }
        usedDisplay.add(candidate);
        nameByFrameId.set(f.id, candidate);
      }
      const out = [];
      const usedFilenames = /* @__PURE__ */ new Set();
      let i = 0;
      for (const frame of frames) {
        i++;
        postToUi({
          type: "progress",
          phase: "exporting-frames",
          current: i,
          total: frames.length,
          label: frame.name
        });
        const baseFilename = sanitizeFilename(frame.name) || `frame_${frame.id.replace(/[^a-zA-Z0-9]/g, "")}`;
        let candidate = `${baseFilename}.png`;
        let n = 2;
        while (usedFilenames.has(candidate)) {
          candidate = `${baseFilename}_${n}.png`;
          n++;
        }
        usedFilenames.add(candidate);
        const bytes = yield frame.exportAsync({
          format: "PNG",
          constraint: { type: "SCALE", value: exportScale }
        });
        const frameBox = frame.absoluteBoundingBox;
        const rects = [];
        if (frameBox) {
          for (const b of bindings) {
            if (b.topFrame.id !== frame.id && b.parentFrame.id !== frame.id) continue;
            const nb = b.node.absoluteBoundingBox;
            if (!nb) continue;
            const x = Math.max(0, nb.x - frameBox.x);
            const y = Math.max(0, nb.y - frameBox.y);
            const right = Math.min(frameBox.width, nb.x + nb.width - frameBox.x);
            const bottom = Math.min(frameBox.height, nb.y + nb.height - frameBox.y);
            const w = Math.max(0, right - x);
            const h = Math.max(0, bottom - y);
            if (w === 0 || h === 0) continue;
            rects.push({
              variableId: b.variableId,
              variableName: varNameById.get(b.variableId) || b.variableId,
              x: x * exportScale,
              y: y * exportScale,
              w: w * exportScale,
              h: h * exportScale
            });
          }
        }
        out.push({
          filename: candidate,
          name: nameByFrameId.get(frame.id) || frame.name,
          pageName: frame.parent && frame.parent.type === "PAGE" ? frame.parent.name : "",
          bytes,
          width: frameBox ? Math.round(frameBox.width * exportScale) : 0,
          height: frameBox ? Math.round(frameBox.height * exportScale) : 0,
          rects
        });
      }
      return { pngs: out, nameByFrameId };
    });
  }
  function leafName(fullName) {
    const idx = fullName.lastIndexOf("/");
    return idx === -1 ? fullName : fullName.slice(idx + 1);
  }
  function groupOf(fullName) {
    const idx = fullName.lastIndexOf("/");
    return idx === -1 ? "" : fullName.slice(0, idx);
  }
  function runExport(selectedCollectionIds, selectedPageIds, exportScale) {
    return __async(this, null, function* () {
      try {
        if (selectedCollectionIds.length === 0) {
          postToUi({ type: "toast", level: "error", text: "Pick at least one collection to export." });
          return;
        }
        if (selectedPageIds.length === 0) {
          postToUi({ type: "toast", level: "error", text: "Pick at least one page to export." });
          return;
        }
        persistSelection(selectedCollectionIds);
        persistPageSelection(selectedPageIds);
        postToUi({ type: "progress", phase: "scanning", current: 0, total: 0, label: "Reading variables\u2026" });
        const collectionById = /* @__PURE__ */ new Map();
        for (const colId of selectedCollectionIds) {
          const col = yield figma.variables.getVariableCollectionByIdAsync(colId);
          if (col) collectionById.set(colId, col);
        }
        const modeOrder = [];
        const seenModes = /* @__PURE__ */ new Set();
        for (const col of collectionById.values()) {
          for (const m of col.modes) {
            if (!seenModes.has(m.name)) {
              seenModes.add(m.name);
              modeOrder.push(m.name);
            }
          }
        }
        const allVars = yield figma.variables.getLocalVariablesAsync("STRING");
        const selectedVars = allVars.filter(
          (v) => collectionById.has(v.variableCollectionId) && !v.description.trim().toLowerCase().startsWith(SKIP_PREFIX)
        );
        if (selectedVars.length === 0) {
          postToUi({ type: "toast", level: "info", text: "No copy variables found in the selected collections." });
          return;
        }
        const selectedIds = new Set(selectedVars.map((v) => v.id));
        const varNameById = new Map(selectedVars.map((v) => [v.id, v.name]));
        const bindings = yield buildBindings(selectedIds, new Set(selectedPageIds));
        const bindingsByVar = /* @__PURE__ */ new Map();
        for (const b of bindings) {
          if (!bindingsByVar.has(b.variableId)) bindingsByVar.set(b.variableId, []);
          bindingsByVar.get(b.variableId).push(b);
        }
        const allFrames = /* @__PURE__ */ new Map();
        for (const b of bindings) {
          allFrames.set(b.topFrame.id, b.topFrame);
          allFrames.set(b.parentFrame.id, b.parentFrame);
        }
        const framesSorted = Array.from(allFrames.values()).sort((a, b) => a.name.localeCompare(b.name));
        const exportResult = framesSorted.length ? yield exportFrames(framesSorted, bindings, varNameById, exportScale) : { pngs: [], nameByFrameId: /* @__PURE__ */ new Map() };
        const { pngs: framePngs, nameByFrameId } = exportResult;
        const entries = selectedVars.map((v) => {
          const col = collectionById.get(v.variableCollectionId);
          const defaultMode = col.modes.find((m) => m.modeId === col.defaultModeId);
          const values = {};
          for (const m of col.modes) {
            const raw = v.valuesByMode[m.modeId];
            values[m.name] = typeof raw === "string" ? raw : "";
          }
          const varBindings = bindingsByVar.get(v.id) || [];
          const seen = /* @__PURE__ */ new Set();
          const occurrences = [];
          for (const b of varBindings) {
            const key = `${b.topFrame.id}|${b.parentFrame.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            occurrences.push({
              topFrameName: nameByFrameId.get(b.topFrame.id) || b.topFrame.name,
              parentFrameName: nameByFrameId.get(b.parentFrame.id) || b.parentFrame.name
            });
          }
          occurrences.sort(
            (a, b) => a.topFrameName.localeCompare(b.topFrameName) || a.parentFrameName.localeCompare(b.parentFrameName)
          );
          const frameNames = Array.from(new Set(occurrences.map((o) => o.topFrameName))).sort((a, b) => a.localeCompare(b));
          return {
            id: v.name,
            name: leafName(v.name),
            fullName: v.name,
            group: groupOf(v.name),
            description: v.description || "",
            collectionName: col.name,
            defaultModeName: defaultMode ? defaultMode.name : col.modes[0] ? col.modes[0].name : "",
            values,
            frames: frameNames,
            occurrences
          };
        });
        entries.sort((a, b) => {
          const c = a.collectionName.localeCompare(b.collectionName);
          if (c !== 0) return c;
          const g = a.group.localeCompare(b.group);
          if (g !== 0) return g;
          return a.name.localeCompare(b.name);
        });
        postToUi({ type: "progress", phase: "building-bundle", current: 1, total: 1 });
        const payload = {
          fileName: figma.root.name,
          fileKey: figma.fileKey || "",
          exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
          modes: modeOrder,
          variables: entries,
          frames: framePngs
        };
        postToUi({ type: "export-result", payload });
      } catch (err) {
        console.error(err);
        postToUi({ type: "toast", level: "error", text: `Export failed: ${stringifyError(err)}` });
      }
    });
  }
  function stringifyError(e) {
    if (e instanceof Error) return e.message;
    if (typeof e === "string") return e;
    try {
      return JSON.stringify(e);
    } catch (_err) {
      return String(e);
    }
  }
  function runImport(updates) {
    return __async(this, null, function* () {
      try {
        const allVars = yield figma.variables.getLocalVariablesAsync("STRING");
        const varMap = new Map(allVars.map((v) => [v.name, v]));
        const collectionCache = /* @__PURE__ */ new Map();
        let updated = 0;
        const skippedNames = [];
        const modeErrors = [];
        for (const update of updates) {
          const variable = varMap.get(update.variableName);
          if (!variable) {
            skippedNames.push(update.variableName);
            continue;
          }
          let collection = collectionCache.get(variable.variableCollectionId);
          if (!collection) {
            const c = yield figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
            if (!c) {
              skippedNames.push(update.variableName);
              continue;
            }
            collection = c;
            collectionCache.set(variable.variableCollectionId, c);
          }
          let wroteAny = false;
          for (const [modeName, value] of Object.entries(update.modeValues)) {
            const mode = collection.modes.find((m) => m.name === modeName);
            if (!mode) {
              const msg = `"${modeName}" not in collection "${collection.name}"`;
              if (!modeErrors.includes(msg)) modeErrors.push(msg);
              continue;
            }
            variable.setValueForMode(mode.modeId, value);
            wroteAny = true;
          }
          if (wroteAny) updated++;
        }
        const parts = [`Updated ${updated} variable${updated === 1 ? "" : "s"}`];
        if (skippedNames.length > 0) parts.push(`${skippedNames.length} not found`);
        if (modeErrors.length > 0) parts.push(`${modeErrors.length} mode warning${modeErrors.length === 1 ? "" : "s"}`);
        postToUi({
          type: "toast",
          level: updated > 0 ? "success" : "info",
          text: parts.join(" \xB7 ")
        });
        postToUi({ type: "import-result", updated, skippedNames, modeErrors });
      } catch (err) {
        postToUi({ type: "toast", level: "error", text: `Import failed: ${stringifyError(err)}` });
        postToUi({ type: "import-result", updated: 0, skippedNames: [], modeErrors: [stringifyError(err)] });
      }
    });
  }
  figma.ui.onmessage = (msg) => {
    if (msg.type === "export") {
      runExport(msg.selectedCollectionIds, msg.selectedPageIds, msg.exportScale);
      return;
    }
    if (msg.type === "persist-selection") {
      persistSelection(msg.selectedCollectionIds);
      return;
    }
    if (msg.type === "persist-page-selection") {
      persistPageSelection(msg.selectedPageIds);
      return;
    }
    if (msg.type === "refresh") {
      pushInit();
      return;
    }
    if (msg.type === "load-team-settings") {
      loadTeamSettings();
      return;
    }
    if (msg.type === "save-team-settings") {
      saveTeamSettings(msg.settings);
      return;
    }
    if (msg.type === "import") {
      runImport(msg.updates);
      return;
    }
    if (msg.type === "cancel") {
      figma.closePlugin();
      return;
    }
  };
})();
