import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Empty,
  Input,
  Drawer,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from "antd";
import { useTranslation } from "react-i18next";
import {
  agentsApi,
  type AdminConversation,
  type AdminConversationMessage,
} from "@/api/modules/agents";
import type { AdminAgentSummary } from "@/api/types/agents";
import { useAuthStore } from "@/stores/authStore";
import { useAgentStore } from "@/stores/agentStore";
import { formatTime } from "./components/constants";
import type { Message } from "@/api/types/chat";
import ReadOnlyConversation from "../../Chat/ReadOnlyConversation";

export default function AdminConversations() {
  const auth = useAuthStore();
  if (
    auth.mode !== "multi_user" ||
    auth.phase !== "authenticated" ||
    auth.user?.platform_role !== "admin"
  )
    return null;
  return <Inspector key={auth.user.id} />;
}

function Inspector() {
  const { t } = useTranslation();
  const selectedAgent = useAgentStore((state) => state.selectedAgent);
  const [agents, setAgents] = useState<AdminAgentSummary[]>([]);
  const [agentId, setAgentId] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void agentsApi
      .listAdminAgents()
      .then((result) => {
        if (!current) return;
        setAgents(result.agents);
        setAgentId(
          result.agents.some((agent) => agent.id === selectedAgent)
            ? selectedAgent
            : result.agents[0]?.id ?? "",
        );
      })
      .catch(() => {
        if (current) setError(t("sessions.viewFailed"));
      });
    return () => {
      current = false;
    };
  }, [t, selectedAgent]);
  return (
    <Space
      direction="vertical"
      size="middle"
      style={{ width: "100%", padding: 16 }}
    >
      <Alert
        type="info"
        showIcon
        message={t("sessions.adminInspectDescription")}
      />
      {error && <Alert type="error" message={error} />}
      <Select
        aria-label={t("sessions.inspectAgent")}
        placeholder={t("sessions.inspectAgent")}
        style={{ width: "100%", maxWidth: 440 }}
        value={agentId || undefined}
        onChange={setAgentId}
        showSearch
        optionFilterProp="label"
        options={agents.map((agent) => ({
          value: agent.id,
          label: `${agent.name} (${agent.id})`,
        }))}
      />
      {agentId && (
        <AgentConversations
          key={agentId}
          agentId={agentId}
          agentName={
            agents.find((agent) => agent.id === agentId)?.name || agentId
          }
        />
      )}
      {!agentId && !error && <Empty />}
    </Space>
  );
}

function AgentConversations({
  agentId,
  agentName,
}: {
  agentId: string;
  agentName: string;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<AdminConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [active, setActive] = useState<AdminConversation | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void agentsApi
      .listAdminConversations(agentId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setRows(result.conversations);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setRows([]);
          setError(t("sessions.viewFailed"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [agentId, revision, t]);
  const search = query.trim().toLowerCase();
  return (
    <>
      {error && <Alert type="error" message={error} />}
      <Space wrap>
        <Input.Search
          aria-label={t("sessions.inspectSearch")}
          placeholder={t("sessions.inspectSearch")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          allowClear
        />
        <Button
          loading={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          {t("common.refresh")}
        </Button>
      </Space>
      <Table
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 20 }}
        scroll={{ x: true }}
        dataSource={rows.filter((row) =>
          `${row.title} ${row.owner_name} ${row.owner_user_id} ${row.id}`
            .toLowerCase()
            .includes(search),
        )}
        columns={[
          { title: t("sessions.inspectTitle"), dataIndex: "title" },
          {
            title: t("sessions.inspectOwner"),
            render: (_, row) => (
              <Space direction="vertical" size={0}>
                <span>{row.owner_name}</span>
                <Typography.Text type="secondary">
                  {row.owner_user_id}
                </Typography.Text>
              </Space>
            ),
          },
          { title: "ID", dataIndex: "id" },
          {
            title: t("sessions.inspectStatus"),
            render: (_, row) => (
              <Tag>
                {t(
                  row.status === "archived"
                    ? "sessions.archivedTab"
                    : "sessions.activeTab",
                )}
              </Tag>
            ),
          },
          {
            title: t("skillGovernance.changedAt"),
            dataIndex: "updated_at",
            render: formatTime,
          },
          {
            title: t("common.actions"),
            render: (_, row) => (
              <Button onClick={() => setActive(row)}>
                {t("skillGovernance.viewDetails")}
              </Button>
            ),
          },
        ]}
      />
      {active && (
        <Transcript
          key={active.id}
          agentId={agentId}
          agentName={agentName}
          conversation={active}
          onClose={() => setActive(null)}
        />
      )}
    </>
  );
}

function Transcript({
  agentId,
  agentName,
  conversation,
  onClose,
}: {
  agentId: string;
  agentName: string;
  conversation: AdminConversation;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<AdminConversationMessage[]>([]);
  const [historyMessages, setHistoryMessages] = useState<Message[]>([]);
  const [showRaw, setShowRaw] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void agentsApi
      .getAdminConversation(agentId, conversation.id, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setMessages(result.messages);
          setHistoryMessages(result.history_messages);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(t("sessions.viewFailed"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [agentId, conversation.id, t]);
  return (
    <Drawer
      open
      title={
        <Space>
          <span>{conversation.title}</span>
          <Tag>{t("common.readOnly")}</Tag>
        </Space>
      }
      onClose={onClose}
      width="min(1200px, 100vw)"
      styles={{
        body: {
          padding: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        },
      }}
      extra={
        <Button onClick={() => setShowRaw((value) => !value)}>
          {t(showRaw ? "sessions.chatView" : "sessions.rawRecords")}
        </Button>
      }
    >
      <div
        style={{
          padding: "12px 24px",
          borderBottom: "1px solid var(--qwenpaw-color-border-secondary, #eee)",
        }}
      >
        <Typography.Text type="secondary">
          {agentName} · {t("sessions.inspectOwner")}: {conversation.owner_name}{" "}
          · {conversation.owner_user_id}
        </Typography.Text>
      </div>
      {error && <Alert type="error" message={error} />}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {loading ? (
          <div style={{ padding: 64, textAlign: "center" }}>
            <Spin />
          </div>
        ) : showRaw ? (
          <pre
            style={{
              padding: 24,
              margin: 0,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {JSON.stringify(messages, null, 2)}
          </pre>
        ) : (
          <ReadOnlyConversation
            messages={historyMessages}
            userName={conversation.owner_name}
            agentName={agentName}
          />
        )}
      </div>
    </Drawer>
  );
}
