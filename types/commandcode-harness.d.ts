/**
 * Minimal local type surface for `@commandcode/harness`.
 *
 * Command Code bundles the harness inside the app and ships no `.d.ts` files, so this
 * hand-written shim exists purely so `npm run typecheck` and editor IntelliSense work
 * without the app installed. It is deliberately permissive - anything the mod casts
 * itself is typed `any` here. When the mod needs a fix, loosen this file, not the mod.
 *
 * Mirrors the public ModApi docs (https://commandcode.ai/docs/mods) as of
 * Command Code 0.1.37 / @commandcode/harness 0.1.0. The ModApi is documented as
 * experimental, so re-check the docs before widening this surface.
 */

export interface Disposable {
	dispose(): void;
}

export interface ModUi {
	notify(message: string, level?: 'info' | 'notice' | 'warning' | 'error'): void;
	confirm(options: {title: string; message?: string}): Promise<boolean>;
	select(options: {title: string; options: string[]}): Promise<string | undefined>;
	input(options: {title: string; placeholder?: string}): Promise<string | undefined>;
}

export interface ModSession {
	appendCustomEntry(entry: {customType: string; data?: unknown}): {entryId: string};
	appendCustomMessageEntry(entry: {
		customType: string;
		content: unknown;
		display?: boolean;
		details?: unknown;
	}): {entryId: string; message: any};
	getCustomEntries(options: {
		customType: string;
	}): ReadonlyArray<{customType: string; data?: unknown}>;
}

export type ToolResult =
	| {ok: true; content: Array<{type: 'text'; text: string}>}
	| {ok: false; error: string};

export interface ToolModule {
	schema: {
		name: string;
		description: string;
		input_schema: Record<string, unknown>;
	};
	readOnly?: boolean;
	run: (args: {
		input: Record<string, any>;
		runtime?: any;
		signal?: any;
	}) => ToolResult | Promise<ToolResult>;
}

export interface ModHooks {
	transformInput?: (
		args: {text: string},
		ctx?: any,
	) =>
		| {action: 'transform'; text: string}
		| {action: 'handled'; message?: string}
		| {action: 'continue'}
		| undefined;

	appendSystemPrompt?: (
		args: {state: any},
		ctx?: any,
	) => string | undefined | Promise<string | undefined>;

	onRunEnd?: (
		args: {state: any; result?: any},
		ctx?: any,
	) => void | Promise<void>;

	onTurnEnd?: (
		args: {state: any; turnNumber?: number; hadToolCalls?: boolean; usage?: any},
		ctx?: any,
	) => any | Promise<any>;
}

export interface ModApi {
	readonly name: string;
	readonly cwd: string;
	readonly ui: ModUi;
	readonly session: ModSession | undefined;

	addFlag(
		name: string,
		options: {type: 'boolean' | 'string'; default?: unknown; description?: string},
	): Disposable;

	getFlag(name: string): boolean | string | undefined;

	addTool(tool: ToolModule): Disposable;

	addCommand(command: {
		name: string;
		description?: string;
		argumentHint?: string;
		handler: (args: {
			args: string;
			cwd: string;
			ui: ModUi;
			exec: ModApi['exec'];
		}) => {prompt?: string; message?: string} | void | Promise<{prompt?: string; message?: string} | void>;
	}): Disposable;

	hooks(hooks: ModHooks): Disposable;

	exec(args: {
		command: string;
		args?: string[];
		cwd?: string;
		signal?: any;
	}): Promise<{stdout: string; stderr: string; code: number}>;
}
