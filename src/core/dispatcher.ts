// Dispatcher — Hot path, runs on every request
// Budget: under 2ms total. Read-only — never writes state.
// Uses immutable snapshot pattern for concurrency safety.

export {};
