export function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

export function invalidJson(): Response {
	return json({ error: "request body must be valid JSON" }, 400);
}
