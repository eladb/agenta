const fmt = (level: string, scope: string, msg: string) =>
  `${new Date().toISOString()} ${level} [${scope}] ${msg}`;

export const log = {
  info: (scope: string, msg: string, ...rest: unknown[]) =>
    console.log(fmt('INFO', scope, msg), ...rest),
  warn: (scope: string, msg: string, ...rest: unknown[]) =>
    console.warn(fmt('WARN', scope, msg), ...rest),
  error: (scope: string, msg: string, ...rest: unknown[]) =>
    console.error(fmt('ERROR', scope, msg), ...rest),
};
