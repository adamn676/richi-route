// A place to unify local storage or caching logic.
// src/services/storage.service.ts
/**
 * Simple wrapper around browser storage (localStorage/sessionStorage).
 * Encapsulates JSON serialization, error handling, and a consistent API.
 * You can swap out the underlying storage mechanism here (e.g. IndexedDB)
 * without touching the rest of your app.
 */
