import { createAuthClient } from "better-auth/client";

// authClient talks to the controller's own better-auth routes at /api/auth.
//
// It holds no secret. Sign-in happens through GitHub's redirect flow and the resulting session
// lives in an HTTP-only cookie, so nothing the browser can read grants access to the API.
export const authClient = createAuthClient();
