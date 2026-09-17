import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "../components/button";
import { authClient } from "../lib/auth-client";

export const Route = createFileRoute("/login")({
	component: Login,
});

function Login() {
	const [error, setError] = useState("");
	const [signingIn, setSigningIn] = useState(false);

	async function signIn() {
		setError("");
		setSigningIn(true);

		try {
			await authClient.signIn.social({ provider: "github" });
		} catch (cause) {
			// Rejection by the operator allow-list surfaces here as well as a failed redirect, so
			// the message stays generic rather than confirming whether an account exists.
			setError(cause instanceof Error ? cause.message : "sign in failed");
			setSigningIn(false);
		}
	}

	return (
		<main className="shell">
			<header className="masthead">
				<div>
					<p className="eyebrow">PVE / HERDR</p>
					<h1>Agent compute</h1>
				</div>
			</header>

			<section className="request-panel" aria-labelledby="login-title">
				<div>
					<p className="eyebrow">SIGN IN</p>
					<h2 id="login-title">Controller access</h2>
				</div>
				<p>This controller admits a single GitHub account.</p>
				<Button disabled={signingIn} onClick={signIn}>
					{signingIn ? "Redirecting" : "Sign in with GitHub"}
				</Button>
				{error === "" ? null : <p className="error">{error}</p>}
			</section>
		</main>
	);
}
