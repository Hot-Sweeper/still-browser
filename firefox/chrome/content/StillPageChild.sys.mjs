// Runs in each tab's top-level page. Reports when a new page is ready to be
// shown (for the back/forward slide) and when the Ctrl+Alt dock chord is held.
// It reads no page content.
export class StillPageChild extends JSWindowActorChild {
  // The page's own background colour, so Still can paint it behind the page
  // (window resizing, edge bumps) instead of Firefox's grey.
  reportColor() {
    try {
      const win = this.contentWindow;
      const doc = this.document;
      if (!win || !doc?.documentElement) return;
      const transparent = (color) => !color || color === "transparent" || /rgba\([^)]*,\s*0\)$/.test(color);
      let color = win.getComputedStyle(doc.documentElement).backgroundColor;
      if (transparent(color) && doc.body) color = win.getComputedStyle(doc.body).backgroundColor;
      if (transparent(color)) {
        const scheme = win.getComputedStyle(doc.documentElement).colorScheme || "";
        const dark = scheme.includes("dark") && win.matchMedia("(prefers-color-scheme: dark)").matches;
        color = dark ? "rgb(28, 27, 34)" : "rgb(255, 255, 255)";
      }
      if (color !== this.lastColor) {
        this.lastColor = color;
        this.sendAsyncMessage("Still:PageColor", { color });
      }
    } catch {}
  }

  // Still's start page asks for site icons for its results. Requests from any
  // other page are ignored (they could otherwise probe your history).
  async answerFavicons(event) {
    const principal = this.document?.nodePrincipal;
    if (principal?.addonId !== "still-prototype@tim.local") return;
    let urls = [];
    try { urls = JSON.parse(String(event.detail || "[]")).filter((url) => typeof url === "string").slice(0, 80); } catch { return; }
    let icons = {};
    try { icons = await this.sendQuery("Still:Favicons", { urls }); } catch { return; }
    const win = this.contentWindow;
    if (!win) return;
    win.dispatchEvent(new win.CustomEvent("still-favicons", { detail: Cu.cloneInto(JSON.stringify(icons || {}), win) }));
  }

  receiveMessage(message) {
    if (message.name === "Still:Color") {
      this.lastColor = null;
      this.reportColor();
      return { color: this.lastColor, events: this.events || 0 };
    }
    return null;
  }

  handleEvent(event) {
    this.events = (this.events || 0) + 1;
    switch (event.type) {
      case "DOMContentLoaded":
        if (event.target === this.document) {
          this.sendAsyncMessage("Still:PageReady", { kind: "dom" });
          this.reportColor();
        }
        break;
      case "load":
        // Many sites (YouTube) switch theme from script; check again later.
        this.reportColor();
        this.contentWindow?.setTimeout(() => this.reportColor(), 1500);
        break;
      case "pageshow":
        if (event.target === this.document) {
          this.sendAsyncMessage("Still:PageReady", { kind: "show", persisted: event.persisted });
          this.reportColor();
        }
        break;
      case "still-favicons-request":
        this.answerFavicons(event);
        break;
      case "keydown":
        if (!event.metaKey && !event.shiftKey
            && ((event.key === "Alt" && event.ctrlKey) || (event.key === "Control" && event.altKey))) {
          this.sendAsyncMessage("Still:Key", { action: "dock-show" });
        }
        break;
      case "keyup":
        if (event.key === "Alt" || event.key === "Control") this.sendAsyncMessage("Still:Key", { action: "dock-release" });
        break;
      case "wheel": {
        if (!event.ctrlKey || event.metaKey || !event.deltaY) break;
        // Native Ctrl+wheel is disabled in still.cfg. Keep this passive so
        // normal wheel scrolling stays on the compositor.
        // Lines and pages count as whole notches; pixel deltas (touchpads,
        // smooth wheels) add up until they make one.
        const now = event.timeStamp;
        if (now - (this.wheelAt || 0) > 220 || Math.sign(this.wheelSum || 0) !== Math.sign(event.deltaY)) this.wheelSum = 0;
        this.wheelAt = now;
        const notch = event.deltaMode === 0 ? event.deltaY / 100 : Math.sign(event.deltaY);
        this.wheelSum = (this.wheelSum || 0) + notch;
        while (Math.abs(this.wheelSum) >= 0.999) {
          const direction = Math.sign(this.wheelSum);
          this.wheelSum -= direction;
          this.sendAsyncMessage("Still:Wheel", { kind: event.altKey ? "dock" : "slots", direction });
        }
        break;
      }
    }
  }
}
