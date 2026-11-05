// Forwards page messages to the Still layer of the window that owns the tab.
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, { StillShared: "resource://still/StillShared.sys.mjs" });

export class StillPageParent extends JSWindowActorParent {
  // Messages come from website processes, so only known shapes pass.
  receiveMessage(message) {
    const { name, data } = message;
    if (name === "Still:Favicons") {
      // Only Still's own extension page may ask; checked here in the parent.
      if (this.manager?.documentPrincipal?.addonId !== "still-prototype@tim.local") return {};
      const urls = Array.isArray(data?.urls) ? data.urls.filter((url) => /^https?:\/\//i.test(url)).slice(0, 80) : [];
      return lazy.StillShared.faviconsFor(urls);
    }
    const valid = (name === "Still:PageReady")
      || (name === "Still:Key" && ["dock-show", "dock-release"].includes(data?.action))
      || (name === "Still:Wheel" && ["slots", "dock"].includes(data?.kind) && [1, -1].includes(data?.direction))
      || (name === "Still:PageColor" && /^rgba?\([\d.,\s]+\)$/.test(data?.color || ""));
    if (!valid) return;
    lazy.StillShared.pageMessage(this.browsingContext.top?.embedderElement, name, data);
  }
}
