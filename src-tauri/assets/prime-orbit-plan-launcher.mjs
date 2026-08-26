import { pathToFileURL } from "node:url";

function requiredPath(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required Prime Orbit runtime path: ${name}`);
	}
	return value;
}

const agentIndexPath = requiredPath("PRIME_ORBIT_AGENT_INDEX_PATH");
const { main } = await import(pathToFileURL(agentIndexPath).href);
if (typeof main !== "function") {
	throw new Error("Prime Agent's programmatic Plan runtime is unavailable");
}

// A process-local extension factory deliberately selects Prime Agent's native
// in-process RPC runtime. Blocking extension UI requests then travel directly
// over this process' JSONL stdio instead of through the daemon supervisor,
// whose v0.8 snapshot/backpressure catch-up cannot replay them.
// The real Plan extension remains the explicit --extension argument and is
// loaded by Prime Agent's own TypeScript loader.
const forceProcessLocalRpc = () => {};
await main(process.argv.slice(2), { extensionFactories: [forceProcessLocalRpc] });
