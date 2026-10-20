import { useTranslation } from "react-i18next";

/** Shared startup and route fallback, including an accessible text status. */
export default function LoadingStatus() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      style={{
        display: "grid",
        placeItems: "center",
        minHeight: "40vh",
        padding: 24,
        color: "var(--text-secondary, #767676)",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      {t("common.loading", "正在加载…")}
    </div>
  );
}
