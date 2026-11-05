import {
  userInputApi,
  subscribeUserInputUpdates,
  type UserInputRequest,
} from "../../api/modules/userInput";
import { useSessionResource } from "../../hooks/useSessionResource";

const resource = {
  load: async (
    sessionId: string,
    signal: AbortSignal,
    agentId: string,
  ): Promise<UserInputRequest | null> => {
    const value = await userInputApi.getPending(sessionId, { signal, agentId });
    return value;
  },
  subscribe: subscribeUserInputUpdates,
};

export function usePendingUserInput(active: boolean) {
  const { value, loading, refresh } = useSessionResource(active, resource);
  return { request: value, loading, refresh };
}
