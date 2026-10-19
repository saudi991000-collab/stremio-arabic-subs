function write(level, message, fields = {}) {
  const safe = Object.fromEntries(
    Object.entries(fields).filter(([key]) => !/password|secret|token|subtitleText/i.test(key))
  );
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, ...safe })}\n`);
}

export const logger = {
  info: (message, fields) => write("info", message, fields),
  warn: (message, fields) => write("warn", message, fields),
  error: (message, fields) => write("error", message, fields)
};
