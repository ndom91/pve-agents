// GitRepository is a repository the controller is willing to clone.
export type GitRepository =
	| { kind: "invalid"; message: string }
	| { kind: "parsed"; name: string; owner: string };

// SEGMENT is what GitHub permits in an owner or repository name.
//
// Deliberately a strict allow-list rather than a list of forbidden characters. These two values
// are interpolated into a clone URL and sent to GitHub as the repository a token may touch, so
// anything that slips through reaches both. A deny-list only stops the attacks already thought of.
const SEGMENT = /^[A-Za-z0-9._-]+$/;

// HOST is the only host the controller clones from.
//
// The GitHub App's tokens are worthless elsewhere, so another host cannot be authenticated. It
// could still be reached, which is the part worth refusing: a request naming an internal address
// would otherwise have the controller's own network position used to fetch it.
const HOST = "github.com";

// parseRepository turns a stored repository string into the owner and name to clone.
//
// Accepts `owner/name`, `github.com/owner/name`, and the https form with an optional `.git`
// suffix, because all three are things a person reasonably types.
export function parseRepository(value: string): GitRepository {
	const trimmed = value.trim().replace(/\.git$/, "");
	// Credentials in the URL are refused rather than dropped. A request carrying them is either a
	// mistake worth surfacing or an attempt to have the controller authenticate as someone else.
	if (trimmed.includes("@")) {
		return {
			kind: "invalid",
			message: "repository must not contain credentials",
		};
	}

	const withoutScheme = trimmed.replace(/^https?:\/\//, "");
	const segments = withoutScheme.split("/").filter((part) => part !== "");
	const scoped =
		segments.length === 3 && segments[0]?.toLowerCase() === HOST
			? segments.slice(1)
			: segments;

	if (segments.length === 3 && segments[0]?.toLowerCase() !== HOST) {
		return {
			kind: "invalid",
			message: `repository must be hosted on ${HOST}`,
		};
	}
	if (scoped.length !== 2) {
		return { kind: "invalid", message: "repository must be owner/name" };
	}

	const [owner, name] = scoped;
	if (
		owner === undefined ||
		name === undefined ||
		!SEGMENT.test(owner) ||
		!SEGMENT.test(name)
	) {
		return { kind: "invalid", message: "repository has an unusable name" };
	}
	// "." and ".." pass the character test but are path traversal once they reach a URL.
	if ([owner, name].some((part) => part === "." || part === "..")) {
		return { kind: "invalid", message: "repository has an unusable name" };
	}

	return { kind: "parsed", name, owner };
}

// repositoryURL is the credential-free URL a workspace clones from.
//
// No credentials by construction: git reads those from its own store, so a token can never end up
// in argv, in ps, or in the error text git prints when a fetch fails.
export function repositoryURL(repository: {
	name: string;
	owner: string;
}): string {
	return `https://${HOST}/${repository.owner}/${repository.name}.git`;
}

// repositoryPage is where a person reads the repository, as opposed to where git clones it.
//
// Built from the parsed owner and name rather than from the stored string, so whichever of the
// three accepted spellings was typed, the link is the same one.
export function repositoryPage(repository: {
	name: string;
	owner: string;
}): string {
	return `https://${HOST}/${repository.owner}/${repository.name}`;
}

// branchPage is where a person reads one branch of that repository.
//
// The branch is escaped segment by segment. Every workspace branch contains a slash -- they are
// all `pve-agents/<hostname>` -- and that slash is part of the path GitHub expects, so escaping
// the string whole would turn the one separator that matters into %2F.
export function branchPage(
	repository: { name: string; owner: string },
	branch: string,
): string {
	const path = branch.split("/").map(encodeURIComponent).join("/");

	return `${repositoryPage(repository)}/tree/${path}`;
}

// shortRepository drops the host, which is github.com for every repository this controller will
// clone and therefore tells a reader nothing.
//
// Here rather than beside the three lists that call it. It was copied into the sidebar entry, the
// fleet row and the home screen's destroyed list, which is three chances for one of them to start
// disagreeing about what a repository is called.
//
// Deliberately not `parseRepository`. That validates and rejects; this only shortens, and a stored
// value that does not parse still has to appear in a list rather than vanish from it.
export function shortRepository(repository: string): string {
	return repository.replace(/^https?:\/\//, "").replace(/^github\.com\//, "");
}
