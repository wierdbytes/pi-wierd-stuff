import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The read-only part of Pi's public footer-data API that this bridge needs. */
interface StatusSource {
  getExtensionStatuses(): ReadonlyMap<string, string>;
}

/**
 * Reuse pi-quotas' published status rather than polling providers ourselves.
 * Pi exposes extension statuses to footer factories only. While hiding the
 * standard footer, retain its live data source for the statusline widget.
 * When the standard footer is restored, it owns quota display again.
 */
export class QuotaStatus {
  private source: StatusSource | undefined;

  getText(): string {
    return this.source?.getExtensionStatuses().get("pi-quotas-usage") ?? "";
  }

  hideFooter(ctx: ExtensionContext): void {
    ctx.ui.setFooter((_tui, _theme, source) => {
      this.source = source;
      return {
        render: () => [],
        invalidate() {},
        dispose: () => { this.clear(); },
      };
    });
  }

  clear(): void {
    this.source = undefined;
  }
}
