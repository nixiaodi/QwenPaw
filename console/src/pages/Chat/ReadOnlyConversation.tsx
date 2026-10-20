import { useMemo } from "react";
import { Avatar, Empty, Typography } from "antd";
import { useTranslation } from "react-i18next";
import { ChatAnywhereOptionsContextProvider } from "@agentscope-ai/chat/lib/AgentScopeRuntimeWebUI/core/Context/ChatAnywhereOptionsContext";
import type { IAgentScopeRuntimeWebUIOptions } from "@agentscope-ai/chat";
import type {
  IAgentScopeRuntimeRequest,
  IAgentScopeRuntimeResponse,
} from "@agentscope-ai/chat/lib/AgentScopeRuntimeWebUI/core/AgentScopeRuntime/types";
import type { Message } from "@/api/types/chat";
import { withGenericFallback } from "@/components/Chat/ToolCards/adapters/v1Adapter";
import { useTheme } from "@/contexts/ThemeContext";
import { useChatScalarSnapshot } from "@/plugins/registry/useChatExtensions";
import { ChatScalar } from "@/plugins/registry/slotKeys";
import { resolveLocalized } from "@/plugins/registry/types";
import defaultConfig from "./OptionsPanel/defaultConfig";
import { convertMessages } from "./sessionApi";
import { ReadOnlyRequestCard, ReadOnlyResponseCard } from "./HostBubbles";
import styles from "./ReadOnlyConversation.module.less";

export default function ReadOnlyConversation({
  messages,
  userName,
  agentName,
}: {
  messages: Message[];
  userName: string;
  agentName: string;
}) {
  const { t, i18n } = useTranslation();
  const { isDark } = useTheme();
  const extensions = useChatScalarSnapshot();
  const avatar =
    resolveLocalized(
      extensions[ChatScalar.welcomeAvatar]?.value,
      i18n.language,
    ) ?? "/qwenpaw.png";
  const colorPrimary =
    extensions[ChatScalar.themeColorPrimary]?.value ||
    defaultConfig.theme.colorPrimary;
  const turns = useMemo(() => convertMessages(messages), [messages]);
  const options = useMemo<IAgentScopeRuntimeWebUIOptions>(
    () => ({
      api: {},
      session: {},
      theme: { ...defaultConfig.theme, colorPrimary, darkMode: isDark },
      customToolRenderConfig: withGenericFallback({}),
    }),
    [colorPrimary, isDark],
  );
  if (!turns.length) return <Empty />;
  return (
    <ChatAnywhereOptionsContextProvider options={options}>
      <div className={styles.surface}>
        <div
          className={styles.timeline}
          role="log"
          aria-label={t("sessions.conversationMessages")}
        >
          {turns.map((turn) => {
            const user = turn.role === "user";
            const data = turn.cards?.[0]?.data;
            const createdAt = Number(data?.created_at);
            return (
              <article
                key={turn.id}
                className={user ? styles.userTurn : styles.assistantTurn}
              >
                <div className={styles.caption}>
                  {!user && <Avatar src={avatar} alt={agentName} />}
                  <Typography.Text strong>
                    {user ? userName : agentName}
                  </Typography.Text>
                  {createdAt > 0 && (
                    <Typography.Text type="secondary">
                      {new Date(createdAt * 1000).toLocaleString()}
                    </Typography.Text>
                  )}
                </div>
                {user ? (
                  <ReadOnlyRequestCard
                    data={data as IAgentScopeRuntimeRequest}
                  />
                ) : (
                  <ReadOnlyResponseCard
                    data={data as IAgentScopeRuntimeResponse}
                  />
                )}
              </article>
            );
          })}
        </div>
      </div>
    </ChatAnywhereOptionsContextProvider>
  );
}
