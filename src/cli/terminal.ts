// The terminal socket's entry point for the server process.
//
// Built alongside the other CLI entries rather than into the TanStack Start bundle, because
// bin/controller-server.mjs owns the http server and this attaches to it directly. The same
// reasoning as the scheduler: operator-side code that shares the controller's TypeScript sources
// instead of reimplementing its wiring in plain JavaScript.
export { attachTerminalSocket } from "../server/terminal-socket";
