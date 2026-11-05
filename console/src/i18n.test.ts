import { describe, expect, it } from "vitest";
import i18n from "./i18n";

describe("translation loading", () => {
  it("keeps common languages ready without loading unused dictionaries", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(i18n.t("common.loading")).not.toBe("common.loading");
    expect(i18n.hasResourceBundle("en", "translation")).toBe(true);
    expect(i18n.hasResourceBundle("zh", "translation")).toBe(true);
    expect(i18n.hasResourceBundle("ru", "translation")).toBe(false);
  });

  it.each(["ru-RU", "ja-JP", "pt-BR", "id-ID", "vi-VN"])(
    "loads %s on demand, including regional language codes",
    async (language) => {
      await i18n.changeLanguage(language);
      const canonical =
        language === "pt-BR" ? language : language.split("-")[0];
      expect(i18n.hasResourceBundle(canonical, "translation")).toBe(true);
      expect(i18n.t("common.loading")).not.toBe("common.loading");
      expect(i18n.resolvedLanguage).toBe(canonical);
    },
  );
});
