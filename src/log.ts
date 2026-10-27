import * as fs from 'fs';
import * as path from 'path';

/** Rotate to cron.log.1 once the log passes this size. */
const MAX_LOG_BYTES = 1024 * 1024;

const pad = (n: number) => String(n).padStart(2, '0');

export const timestamp = (date = new Date()): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
	+ `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

export const appendLog = (logPath: string, lines: string[]): void => {
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
	try {
		if (fs.statSync(logPath).size > MAX_LOG_BYTES) {
			fs.renameSync(logPath, `${logPath}.1`);
		}
	} catch {
		// no log yet
	}
	fs.appendFileSync(logPath, `${lines.join('\n')}\n`);
};

/** The last `maxBytes` of the log, starting at a line boundary. */
export const tailLog = (logPath: string, maxBytes = 128 * 1024): string | null => {
	let fd: number;
	try {
		fd = fs.openSync(logPath, 'r');
	} catch {
		return null;
	}
	try {
		const { size } = fs.fstatSync(fd);
		const start = Math.max(0, size - maxBytes);
		const buffer = Buffer.alloc(size - start);
		fs.readSync(fd, buffer, 0, buffer.length, start);
		const text = buffer.toString('utf8');
		return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
	} finally {
		fs.closeSync(fd);
	}
};

export const logSize = (logPath: string): number | null => {
	try {
		return fs.statSync(logPath).size;
	} catch {
		return null;
	}
};
