/**
 * dsh-opencode-session-header — Host bundle for DeepSeek Harness.
 *
 * WHY
 *   OpenCode Go (opencode.ai/zen/go) has required the `x-opencode-session`
 *   header on every inference request since 2026-09-06; a request without it
 *   is answered with `400 {"type":"MissingSessionID"}`.
 *
 *   pi-ai ships `withOpenCodeSessionHeader`, which derives that header from
 *   `options.sessionId`, and the DSH agent loop supplies a session id — so an
 *   ordinary turn is fine. A hand-built LLM call that passes no session id,
 *   such as the `dsh-experimental-auto-review` reviewer request, reaches the
 *   wire without the header and fails.
 *
 * WHAT
 *   Wrap this process's `globalThis.fetch`. When an outbound request targets a
 *   TARGET_HOSTS host and carries no `x-opencode-session` yet, set a stable,
 *   format-valid token. A request that already carries the header, in any
 *   casing, is passed through untouched — so the agent loop keeps its own
 *   per-session value and nothing else changes.
 *
 *   The gateway checks only that the header is present and well-formed; it does
 *   not verify that the session was ever registered. A process-stable token is
 *   therefore enough, and every injected request from this process shares one
 *   routing key.
 *
 *   Touches no files, credentials, or settings. Unloading restores the
 *   original fetch, and a second activation (for example after HMR) does not
 *   stack wrappers.
 */

/** Header the OpenCode Go gateway requires. */
const HEADER = 'x-opencode-session';

/** Hosts that receive the header. Subdomains are included. */
const TARGET_HOSTS = ['opencode.ai'];

/** Token prefix; the remainder is random hex, so the value is alphanumeric. */
const TOKEN_PREFIX = 'dsh';

/** Flip to true to log every injected header to the Host console. */
const VERBOSE = false;

/** Guard so a reloaded module generation does not wrap fetch twice. */
const INSTALLED = Symbol.for('dsh.opencode-session-header.installed');

/** One process-stable, format-valid token. */
const TOKEN = `${TOKEN_PREFIX}${randomHex()}`;

/** Eight random hex digits, with a fallback for a runtime without `crypto`. */
function randomHex() {
	try {
		return globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 8);
	} catch {
		return Math.random().toString(16).slice(2, 10).padEnd(8, '0');
	}
}

/** The request URL, read from any `fetch` first argument. */
function requestUrl(input) {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.href;
	if (input !== null && typeof input === 'object' && typeof input.url === 'string') return input.url;
	return void 0;
}

/** Whether a URL's host is one of `hosts`, subdomains included. */
function hostMatches(rawUrl, hosts) {
	let hostname;
	try {
		hostname = new URL(rawUrl).hostname.toLowerCase();
	} catch {
		return false;
	}
	return hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

/**
 * Build a fetch wrapper that injects {@link HEADER} when it is missing.
 * @param original - the fetch to delegate every call to.
 * @param hosts - hosts whose requests qualify.
 * @returns the wrapper to install as `globalThis.fetch`.
 */
function wrapFetch(original, hosts) {
	return function patchedFetch(input, init) {
		try {
			const url = requestUrl(input);
			if (url === void 0 || !hostMatches(url, hosts)) return original(input, init);
			const isRequest = typeof Request !== 'undefined' && input instanceof Request;
			const source = init?.headers ?? (isRequest ? input.headers : void 0);
			const headers = new Headers(source);
			if (headers.has(HEADER)) return original(input, init);
			headers.set(HEADER, TOKEN);
			if (VERBOSE) console.log(`[opencode-session-header] injected ${HEADER} for ${url}`);
			// Without an init override the headers live on the Request itself, so
			// the call has to be rebuilt rather than merged.
			if (isRequest && init?.headers === void 0) return original(new Request(input, { headers }));
			return original(input, { ...init, headers });
		} catch {
			// Never turn a header fix into a new failure mode: fall through untouched.
			return original(input, init);
		}
	};
}

/**
 * Activate the bundle: inject the header on qualifying requests for as long as
 * this plugin stays loaded.
 * @param ctx - the plugin context that owns the registration.
 */
export function apply(ctx) {
	if (globalThis[INSTALLED] === true) return;
	const original = globalThis.fetch;
	const wrapper = wrapFetch(original, TARGET_HOSTS);
	globalThis.fetch = wrapper;
	globalThis[INSTALLED] = true;
	ctx.effect(() => () => {
		if (globalThis.fetch === wrapper) globalThis.fetch = original;
		globalThis[INSTALLED] = false;
	});
}
