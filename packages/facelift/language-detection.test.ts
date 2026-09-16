import { afterEach, describe, expect, it } from "vitest";

import {
	detectCodeLanguage,
	disposeLanguageDetector,
	LANGUAGE_SAMPLE_BYTES,
	sampleUtf8,
	selectDetectedLanguage,
} from "./language-detection.ts";

afterEach(() => disposeLanguageDetector());

describe("language detection confidence gate", () => {
	it("accepts a clear supported winner", () => {
		expect(
			selectDetectedLanguage([
				{ languageId: "ts", confidence: 0.31 },
				{ languageId: "js", confidence: 0.12 },
			]),
		).toBe("typescript");
	});

	it("returns no result for low-confidence text", () => {
		expect(
			selectDetectedLanguage([
				{ languageId: "ini", confidence: 0.08 },
				{ languageId: "yaml", confidence: 0.03 },
			]),
		).toBeUndefined();
	});

	it("returns no result when candidates are too close", () => {
		expect(
			selectDetectedLanguage([
				{ languageId: "sh", confidence: 0.16 },
				{ languageId: "bat", confidence: 0.14 },
			]),
		).toBeUndefined();
	});

	it("returns no result for an unsupported model label", () => {
		expect(selectDetectedLanguage([{ languageId: "ipynb", confidence: 0.9 }])).toBeUndefined();
	});
});

describe("language detection sampling", () => {
	it("limits model input to 4 KiB", () => {
		const sampled = sampleUtf8("a".repeat(LANGUAGE_SAMPLE_BYTES + 100));
		expect(new TextEncoder().encode(sampled).length).toBe(LANGUAGE_SAMPLE_BYTES);
	});

	it("does not split a UTF-8 code point at the limit", () => {
		const sampled = sampleUtf8(`${"a".repeat(LANGUAGE_SAMPLE_BYTES - 1)}界tail`);
		expect(new TextEncoder().encode(sampled).length).toBe(LANGUAGE_SAMPLE_BYTES - 1);
		expect(sampled.endsWith("�")).toBe(false);
	});
});

describe("VS Code language model integration", () => {
	it("detects an incomplete TypeScript snippet", async () => {
		const source = `
export interface Account {
  id: string;
  balance: number;
}

export async function loadAccount(id: string): Promise<Account> {
  const response = await fetch(\`/api/accounts/\${id}\`);
  return response.json();
`;
		expect(await detectCodeLanguage(source)).toBe("typescript");
	});

	it("declines ordinary prose", async () => {
		const prose =
			"The command completed successfully. There were fourteen results and no errors. " +
			"Please inspect the output above for more information.";
		expect(await detectCodeLanguage(prose)).toBeUndefined();
	});
});
