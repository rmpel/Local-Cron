import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as Local from '@getflywheel/local';
import * as LocalMain from '@getflywheel/local/main';
import {
	ADDON_NAME, CronSettings, CronState, DEFAULT_SETTINGS, INTERVALS, IPC_EVENTS, LastRun, MODE_LABELS, SITE_KEY,
} from './constants';
import { CronEntry, matches, parseCrontab } from './crontab';
import { appendLog, logSize, tailLog, timestamp } from './log';

/** Web and CLI runs are killed after this long; custom commands never are. */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
/** Output kept per run, for the log and the last-run summary. */
const MAX_OUTPUT_BYTES = 64 * 1024;
/** Fire ticks a little after the minute starts, so timer jitter never lands in the previous minute. */
const TICK_OFFSET_MS = 500;
/** An interval counts as elapsed this much early, so a 5-minute interval never slips to 6 minutes. */
const INTERVAL_SLACK_MS = 30 * 1000;

interface RunResult {
	ok: boolean;
	summary: string;
	output: string;
}

interface SiteRuntime {
	/** Set while a web/cli run holds the lock. */
	lockedSince: number | null;
	/** Start of the last scheduled web/cli run; cleared to run on the next tick. */
	lastStart: number | null;
	lastRun: LastRun | null;
	/** Everything currently running for the site, so a site stop can kill it. */
	cancels: Set<() => void>;
	runningCustom: number;
}

export default function (context: LocalMain.AddonMainContext): void {
	const { electron } = context;
	const { siteData, siteProcessManager, lightningServices, localLogger } = LocalMain.getServiceContainer().cradle as any;

	const logger = localLogger.child({ thread: 'main', addon: ADDON_NAME });

	const runtimes = new Map<string, SiteRuntime>();
	const runtimeFor = (siteId: string): SiteRuntime => {
		if (!runtimes.has(siteId)) {
			runtimes.set(siteId, { lockedSince: null, lastStart: null, lastRun: null, cancels: new Set(), runningCustom: 0 });
		}
		return runtimes.get(siteId);
	};

	const toSite = (site: any): Local.Site => (site instanceof Local.Site ? site : new Local.Site(site));

	/**
	 * The directory the site is actually served from. Local's paths.webRoot is
	 * always app/public, but composer-based sites point the DocumentRoot (or
	 * nginx root) in conf/ at e.g. app/public_html, so the config wins.
	 */
	const webRootFor = (site: any): string => {
		const sitePath = LocalMain.formatHomePath(site.path);
		const localRoot = toSite(site).paths.webRoot;
		const configs: [string, RegExp][] = [
			[path.join(sitePath, 'conf', 'apache', 'site.conf.hbs'), /^\s*DocumentRoot\s+"?([^"\n]+?)"?\s*$/m],
			[path.join(sitePath, 'conf', 'nginx', 'site.conf.hbs'), /^\s*root\s+"?([^";\n]+?)"?\s*;/m],
		];
		for (const [file, pattern] of configs) {
			try {
				const root = fs.readFileSync(file, 'utf8').match(pattern)?.[1]?.trim();
				if (root && !root.includes('{{')) {
					const resolved = path.resolve(sitePath, LocalMain.formatHomePath(root));
					if (fs.existsSync(resolved)) {
						return resolved;
					}
				}
			} catch {
				// not this web server
			}
		}
		return fs.existsSync(localRoot) ? localRoot : sitePath;
	};

	const defaultCrontab = (site: any): string => {
		const webRoot = webRootFor(site);
		const relative = path.relative(LocalMain.formatHomePath(site.path), webRoot) || '.';
		return `# Commands run in this site's web root: ${path.basename(webRoot)} (${relative})\n`
			+ DEFAULT_SETTINGS.crontab;
	};

	const settingsFor = (site: any): CronSettings => {
		const saved = site?.[SITE_KEY] ?? {};
		return {
			...DEFAULT_SETTINGS,
			...(site && saved.crontab === undefined ? { crontab: defaultCrontab(site) } : {}),
			...saved,
		};
	};

	const isRunning = (site: any): boolean => siteProcessManager.getSiteStatus(site) === 'running';

	const logPathFor = (site: any): string => path.join(LocalMain.formatHomePath(site.path), 'logs', 'cron', 'cron.log');

	/** The environment of Local's "Open site shell": the site's PHP, MySQL, WP-CLI and Composer first on PATH. */
	const shellEnvFor = (site: Local.Site): NodeJS.ProcessEnv => {
		const env: NodeJS.ProcessEnv = { ...process.env };
		delete env.NODE_ENV;
		for (const key of Object.keys(env)) {
			if (key.startsWith('ELECTRON_')) {
				delete env[key];
			}
		}
		const resources = (process as any).electronPaths?.resourcesPath
			?? path.join((process as any).resourcesPath, 'extraResources');
		const platformDir = process.platform === 'win32' ? 'win32' : 'posix';
		const php = lightningServices.getSiteServiceByRole(site, 'php');
		const db = lightningServices.getSiteServiceByRole(site, 'database');
		env.PATH = [
			path.join(resources, 'bin', 'composer', platformDir),
			path.join(resources, 'bin', 'wp-cli', platformDir),
			php?.$PATH,
			db?.$PATH,
			env.PATH,
		].filter(Boolean).join(path.delimiter);
		if (php?.configPath) {
			env.PHPRC = php.configPath;
		}
		if (db?.configPath) {
			env.MYSQL_HOME = db.configPath;
		}
		env.WP_CLI_CONFIG_PATH = path.join(resources, 'bin', 'wp-cli', 'config.yaml');
		env.WP_CLI_DISABLE_AUTO_CHECK_UPDATE = '1';
		return env;
	};

	const limitOutput = (chunks: Buffer[]): string => {
		const all = Buffer.concat(chunks);
		return all.length > MAX_OUTPUT_BYTES
			? `${all.subarray(0, MAX_OUTPUT_BYTES).toString('utf8')}\n[output truncated]`
			: all.toString('utf8');
	};

	const lastLine = (text: string): string => text.trim().split('\n').pop()?.trim().slice(0, 200) ?? '';

	/** Runs a shell command in the site's web root; resolves (never rejects) when it ends. */
	const runCommand = (
		site: Local.Site,
		command: string,
		extraEnv: Record<string, string>,
		timeoutMs: number | null,
	): Promise<RunResult> => new Promise((resolve) => {
		const runtime = runtimeFor(site.id);
		const env = shellEnvFor(site);
		// NAME=value lines may reference earlier variables: PATH=/opt/homebrew/bin:$PATH
		for (const [key, value] of Object.entries(extraEnv)) {
			env[key] = value.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, a, b) => env[a ?? b] ?? '');
		}

		const chunks: Buffer[] = [];
		let size = 0;
		let stopReason: string | null = null;
		let child: ChildProcess;
		try {
			child = spawn(command, {
				cwd: webRootFor(site),
				env,
				shell: process.platform === 'win32' ? true : '/bin/sh',
				// Own process group, so a kill takes the whole command tree down.
				detached: process.platform !== 'win32',
				windowsHide: true,
			});
		} catch (err) {
			resolve({ ok: false, summary: `could not start: ${err?.message ?? err}`, output: '' });
			return;
		}

		const collect = (chunk: Buffer) => {
			if (size <= MAX_OUTPUT_BYTES) {
				chunks.push(chunk);
				size += chunk.length;
			}
		};
		child.stdout?.on('data', collect);
		child.stderr?.on('data', collect);

		const kill = (reason: string) => {
			stopReason = reason;
			try {
				if (process.platform === 'win32') {
					spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
				} else {
					process.kill(-child.pid, 'SIGTERM');
				}
			} catch {
				child.kill('SIGTERM');
			}
		};
		const cancel = () => kill('killed: site stopped');
		runtime.cancels.add(cancel);
		const timer = timeoutMs ? setTimeout(() => kill(`killed: timed out after ${timeoutMs / 60000} minutes`), timeoutMs) : null;

		let done = false;
		const finish = (result: RunResult) => {
			if (done) {
				return;
			}
			done = true;
			if (timer) {
				clearTimeout(timer);
			}
			runtime.cancels.delete(cancel);
			resolve(result);
		};
		child.on('error', (err) => finish({ ok: false, summary: err.message, output: limitOutput(chunks) }));
		child.on('close', (code, signal) => {
			const output = limitOutput(chunks);
			if (stopReason) {
				finish({ ok: false, summary: stopReason, output });
			} else if (code === 0) {
				finish({ ok: true, summary: lastLine(output) || 'exit 0', output });
			} else {
				finish({ ok: false, summary: `exit ${code ?? signal}${lastLine(output) ? `: ${lastLine(output)}` : ''}`, output });
			}
		});
	});

	/** GET wp-cron.php, following redirects (e.g. to https) and accepting Local's self-signed certificates. */
	const requestCron = (site: Local.Site): Promise<RunResult> => new Promise((resolve) => {
		const runtime = runtimeFor(site.id);
		let current: http.ClientRequest | null = null;
		let stopReason: string | null = null;
		let done = false;

		const cancel = () => {
			stopReason = 'aborted: site stopped';
			current?.destroy();
		};
		runtime.cancels.add(cancel);
		const finish = (result: RunResult) => {
			if (!done) {
				done = true;
				runtime.cancels.delete(cancel);
				resolve(result);
			}
		};

		const get = (url: string, redirectsLeft: number) => {
			const client = url.startsWith('https:') ? https : http;
			current = client.get(url, { rejectUnauthorized: false, timeout: RUN_TIMEOUT_MS } as https.RequestOptions, (res) => {
				const status = res.statusCode ?? 0;
				if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
					res.resume();
					get(new URL(res.headers.location, url).toString(), redirectsLeft - 1);
					return;
				}
				const chunks: Buffer[] = [];
				let size = 0;
				res.on('data', (chunk: Buffer) => {
					if (size <= MAX_OUTPUT_BYTES) {
						chunks.push(chunk);
						size += chunk.length;
					}
				});
				res.on('end', () => finish({
					ok: status >= 200 && status < 300,
					summary: `HTTP ${status} from ${url.replace(/\?.*$/, '')}`,
					output: limitOutput(chunks),
				}));
			});
			current.on('timeout', () => {
				stopReason = `timed out after ${RUN_TIMEOUT_MS / 60000} minutes`;
				current.destroy();
			});
			current.on('error', (err) => finish({ ok: false, summary: stopReason ?? err.message, output: '' }));
		};

		const base = site.url.replace(/\/+$/, '');
		get(`${base}/wp-cron.php?doing_wp_cron=${(Date.now() / 1000).toFixed(4)}`, 5);
	});

	/** WP-CLI's due-now runner; on multisite once per (sub)site, as wp-cron.php only covers one. */
	const runWpCli = async (site: Local.Site): Promise<RunResult> => {
		const command = 'wp cron event run --due-now';
		if (!site.multiSite) {
			return runCommand(site, command, {}, RUN_TIMEOUT_MS);
		}
		const list = await runCommand(site, 'wp site list --field=url --archived=0 --deleted=0 --spam=0', {}, RUN_TIMEOUT_MS);
		if (!list.ok) {
			return list;
		}
		const urls = list.output.split('\n').map((url) => url.trim()).filter((url) => /^https?:\/\//.test(url));
		const outputs: string[] = [];
		let failed = 0;
		for (const url of urls) {
			const result = await runCommand(site, `${command} --url='${url.replace(/'/g, '')}'`, {}, RUN_TIMEOUT_MS);
			outputs.push(`--- ${url}\n${result.output.trim()}`);
			if (!result.ok) {
				failed++;
			}
			if (!isRunning(site)) {
				break;
			}
		}
		return {
			ok: failed === 0,
			summary: `${urls.length} site(s), ${failed ? `${failed} failed` : 'all OK'}`,
			output: outputs.join('\n'),
		};
	};

	const record = (site: Local.Site, label: string, startedAt: number, result: RunResult) => {
		const durationMs = Date.now() - startedAt;
		runtimeFor(site.id).lastRun = { at: startedAt, label, ok: result.ok, durationMs, summary: result.summary };
		if (!result.ok) {
			logger.warn(`Cron ${label} failed for site ${site.name}: ${result.summary}`);
		}
		if (!settingsFor(siteData.getSite(site.id)).logging) {
			return;
		}
		const lines = [`[${timestamp(new Date(startedAt))}] ${result.ok ? 'OK  ' : 'FAIL'} ${label} (${(durationMs / 1000).toFixed(1)}s) ${result.summary}`];
		const output = result.output.trim();
		if (output && !(lastLine(output) === result.summary && !output.includes('\n'))) {
			lines.push(...output.split('\n').map((line) => `    ${line}`));
		}
		try {
			appendLog(logPathFor(site), lines);
		} catch (err) {
			logger.warn(`Could not write the cron log for site ${site.name}: ${err?.message ?? err}`);
		}
	};

	const logSkip = (site: Local.Site, label: string, reason: string) => {
		if (settingsFor(siteData.getSite(site.id)).logging) {
			try {
				appendLog(logPathFor(site), [`[${timestamp()}] SKIP ${label} ${reason}`]);
			} catch {
				// a skip note is not worth a warning
			}
		}
	};

	/** A web or CLI run, under the site's lock: never two at once. */
	const runLocked = async (site: Local.Site, mode: 'web' | 'cli'): Promise<void> => {
		const runtime = runtimeFor(site.id);
		if (runtime.lockedSince !== null) {
			logSkip(site, mode, `previous run still in progress (since ${timestamp(new Date(runtime.lockedSince))})`);
			return;
		}
		const startedAt = Date.now();
		runtime.lockedSince = startedAt;
		try {
			const result = mode === 'web' ? await requestCron(site) : await runWpCli(site);
			record(site, mode, startedAt, result);
		} catch (err) {
			record(site, mode, startedAt, { ok: false, summary: err?.message ?? String(err), output: '' });
		} finally {
			runtime.lockedSince = null;
		}
	};

	const runCustom = async (site: Local.Site, entry: CronEntry): Promise<void> => {
		const runtime = runtimeFor(site.id);
		const startedAt = Date.now();
		runtime.runningCustom++;
		try {
			record(site, `${entry.schedule} ${entry.command}`, startedAt, await runCommand(site, entry.command, entry.env, null));
		} finally {
			runtime.runningCustom--;
		}
	};

	const tick = () => {
		const now = new Date();
		for (const siteJson of Object.values<any>(siteData.getSites())) {
			const settings = settingsFor(siteJson);
			if (settings.mode === 'disabled' || !isRunning(siteJson)) {
				continue;
			}
			const site = toSite(siteJson);
			const runtime = runtimeFor(site.id);
			if (settings.mode === 'custom') {
				for (const entry of parseCrontab(settings.crontab).entries) {
					if (matches(entry, now)) {
						runCustom(site, entry);
					}
				}
				continue;
			}
			if (runtime.lastStart === null || now.getTime() - runtime.lastStart >= settings.interval * 60000 - INTERVAL_SLACK_MS) {
				runtime.lastStart = now.getTime();
				runLocked(site, settings.mode);
			}
		}
	};

	let nextTickAt = 0;
	const scheduleTick = () => {
		const now = Date.now();
		nextTickAt = now - (now % 60000) + 60000 + TICK_OFFSET_MS;
		setTimeout(() => {
			try {
				tick();
			} catch (err) {
				logger.error(`Cron tick failed: ${err?.message ?? err}`);
			}
			scheduleTick();
		}, nextTickAt - now);
	};
	scheduleTick();

	const cancelAll = (siteId: string) => {
		for (const cancel of [...runtimeFor(siteId).cancels]) {
			cancel();
		}
	};

	LocalMain.HooksMain.addAction('siteStarted', (siteJson: any) => {
		const settings = settingsFor(siteData.getSite(siteJson.id) ?? siteJson);
		runtimeFor(siteJson.id).lastStart = null;
		if (settings.mode !== 'custom') {
			return;
		}
		const site = toSite(siteData.getSite(siteJson.id) ?? siteJson);
		for (const entry of parseCrontab(settings.crontab).entries.filter((e) => e.reboot)) {
			runCustom(site, entry);
		}
	});

	// Cron never runs for a stopped site: anything still running is killed.
	LocalMain.HooksMain.addAction('siteStopped', (siteJson: any) => cancelAll(siteJson.id));
	electron.app.on('before-quit', () => runtimes.forEach((_, siteId) => cancelAll(siteId)));

	const buildState = (siteId: string): CronState | null => {
		const siteJson = siteData.getSite(siteId);
		if (!siteJson) {
			return null;
		}
		const settings = settingsFor(siteJson);
		const runtime = runtimeFor(siteId);
		const siteRunning = isRunning(siteJson);
		let nextRun: number | null = null;
		if (siteRunning && (settings.mode === 'web' || settings.mode === 'cli')) {
			nextRun = runtime.lastStart === null
				? nextTickAt
				: Math.max(nextTickAt, runtime.lastStart + settings.interval * 60000 - INTERVAL_SLACK_MS + TICK_OFFSET_MS);
			// Ticks happen on minute boundaries.
			nextRun = Math.ceil((nextRun - TICK_OFFSET_MS) / 60000) * 60000;
		}
		const logPath = logPathFor(siteJson);
		return {
			settings,
			siteRunning,
			locked: runtime.lockedSince !== null,
			runningCustom: runtime.runningCustom,
			lastRun: runtime.lastRun,
			nextRun,
			webRoot: webRootFor(siteJson),
			logPath,
			logSize: logSize(logPath),
		};
	};

	LocalMain.addIpcAsyncListener(IPC_EVENTS.GET_STATE, async (siteId: string) => buildState(siteId));

	LocalMain.addIpcAsyncListener(IPC_EVENTS.SAVE_SETTINGS, async (siteId: string, patch: Partial<CronSettings>) => {
		const siteJson = siteData.getSite(siteId);
		if (!siteJson) {
			return null;
		}
		const previous = settingsFor(siteJson);
		const next: CronSettings = { ...previous, ...patch };
		if (!(next.mode in MODE_LABELS)) {
			next.mode = 'disabled';
		}
		if (!INTERVALS.includes(Number(next.interval))) {
			next.interval = DEFAULT_SETTINGS.interval;
		}
		next.interval = Number(next.interval);
		next.crontab = String(next.crontab ?? '');
		next.logging = Boolean(next.logging);

		siteData.updateSite(siteId, { id: siteId, [SITE_KEY]: next } as Partial<Local.SiteJSON>);
		if (next.mode !== previous.mode || next.interval !== previous.interval) {
			// A new schedule starts on the next tick rather than waiting out the old interval.
			runtimeFor(siteId).lastStart = null;
			logger.info(`Cron for site ${siteId} set to ${next.mode}${next.mode === 'web' || next.mode === 'cli' ? ` every ${next.interval} min` : ''}.`);
		}
		return buildState(siteId);
	});

	/** Run now: the web/cli job (lock respected), or the custom entry on the given crontab line. */
	LocalMain.addIpcAsyncListener(IPC_EVENTS.RUN_NOW, async (siteId: string, line?: number) => {
		const siteJson = siteData.getSite(siteId);
		if (!siteJson || !isRunning(siteJson)) {
			return buildState(siteId);
		}
		const settings = settingsFor(siteJson);
		const site = toSite(siteJson);
		if (settings.mode === 'web' || settings.mode === 'cli') {
			runLocked(site, settings.mode);
		} else if (settings.mode === 'custom') {
			const entry = parseCrontab(settings.crontab).entries.find((e) => e.line === line);
			if (entry) {
				runCustom(site, entry);
			}
		}
		return buildState(siteId);
	});

	LocalMain.addIpcAsyncListener(IPC_EVENTS.READ_LOG, async (siteId: string) => {
		const siteJson = siteData.getSite(siteId);
		return siteJson ? tailLog(logPathFor(siteJson)) : null;
	});

	LocalMain.addIpcAsyncListener(IPC_EVENTS.CLEAR_LOG, async (siteId: string) => {
		const siteJson = siteData.getSite(siteId);
		if (siteJson) {
			for (const file of [logPathFor(siteJson), `${logPathFor(siteJson)}.1`]) {
				try {
					fs.unlinkSync(file);
				} catch {
					// already gone
				}
			}
		}
		return buildState(siteId);
	});

	LocalMain.addIpcAsyncListener(IPC_EVENTS.REVEAL_LOG, async (siteId: string) => {
		const siteJson = siteData.getSite(siteId);
		if (siteJson) {
			const logPath = logPathFor(siteJson);
			if (fs.existsSync(logPath)) {
				electron.shell.showItemInFolder(logPath);
			} else {
				fs.mkdirSync(path.dirname(logPath), { recursive: true });
				electron.shell.openPath(path.dirname(logPath));
			}
		}
	});

	LocalMain.addIpcAsyncListener(IPC_EVENTS.OPEN_LOG, async (siteId: string) => {
		const siteJson = siteData.getSite(siteId);
		if (siteJson && fs.existsSync(logPathFor(siteJson))) {
			await electron.shell.openPath(logPathFor(siteJson));
		}
	});
}
