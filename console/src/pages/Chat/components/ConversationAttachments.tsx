import { useEffect, useState } from "react";
import { Badge, Button, Dropdown, Tooltip } from "antd";
import { Paperclip } from "lucide-react";
import { chatApi } from "../../../api/modules/chat";
import type { AttachmentListItem } from "../../../features/attachments/types";
import type { FileLocator } from "../../../features/files-workspace/fileLocator";

export default function ConversationAttachments({
  agentId,
  conversationId,
  refreshKey,
}: {
  agentId: string;
  conversationId?: string;
  refreshKey?: unknown;
}) {
  const [items, setItems] = useState<AttachmentListItem[]>([]);
  useEffect(() => {
    let active = true;
    setItems([]);
    if (!conversationId) return;
    let version = 0;
    const load = () => {
      const ticket = ++version;
      void chatApi
        .listAttachments({ conversationId, requestContext: { agentId } })
        .then((files) => {
          if (active && ticket === version)
            setItems(files.filter((file) => file.lifecycle !== "deleted"));
        })
        .catch(() => {
          if (active && ticket === version) setItems([]);
        });
    };
    load();
    window.addEventListener("qwenpaw:attachments-changed", load);
    return () => {
      active = false;
      window.removeEventListener("qwenpaw:attachments-changed", load);
    };
  }, [agentId, conversationId, refreshKey]);
  if (!items.length) return null;
  const openFile = (file: AttachmentListItem) => {
    const locator: FileLocator = {
      category: "attachment",
      agentId,
      stableId: file.id,
      relativePath: file.original_name,
      conversationId,
    };
    window.dispatchEvent(
      new CustomEvent("qwenpaw:open-file-preview", {
        detail: { locator },
      }),
    );
  };
  return (
    <Dropdown
      menu={{
        items: items.map((file) => ({
          key: file.id,
          label: file.original_name,
          onClick: () => openFile(file),
        })),
      }}
      trigger={["click"]}
    >
      <Tooltip title="本对话上传的文件">
        <Badge count={items.length} size="small">
          <Button
            type="text"
            aria-label={`本对话文件（${items.length}）`}
            icon={<Paperclip size={16} />}
          />
        </Badge>
      </Tooltip>
    </Dropdown>
  );
}
