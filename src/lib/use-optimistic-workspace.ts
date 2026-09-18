import { useQueryClient } from "@tanstack/react-query";

import { workspaceKeys } from "./queries";

// WorkspacePatch is what an action claims will be true before the server has said so.
//
// Typed rather than a bag of unknowns: a misspelled field would otherwise typecheck and silently
// predict nothing, which is the worst outcome for a prediction because it looks like it worked.
export type WorkspacePatch = {
	activity?: string;
	desiredState?: string;
	errorCode?: string | undefined;
	errorMessage?: string | undefined;
	status?: string;
};

// Rollback restores what was on screen before a prediction was made.
export type Rollback = () => void;

// useOptimisticWorkspace shows the result of an action immediately, and gives back the undo.
//
// Every optimistic action goes through this, so none of them can forget the rollback. Returning it
// rather than applying it here keeps the decision where it belongs: a mutation that was accepted
// but refused — an agent that turns out to be blocked — has to put the prediction back just as a
// failed one does, and only the caller knows which replies count as refusals.
export function useOptimisticWorkspace(workspaceId: string) {
	const queryClient = useQueryClient();
	const key = workspaceKeys.detail(workspaceId);

	return async function predict(patch: WorkspacePatch): Promise<Rollback> {
		// Cancelled first, or an in-flight fetch could land after the patch and overwrite it with
		// the state the server held before the action.
		await queryClient.cancelQueries({ queryKey: key });
		const previous = queryClient.getQueryData(key);

		queryClient.setQueryData(key, (current: object | undefined) =>
			current === undefined ? current : { ...current, ...patch },
		);

		return () => queryClient.setQueryData(key, previous);
	};
}
