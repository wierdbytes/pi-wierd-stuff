import assert from "node:assert/strict";
import { test } from "vitest";
import { DEFAULT_ASK_CONFIG } from "./config/defaults.ts";
import { migrateAskConfig } from "./config/migrate.ts";
import { CURRENT_ASK_CONFIG_SCHEMA_VERSION } from "./config/migrations/index.ts";

const INVALID_CONFIG_PATTERN = /Config was invalid or unsupported/;

const currentConfigFile = {
	schemaVersion: CURRENT_ASK_CONFIG_SCHEMA_VERSION,
	behaviour: DEFAULT_ASK_CONFIG.behaviour,
	keymaps: DEFAULT_ASK_CONFIG.keymaps,
};

test("config migration framework accepts the current schema version", () => {
	const result = migrateAskConfig(currentConfigFile);

	assert.equal(result.migrated, false);
	assert.deepEqual(result.config, DEFAULT_ASK_CONFIG);
});

test("config migration maps previous-version config files into current shape", () => {
	const legacyKeymaps = {
		cancel: "q",
		confirm: "ctrl+k",
		dismiss: "ctrl+d",
		optionNote: "x",
		questionNote: "shift+x",
		toggle: "ctrl+t",
	};
	const cases = [
		{
			name: "v1",
			raw: {
				schemaVersion: 1,
				behaviour: DEFAULT_ASK_CONFIG.behaviour,
				keymaps: legacyKeymaps,
			},
		},
		{
			name: "v2",
			raw: {
				schemaVersion: 2,
				answer: DEFAULT_ASK_CONFIG.answer,
				behaviour: DEFAULT_ASK_CONFIG.behaviour,
				keymaps: legacyKeymaps,
			},
		},
		{
			name: "v3",
			raw: {
				schemaVersion: 3,
				answer: DEFAULT_ASK_CONFIG.answer,
				behaviour: DEFAULT_ASK_CONFIG.behaviour,
				keymaps: legacyKeymaps,
				notifications: DEFAULT_ASK_CONFIG.notifications,
			},
		},
	];

	for (const { name, raw } of cases) {
		const result = migrateAskConfig(raw);
		assert.equal(result.migrated, true, name);
		assert.deepEqual(result.config.keymaps.global.dismiss, ["ctrl+d"], name);
		assert.deepEqual(result.config.keymaps.main.cancel, ["q"], name);
		assert.deepEqual(result.config.keymaps.main.confirm, ["ctrl+k"], name);
		assert.deepEqual(result.config.keymaps.main.toggle, ["ctrl+t"], name);
		assert.deepEqual(result.config.keymaps.editor.submit, ["ctrl+k"], name);
		assert.deepEqual(result.config.keymaps.editor.close, ["q"], name);
		assert.deepEqual(result.config.keymaps.noteEditor.save, ["ctrl+k"], name);
		assert.deepEqual(result.config.keymaps.noteEditor.close, ["q"], name);
		assert.deepEqual(
			result.config.keymaps.settingsModal,
			DEFAULT_ASK_CONFIG.keymaps.settingsModal,
			name
		);
	}
});

test("config migration adds v5 defaults to v4 configs", () => {
	const v4MainKeymaps = Object.fromEntries(
		Object.entries(DEFAULT_ASK_CONFIG.keymaps.main).filter(
			([key]) => key !== "changeQuestionType"
		)
	);
	const result = migrateAskConfig({
		schemaVersion: 4,
		answer: DEFAULT_ASK_CONFIG.answer,
		behaviour: {
			autoSubmitWhenAnsweredWithoutNotes: true,
			confirmDismissWhenDirty: true,
			doublePressReviewShortcuts: true,
			showFooterHints: false,
		},
		keymaps: {
			...DEFAULT_ASK_CONFIG.keymaps,
			main: v4MainKeymaps,
		},
		notifications: DEFAULT_ASK_CONFIG.notifications,
	});

	assert.equal(result.migrated, true);
	assert.equal(result.config.behaviour.presentSingleAsMulti, false);
	assert.equal(result.config.behaviour.showFooterHints, false);
	assert.deepEqual(result.config.keymaps.main.changeQuestionType, ["t"]);
});

test("config migration maps legacy flat keymaps into context keymaps", () => {
	const result = migrateAskConfig({
		schemaVersion: 3,
		behaviour: DEFAULT_ASK_CONFIG.behaviour,
		keymaps: {
			cancel: "q",
			confirm: "ctrl+k",
			dismiss: "ctrl+d",
			optionNote: "x",
			questionNote: "shift+x",
			toggle: "ctrl+t",
		},
		notifications: DEFAULT_ASK_CONFIG.notifications,
	});

	assert.equal(result.migrated, true);
	assert.deepEqual(result.config.keymaps.global.dismiss, ["ctrl+d"]);
	assert.deepEqual(result.config.keymaps.main.cancel, ["q"]);
	assert.deepEqual(result.config.keymaps.editor.submit, ["ctrl+k"]);
	assert.deepEqual(result.config.keymaps.noteEditor.save, ["ctrl+k"]);
});

test("config migration framework rejects unsupported future schema versions", () => {
	assert.throws(
		() =>
			migrateAskConfig({
				...currentConfigFile,
				schemaVersion: CURRENT_ASK_CONFIG_SCHEMA_VERSION + 1,
			}),
		INVALID_CONFIG_PATTERN
	);
});

test("config migration framework rejects unversioned config files", () => {
	assert.throws(
		() =>
			migrateAskConfig({
				behaviour: DEFAULT_ASK_CONFIG.behaviour,
				keymaps: DEFAULT_ASK_CONFIG.keymaps,
			}),
		INVALID_CONFIG_PATTERN
	);
});
