import React from "react";
import ChatPlanPanel from "../ChatPlanPanel";
import UserInputPanel from "../UserInputPanel";
import { usePendingUserInput } from "../UserInputPanel/usePendingUserInput";

interface TaskInteractionPanelProps {
  planEnabled: boolean;
}

const TaskInteractionPanel: React.FC<TaskInteractionPanelProps> = ({
  planEnabled,
}) => {
  const { request, refresh } = usePendingUserInput(true);

  if (request) {
    return <UserInputPanel request={request} onResolved={refresh} />;
  }

  return <ChatPlanPanel enabled={planEnabled} />;
};

export default TaskInteractionPanel;
