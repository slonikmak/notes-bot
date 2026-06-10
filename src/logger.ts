import fs from 'node:fs';
import path from 'node:path';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

export class Logger {
  private level: LogLevel = LogLevel.INFO;
  private target: 'console' | 'file' | 'both' = 'console';
  private filePath: string = 'logs/app.log';

  constructor() {
    this.configure();
  }

  public configure(): void {
    const envLevel = process.env.LOG_LEVEL?.toUpperCase();
    if (envLevel === 'DEBUG') this.level = LogLevel.DEBUG;
    else if (envLevel === 'INFO') this.level = LogLevel.INFO;
    else if (envLevel === 'WARN') this.level = LogLevel.WARN;
    else if (envLevel === 'ERROR') this.level = LogLevel.ERROR;

    const envTarget = process.env.LOG_TARGET?.toLowerCase();
    if (envTarget === 'console' || envTarget === 'file' || envTarget === 'both') {
      this.target = envTarget as 'console' | 'file' | 'both';
    }

    if (process.env.LOG_FILE_PATH) {
      this.filePath = process.env.LOG_FILE_PATH;
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.level;
  }

  private write(level: LogLevel, message: string, context?: string, metadata?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const timestamp = new Date().toISOString();
    const levelName = LEVEL_NAMES[level];
    const ctxString = context ? ` [${context}]` : '';

    // Console output: readable text
    if (this.target === 'console' || this.target === 'both') {
      let consoleMsg = `[${timestamp}] [${levelName}]${ctxString} ${message}`;
      if (metadata && Object.keys(metadata).length > 0) {
        consoleMsg += ` ${JSON.stringify(metadata)}`;
      }
      if (level === LogLevel.ERROR) {
        console.error(consoleMsg);
      } else if (level === LogLevel.WARN) {
        console.warn(consoleMsg);
      } else {
        console.log(consoleMsg);
      }
    }

    // File output: structured JSON
    if (this.target === 'file' || this.target === 'both') {
      const logEntry = {
        timestamp,
        level: levelName,
        context: context || undefined,
        message,
        metadata: metadata && Object.keys(metadata).length > 0 ? metadata : undefined,
      };

      try {
        const logLine = JSON.stringify(logEntry) + '\n';
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.appendFileSync(this.filePath, logLine, 'utf8');
      } catch (err) {
        console.error(`[LOGGER ERROR] Failed to write log to file "${this.filePath}":`, err);
      }
    }
  }

  public debug(message: string, context?: string, metadata?: Record<string, unknown>): void {
    this.write(LogLevel.DEBUG, message, context, metadata);
  }

  public info(message: string, context?: string, metadata?: Record<string, unknown>): void {
    this.write(LogLevel.INFO, message, context, metadata);
  }

  public warn(message: string, context?: string, metadata?: Record<string, unknown>): void {
    this.write(LogLevel.WARN, message, context, metadata);
  }

  public error(message: string, error?: Error | unknown, context?: string, metadata?: Record<string, unknown>): void {
    let errMsg = message;
    let errMeta = metadata || {};
    if (error) {
      if (error instanceof Error) {
        errMsg = `${message}: ${error.message}`;
        errMeta = { ...errMeta, stack: error.stack };
      } else {
        errMsg = `${message}: ${String(error)}`;
      }
    }
    this.write(LogLevel.ERROR, errMsg, context, errMeta);
  }
}

export const logger = new Logger();
