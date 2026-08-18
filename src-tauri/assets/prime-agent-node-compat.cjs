"use strict";

// Prime Agent is currently developed primarily on Unix. Prime Orbit loads this
// compatibility layer only for source-based RPC sessions on Windows; NODE_OPTIONS
// then carries it into the daemon's Node workers.
if (process.platform === "win32") {
	const sentinel = Symbol.for("prime-orbit.windows-node-compat.v1");
	if (!globalThis[sentinel]) {
		globalThis[sentinel] = true;

		const childProcess = require("node:child_process");
		const fs = require("node:fs");
		const path = require("node:path");
		const { syncBuiltinESMExports } = require("node:module");
		const { promisify } = require("node:util");

		const original = {
			spawn: childProcess.spawn,
			spawnSync: childProcess.spawnSync,
			execFile: childProcess.execFile,
			execFileSync: childProcess.execFileSync,
			exec: childProcess.exec,
			execSync: childProcess.execSync,
			fork: childProcess.fork,
			renameSync: fs.renameSync,
		};

		function hidden(options) {
			if (options === undefined || options === null) return { windowsHide: true };
			if (typeof options !== "object") return options;
			return { ...options, windowsHide: true };
		}

		function compatiblePython(value) {
			if (typeof value !== "string" || !/[\\/]bin[\\/]python(?:\.exe)?$/i.test(value)) return value;
			const normalized = path.win32.normalize(value);
			if (!path.win32.isAbsolute(normalized)) return value;
			const candidate = path.win32.join(path.win32.dirname(path.win32.dirname(normalized)), "Scripts", "python.exe");
			try {
				const originalMetadata = fs.lstatSync(normalized);
				if (originalMetadata.isFile() && !originalMetadata.isSymbolicLink()) return value;
			} catch {
				// The missing POSIX-layout interpreter is the v0.7.3 Windows bug.
			}
			try {
				const metadata = fs.lstatSync(candidate);
				return metadata.isFile() && !metadata.isSymbolicLink() ? candidate : value;
			} catch {
				return value;
			}
		}

		function compatibleArguments(args) {
			return Array.isArray(args) ? args.map(compatiblePython) : args;
		}

		childProcess.spawn = function primeOrbitSpawn(command, args, options) {
			const compatibleCommand = compatiblePython(command);
			if (Array.isArray(args)) {
				return original.spawn.call(this, compatibleCommand, compatibleArguments(args), hidden(options));
			}
			return original.spawn.call(this, compatibleCommand, hidden(args));
		};

		childProcess.spawnSync = function primeOrbitSpawnSync(command, args, options) {
			const compatibleCommand = compatiblePython(command);
			if (Array.isArray(args)) {
				return original.spawnSync.call(this, compatibleCommand, compatibleArguments(args), hidden(options));
			}
			return original.spawnSync.call(this, compatibleCommand, hidden(args));
		};

		childProcess.execFile = function primeOrbitExecFile(file, args, options, callback) {
			const compatibleFile = compatiblePython(file);
			if (Array.isArray(args)) {
				const compatibleArgs = compatibleArguments(args);
				if (typeof options === "function") {
					return original.execFile.call(this, compatibleFile, compatibleArgs, hidden(), options);
				}
				return original.execFile.call(this, compatibleFile, compatibleArgs, hidden(options), callback);
			}
			if (typeof args === "function") {
				return original.execFile.call(this, compatibleFile, hidden(), args);
			}
			return original.execFile.call(this, compatibleFile, hidden(args), options);
		};

		childProcess.execFileSync = function primeOrbitExecFileSync(file, args, options) {
			const compatibleFile = compatiblePython(file);
			if (Array.isArray(args)) {
				return original.execFileSync.call(this, compatibleFile, compatibleArguments(args), hidden(options));
			}
			return original.execFileSync.call(this, compatibleFile, hidden(args));
		};

		childProcess.exec = function primeOrbitExec(command, options, callback) {
			if (typeof options === "function") return original.exec.call(this, command, hidden(), options);
			return original.exec.call(this, command, hidden(options), callback);
		};

		childProcess.execSync = function primeOrbitExecSync(command, options) {
			return original.execSync.call(this, command, hidden(options));
		};

		childProcess.fork = function primeOrbitFork(modulePath, args, options) {
			if (Array.isArray(args)) return original.fork.call(this, modulePath, args, hidden(options));
			return original.fork.call(this, modulePath, hidden(args));
		};

		const customPromisify = promisify.custom;
		if (typeof original.exec[customPromisify] === "function") {
			Object.defineProperty(childProcess.exec, customPromisify, {
				configurable: true,
				value(command, options) {
					return original.exec[customPromisify].call(this, command, hidden(options));
				},
			});
		}
		if (typeof original.execFile[customPromisify] === "function") {
			Object.defineProperty(childProcess.execFile, customPromisify, {
				configurable: true,
				value(file, args, options) {
					const compatibleFile = compatiblePython(file);
					if (Array.isArray(args)) {
						return original.execFile[customPromisify].call(
							this,
							compatibleFile,
							compatibleArguments(args),
							hidden(options),
						);
					}
					return original.execFile[customPromisify].call(this, compatibleFile, hidden(args));
				},
			});
		}

		function regularDirectory(value) {
			try {
				const metadata = fs.lstatSync(value);
				return metadata.isDirectory() && !metadata.isSymbolicLink();
			} catch {
				return false;
			}
		}

		function regularOwner(directory) {
			try {
				const metadata = fs.lstatSync(path.win32.join(directory, "owner.json"));
				return metadata.isFile() && !metadata.isSymbolicLink();
			} catch {
				return false;
			}
		}

		function isPrimeAgentLeaseCollision(error, source, destination) {
			if (error?.code !== "EPERM" || typeof source !== "string" || typeof destination !== "string") return false;
			const lock = path.win32.normalize(destination);
			const candidate = path.win32.normalize(source);
			if (path.win32.basename(path.win32.dirname(lock)).toLowerCase() !== "session-leases") return false;
			if (!/^[0-9a-f]{64}\.lock$/i.test(path.win32.basename(lock))) return false;
			const suffix = candidate.slice(lock.length);
			if (!/^\.candidate-[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suffix)) return false;
			// Prime Agent's guarded collision path validates or quarantines the
			// destination owner. The shim only normalizes Windows' error code and
			// never removes a lease itself.
			return regularDirectory(candidate) && regularDirectory(lock) && regularOwner(candidate);
		}

		fs.renameSync = function primeOrbitRenameSync(source, destination) {
			try {
				return original.renameSync.call(this, source, destination);
			} catch (error) {
				if (isPrimeAgentLeaseCollision(error, source, destination)) {
					error.code = "EEXIST";
				}
				throw error;
			}
		};

		// Prime Agent imports these functions as named ESM bindings. Refreshing the
		// builtin exports is what makes the CJS compatibility wrappers visible there.
		syncBuiltinESMExports();
	}
}
