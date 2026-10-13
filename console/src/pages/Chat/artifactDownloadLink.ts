import { message } from "antd";
import { artifactsApi } from "../../api/modules/artifacts";
import { artifactIdFromDownloadUrl } from "../../features/files-workspace/fileLocator";
import {
  latestConversationArtifact,
  sandboxArtifactName,
} from "./sandboxArtifactLink";

export { artifactIdFromDownloadUrl } from "../../features/files-workspace/fileLocator";

interface LinkClick {
  target: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}

export function handleArtifactDownloadLink(
  event: LinkClick,
  scope?: { agentId: string; conversationId?: string },
): boolean {
  if (!(event.target instanceof Element)) return false;
  const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
  if (!anchor) return false;
  const sandboxName = sandboxArtifactName(anchor.getAttribute("href") || "");
  if (sandboxName) {
    event.preventDefault();
    event.stopPropagation();
    if (!scope?.conversationId) {
      message.error("请在原对话中下载该产物");
      return true;
    }
    const context = { agentId: scope.agentId };
    void artifactsApi
      .list(context)
      .then(async (artifacts) => {
        const artifact = latestConversationArtifact(
          artifacts,
          sandboxName,
          scope.conversationId,
        );
        if (!artifact) {
          message.error("当前对话中未找到该文件，请在文件面板查看已生成的产物");
          return;
        }
        await artifactsApi.download(
          artifact.id,
          artifact.original_name,
          context,
        );
      })
      .catch(() => message.error("下载产物失败，请检查登录状态或重试"));
    return true;
  }
  const artifactId = artifactIdFromDownloadUrl(anchor.href);
  if (!artifactId) return false;
  event.preventDefault();
  event.stopPropagation();
  const download = scope
    ? artifactsApi.download(artifactId, anchor.download || "artifact", {
        agentId: scope.agentId,
      })
    : artifactsApi.download(artifactId, anchor.download || "artifact");
  void download.catch(() =>
    message.error("下载产物失败，请检查登录状态或重试"),
  );
  return true;
}
