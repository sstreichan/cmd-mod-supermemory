import type {ModApi} from '@commandcode/harness';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, join, resolve} from 'node:path';

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://api.supermemory.ai';
const TIMEOUT_MS = 30000;
const MAX_CONVERSATION_CHARS = 100_000;
const MIN_TOKENS_FOR_COMPACTION = 50_000;
const COMPACTION_COOLDOWN_MS = 30_000;
const DEFAULT_CONTEXT_LIMIT = 200_000;
const MOD_ID = 'supermemory';

const DEFAULT_KEYWORD_PATTERNS = [
	'remember',
	'memorize',
	'save\\s+this',
	'note\\s+this',
	'keep\\s+in\\s+mind',
	"don'?t\\s+forget",
	'learn\\s+this',
	'store\\s+this',
	'record\\s+this',
	'make\\s+a\\s+note',
	'take\\s+note',
	'jot\\s+down',
	'commit\\s+to\\s+memory',
	'remember\\s+that',
	'never\\s+forget',
	'always\\s+remember',
];

const MEMORY_TYPES = [
	'project-config',
	'architecture',
	'error-solution',
	'preference',
	'learned-pattern',
	'conversation',
] as const;

const AGENT_ENTITY_CONTEXT = `Shared coding-agent memory for one software repository.

RULES:
- Preserve durable context that helps continue work across sessions
- Condense responses into decisions, outcomes, and reusable knowledge
- Keep user preferences and project facts concise and independently understandable

EXTRACT:
- User preferences, accepted decisions, durable workflows, actions, and learnings
- Architecture: "uses monorepo with turborepo", "API in /apps/api"
- Conventions: "components in PascalCase", "hooks prefixed with use"
- Patterns: "all API routes use withAuth wrapper", "errors thrown as ApiError"
- Setup: "requires .env with DATABASE_URL", "run pnpm db:migrate first"
- Decisions: "chose Drizzle over Prisma for performance", "using RSC for data fetching"

SKIP:
- Generic assistant suggestions the user did not accept
- Transient command output and low-value implementation chatter
- Granular details that do not help future work`;

const RECALL_DIRECTIVE = `<supermemory-recall>
Before responding, silently decide whether recalling saved memory (past sessions, decisions, conventions, the user's preferences) would materially improve your answer to THIS message. Reason first — don't search reflexively, and don't narrate the decision.

Recall — by calling the \`supermemory\` tool with \`mode: "search"\` — when the message:
- refers to earlier work or decisions ("the auth flow", "like we did", "continue", "the bug from before")
- touches an area where saved conventions, patterns, or preferences likely exist
- is ambiguous in a way past context would resolve

Skip recall when the message is self-contained, trivial, a greeting/meta, fully answerable from the current conversation, or you already recalled the relevant context this session and the topic hasn't shifted.

Cadence is per-message: it's fine to recall on several turns in a row, and fine to never recall in a session. When you do recall, run it before answering and fold the results into your response.
</supermemory-recall>`;

const MEMORY_NUDGE = `[MEMORY TRIGGER DETECTED]
The user wants you to remember something. You MUST use the \`supermemory\` tool with \`mode: "add"\` to save this information.

Extract the key information the user wants remembered and save it as a concise, searchable memory.
- Use \`scope: "project"\` for project-specific preferences (e.g., "run lint with tests")
- Use \`scope: "user"\` for personal preferences in this project (e.g., "prefers concise responses")
- Choose an appropriate \`type\`: "preference", "project-config", "learned-pattern", etc.

DO NOT skip this step. The user explicitly asked you to remember.`;

// ─── Config ──────────────────────────────────────────────────────────────────

interface SmConfig {
	apiKey: string;
	baseUrl: string;
	similarityThreshold: number;
	maxMemories: number;
	maxProjectMemories: number;
	maxProfileItems: number;
	injectProfile: boolean;
	autoIngest: boolean;
	autoRecall: boolean;
	captureEveryNTurns: number;
	compactionThreshold: number;
	contextLimit: number;
	keywordPatterns: string[];
	projectContainerTag?: string;
	userContainerTag?: string;
}

function loadJsonc(path: string): Record<string, unknown> | null {
	try {
		if (!existsSync(path)) return null;
		const raw = readFileSync(path, 'utf-8');
		const stripped = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
		return JSON.parse(stripped) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function resolveConfig(cmd: ModApi): SmConfig {
	const configDir = join(homedir(), '.commandcode');
	const fileConfig =
		loadJsonc(join(configDir, 'supermemory.jsonc')) ??
		loadJsonc(join(configDir, 'supermemory.json')) ??
		 {};

	const flag = (name: string) => cmd.getFlag(name);

	const apiKey =
		(typeof flag('api-key') === 'string' && (flag('api-key') as string)) ||
		(typeof fileConfig.apiKey === 'string' ? fileConfig.apiKey : '') ||
		process.env.SUPERMEMORY_API_KEY ||
		'';

	const baseUrl =
		(typeof flag('base-url') === 'string' && (flag('base-url') as string)) ||
		(typeof fileConfig.baseUrl === 'string' ? fileConfig.baseUrl : '') ||
		process.env.SUPERMEMORY_API_URL ||
		process.env.SUPERMEMORY_BASE_URL ||
		DEFAULT_BASE_URL;

	const num = (name: string, def: number, fileKey: string, legacyFileKey?: string) => {
		const parse = (raw: unknown): number | undefined => {
			if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
			if (typeof raw === 'string' && raw.trim() !== '') {
				const n = Number(raw);
				if (Number.isFinite(n) && n >= 0) return n;
			}
			return undefined;
		};
		return (
			parse(flag(name)) ??
			parse(fileConfig[fileKey]) ??
			(legacyFileKey ? parse(fileConfig[legacyFileKey]) : undefined) ??
			def
		);
	};

	const bool = (name: string, def: boolean, fileKey: string, legacyFileKey?: string) => {
		const parse = (raw: unknown): boolean | undefined => {
			if (typeof raw === 'boolean') return raw;
			if (typeof raw === 'string') {
				const s = raw.trim().toLowerCase();
				if (['true', '1', 'yes', 'on'].includes(s)) return true;
				if (['false', '0', 'no', 'off'].includes(s)) return false;
			}
			return undefined;
		};
		return (
			parse(flag(name)) ??
			parse(fileConfig[fileKey]) ??
			(legacyFileKey ? parse(fileConfig[legacyFileKey]) : undefined) ??
			def
		);
	};

	const patterns = [...DEFAULT_KEYWORD_PATTERNS];
	if (Array.isArray(fileConfig.keywordPatterns)) {
		for (const p of fileConfig.keywordPatterns) {
			if (typeof p === 'string') {
				try {
					new RegExp(p);
					patterns.push(p);
				} catch {}
			}
		}
	}

	return {
		apiKey,
		baseUrl: baseUrl.replace(/\/+$/, ''),
		similarityThreshold: num('similarity-threshold', 0.55, 'similarityThreshold'),
		maxMemories: num('max-memories', 5, 'maxMemories'),
		maxProjectMemories: num('max-project-memories', 10, 'maxProjectMemories'),
		maxProfileItems: num('max-profile-items', 5, 'maxProfileItems'),
		injectProfile: bool('inject-profile', true, 'injectProfile'),
		autoIngest: bool('auto-ingest', true, 'autoIngest'),
		autoRecall: bool('auto-recall', true, 'autoRecall', 'autoRecallEveryPrompt'),
		captureEveryNTurns: num('capture-every-n-turns', 3, 'captureEveryNTurns'),
		compactionThreshold: num('compaction-threshold', 0.8, 'compactionThreshold'),
		contextLimit: num('context-limit', DEFAULT_CONTEXT_LIMIT, 'contextLimit'),
		keywordPatterns: patterns,
		projectContainerTag:
			typeof fileConfig.projectContainerTag === 'string'
				? fileConfig.projectContainerTag
				: undefined,
		userContainerTag:
			typeof fileConfig.userContainerTag === 'string'
				? fileConfig.userContainerTag
				: undefined,
	};
}

// ─── API Client ──────────────────────────────────────────────────────────────

async function smFetch(
	baseUrl: string,
	apiKey: string,
	path: string,
	method: string = 'GET',
	body?: Record<string, unknown>,
) {
	const url = `${baseUrl}${path}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			method,
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new Error(`SuperMemory API ${res.status}: ${text}`);
		}
		return res.json();
	} finally {
		clearTimeout(timer);
	}
}

// ─── Privacy ─────────────────────────────────────────────────────────────────

function stripPrivateContent(text: string): string {
	return text.replace(/<private>[\s\S]*?<\/private>/gi, '[REDACTED]');
}

function isFullyPrivate(text: string): boolean {
	return stripPrivateContent(text).trim() === '[REDACTED]' || stripPrivateContent(text).trim() === '';
}

// ─── Container Tags ──────────────────────────────────────────────────────────

function sha256(input: string): string {
	return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function normalizeGitRemote(remoteUrl: string): string | null {
	const raw = remoteUrl.trim();
	if (!raw) return null;
	let normalized: string;
	if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) {
		try {
			const parsed = new URL(raw);
			normalized =
				parsed.protocol === 'file:'
					? `file:${decodeURIComponent(parsed.pathname)}`
					: `${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}/${parsed.pathname.replace(/^\/+/, '')}`;
		} catch {
			normalized = raw;
		}
	} else {
		const scpStyle = raw.match(/^(?:[^@/]+@)?([^:]+):(.+)$/);
		normalized =
			scpStyle?.[1] && scpStyle?.[2]
				? `${scpStyle[1].toLowerCase()}/${scpStyle[2]}`
				: `file:${resolve(raw)}`;
	}
	return normalized
		.replace(/[?#].*$/, '')
		.replace(/\/+$/, '')
		.replace(/\.git$/i, '')
		.replace(/\/{2,}/g, '/')
		.toLowerCase();
}

async function getGitRoot(cmd: ModApi, directory: string): Promise<string | null> {
	try {
		const {stdout, code} = await cmd.exec({
			command: 'git',
			args: ['rev-parse', '--show-toplevel'],
			cwd: directory,
		});
		return code === 0 && stdout.trim() ? stdout.trim() : null;
	} catch {
		return null;
	}
}

async function getGitRemote(cmd: ModApi, directory: string): Promise<string | null> {
	try {
		const {stdout, code} = await cmd.exec({
			command: 'git',
			args: ['remote', 'get-url', 'origin'],
			cwd: directory,
		});
		return code === 0 && stdout.trim() ? stdout.trim() : null;
	} catch {
		return null;
	}
}

function sanitizeRepoName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_|_$/g, '')
		.slice(0, 95)
		.replace(/_+$/g, '') || 'unknown';
}

interface ResolvedTags {
	canonical: string;
	projectId: string;
	projectName: string;
	personalReads: string[];
	projectReads: string[];
	allReads: string[];
}

async function resolveTags(cmd: ModApi, directory: string, config: SmConfig): Promise<ResolvedTags> {
	const basePath = (await getGitRoot(cmd, directory)) || resolve(directory);
	const remote = await getGitRemote(cmd, basePath);
	const normalizedRemote = remote ? normalizeGitRemote(remote) : null;
	const repoName = remote
		? remote.replace(/\/+$/, '').replace(/\.git$/i, '').split(/[/]/).pop() || 'unknown'
		: basename(basePath) || 'unknown';

	const projectId = sha256(normalizedRemote || `path:${basePath}`);
	const shortName = sanitizeRepoName(repoName).slice(0, 72).replace(/_+$/g, '');
	const canonical = `repo_${shortName || 'unknown'}__${projectId}`;

	const personalReads = [canonical];
	const projectReads = [canonical];

	if (config.userContainerTag) personalReads.push(config.userContainerTag);
	if (config.projectContainerTag) projectReads.push(config.projectContainerTag);

	return {
		canonical,
		projectId,
		projectName: repoName,
		personalReads: [...new Set(personalReads)],
		projectReads: [...new Set(projectReads)],
		allReads: [...new Set([...personalReads, ...projectReads])],
	};
}

// ─── Format Helpers ──────────────────────────────────────────────────────────

function extractText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content))
		return content
			.map((c: any) => (c.type === 'text' ? c.text : ''))
			.filter(Boolean)
			.join('');
	return '';
}

function formatRecallHit(hit: {memory?: string; content?: string; chunk?: string; text?: string; title?: string}): string {
	return hit.memory || hit.title || hit.content || hit.chunk || hit.text || '(unknown)';
}

function formatSearchResults(
	data: any,
	limit: number,
): {lines: string[]; count: number} {
	const results = (data.results ?? []).slice(0, limit);
	const lines: string[] = [];
	for (const r of results) {
		const hit = formatRecallHit(r);
		const sim = r.similarity ? ` [${Math.round(r.similarity * 100)}%]` : '';
		lines.push(`- ${hit}${sim}`);
	}
	if (!lines.length) lines.push('No results found.');
	return {lines, count: results.length};
}

// ─── Main Mod ────────────────────────────────────────────────────────────────

export default async function (cmd: ModApi): Promise<void> {
	const config = resolveConfig(cmd);
	const tags = await resolveTags(cmd, cmd.cwd, config);

	if (!config.apiKey) {
		cmd.ui.notify(
			'supermemory: no API key — set SUPERMEMORY_API_KEY or --mod-option api-key=sm_...',
		);
	}

	// --- Flags ---

	cmd.addFlag('api-key', {
		type: 'string',
		description: 'SuperMemory API key (or SUPERMEMORY_API_KEY env var)',
	});
	cmd.addFlag('base-url', {
		type: 'string',
		description: 'SuperMemory API base URL (default: api.supermemory.ai)',
	});
	cmd.addFlag('similarity-threshold', {
		type: 'string',
		description: 'Min similarity for memory retrieval (0-1, default 0.55)',
	});
	cmd.addFlag('max-memories', {
		type: 'string',
		description: 'Max memories injected per request (default 5)',
	});
	cmd.addFlag('max-project-memories', {
		type: 'string',
		description: 'Max project memories listed (default 10)',
	});
	cmd.addFlag('max-profile-items', {
		type: 'string',
		description: 'Max profile facts injected (default 5)',
	});
	cmd.addFlag('inject-profile', {
		type: 'boolean',
		default: true,
		description: 'Include user profile in context',
	});
	cmd.addFlag('auto-ingest', {
		type: 'boolean',
		default: true,
		description: 'Automatically ingest conversation at run end',
	});
	cmd.addFlag('auto-recall', {
		type: 'boolean',
		default: true,
		description: 'Inject recall directive on each turn',
	});
	cmd.addFlag('capture-every-n-turns', {
		type: 'string',
		description: 'Save conversation every N turns (0 = session end only)',
	});
	cmd.addFlag('compaction-threshold', {
		type: 'string',
		description: 'Context usage ratio that triggers compaction (0-1, default 0.8)',
	});
	cmd.addFlag('context-limit', {
		type: 'string',
		description: "Your model's context window in tokens (default 200000)",
	});

	// ─── Unified Tool ─────────────────────────────────────────────────────

	cmd.addTool({
		schema: {
			name: 'supermemory',
			description:
				'Manage and query the Supermemory persistent memory system. Modes: add (store), search (recall), profile (view), list (recent), forget (delete), help (usage).',
			input_schema: {
				type: 'object',
				properties: {
					mode: {
						type: 'string',
						enum: ['add', 'search', 'profile', 'list', 'forget', 'help'],
						description: 'The operation to perform.',
					},
					content: {
						type: 'string',
						description: 'Content to store (add mode).',
					},
					query: {
						type: 'string',
						description: 'Search query (search mode) or profile query (profile mode).',
					},
					type: {
						type: 'string',
						enum: [...MEMORY_TYPES],
						description: 'Memory type (add mode).',
					},
					scope: {
						type: 'string',
						enum: ['user', 'project'],
						description: 'Memory scope (add/search/list/forget). Default: project.',
					},
					memory_id: {
						type: 'string',
						description: 'Memory ID to delete (forget mode).',
					},
					limit: {
						type: 'number',
						description: 'Max results (search/list).',
					},
				},
				required: [],
			},
		},
		run: async ({input}) => {
			const cfg = resolveConfig(cmd);
			if (!cfg.apiKey) {
				return {ok: false, error: 'SUPERMEMORY_API_KEY not set.'};
			}
			const mode = (input.mode as string) || 'help';
			const scope = (input.scope as string) || 'project';
			const internalScope = scope === 'user' ? 'personal' : 'project';
			const readTags = scope === 'user' ? tags.personalReads : tags.projectReads;
			const limit = (input.limit as number) || cfg.maxMemories;

			try {
				switch (mode) {
					case 'help':
						return {
							ok: true,
							content: [
								{
									type: 'text',
									text: JSON.stringify(
										{
											success: true,
											commands: [
												{command: 'add', description: 'Store a new memory', args: ['content', 'type?', 'scope?']},
												{command: 'search', description: 'Search memories', args: ['query', 'scope?']},
												{command: 'profile', description: 'View user profile', args: ['query?']},
												{command: 'list', description: 'List recent memories', args: ['scope?', 'limit?']},
												{command: 'forget', description: 'Remove a memory', args: ['memory_id', 'scope?']},
											],
											scopes: {user: 'Personal preferences for this project', project: 'Project-specific knowledge (default)'},
											types: [...MEMORY_TYPES],
										},
										null,
										2,
									),
								},
							],
						};

					case 'add': {
						if (!input.content) return {ok: false, error: 'content is required for add mode'};
						const sanitized = stripPrivateContent(input.content as string);
						if (isFullyPrivate(input.content as string)) return {ok: false, error: 'Cannot store fully private content'};

						const body: Record<string, unknown> = {
							content: sanitized,
							containerTag: tags.canonical,
							metadata: {
								sm_source: 'commandcode',
								sm_scope: internalScope,
								...(input.type ? {type: input.type} : {}),
							},
							entityContext: AGENT_ENTITY_CONTEXT,
						};
						const data = await smFetch(cfg.baseUrl, cfg.apiKey, '/v3/documents', 'POST', body);
						return {
							ok: true,
							content: [{type: 'text', text: JSON.stringify({success: true, message: `Memory added to ${scope} scope`, id: data.id, scope, type: input.type}, null, 2)}],
						};
					}

					case 'search': {
						if (!input.query) return {ok: false, error: 'query is required for search mode'};

						const searchOne = async (containerTag: string) => {
							const body: Record<string, unknown> = {
								q: input.query,
								containerTag,
								searchMode: 'hybrid',
								threshold: cfg.similarityThreshold,
								limit,
								filters: {AND: [{key: 'sm_scope', value: internalScope}]},
							};
							return smFetch(cfg.baseUrl, cfg.apiKey, '/v4/search', 'POST', body);
						};

						const responses = await Promise.all(readTags.map(searchOne));
						const merged = responses.flatMap((r: any) => r.results ?? []).sort((a: any, b: any) => (b.similarity ?? 0) - (a.similarity ?? 0)).slice(0, limit);
						const {lines, count} = formatSearchResults({results: merged}, limit);
						return {
							ok: true,
							content: [{type: 'text', text: JSON.stringify({success: true, query: input.query, scope, count, results: lines}, null, 2)}],
						};
					}

					case 'profile': {
						const profileCalls = tags.personalReads.map((ct) =>
							smFetch(cfg.baseUrl, cfg.apiKey, '/v4/profile', 'POST', {
								containerTag: ct,
								threshold: cfg.similarityThreshold,
								...(input.query ? {q: input.query} : {}),
							}),
						);
						const profileResults = await Promise.all(profileCalls);
						const staticFacts = new Set<string>();
						const dynamicFacts = new Set<string>();
						for (const pr of profileResults) {
							for (const f of (pr as any).profile?.static ?? []) {
								const t = typeof f === 'string' ? f : f.content ?? JSON.stringify(f);
								if (t) staticFacts.add(t);
							}
							for (const f of (pr as any).profile?.dynamic ?? []) {
								const t = typeof f === 'string' ? f : f.content ?? JSON.stringify(f);
								if (t) dynamicFacts.add(t);
							}
						}
						const lines: string[] = [];
						const staticArr = [...staticFacts].slice(0, cfg.maxProfileItems);
						const dynamicArr = [...dynamicFacts].slice(0, cfg.maxProfileItems);
						if (staticArr.length) {
							lines.push('User Profile:');
							for (const s of staticArr) lines.push(`- ${s}`);
						}
						if (dynamicArr.length) {
							lines.push('Recent Context:');
							for (const d of dynamicArr) lines.push(`- ${d}`);
						}
						if (!lines.length) lines.push('No profile data yet.');
						return {ok: true, content: [{type: 'text', text: lines.join('\n')}]};
					}

					case 'list': {
						const listLimit = (input.limit as number) || 20;
						const listResult = await smFetch(cfg.baseUrl, cfg.apiKey, '/v3/documents/list', 'POST', {
							containerTags: readTags,
							filters: {AND: [{key: 'sm_scope', value: internalScope}]},
							limit: listLimit,
							order: 'desc',
							sort: 'createdAt',
							includeContent: true,
						});
						const memories = ((listResult as any).memories ?? []).slice(0, listLimit);
						return {
							ok: true,
							content: [
								{
									type: 'text',
									text: JSON.stringify(
										{
											success: true,
											scope,
											count: memories.length,
											memories: memories.map((m: any) => ({
												id: m.id,
												title: m.title ?? '',
												status: m.status ?? '',
												content: m.content ?? m.summary ?? '',
												createdAt: m.createdAt,
											})),
										},
										null,
										2,
									),
								},
							],
						};
					}

					case 'forget': {
						if (!input.memory_id) return {ok: false, error: 'memory_id is required for forget mode'};
						const id = input.memory_id as string;
						// v4 forget requires the memory's containerTag — try each tag in scope
						for (const ct of readTags) {
							try {
								await smFetch(cfg.baseUrl, cfg.apiKey, '/v4/memories', 'DELETE', {
									id,
									containerTag: ct,
								});
								return {
									ok: true,
									content: [{type: 'text', text: JSON.stringify({success: true, message: `Memory ${id} removed`}, null, 2)}],
								};
							} catch {
								// try next tag
							}
						}
						// Fallback: delete the source document directly
						try {
							await smFetch(cfg.baseUrl, cfg.apiKey, `/v3/documents/${id}`, 'DELETE');
							return {
								ok: true,
								content: [{type: 'text', text: JSON.stringify({success: true, message: `Document ${id} deleted`}, null, 2)}],
							};
						} catch (e: any) {
							return {ok: false, error: e.message};
						}
					}

					default:
						return {ok: false, error: `Unknown mode: ${mode}`};
				}
			} catch (e: any) {
				return {ok: false, error: e.message};
			}
		},
	});

	// ─── Keyword Detection (transformInput) ──────────────────────────────

	const keywordRegex = new RegExp(`\\b(${config.keywordPatterns.join('|')})\\b`, 'i');
	const codeBlockPattern = /```[\s\S]*?```/g;
	const inlineCodePattern = /`[^`]+`/g;

	cmd.hooks({
		transformInput: ({text}) => {
			const stripped = text.replace(codeBlockPattern, '').replace(inlineCodePattern, '');
			if (keywordRegex.test(stripped)) {
				return {action: 'transform', text: `${MEMORY_NUDGE}\n\n${text}`};
			}
			return undefined;
		},
	});

	// ─── Context Injection + Reasoned Recall (appendSystemPrompt) ────────

	let contextInjected = false;

	cmd.hooks({
		appendSystemPrompt: async () => {
			const cfg = resolveConfig(cmd);
			if (!cfg.apiKey) return undefined;

			const parts: string[] = [];

			// First-message context injection
			if (!contextInjected) {
				contextInjected = true;
				try {
					const [profileResults, searchResults, listResults] = await Promise.all([
						Promise.all(
							tags.personalReads.map((ct) =>
								smFetch(cfg.baseUrl, cfg.apiKey, '/v4/profile', 'POST', {
									containerTag: ct,
									threshold: cfg.similarityThreshold,
								}),
							),
						),
						smFetch(cfg.baseUrl, cfg.apiKey, '/v4/search', 'POST', {
							q: 'user preferences, project setup, conventions',
							containerTag: tags.canonical,
							searchMode: 'hybrid',
							threshold: cfg.similarityThreshold,
							limit: cfg.maxMemories,
							filters: {AND: [{key: 'sm_scope', value: 'personal'}]},
						}),
						smFetch(cfg.baseUrl, cfg.apiKey, '/v3/documents/list', 'POST', {
							containerTags: tags.projectReads,
							filters: {AND: [{key: 'sm_scope', value: 'project'}]},
							limit: cfg.maxProjectMemories,
							order: 'desc',
							sort: 'createdAt',
							includeContent: true,
						}),
					]);

					const contextLines = ['[SUPERMEMORY]'];
					const staticFacts = new Set<string>();
					const dynamicFacts = new Set<string>();

					for (const pr of profileResults) {
						for (const f of (pr as any).profile?.static ?? []) {
							const t = typeof f === 'string' ? f : f.content ?? JSON.stringify(f);
							if (t) staticFacts.add(t);
						}
						for (const f of (pr as any).profile?.dynamic ?? []) {
							const t = typeof f === 'string' ? f : f.content ?? JSON.stringify(f);
							if (t) dynamicFacts.add(t);
						}
					}

					if (cfg.injectProfile && staticFacts.size > 0) {
						contextLines.push('\nUser Profile:');
						for (const f of [...staticFacts].slice(0, cfg.maxProfileItems))
							contextLines.push(`- ${f}`);
					}
					if (cfg.injectProfile && dynamicFacts.size > 0) {
						contextLines.push('\nRecent Context:');
						for (const f of [...dynamicFacts].slice(0, cfg.maxProfileItems))
							contextLines.push(`- ${f}`);
					}

					const projMemories = (listResults as any).memories ?? [];
					if (projMemories.length) {
						contextLines.push('\nProject Knowledge:');
						for (const m of projMemories.slice(0, cfg.maxProjectMemories)) {
							const text = m.content ?? m.summary ?? m.title ?? '';
							if (text) contextLines.push(`- ${text}`);
						}
					}

					const userResults = (searchResults as any).results ?? [];
					if (userResults.length) {
						contextLines.push('\nRelevant Memories:');
						for (const r of userResults.slice(0, cfg.maxMemories)) {
							const hit = formatRecallHit(r);
							const sim = r.similarity ? ` [${Math.round(r.similarity * 100)}%]` : '';
							contextLines.push(`- ${hit}${sim}`);
						}
					}

					if (contextLines.length > 1) {
						parts.push(contextLines.join('\n'));
					}
				} catch {
					// silent
				}
			}

			// Reasoned recall directive
			if (cfg.autoRecall) {
				parts.push(RECALL_DIRECTIVE);
			}

			return parts.length ? parts.join('\n\n') : undefined;
		},
	});

	// ─── Automatic Capture (onRunEnd) ────────────────────────────────────

	cmd.hooks({
		onRunEnd: async ({state}) => {
			const cfg = resolveConfig(cmd);
			if (!cfg.apiKey || !cfg.autoIngest) return;

			const turnCount = cfg.captureEveryNTurns || 0;
			const messages = state.messages
				.filter((m: any) => m.role === 'user' || m.role === 'assistant')
				.map((m: any) => {
					const text = extractText(m.content);
					if (!text || isFullyPrivate(text)) return null;
					return `${m.role}: ${stripPrivateContent(text).slice(0, 2000)}`;
				})
				.filter(Boolean);

			if (!messages.length) return;

			// Batch into groups of captureEveryNTurns
			const batches: string[][] = [];
			if (turnCount > 0) {
				for (let i = 0; i < messages.length; i += turnCount) {
					batches.push(messages.slice(i, i + turnCount));
				}
			} else {
				batches.push(messages);
			}

			for (const batch of batches) {
				const transcript = batch.join('\n');
				const content =
					transcript.length > MAX_CONVERSATION_CHARS
						? `${transcript.slice(0, MAX_CONVERSATION_CHARS)}\n...[truncated]`
						: transcript;

				try {
					await smFetch(cfg.baseUrl, cfg.apiKey, '/v3/documents', 'POST', {
						content,
						containerTag: tags.canonical,
						metadata: {
							type: 'conversation',
							sm_source: 'commandcode',
							sm_scope: 'personal',
							sm_capture_mode: 'automatic',
						},
						entityContext: AGENT_ENTITY_CONTEXT,
					});
				} catch {
					// silent
				}
			}
		},
	});

	// ─── Preemptive Compaction (onTurnEnd) ───────────────────────────────

	let lastCompactionTime = 0;
	let compactionInProgress = false;

	cmd.hooks({
		onTurnEnd: async ({state, usage}, ctx) => {
			const cfg = resolveConfig(cmd);
			if (!cfg.apiKey || compactionInProgress) return state;

			const now = Date.now();
			if (now - lastCompactionTime < COMPACTION_COOLDOWN_MS) return state;

			// usage.inputTokens is this turn's whole prompt (cache reads are included in it as
			// inputTokenDetails, so never add them) - the real context size. Fall back to a
			// message-count estimate only when the provider reported nothing.
			const reportedTokens = typeof usage?.inputTokens === 'number' ? usage.inputTokens : 0;
			const estimatedTokens = reportedTokens > 0 ? reportedTokens : (state.messages?.length ?? 0) * 2000;
			const usageRatio = estimatedTokens / cfg.contextLimit;

			// The floor exists to skip trivially small sessions; it must never exceed the ratio
			// gate, or a small configured contextLimit would make the trigger unreachable.
			const minTokens = Math.min(MIN_TOKENS_FOR_COMPACTION, cfg.contextLimit * cfg.compactionThreshold);

			if (estimatedTokens < minTokens || usageRatio < cfg.compactionThreshold) {
				return state;
			}

			compactionInProgress = true;
			lastCompactionTime = now;

			try {
				// Fetch project memories and inject a compaction context message
				const listResult = await smFetch(cfg.baseUrl, cfg.apiKey, '/v3/documents/list', 'POST', {
					containerTags: tags.projectReads,
					filters: {AND: [{key: 'sm_scope', value: 'project'}]},
					limit: cfg.maxProjectMemories,
					order: 'desc',
					sort: 'createdAt',
					includeContent: true,
				});

				const projMemories = ((listResult as any).memories ?? [])
					.map((m: any) => m.content ?? m.summary ?? m.title ?? '')
					.filter(Boolean);

				if (!projMemories.length) return state;

				const compactionMsg = [
					'[SUPERMEMORY COMPACTION]',
					'Context is near capacity. Preserve these project facts during compaction:',
					...projMemories.map((m: string) => `- ${m}`),
					'End of SuperMemory context.',
				].join('\n');

				const session = (ctx as unknown as {session?: typeof cmd.session} | undefined)?.session ?? cmd.session;
				if (session) {
					const {message} = session.appendCustomMessageEntry({
						customType: 'supermemory/compaction',
						content: compactionMsg,
						display: false,
					});
					if (message) {
						return {...state, messages: [...state.messages, message]};
					}
				}
			} catch {
				// silent
			} finally {
				compactionInProgress = false;
			}

			return state;
		},
	});

	// ─── Slash Commands ──────────────────────────────────────────────────

	cmd.addCommand({
		name: 'memory',
		description:
			'SuperMemory: /memory add|search|profile|list|forget|help [args]',
		argumentHint: '<mode> [args]',
		handler: ({args}) => {
			const trimmed = args.trim();
			const match = trimmed.match(/^(add|search|profile|list|forget|help)\s*([\s\S]*)$/);
			if (!match) {
				return {
					message:
						'Usage: /memory <add|search|profile|list|forget|help> [args]\n\nModes:\n  add <text>         — Store a memory\n  search <query>     — Search memories\n  profile [query]    — View user profile\n  list [scope]       — List recent memories\n  forget <id>        — Delete a memory\n  help               — Show usage guide',
				};
			}
			const [, mode, rest] = match;
			if (mode === 'help') {
				return {prompt: 'Call the supermemory tool with mode: "help".'};
			}
			if (mode === 'profile') {
				return {
					prompt: `Call the supermemory tool with mode: "profile"${rest.trim() ? ` and query: "${rest.trim()}"` : ''}.`,
				};
			}
			if (mode === 'list') {
				const scope = rest.trim() || 'project';
				return {
					prompt: `Call the supermemory tool with mode: "list" and scope: "${scope}".`,
				};
			}
			if (mode === 'search' && rest.trim()) {
				return {
					prompt: `Call the supermemory tool with mode: "search" and query: "${rest.trim()}".`,
				};
			}
			if (mode === 'add' && rest.trim()) {
				return {
					prompt: `Call the supermemory tool with mode: "add" and content: "${rest.trim()}".`,
				};
			}
			if (mode === 'forget' && rest.trim()) {
				return {
					prompt: `Call the supermemory tool with mode: "forget" and memory_id: "${rest.trim()}".`,
				};
			}
			return {message: `Usage: /memory ${mode} <required argument>`};
		},
	});

	cmd.addCommand({
		name: 'supermemory-index',
		description: 'Index the codebase into SuperMemory for project knowledge',
		handler: () => ({
			prompt: `Explore this codebase thoroughly. Then use the supermemory tool with mode: "add" to store what you found. Use scope: "project" and type: "architecture". Include:
1. Project structure and key directories
2. Tech stack and dependencies
3. Build/test commands
4. Coding conventions and patterns
5. Architecture decisions visible in the code

Be thorough — this will be used as project memory for future sessions.`,
		}),
	});
}
