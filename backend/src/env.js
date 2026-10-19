/**
 * Loads backend/.env (if present) before anything reads process.env.
 * Imported first by src/index.js so config.js sees the values — this is what
 * makes "copy .env.example to backend/.env" actually work without exporting
 * vars in your shell.
 */
try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  /* no .env file — env vars come from the environment */
}
