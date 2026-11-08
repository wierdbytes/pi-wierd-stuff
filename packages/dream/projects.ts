/**
 * Which project a session was really about.
 *
 * pi is often started in a workspace folder (`~/me/dev`, `~`) while the work
 * happens in a project below it. Every session's cwd resolves to a project
 * root; a root that contains other known roots is a "workspace" (broad).
 * A session's primary project is its own cwd project unless that is a
 * workspace — then it is the project whose files the session touched most.
 * Only real projects (git repos or folders with project markers) attract a
 * session; working with files in ~/Downloads, ~/.pi/agent or /tmp does not
 * make them a project.
 */

export interface KnownRoot {
	root: string;
	key: string;
	/** Contains other known project roots (e.g. ~/me/dev, ~). */
	broad: boolean;
	/** A real project (git repo or project markers); only these attract sessions by touched files. */
	project: boolean;
}

export class ProjectMap {
	/** Deepest roots first, so the first prefix match is the most specific project. */
	readonly roots: KnownRoot[];
	private byKey = new Map<string, KnownRoot>();

	constructor(entries: Iterable<{ root: string; key: string; project?: boolean }>) {
		const byRoot = new Map<string, { key: string; project: boolean }>();
		for (const e of entries) if (e.root && e.key && e.root !== "/") byRoot.set(e.root.replace(/\/+$/, ""), { key: e.key, project: e.project ?? true });
		const roots: KnownRoot[] = [...byRoot.entries()].map(([root, v]) => ({ root, key: v.key, project: v.project, broad: false }));
		for (const r of roots) r.broad = roots.some((o) => o !== r && o.root.startsWith(`${r.root}/`));
		roots.sort((a, b) => b.root.length - a.root.length);
		this.roots = roots;
		for (const r of roots) if (!this.byKey.has(r.key) || !r.broad) this.byKey.set(r.key, r);
	}

	/** The most specific known project containing `path`. */
	projectOf(path: string): KnownRoot | undefined {
		return this.roots.find((r) => path === r.root || path.startsWith(`${r.root}/`));
	}

	rootOf(key: string): KnownRoot | undefined {
		return this.byKey.get(key);
	}

	isBroad(key: string): boolean {
		return this.byKey.get(key)?.broad ?? false;
	}

	/** An existing, specific project a note can live in. */
	isProject(key: string): boolean {
		const r = this.byKey.get(key);
		return !!r && r.project && !r.broad;
	}

	/** Specific (non-workspace) real projects touched by `paths`, most used first. */
	touched(paths: ReadonlyArray<readonly [string, number]>): Array<{ key: string; n: number }> {
		const counts = new Map<string, number>();
		for (const [p, n] of paths) {
			const r = this.projectOf(p);
			if (r && !r.broad && r.project) counts.set(r.key, (counts.get(r.key) ?? 0) + n);
		}
		return [...counts.entries()].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n);
	}

	/** Primary project of a session: its cwd project, unless that is a workspace folder. */
	primary(cwdKey: string, paths: ReadonlyArray<readonly [string, number]>): { key: string; touched: Array<{ key: string; n: number }>; workspace: boolean } {
		const touched = this.touched(paths);
		const workspace = this.isBroad(cwdKey);
		if (!workspace) return { key: cwdKey, touched, workspace };
		return { key: touched[0]?.key ?? cwdKey, touched, workspace };
	}
}
