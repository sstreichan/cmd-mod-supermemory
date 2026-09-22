/**
 * `@types/node` types `fetch().json()` as `Promise<unknown>` (it inherits undici's
 * `BodyMixin`), which is accurate but leaves every `const data = await ...json()` untyped -
 * exactly how this mod treats the Supermemory API responses (untyped JSON, narrowed at the
 * call site). Widening the global `Response.json()` to `any` keeps that assumption in the
 * type shim instead of forcing a cast into the mod.
 *
 * The augmentation is safe: `Response extends _Response` declares no `json()` of its own, and
 * `Promise<any>` is assignable to the inherited `Promise<unknown>`.
 */

declare global {
	interface Response {
		json(): Promise<any>;
	}
}

export {};
