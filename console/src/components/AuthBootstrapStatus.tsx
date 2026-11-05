import { useEffect } from "react";
import { Alert, Button } from "antd";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../stores/authStore";
import LoadingStatus from "./LoadingStatus";

/** Keep a failed connectivity check separate from the anonymous login screen. */
export default function AuthBootstrapStatus() {
  const failed = useAuthStore((state) => state.bootstrapError);
  const bootstrap = useAuthStore((state) => state.bootstrap);
  const { t } = useTranslation();
  useEffect(() => {
    if (!failed) return;
    const retry = () => {
      void bootstrap();
    };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [failed, bootstrap]);
  if (!failed) return <LoadingStatus />;
  return (
    <div style={{ maxWidth: 520, margin: "20vh auto", padding: 24 }}>
      <Alert
        type="warning"
        showIcon
        message={t("login.sessionCheckFailed")}
        action={
          <Button onClick={() => void bootstrap()}>
            {t("login.retrySession")}
          </Button>
        }
      />
    </div>
  );
}
