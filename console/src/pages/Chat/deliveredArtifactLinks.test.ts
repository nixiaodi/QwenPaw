import { expect, it } from "vitest";
import { normalizeSandboxArtifactLinks } from "./sandboxArtifactLink";
import { deliveredArtifactsFromMessages, artifactDisplayName } from "./deliveredArtifacts";

const deliveries = [{
  name: "成都今日旅游推荐报告_2026-10-06.pdf",
  url: "/api/console/artifacts/1053cdda-fc2d-44e6-a1b0-cbe039e75216/download",
}];

it("uses this response's delivered artifact instead of a fabricated cloud link", () => {
  const input = "[下载《成都今日旅游推荐报告》PDF](https://qianwen-res.oss-cn-beijing.aliyuncs.com/secure/openapi/download/content_fake.pdf?Signature=fake)";
  expect(normalizeSandboxArtifactLinks(input, deliveries)).toBe(
    `[下载《成都今日旅游推荐报告》PDF](${deliveries[0].url})`,
  );
});

it("does not replace unrelated references or code examples", () => {
  for (const input of [
    "[景区官方说明](https://example.com/report.pdf)",
    "[下载另一份报告](https://example.com/report.pdf)",
    "`[下载《成都今日旅游推荐报告》PDF](https://example.com/report.pdf)`",
  ]) expect(normalizeSandboxArtifactLinks(input, deliveries)).toBe(input);
});

it("does not invent a download without a delivered file", () => {
  const input = "[下载报告](https://example.com/report.pdf)";
  expect(normalizeSandboxArtifactLinks(input, [])).toBe(input);
});

it("extracts links only from successful file delivery tools", () => {
  const output = JSON.stringify([
    { type: "data", source: {url: "file:///private/" + encodeURIComponent(deliveries[0].name)} },
    { type: "text", text: "File sent successfully. Download link: " + deliveries[0].url },
  ]);
  const block = {content: [{data: {name: "send_file_to_user", state: "success", output}}]};
  expect(deliveredArtifactsFromMessages([block])).toEqual(deliveries);
  expect(deliveredArtifactsFromMessages([{content: [{data: {name:"web_search", state:"success", output}}]}])).toEqual([]);
  expect(artifactDisplayName(encodeURIComponent(deliveries[0].name))).toBe(deliveries[0].name);
});
