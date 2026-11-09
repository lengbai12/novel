// Thrown by a job when the user cancels it. Engine code must not catch it silently.
export class Cancelled extends Error {}

// Thrown when an operation conflicts with an active job or existing state.
export class Conflict extends Error {}
