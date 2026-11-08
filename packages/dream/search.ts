/**
 * Small in-memory BM25 for notes and session digests (Russian + English).
 *
 * The corpus is tiny (hundreds of notes, a few thousand digest chunks), so a
 * plain inverted index rebuilt on demand beats running a search service.
 *
 * Russian inflects heavily, so a Cyrillic word yields truncated forms at two
 * lengths (4 and 6 letters) plus the same without a common verb prefix:
 * "коммита"/"коммит" and "задеплой"/"деплой" meet, while the longer form
 * keeps "контекст" apart from "контроль". English gets light suffix
 * stripping ("deploys" → "deploy").
 */

const RU_PREFIXES = ["пере", "под", "при", "про", "раз", "рас", "за", "вы", "по", "на", "от", "до", "об", "вз", "из"];

const STOP = new Set(
	"и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между the a an and or of to in on for is it this that with be as at by from are was were has have had not but if then so do does did can will just".split(
		" ",
	),
);

function ruForms(word: string): string[] {
	if (word.length <= 4) return [word];
	const out = [word.slice(0, 4)];
	if (word.length >= 6) out.push(word.slice(0, 6));
	for (const p of RU_PREFIXES) {
		if (word.startsWith(p) && word.length - p.length >= 5) {
			const rest = word.slice(p.length);
			out.push(rest.slice(0, 4));
			if (rest.length >= 6) out.push(rest.slice(0, 6));
			break;
		}
	}
	return out;
}

function enStem(word: string): string {
	if (word.length > 4) {
		for (const suf of ["ing", "ed", "es", "s"]) if (word.endsWith(suf) && word.length - suf.length >= 3) return word.slice(0, -suf.length);
	}
	return word;
}

export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.toLowerCase().replace(/ё/g, "е").split(/[^\p{L}\p{N}_]+/u)) {
		if (raw.length < 2 || STOP.has(raw)) continue;
		if (/^[а-я]+$/.test(raw)) out.push(...ruForms(raw));
		else if (/^[a-z]+$/.test(raw)) out.push(enStem(raw));
		else out.push(raw);
	}
	return out;
}

export interface Doc<M = unknown> {
	id: string;
	text: string;
	meta: M;
}

export interface Hit<M = unknown> {
	doc: Doc<M>;
	score: number;
}

export class Bm25<M = unknown> {
	private postings = new Map<string, Array<[number, number]>>();
	private lengths: number[] = [];
	private avg = 0;
	constructor(
		readonly docs: Doc<M>[],
		private k1 = 1.2,
		private b = 0.75,
	) {
		let total = 0;
		docs.forEach((doc, i) => {
			const tf = new Map<string, number>();
			const toks = tokenize(doc.text);
			for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
			for (const [t, n] of tf) {
				let list = this.postings.get(t);
				if (!list) this.postings.set(t, (list = []));
				list.push([i, n]);
			}
			this.lengths.push(toks.length);
			total += toks.length;
		});
		this.avg = docs.length ? total / docs.length : 0;
	}

	search(query: string, limit = 10, filter?: (doc: Doc<M>) => boolean): Hit<M>[] {
		const terms = [...new Set(tokenize(query))];
		if (!terms.length || !this.docs.length) return [];
		const scores = new Map<number, number>();
		const N = this.docs.length;
		for (const t of terms) {
			const list = this.postings.get(t);
			if (!list) continue;
			const idf = Math.log(1 + (N - list.length + 0.5) / (list.length + 0.5));
			for (const [i, tf] of list) {
				const len = this.lengths[i] || 1;
				const s = (idf * tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + (this.b * len) / (this.avg || 1)));
				scores.set(i, (scores.get(i) ?? 0) + s);
			}
		}
		return [...scores.entries()]
			.filter(([i]) => !filter || filter(this.docs[i]))
			.sort((a, b) => b[1] - a[1])
			.slice(0, limit)
			.map(([i, score]) => ({ doc: this.docs[i], score }));
	}
}

/** The lines of `text` that best match `query`, clipped to `max` chars. */
export function snippet(text: string, query: string, max = 320): string {
	const terms = new Set(tokenize(query));
	const lines = text.split("\n");
	let best = 0;
	let bestScore = -1;
	lines.forEach((line, i) => {
		const score = tokenize(line).filter((t) => terms.has(t)).length;
		if (score > bestScore) {
			bestScore = score;
			best = i;
		}
	});
	let out = lines[best] ?? "";
	for (let i = best + 1; i < lines.length && out.length < max; i++) out += `\n${lines[i]}`;
	return out.length > max ? `${out.slice(0, max)}…` : out;
}

/** Split a digest into chunks of whole lines; each chunk starts at an entry line. */
export function chunkDigest(text: string, maxChars = 2400): Array<{ entryId?: string; text: string }> {
	const chunks: Array<{ entryId?: string; text: string }> = [];
	let cur: string[] = [];
	let size = 0;
	let entryId: string | undefined;
	const flush = () => {
		if (cur.length) chunks.push({ entryId, text: cur.join("\n") });
		cur = [];
		size = 0;
		entryId = undefined;
	};
	for (const line of text.split("\n")) {
		const id = /^\[([0-9a-f-]{6,})\]/.exec(line)?.[1];
		if (id && size + line.length > maxChars) flush();
		if (id && !entryId) entryId = id;
		cur.push(line);
		size += line.length + 1;
	}
	flush();
	return chunks;
}
