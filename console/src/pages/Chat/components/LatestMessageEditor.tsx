import {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from "react";
import { Button, Input, Tooltip } from "antd";
import { EditOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useChatAnywhereMessages } from "@agentscope-ai/chat/lib/AgentScopeRuntimeWebUI/core/Context/ChatAnywhereMessagesContext";
import { createClientMessageId } from "../../../utils/clientMessageId";
import { requestText, type EditRequestData } from "../latestMessageEdit";
import styles from "./LatestMessageEditor.module.less";

type Draft = {
  data: EditRequestData;
  text: string;
  requestId: string;
  busy: boolean;
  error?: string;
};
type EditorContext = {
  enabled: boolean;
  draft: Draft | null;
  setDraft: (draft: Draft | null) => void;
  resend: (
    data: EditRequestData,
    text: string,
    requestId: string,
  ) => Promise<void>;
};
const Context = createContext<EditorContext | null>(null);

export function LatestMessageEditProvider({
  enabled,
  scopeKey,
  resend,
  children,
}: {
  enabled: boolean;
  scopeKey: string;
  resend: EditorContext["resend"];
  children: ReactNode;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const setScopedDraft = (next: Draft | null) => {
    if (scopeRef.current === scopeKey) setDraft(next);
  };
  useEffect(() => setDraft(null), [scopeKey]);
  return (
    <Context.Provider
      value={{ enabled, draft, setDraft: setScopedDraft, resend }}
    >
      {children}
    </Context.Provider>
  );
}

export function EditMessageAction({ data }: { data: EditRequestData }) {
  const editor = useContext(Context);
  const { getMessages } = useChatAnywhereMessages();
  const { t } = useTranslation();
  const latest = getMessages()
    .filter((message) => message.role === "user")
    .slice(-1)[0];
  const latestData = latest?.cards?.find(
    (card) => card.code === "AgentScopeRuntimeRequestCard",
  )?.data;
  const metadata = data.input?.slice(-1)[0]?.metadata as
    | Record<string, unknown>
    | undefined;
  if (
    !editor?.enabled ||
    latestData !== data ||
    editor.draft?.busy ||
    metadata?.qwenpaw_editable !== true
  )
    return null;
  return (
    <Tooltip title={t("chat.editMessage")}>
      <Button
        type="text"
        size="small"
        aria-label={t("chat.editMessage")}
        icon={<EditOutlined />}
        onClick={() =>
          editor.setDraft({
            data,
            text: requestText(data),
            requestId: createClientMessageId(),
            busy: false,
          })
        }
      />
    </Tooltip>
  );
}

export function LatestMessageEditor({
  data,
  children,
  attachments,
}: {
  data: EditRequestData;
  children: ReactNode;
  attachments?: ReactNode;
}) {
  const editor = useContext(Context);
  const { t } = useTranslation();
  const draft = editor?.draft;
  if (!editor || !draft || draft.data !== data) return <>{children}</>;
  const send = async () => {
    if (draft.busy || !draft.text.trim()) return;
    editor.setDraft({ ...draft, busy: true, error: undefined });
    try {
      await editor.resend(data, draft.text, draft.requestId);
      editor.setDraft(null);
    } catch (error) {
      editor.setDraft({
        ...draft,
        busy: false,
        error: error instanceof Error ? error.message : t("chat.editFailed"),
      });
    }
  };
  return (
    <div className={styles.editor} data-testid="latest-message-editor">
      <Input.TextArea
        autoFocus
        aria-label={t("chat.editMessage")}
        value={draft.text}
        disabled={draft.busy}
        maxLength={10000}
        autoSize={{ minRows: 2, maxRows: 12 }}
        onChange={(event) =>
          editor.setDraft({
            ...draft,
            text: event.target.value,
            requestId: draft.error ? createClientMessageId() : draft.requestId,
            error: undefined,
          })
        }
        onKeyDown={(event) => {
          if (event.key === "Escape" && !draft.busy) editor.setDraft(null);
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void send();
          }
        }}
      />
      {attachments && (
        <div className={styles.attachments}>
          <div className={styles.attachmentHint}>
            {t("chat.editAttachmentsRetained")}
          </div>
          {attachments}
        </div>
      )}
      {draft.error && (
        <div role="alert" className={styles.error}>
          {draft.error}
        </div>
      )}
      <div className={styles.actions}>
        <Button
          aria-label={t("common.cancel")}
          disabled={draft.busy}
          onClick={() => editor.setDraft(null)}
        >
          {t("common.cancel")}
        </Button>
        <Button
          aria-label={t("chat.editResend")}
          type="primary"
          loading={draft.busy}
          disabled={!draft.text.trim()}
          onClick={() => void send()}
        >
          {t("chat.editResend")}
        </Button>
      </div>
    </div>
  );
}
