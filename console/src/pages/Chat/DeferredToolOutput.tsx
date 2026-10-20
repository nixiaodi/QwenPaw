import { useEffect, useRef, useState } from "react";
import { Button, Space, Typography } from "antd";
import ResponseTool from "@agentscope-ai/chat/lib/AgentScopeRuntimeWebUI/core/AgentScopeRuntime/Response/Tool";
import type { IAgentScopeRuntimeMessage } from "@agentscope-ai/chat/lib/AgentScopeRuntimeWebUI/core/AgentScopeRuntime/types";
import { request } from "../../api/request";
import { historyScope } from "./historyPaging";

export default function DeferredToolOutput({
  data,
}: {
  data: IAgentScopeRuntimeMessage;
}) {
  const outputRef = (item: IAgentScopeRuntimeMessage["content"][number]) =>
    item.type === "data"
      ? (
          item.data as {
            qwenpaw_output_ref?: { path: string; byte_size: number };
          }
        )?.qwenpaw_output_ref
      : undefined;
  const index = data.content.findIndex((item) => outputRef(item));
  const ref = index >= 0 ? outputRef(data.content[index]) : undefined;
  const [loaded, setLoaded] = useState<IAgentScopeRuntimeMessage>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    setLoaded(undefined);
    setFailed(false);
    setBusy(false);
    return () => controller.current?.abort();
  }, [ref?.path]);
  const load = async () => {
    if (
      !ref ||
      (controller.current && !controller.current.signal.aborted && busy)
    )
      return;
    if (!/^\/(chats|admin\/agents)\//.test(ref.path)) return;
    const current = new AbortController();
    controller.current = current;
    const scope = historyScope();
    setBusy(true);
    setFailed(false);
    try {
      const result = await request<IAgentScopeRuntimeMessage>(ref.path, {
        signal: current.signal,
      });
      if (current.signal.aborted || historyScope() !== scope) return;
      if (!result.content?.[0]) throw new Error("Invalid tool output");
      const content = [...data.content];
      content[index] = result.content[0];
      setLoaded({ ...data, content });
    } catch {
      if (!current.signal.aborted && historyScope() === scope) setFailed(true);
    } finally {
      if (!current.signal.aborted) setBusy(false);
    }
  };
  return (
    <>
      <ResponseTool data={loaded || data} />
      {ref && !loaded && (
        <Space style={{ margin: "4px 0 12px" }}>
          <Button size="small" loading={busy} onClick={() => void load()}>
            {failed ? "重试加载完整输出" : "加载完整输出"} (
            {Math.ceil(ref.byte_size / 1024)} KB)
          </Button>
          {failed && <Typography.Text type="danger">加载失败</Typography.Text>}
        </Space>
      )}
    </>
  );
}
