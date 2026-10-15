/**
 * Offline checks for the bundle's fetch rule. Run: node verify.mjs
 *
 * Replaces `globalThis.fetch` with a recorder, activates the plugin against a
 * stub context, and asserts the four decisions that matter: inject when the
 * header is missing, leave it alone when it is present, ignore other hosts, and
 * restore fetch on unload.
 */
import assert from 'node:assert/strict';
import { apply } from './index.js';

const HEADER = 'x-opencode-session';
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
	calls.push({ input, init });
	return Promise.resolve({ ok: true });
};
const recorder = globalThis.fetch;

const disposers = [];
const ctx = { effect: (fn) => { const dispose = fn(); disposers.push(dispose); return dispose; } };

/** The header value the last recorded call would put on the wire. */
function headerOfLastCall() {
	const call = calls.at(-1);
	const isRequest = typeof Request !== 'undefined' && call.input instanceof Request;
	const source = call.init?.headers ?? (isRequest ? call.input.headers : void 0);
	return new Headers(source).get(HEADER);
}

try {
	apply(ctx);

	// 1. Qualifying host, header missing -> injected, format alphanumeric.
	await globalThis.fetch('https://opencode.ai/zen/go/v1/responses', {
		method: 'POST',
		headers: { authorization: 'Bearer test' }
	});
	assert.match(headerOfLastCall(), /^dsh[0-9a-f]{8}$/, 'injects on a qualifying request');

	// 2. Header already present in another casing -> untouched.
	await globalThis.fetch('https://opencode.ai/zen/go/v1/responses', {
		headers: { 'X-OpenCode-Session': 'keep-me' }
	});
	assert.equal(headerOfLastCall(), 'keep-me', 'never overwrites a caller-supplied value');

	// 3. Other hosts -> untouched.
	await globalThis.fetch('https://api.deepseek.com/anthropic/v1/messages', {
		headers: { authorization: 'Bearer test' }
	});
	assert.equal(headerOfLastCall(), null, 'leaves other providers alone');

	// 4. Subdomain of a target host -> injected.
	await globalThis.fetch('https://edge.opencode.ai/zen/go/v1/responses');
	assert.match(headerOfLastCall(), /^dsh[0-9a-f]{8}$/, 'covers subdomains');

	// 5. Request object without init -> rebuilt with the header.
	await globalThis.fetch(new Request('https://opencode.ai/zen/go/v1/responses', {
		headers: { authorization: 'Bearer test' }
	}));
	assert.match(headerOfLastCall(), /^dsh[0-9a-f]{8}$/, 'handles a Request argument');

	// 6. Malformed input -> passed through, never thrown.
	await globalThis.fetch('not a url');
	assert.equal(headerOfLastCall(), null, 'passes through an unparseable target');

	// 7. Second activation does not stack wrappers.
	const installed = globalThis.fetch;
	apply(ctx);
	assert.equal(globalThis.fetch, installed, 're-activation is a no-op');

	// 8. Unload restores the original fetch.
	for (const dispose of disposers) dispose();
	assert.equal(globalThis.fetch, recorder, 'unload restores fetch');

	console.log('verify: 8 checks passed');
} finally {
	globalThis.fetch = realFetch;
}
