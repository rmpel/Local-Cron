export const ADDON_NAME = 'local-cron';

/**
 * The per-site settings, persisted into Local's sites.json via
 * siteData.updateSite() so they travel with the site record.
 */
export const SITE_KEY = 'localCron';

export type CronMode = 'disabled' | 'web' | 'cli' | 'custom';

export interface CronSettings {
	mode: CronMode;
	/** Minutes between runs, for the web and cli modes. */
	interval: number;
	/** Crontab-style lines, for the custom mode. */
	crontab: string;
	logging: boolean;
}

export const DEFAULT_SETTINGS: CronSettings = {
	mode: 'disabled',
	interval: 5,
	crontab: '# m h dom mon dow command\n*/15 * * * * wp cron event run --due-now\n',
	logging: false,
};

export const INTERVALS = [1, 2, 5, 10, 15, 30, 60];

export const MODE_LABELS: Record<CronMode, string> = {
	disabled: 'Disabled',
	web: 'Web (wp-cron.php)',
	cli: 'CLI (WP-CLI)',
	custom: 'Custom (crontab)',
};

export const IPC_EVENTS = {
	GET_STATE: 'local-cron:get-state',
	SAVE_SETTINGS: 'local-cron:save-settings',
	RUN_NOW: 'local-cron:run-now',
	READ_LOG: 'local-cron:read-log',
	CLEAR_LOG: 'local-cron:clear-log',
	REVEAL_LOG: 'local-cron:reveal-log',
	OPEN_LOG: 'local-cron:open-log',
};

export interface LastRun {
	at: number;
	/** "web", "cli", or the custom command line. */
	label: string;
	ok: boolean;
	durationMs: number;
	summary: string;
}

export interface CronState {
	settings: CronSettings;
	siteRunning: boolean;
	/** A web/cli run holds the site's lock. */
	locked: boolean;
	/** Custom commands currently running. */
	runningCustom: number;
	lastRun: LastRun | null;
	/** Next scheduled web/cli run, while the site runs. */
	nextRun: number | null;
	/** Where custom and CLI commands run: the site's real document root. */
	webRoot: string;
	logPath: string;
	logSize: number | null;
}
