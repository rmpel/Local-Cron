/**
 * A small crontab parser: five time fields (with *, lists, ranges, steps and
 * month/weekday names), the @hourly/@daily/... macros, @reboot (= when the
 * site starts), comments, and NAME=value environment lines that apply to the
 * commands below them. Pure, so the renderer can use it for live validation.
 */

export interface CronEntry {
	/** 1-based line number in the crontab text. */
	line: number;
	/** The schedule part as written, e.g. "*\/5 * * * *" or "@daily". */
	schedule: string;
	command: string;
	/** Environment in effect for this command (from NAME=value lines above it). */
	env: Record<string, string>;
	reboot: boolean;
	minutes: Set<number>;
	hours: Set<number>;
	days: Set<number>;
	months: Set<number>;
	weekdays: Set<number>;
	/** The day-of-month field was not "*". */
	daysRestricted: boolean;
	/** The day-of-week field was not "*". */
	weekdaysRestricted: boolean;
}

export interface CronParseError {
	line: number;
	message: string;
}

export interface ParsedCrontab {
	entries: CronEntry[];
	errors: CronParseError[];
}

const MACROS: Record<string, string> = {
	'@yearly': '0 0 1 1 *',
	'@annually': '0 0 1 1 *',
	'@monthly': '0 0 1 * *',
	'@weekly': '0 0 * * 0',
	'@daily': '0 0 * * *',
	'@midnight': '0 0 * * *',
	'@hourly': '0 * * * *',
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface FieldSpec {
	name: string;
	min: number;
	max: number;
	names?: string[];
	/** Value the names list starts at (1 for months, 0 for weekdays). */
	namesOffset?: number;
}

const FIELDS: FieldSpec[] = [
	{ name: 'minute', min: 0, max: 59 },
	{ name: 'hour', min: 0, max: 23 },
	{ name: 'day of month', min: 1, max: 31 },
	{ name: 'month', min: 1, max: 12, names: MONTH_NAMES, namesOffset: 1 },
	// 7 is accepted as an alias for Sunday and folded to 0 below.
	{ name: 'day of week', min: 0, max: 7, names: DAY_NAMES, namesOffset: 0 },
];

const parseValue = (raw: string, spec: FieldSpec): number => {
	const lower = raw.toLowerCase();
	if (spec.names) {
		const index = spec.names.indexOf(lower);
		if (index !== -1) {
			return index + spec.namesOffset;
		}
	}
	if (!/^\d+$/.test(raw)) {
		throw new Error(`invalid ${spec.name} value "${raw}"`);
	}
	const value = Number(raw);
	if (value < spec.min || value > spec.max) {
		throw new Error(`${spec.name} ${value} is out of range ${spec.min}-${spec.max}`);
	}
	return value;
};

const parseField = (field: string, spec: FieldSpec): Set<number> => {
	const values = new Set<number>();
	for (const part of field.split(',')) {
		const [rangePart, stepPart, extra] = part.split('/');
		if (extra !== undefined || rangePart === '') {
			throw new Error(`invalid ${spec.name} "${part}"`);
		}
		let step = 1;
		if (stepPart !== undefined) {
			if (!/^\d+$/.test(stepPart) || Number(stepPart) === 0) {
				throw new Error(`invalid ${spec.name} step "${stepPart}"`);
			}
			step = Number(stepPart);
		}
		let from: number;
		let to: number;
		if (rangePart === '*') {
			from = spec.min;
			to = spec.max;
		} else if (rangePart.includes('-')) {
			const [a, b] = rangePart.split('-');
			from = parseValue(a, spec);
			to = parseValue(b, spec);
			if (from > to) {
				throw new Error(`${spec.name} range "${rangePart}" runs backwards`);
			}
		} else {
			from = parseValue(rangePart, spec);
			// "5/15" means "from 5, every 15" like Vixie cron.
			to = stepPart !== undefined ? spec.max : from;
		}
		for (let value = from; value <= to; value += step) {
			values.add(value);
		}
	}
	if (spec.max === 7 && values.has(7)) {
		values.delete(7);
		values.add(0);
	}
	return values;
};

const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

const unquote = (value: string): string => {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === '\'') && trimmed[trimmed.length - 1] === trimmed[0]) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
};

export const parseCrontab = (text: string): ParsedCrontab => {
	const entries: CronEntry[] = [];
	const errors: CronParseError[] = [];
	const env: Record<string, string> = {};

	(text ?? '').split(/\r?\n/).forEach((rawLine, index) => {
		const line = index + 1;
		const trimmed = rawLine.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			return;
		}

		const envMatch = trimmed.match(ENV_LINE);
		if (envMatch) {
			env[envMatch[1]] = unquote(envMatch[2]);
			return;
		}

		let schedule: string;
		let fields: string[];
		let command: string;
		let reboot = false;

		if (trimmed.startsWith('@')) {
			const match = trimmed.match(/^(@\S+)\s+(.+)$/);
			if (!match) {
				errors.push({ line, message: 'missing command' });
				return;
			}
			schedule = match[1];
			command = match[2];
			const macro = schedule.toLowerCase();
			if (macro === '@reboot') {
				reboot = true;
				fields = ['*', '*', '*', '*', '*'];
			} else if (MACROS[macro]) {
				fields = MACROS[macro].split(' ');
			} else {
				errors.push({ line, message: `unknown macro "${schedule}"` });
				return;
			}
		} else {
			const parts = trimmed.split(/\s+/);
			if (parts.length < 6) {
				errors.push({ line, message: 'expected five time fields followed by a command' });
				return;
			}
			fields = parts.slice(0, 5);
			schedule = fields.join(' ');
			command = trimmed.replace(/^(\S+\s+){5}/, '');
		}

		try {
			const [minutes, hours, days, months, weekdays] = fields.map((field, i) => parseField(field, FIELDS[i]));
			entries.push({
				line,
				schedule,
				command,
				env: { ...env },
				reboot,
				minutes,
				hours,
				days,
				months,
				weekdays,
				daysRestricted: !fields[2].startsWith('*'),
				weekdaysRestricted: !fields[4].startsWith('*'),
			});
		} catch (err) {
			errors.push({ line, message: err.message });
		}
	});

	return { entries, errors };
};

const dayMatches = (entry: CronEntry, date: Date): boolean => {
	const dom = entry.days.has(date.getDate());
	const dow = entry.weekdays.has(date.getDay());
	// Classic cron: when both day fields are restricted, either may match.
	if (entry.daysRestricted && entry.weekdaysRestricted) {
		return dom || dow;
	}
	return dom && dow;
};

/** Does the entry fire in the minute that contains `date` (local time)? */
export const matches = (entry: CronEntry, date: Date): boolean => !entry.reboot
	&& entry.minutes.has(date.getMinutes())
	&& entry.hours.has(date.getHours())
	&& entry.months.has(date.getMonth() + 1)
	&& dayMatches(entry, date);

/** The first minute strictly after `from` that the entry fires in, or null. */
export const nextRun = (entry: CronEntry, from: Date = new Date()): Date | null => {
	if (entry.reboot) {
		return null;
	}
	const date = new Date(from.getTime());
	date.setSeconds(0, 0);
	date.setMinutes(date.getMinutes() + 1);

	// Skip whole months/days/hours that cannot match; bounded to ~5 years so
	// impossible schedules such as "0 0 31 2 *" end.
	for (let guard = 0; guard < 100000; guard++) {
		if (!entry.months.has(date.getMonth() + 1)) {
			date.setMonth(date.getMonth() + 1, 1);
			date.setHours(0, 0, 0, 0);
		} else if (!dayMatches(entry, date)) {
			date.setDate(date.getDate() + 1);
			date.setHours(0, 0, 0, 0);
		} else if (!entry.hours.has(date.getHours())) {
			date.setHours(date.getHours() + 1, 0, 0, 0);
		} else if (!entry.minutes.has(date.getMinutes())) {
			date.setMinutes(date.getMinutes() + 1, 0, 0);
		} else {
			return date;
		}
	}
	return null;
};
