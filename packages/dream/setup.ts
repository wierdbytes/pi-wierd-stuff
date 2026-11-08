/**
 * `/dream init`: create the memory repository, its GitHub remote and the
 * settings file. Idempotent — every step checks before it acts, so running it
 * again only fills in what is missing.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configPath, type DreamConfig, saveConfig } from "./config.ts";
import { gh, ghOk, git, githubRepoOf, gitOk } from "./gitops.ts";
import { CHARTER_FILE, GLOBAL_SCOPE, INDEX_FILE, memoryPaths, scopeDir } from "./layout.ts";
import { buildIndex } from "./memindex.ts";
import { DEFAULT_GLOBAL_CHARTER, DEFAULT_PROJECT_CHARTER } from "./prompts.ts";

const GITIGNORE = ".local/\n.DS_Store\n";

const README = `# pi memory

Память агентов [pi](https://pi.dev) на этой машине. Её ведёт [@wierdbytes/pi-dream](https://github.com/wierdbytes/pi-wierd-stuff/tree/master/packages/dream): фоновый «сон» перечитывает новые сессии pi, предлагает изменения памяти и присылает их сюда pull request'ом. В сессии попадает только то, что смёрджено в \`main\`.

## Устройство

\`\`\`
scopes/global/                 всё, что верно для тебя и машины во всех проектах
  charter.md                   зачем эта память — направляет сон (в сессии не попадает)
  MEMORY.md                    индекс, генерируется из notes/ — именно он подгружается в сессии
  notes/<slug>.md              одна заметка = один файл (front matter + текст)
  skills/<name>/SKILL.md       одобренные скиллы, pi подхватывает их автоматически
scopes/projects/<проект>/      то же для одного проекта (ключ — git remote или путь)
reports/<run>.md               отчёт каждого сна
prompts/<stage>.md             (необязательно) свои промпты сна: cards, curator, review, verify
.local/                        не в git: inbox, дайджесты и карточки сессий, логи, состояние
\`\`\`

## Заметка

\`\`\`markdown
---
id: m-7f3a2c
title: "Утверждение одной строкой — это и есть строка в индексе"
type: procedure            # preference | procedure | pitfall | fact | decision | reference
status: active             # active | superseded | deprecated
index: always              # always — строка в каждой сессии scope; pointer — «когда → id»; none — только поиск
when: "когда это нужно"
created: "2026-11-08"
updated: "2026-11-08"
evidence:
  - {"s": "<session id>", "e": ["<entry id>"], "date": "2026-11-06", "at": "2026-11-06T14:05Z", "kind": "user"}
---

Подробности: точные команды, пути, условия, причины.
\`\`\`

## Ревью

- **Merge** — изменения становятся памятью.
- **Правки прямо в PR** — сон продолжит с твоей версии; можно и руками добавлять заметки (id и даты сон допишет сам).
- **Комментарий в PR** — указание сну, выполнится при следующем \`/dream run\`.
- **Закрыть без merge** — отклонить предложенные заметки.
- \`pinned: true\` в заметке — сон никогда не закроет её сам.

Сессию-доказательство можно открыть: \`pi --session <id>\`.
`;

const PROMPTS_README = `# Свои промпты сна

Положи сюда \`cards.md\`, \`curator.md\`, \`review.md\` или \`verify.md\`, чтобы заменить соответствующий системный промпт pi-dream.
Плейсхолдеры: \`{{language}}\`, \`{{charter}}\`, \`{{global_budget}}\`, \`{{project_budget}}\`.
Изменения промптов проходят ревью как всё остальное.
`;

function writeIfMissing(path: string, content: string, created: string[]): void {
	if (existsSync(path)) return;
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf-8");
	created.push(path);
}

export async function initMemory(cfg: DreamConfig, log: (msg: string) => void): Promise<{ repo?: string }> {
	const root = cfg.memoryDir;
	const P = memoryPaths(root);
	mkdirSync(P.local, { recursive: true });

	if (!existsSync(join(root, ".git"))) {
		await gitOk(root, ["init", "-b", cfg.github.base]);
		log(`git init ${root}`);
	}

	const created: string[] = [];
	writeIfMissing(join(root, ".gitignore"), GITIGNORE, created);
	writeIfMissing(join(root, "README.md"), README, created);
	writeIfMissing(join(scopeDir(root, GLOBAL_SCOPE), CHARTER_FILE), `${DEFAULT_GLOBAL_CHARTER}\n`, created);
	writeIfMissing(join(scopeDir(root, GLOBAL_SCOPE), INDEX_FILE), buildIndex([], "global", cfg.budgets.globalTokens).text, created);
	writeIfMissing(join(scopeDir(root, GLOBAL_SCOPE), "notes", ".gitkeep"), "", created);
	writeIfMissing(join(P.scopes, "projects", "_charter.md"), `${DEFAULT_PROJECT_CHARTER}\n`, created);
	writeIfMissing(join(P.reports, ".gitkeep"), "", created);
	writeIfMissing(join(P.prompts, "README.md"), PROMPTS_README, created);
	if (created.length) log(`created ${created.length} files`);

	const status = await git(root, ["status", "--porcelain"]);
	if (status.stdout.trim()) {
		await gitOk(root, ["add", "-A"]);
		await gitOk(root, ["commit", "-m", "pi-dream: initialize memory repository"]);
		log("committed the skeleton");
	}

	let remote = await git(root, ["remote", "get-url", "origin"]);
	if (remote.code !== 0) {
		const owner = await ghOk(["api", "user", "--jq", ".login"]);
		const full = `${owner}/${cfg.github.repo}`;
		const exists = await gh(["repo", "view", full, "--json", "name"]);
		if (exists.code === 0) {
			const ssh = `git@github.com:${full}.git`;
			await gitOk(root, ["remote", "add", "origin", ssh]);
			log(`origin → existing ${full}`);
		} else {
			await ghOk(
				["repo", "create", full, "--private", "--description", "pi agent memory, maintained by pi-dream", "--source", root, "--remote", "origin"],
				{ timeoutMs: 120_000 },
			);
			log(`created private GitHub repo ${full}`);
		}
		remote = await git(root, ["remote", "get-url", "origin"]);
	}
	const repo = githubRepoOf(remote.stdout.trim());

	const push = await git(root, ["push", "-u", "origin", cfg.github.base], 120_000);
	if (push.code !== 0) log(`push failed: ${push.stderr.trim()}`);
	else log(`pushed ${cfg.github.base}`);

	if (repo) {
		const label = await gh(["label", "create", cfg.github.label, "--repo", repo, "--color", "7AA2F7", "--description", "pi-dream memory review", "--force"]);
		if (label.code === 0) log(`label "${cfg.github.label}" ready`);
	}

	if (!existsSync(configPath())) {
		saveConfig(cfg);
		log(`settings → ${configPath()}`);
	}
	return { repo };
}

/** Whether the memory repo exists and has a remote. */
export async function memoryReady(root: string): Promise<{ git: boolean; remote: boolean }> {
	if (!existsSync(join(root, ".git"))) return { git: false, remote: false };
	const r = await git(root, ["remote", "get-url", "origin"]);
	return { git: true, remote: r.code === 0 };
}
