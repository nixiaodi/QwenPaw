import React from "react";
import ChatPlanPanel from "../ChatPlanPanel";
import RuntimeStatusPanel from "../RuntimeStatusPanel";
import UserInputPanel from "../UserInputPanel";
import { usePendingUserInput } from "../UserInputPanel/usePendingUserInput";

interface TaskInteractionPanelProps {
  planEnabled: boolean;
  running: boolean;
}

const TaskInteractionPanel: React.FC<TaskInteractionPanelProps> = ({
  planEnabled,
  running,
}) => {
  const { request, refresh } = usePendingUserInput(true);

  if (request) {
    return <UserInputPanel request={request} onResolved={refresh} />;
  }

  return (
    <>
      <RuntimeStatusPanel enabled={running} />
      <ChatPlanPanel enabled={planEnabled} />
    </>
  );
};

export default TaskInteractionPanel;
