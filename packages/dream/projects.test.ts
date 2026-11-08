import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { callPaths, expandPath } from "./digest.ts";
import { looksLikeProject } from "./project.ts";
import { ProjectMap } from "./projects.ts";

const H = homedir();
const map = new ProjectMap([
	{ root: H, key: `local:${H}` },
	{ root: `${H}/me/dev`, key: `local:${H}/me/dev` },
	{ root: `${H}/me/dev/pushemoji`, key: `local:${H}/me/dev/pushemoji` },
	{ root: `${H}/me/dev/pi-wierd-stuff`, key: "github.com/wierdbytes/pi-wierd-stuff" },
	{ root: `${H}/.config/herdr-app`, key: `local:${H}/.config/herdr-app` },
	{ root: `${H}/Downloads`, key: `local:${H}/Downloads`, project: false },
]);

describe("project map", () => {
	it("marks workspace folders that contain other projects", () => {
		expect(map.isBroad(`local:${H}/me/dev`)).toBe(true);
		expect(map.isBroad(`local:${H}`)).toBe(true);
		expect(map.isBroad(`local:${H}/me/dev/pushemoji`)).toBe(false);
	});

	it("finds the most specific project of a path", () => {
		expect(map.projectOf(`${H}/me/dev/pushemoji/src/x.svg`)?.key).toBe(`local:${H}/me/dev/pushemoji`);
		expect(map.projectOf(`${H}/me/dev/other/file`)?.key).toBe(`local:${H}/me/dev`);
		expect(map.projectOf("/tmp/x")).toBeUndefined();
	});

	it("picks the touched project for sessions started in a workspace folder", () => {
		const paths: Array<[string, number]> = [
			[`${H}/me/dev/pushemoji/src/a.svg`, 5],
			[`${H}/me/dev/pi-wierd-stuff/AGENTS.md`, 1],
			[`${H}/Downloads/x.png`, 9],
		];
		const p = map.primary(`local:${H}/me/dev`, paths);
		expect(p.workspace).toBe(true);
		expect(p.key).toBe(`local:${H}/me/dev/pushemoji`);
		expect(p.touched.map((t) => t.key)).toEqual([`local:${H}/me/dev/pushemoji`, "github.com/wierdbytes/pi-wierd-stuff"]);
		// a session in a real project stays there
		expect(map.primary("github.com/wierdbytes/pi-wierd-stuff", paths).key).toBe("github.com/wierdbytes/pi-wierd-stuff");
		// plain folders (Downloads) never attract a session; nothing specific touched: stays with the cwd
		expect(map.primary(`local:${H}`, [[`${H}/Downloads/a`, 3]]).key).toBe(`local:${H}`);
		expect(map.isProject(`local:${H}/Downloads`)).toBe(false);
		expect(map.isProject(`local:${H}/me/dev`)).toBe(false);
		expect(map.isProject(`local:${H}/me/dev/pushemoji`)).toBe(true);
	});

	it("recognizes project folders by their markers", () => {
		const dir = mkdtempSync(join(tmpdir(), "dream-proj-"));
		mkdirSync(join(dir, "plain"));
		mkdirSync(join(dir, "withpi", ".pi"), { recursive: true });
		mkdirSync(join(dir, "node"));
		writeFileSync(join(dir, "node", "package.json"), "{}");
		expect(looksLikeProject(join(dir, "plain"))).toBe(false);
		expect(looksLikeProject(join(dir, "withpi"))).toBe(true);
		expect(looksLikeProject(join(dir, "node"))).toBe(true);
	});
});

describe("session paths", () => {
	it("expands home, relative and absolute paths, and skips globs and flags", () => {
		expect(expandPath("~/me/dev", "/x")).toBe(join(H, "me/dev"));
		expect(expandPath("src/a.ts", "/proj")).toBe("/proj/src/a.ts");
		expect(expandPath("'/a/b/'", "/x")).toBe("/a/b");
		expect(expandPath("*.ts", "/x")).toBeUndefined();
		expect(expandPath("-la", "/x")).toBeUndefined();
		expect(expandPath("https://example.com/a", "/x")).toBeUndefined();
	});

	it("collects tool paths, cd targets and home paths from bash", () => {
		expect(callPaths("read", { path: "src/a.ts" }, "/proj")).toEqual(["/proj/src/a.ts"]);
		const bash = callPaths("bash", { command: `cd ~/me/dev/pushemoji && python3 x.py ${H}/me/dev/pushemoji/src/a.svg -o out/a.tgs` }, "/proj");
		expect(bash).toContain(join(H, "me/dev/pushemoji"));
		expect(bash).toContain(join(H, "me/dev/pushemoji/src/a.svg"));
	});
});
